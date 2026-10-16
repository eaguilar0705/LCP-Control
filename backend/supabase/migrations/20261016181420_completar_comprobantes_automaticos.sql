-- Una factura sin su foto contable completa no puede desaparecer de la lista
-- ni hacer que la suma parcial de otras facturas parezca el total definitivo.
create or replace function private.sales_journal_entries(p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_start date; v_result jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then raise exception 'Período inválido.'; end if;
 select occurred_on into v_start from public.journal_entries where kind='opening' and voided_at is null;
 with documents as materialized (
  select d.id,(d.created_at at time zone 'America/Managua')::date as day,
   private.sale_ledger_account(d.payment_method,d.currency) money_account,
   private.credit_invoice_amount(d.id) is null missing_sale,
   exists(select 1 from public.document_items i left join public.document_item_costs c
    on c.document_item_id=i.id and c.document_id=i.document_id and c.product_id=i.product_id
    where i.document_id=d.id and (c.document_item_id is null or c.quantity<>i.quantity or c.unit_cost_nio is null)) missing_cost
  from public.documents d where d.kind='invoice' and v_start is not null
   and (d.created_at at time zone 'America/Managua')::date between greatest(p_from,v_start) and p_to
 ), days as (
  select day,count(*) invoices,count(*) filter(where missing_sale) missing_sales,
   count(*) filter(where missing_cost or missing_sale) missing_costs
  from documents group by day
 ), postings as (
  select p.day,case when p.source='cost' then 'sales_cost' else 'sales' end kind,p.account,p.debit,p.credit
  from private.operational_postings p join documents d on d.id=p.source_id
  where p.source in ('sale','tax','cost')
 ), accounts as (
  select day,kind,account from postings
  union select day,'sales',money_account from documents
  union select day,'sales','4110' from days
  union select day,'sales_cost','1130' from days
  union select day,'sales_cost','5120' from days
 ), amounts as (
  select k.day,k.kind,k.account,a.name,
   case when d.missing_sales>0 or bool_or(p.debit is null and p.account is not null) then null else coalesce(sum(p.debit),0) end debit,
   case when d.missing_sales>0 or bool_or(p.credit is null and p.account is not null) then null else coalesce(sum(p.credit),0) end credit
  from accounts k join public.ledger_accounts a on a.code=k.account join days d on d.day=k.day
  left join postings p on p.day=k.day and p.kind=k.kind and p.account=k.account
  group by k.day,k.kind,k.account,a.name,d.missing_sales
 ), entries as (
  select a.day,a.kind,jsonb_agg(jsonb_build_object('account',a.account,'name',a.name,
   'debit',a.debit,'credit',a.credit,'debit_nio',a.debit,'credit_nio',a.credit) order by a.account) lines
  from amounts a group by a.day,a.kind
 ), vouchers as (
  select jsonb_build_object('id',e.kind||':'||e.day,'number',0,'occurred_on',e.day,'kind',e.kind,
   'description',case when e.kind='sales' then 'Ventas del día' else 'Costo de ventas del día' end,
   'reference',d.invoices::text||' factura(s)','currency','NIO','exchange_rate',1,
   'voided_at',null,'void_reason',null,'automatic',true,'missingSales',d.missing_sales,
   'missingCosts',case when e.kind='sales_cost' then d.missing_costs else 0 end,'lines',e.lines) entry,e.day,e.kind
  from entries e join days d on d.day=e.day order by e.day desc,e.kind limit 501
 ) select coalesce(jsonb_agg(entry order by day desc,kind),'[]'::jsonb) into v_result from vouchers;
 return v_result;
end $$;

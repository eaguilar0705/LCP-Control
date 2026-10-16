-- Los comprobantes diarios se leen de las mismas partidas que alimentan el
-- mayor. No se copian a journal_entries: hacerlo duplicaría ventas y costos.
create function private.sales_journal_entries(p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_start date; v_result jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then raise exception 'Período inválido.'; end if;
 select occurred_on into v_start from public.journal_entries where kind='opening' and voided_at is null;
 with postings as (
  select day,case when source='cost' then 'sales_cost' else 'sales' end kind,source_id,account,debit,credit
  from private.operational_postings
  where source in ('sale','tax','cost') and day between greatest(p_from,v_start) and p_to and v_start is not null
 ), amounts as (
  select p.day,p.kind,p.account,a.name,
   case when bool_or(p.debit is null) then null else sum(p.debit) end debit,
   case when bool_or(p.credit is null) then null else sum(p.credit) end credit
  from postings p join public.ledger_accounts a on a.code=p.account
  group by p.day,p.kind,p.account,a.name
 ), entries as (
  select a.day,a.kind,jsonb_agg(jsonb_build_object('account',a.account,'name',a.name,
   'debit',a.debit,'credit',a.credit,'debit_nio',a.debit,'credit_nio',a.credit) order by a.account) lines
  from amounts a group by a.day,a.kind
 ), vouchers as (
  select jsonb_build_object('id',e.kind||':'||e.day,'number',0,'occurred_on',e.day,'kind',e.kind,
   'description',case when e.kind='sales' then 'Ventas del día' else 'Costo de ventas del día' end,
   'reference',(select count(distinct source_id)::text||' factura(s)' from postings p where p.day=e.day and p.kind=e.kind),
   'currency','NIO','exchange_rate',1,'voided_at',null,'void_reason',null,'automatic',true,
   'missingCosts',(select count(distinct source_id) from postings p where p.day=e.day and p.kind=e.kind and (p.debit is null or p.credit is null)),
   'lines',e.lines) entry,e.day,e.kind
  from entries e order by e.day desc,e.kind limit 501
 ) select coalesce(jsonb_agg(entry order by day desc,kind),'[]'::jsonb) into v_result from vouchers;
 return v_result;
end $$;
create function public.sales_journal_entries(p_from date,p_to date) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.sales_journal_entries(p_from,p_to); $$;
revoke all on function private.sales_journal_entries(date,date),public.sales_journal_entries(date,date) from public,anon;
grant execute on function private.sales_journal_entries(date,date),public.sales_journal_entries(date,date) to authenticated;

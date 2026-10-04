-- Una foto contable debe pertenecer al mismo renglón, factura y perfume.
-- Si el producto no coincide, se informa una venta sin importe completo y se
-- mantiene la caja pendiente; los arqueos no deben aceptar ese saldo.
create or replace function private.cashflow_rows(p_from date,p_to date)
returns table(day date,account text,category text,inflow_nio numeric,outflow_nio numeric,missing_sales bigint)
language sql stable security invoker set search_path='' as $$
 with sales as (
  select (d.created_at at time zone 'America/Managua')::date as day,
   case when d.payment_method='cash' then 'caja' else 'banco' end as account,
   case when count(i.id)>0 and count(c.document_item_id)=count(i.id)
    and bool_and(c.quantity=i.quantity and c.net_revenue_nio is not null and c.tax_nio is not null)
    then round(sum(c.net_revenue_nio+c.tax_nio),2) end as amount
  from public.documents d
  left join public.document_items i on i.document_id=d.id
  left join public.document_item_costs c
   on c.document_item_id=i.id and c.document_id=d.id and c.product_id=i.product_id
  where d.kind='invoice' and d.payment_method<>'pending'
   and d.created_at>=(p_from::timestamp at time zone 'America/Managua')
   and d.created_at<((p_to+1)::timestamp at time zone 'America/Managua')
  group by d.id,d.created_at,d.payment_method
 ), entries as (
  select f.occurred_on as day,f.account,f.kind,
   round(f.amount*f.exchange_rate,2) as amount,f.to_account
  from public.finance_entries f
  where f.voided_at is null and f.occurred_on between p_from and p_to
   and f.account in ('caja','banco')
 )
 select s.day,s.account,'sales'::text,coalesce(s.amount,0),0::numeric,
  case when s.amount is null then 1::bigint else 0::bigint end from sales s
 union all
 select e.day,e.account,e.kind,
  case when e.kind in ('opening','capital','loan','collection') then e.amount else 0 end,
  case when e.kind in ('withdrawal','transfer','supplier_payment') then e.amount else 0 end,0::bigint
 from entries e
 union all
 select e.day,e.to_account,'transfer'::text,e.amount,0::numeric,0::bigint
 from entries e where e.kind='transfer'
 union all
 select s.incurred_on,s.account,'purchases'::text,0::numeric,
  round(s.goods_amount*s.exchange_rate,2)+round(s.shipping_amount*s.exchange_rate,2),0::bigint
 from public.purchase_shipments s where s.incurred_on between p_from and p_to and s.account in ('caja','banco')
 union all
 select e.incurred_on,e.account,
  case when e.category in ('prestamo_acreedor','prestamo_bancario') then 'loan_payment' else 'expense' end,
  0::numeric,round(e.amount*e.exchange_rate,2),0::bigint
 from public.expense_records e where e.incurred_on between p_from and p_to and e.voided_at is null
$$;
revoke all on function private.cashflow_rows(date,date) from public,anon,authenticated;

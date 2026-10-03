-- Flujo de dinero agregado en el servidor y arqueos auditables. Las tasas son
-- las guardadas en cada operación; pendientes y crédito no mueven efectivo.
create function private.cashflow_rows(p_from date,p_to date)
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
  left join public.document_item_costs c on c.document_item_id=i.id and c.document_id=d.id
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

-- Cada cuenta necesita un saldo inicial explícito. El saldo cero se admite
-- cuando se registra como apertura; la ausencia de apertura devuelve null.
create function private.cashflow_balance(p_at date) returns jsonb
language sql stable security invoker set search_path='' as $$
 with bases as (
  select f.account,min(f.occurred_on) as start_on from public.finance_entries f
  where f.kind='opening' and f.voided_at is null and f.occurred_on<=p_at
   and f.account in ('caja','banco') group by f.account
 ), amounts as (
  select b.account,b.start_on,sum(r.inflow_nio-r.outflow_nio) as balance,
   coalesce(sum(r.missing_sales),0) as missing
  from bases b left join lateral private.cashflow_rows(b.start_on,p_at) r on r.account=b.account
  group by b.account,b.start_on
 )
 select jsonb_build_object(
  'startOn',(select min(start_on) from bases),
  'cashStartOn',(select start_on from bases where account='caja'),
  'caja',(select case when missing=0 then coalesce(balance,0) end from amounts where account='caja'),
  'banco',(select case when missing=0 then coalesce(balance,0) end from amounts where account='banco'),
  'missingSales',coalesce((select sum(missing) from amounts),0),
  'cashMissingSales',coalesce((select missing from amounts where account='caja'),0)
 )
$$;
revoke all on function private.cashflow_balance(date) from public,anon,authenticated;

create function private.finance_cashflow(p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_open jsonb; v_close jsonb; v_rows jsonb; v_totals jsonb; v_start date; v_missing bigint;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from+1>3660 then raise exception 'Selecciona un período válido de diez años o menos.'; end if;
 v_open:=private.cashflow_balance(p_from-1); v_close:=private.cashflow_balance(p_to);
 v_start:=(v_close->>'startOn')::date;
 with bases as (
  select f.account,min(f.occurred_on) as start_on from public.finance_entries f
  where f.kind='opening' and f.voided_at is null and f.occurred_on<=p_to
   and f.account in ('caja','banco') group by f.account
 ), grouped as (
  select r.day,r.account,r.category,round(sum(r.inflow_nio),2) as incoming,
   round(sum(r.outflow_nio),2) as outgoing,count(*) as operations,sum(r.missing_sales) as missing
  from private.cashflow_rows(p_from,p_to) r left join bases b on b.account=r.account
  where b.start_on is null or r.day>=b.start_on
  group by r.day,r.account,r.category
 ) select coalesce(jsonb_agg(jsonb_build_object('day',g.day,'account',g.account,'category',g.category,
  'inflowNio',g.incoming,'outflowNio',g.outgoing,'operations',g.operations,'missingSales',g.missing)
  order by g.day,g.account,g.category),'[]'::jsonb),
  jsonb_build_object('inflowNio',coalesce(sum(g.incoming) filter(where g.category not in ('opening','transfer')),0),
   'outflowNio',coalesce(sum(g.outgoing) filter(where g.category not in ('opening','transfer')),0),
   'netNio',coalesce(sum(g.incoming-g.outgoing) filter(where g.category not in ('opening','transfer')),0))
 into v_rows,v_totals from grouped g;
 with bases as (
  select f.account,min(f.occurred_on) as start_on from public.finance_entries f
  where f.kind='opening' and f.voided_at is null and f.occurred_on<=p_to
   and f.account in ('caja','banco') group by f.account
 ) select coalesce(sum(r.missing_sales),0) into v_missing
 from private.cashflow_rows(least(coalesce(v_start,p_from),p_from),p_to) r left join bases b on b.account=r.account
 where b.start_on is null or r.day>=b.start_on;
 return jsonb_build_object('available',true,'from',p_from,'to',p_to,'startOn',v_start,
  'opening',jsonb_build_object('caja',v_open->'caja','banco',v_open->'banco'),
  'closing',jsonb_build_object('caja',v_close->'caja','banco',v_close->'banco'),
  'missingSales',v_missing,'rows',v_rows,'totals',v_totals);
end $$;

create table public.cash_closings (
 id uuid primary key default gen_random_uuid(),request_id uuid not null,request_payload jsonb not null,
 closed_on date not null,counted_nio numeric(14,2) not null check(counted_nio>=0),
 counted_usd numeric(14,2) not null check(counted_usd>=0),
 exchange_rate numeric(14,6) check(exchange_rate>0),
 counted_total_nio numeric(24,2) not null check(counted_total_nio>=0),
 expected_nio numeric(24,2) not null,difference_nio numeric(24,2) not null,
 note text not null default '' check(length(note)<=1000),
 created_by uuid not null references private.business_actors(id),created_at timestamptz not null default now(),
 voided_at timestamptz,voided_by uuid references private.business_actors(id),void_reason text,
 unique(created_by,request_id),
 check(counted_usd=0 or exchange_rate is not null),
 check(difference_nio=counted_total_nio-expected_nio),
 check(difference_nio=0 or length(trim(note))>0),
 check((voided_at is null and voided_by is null and void_reason is null) or
  (voided_at is not null and voided_by is not null and length(trim(void_reason)) between 1 and 500))
);
create unique index cash_closings_active_day_idx on public.cash_closings(closed_on) where voided_at is null;
create index cash_closings_created_by_idx on public.cash_closings(created_by);
create index cash_closings_voided_by_idx on public.cash_closings(voided_by);
alter table public.cash_closings enable row level security;
revoke all on public.cash_closings from public,anon,authenticated;
grant select on public.cash_closings to authenticated;
create policy owner_accounting_read on public.cash_closings for select to authenticated
 using ((select private.staff_role())='admin');

create function private.record_cash_closing(p_input jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_request uuid; v_day date; v_existing public.cash_closings%rowtype;
 v_nio numeric; v_usd numeric; v_rate numeric; v_total numeric; v_balance jsonb; v_expected numeric; v_diff numeric; v_note text; v_id uuid;
begin
 if v_uid is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 v_request:=(p_input->>'requestId')::uuid;
 if v_request is null then raise exception 'Falta el identificador de operación.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('cash-closing:'||v_uid::text||v_request::text,0));
 select * into v_existing from public.cash_closings where created_by=v_uid and request_id=v_request;
 if found then
  if v_existing.request_payload<>p_input then raise exception 'El arqueo ya existe con otros datos.'; end if;
  return v_existing.id;
 end if;
 v_day:=(p_input->>'closedOn')::date;
 if v_day is null or v_day>(now() at time zone 'America/Managua')::date then raise exception 'Fecha de arqueo inválida.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('cash-closing-day:'||v_day::text,0));
 if exists(select 1 from public.cash_closings where closed_on=v_day and voided_at is null) then
  raise exception 'Ya existe un arqueo vigente para este día. Anúlalo con motivo antes de registrar otro.'; end if;
 v_nio:=private.accounting_number(p_input,'countedNio',1000000000);
 v_usd:=private.accounting_number(p_input,'countedUsd',1000000000);
 if p_input->'exchangeRate' is not null and p_input->'exchangeRate'<>'null'::jsonb then
  v_rate:=private.accounting_number(p_input,'exchangeRate',1000000,6);
  if v_rate<=0 then raise exception 'Indica una tasa de cambio positiva para el efectivo contado.'; end if;
 end if;
 if v_usd>0 and v_rate is null then raise exception 'Indica la tasa de cambio del efectivo contado en dólares.'; end if;
 v_total:=round(v_nio+v_usd*coalesce(v_rate,1),2);
 v_balance:=private.cashflow_balance(v_day);
 if v_balance->>'cashStartOn' is null then raise exception 'Registra primero el saldo inicial de caja para este día.'; end if;
 if (v_balance->>'cashMissingSales')::bigint>0 then raise exception 'Hay facturas de efectivo sin importe histórico completo. No se puede cerrar la caja.'; end if;
 v_expected:=(v_balance->>'caja')::numeric;
 v_diff:=v_total-v_expected;
 v_note:=trim(coalesce(p_input->>'note',''));
 if length(v_note)>1000 or (v_diff<>0 and v_note='') then raise exception 'Explica la diferencia del arqueo en una nota de hasta 1000 caracteres.'; end if;
 perform private.limit_catalog_writes();
 insert into public.cash_closings(request_id,request_payload,closed_on,counted_nio,counted_usd,exchange_rate,
  counted_total_nio,expected_nio,difference_nio,note,created_by)
 values(v_request,p_input,v_day,v_nio,v_usd,v_rate,v_total,v_expected,v_diff,v_note,v_uid) returning id into v_id;
 return v_id;
end $$;

create function private.void_cash_closing(p_id uuid,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_row public.cash_closings%rowtype;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if length(trim(coalesce(p_reason,''))) not between 1 and 500 then raise exception 'Indica el motivo de la anulación.'; end if;
 select * into v_row from public.cash_closings where id=p_id for update;
 if not found then raise exception 'Arqueo no encontrado.'; end if;
 if v_row.voided_at is not null then
  if v_row.void_reason<>trim(p_reason) then raise exception 'El arqueo ya fue anulado con otro motivo.'; end if;
  return p_id;
 end if;
 perform private.limit_catalog_writes();
 update public.cash_closings set voided_at=now(),voided_by=auth.uid(),void_reason=trim(p_reason) where id=p_id;
 return p_id;
end $$;

create function private.list_cash_closings(p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from+1>3660 then raise exception 'Selecciona un período válido de diez años o menos.'; end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',c.id,'requestId',c.request_id,'closedOn',c.closed_on,'countedNio',c.counted_nio,'countedUsd',c.counted_usd,
  'exchangeRate',c.exchange_rate,'countedTotalNio',c.counted_total_nio,'expectedNio',c.expected_nio,
  'differenceNio',c.difference_nio,'note',c.note,'createdAt',c.created_at,'voidedAt',c.voided_at,'voidReason',c.void_reason,
  'currentExpectedNio',b.value->'caja','currentMissingSales',b.value->'cashMissingSales',
  'changed',(b.value->>'caja')::numeric is distinct from c.expected_nio)
  order by c.closed_on desc,c.created_at desc),'[]'::jsonb) into v_result
 from public.cash_closings c cross join lateral (select private.cashflow_balance(c.closed_on) as value) b
 where c.closed_on between p_from and p_to;
 return v_result;
end $$;

create function public.finance_cashflow(p_from date,p_to date) returns jsonb language sql stable security invoker set search_path='' as $$select private.finance_cashflow(p_from,p_to)$$;
create function public.record_cash_closing(p_input jsonb) returns uuid language sql security invoker set search_path='' as $$select private.record_cash_closing(p_input)$$;
create function public.void_cash_closing(p_id uuid,p_reason text) returns uuid language sql security invoker set search_path='' as $$select private.void_cash_closing(p_id,p_reason)$$;
create function public.list_cash_closings(p_from date,p_to date) returns jsonb language sql stable security invoker set search_path='' as $$select private.list_cash_closings(p_from,p_to)$$;
revoke all on function private.finance_cashflow(date,date),private.record_cash_closing(jsonb),private.void_cash_closing(uuid,text),private.list_cash_closings(date,date),
 public.finance_cashflow(date,date),public.record_cash_closing(jsonb),public.void_cash_closing(uuid,text),public.list_cash_closings(date,date) from public,anon,authenticated;
grant execute on function private.finance_cashflow(date,date),private.record_cash_closing(jsonb),private.void_cash_closing(uuid,text),private.list_cash_closings(date,date),
 public.finance_cashflow(date,date),public.record_cash_closing(jsonb),public.void_cash_closing(uuid,text),public.list_cash_closings(date,date) to authenticated;

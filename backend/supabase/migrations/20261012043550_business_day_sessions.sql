-- One business day per store. Physical cash is recorded in both currencies;
-- it is not a new capital contribution or a financial opening balance.
create table public.business_days (
 day date primary key,
 opening_nio numeric(18,2) not null check(opening_nio >= 0),
 opening_usd numeric(18,2) not null check(opening_usd >= 0),
 opened_at timestamptz not null default now(),
 opened_by uuid not null references private.business_actors(id),
 opening_request uuid not null unique,
 opening_payload jsonb not null,
 closed_at timestamptz,
 closed_by uuid references private.business_actors(id),
 closing_request uuid unique,
 closing_payload jsonb,
 report jsonb,
 check ((closed_at is null) = (report is null))
);
create unique index business_days_one_open on public.business_days ((true)) where closed_at is null;
create index business_days_opened_by on public.business_days(opened_by);
create index business_days_closed_by on public.business_days(closed_by);
alter table public.business_days enable row level security;
revoke all on public.business_days from anon,authenticated;

create function private.business_day_report(p_day date) returns jsonb
language sql stable security definer set search_path='' as $$
 with sales as (
  select d.*, coalesce((select sum(i.quantity) from public.document_items i where i.document_id=d.id),0) units
  from public.documents d where d.kind='invoice' and (d.created_at at time zone 'America/Managua')::date=p_day
 ), payments as (
  select payment_method,currency,count(*) invoices,sum(total) amount,sum(units) units
  from sales group by payment_method,currency
 ), cash as (
  select currency,total amount from sales where payment_method='cash'
  union all
  select currency,case when kind in ('capital','loan','collection') then amount else -amount end
  from public.finance_entries where occurred_on=p_day and voided_at is null and account='caja' and kind<>'opening'
  union all
  select currency,amount from public.finance_entries where occurred_on=p_day and voided_at is null and kind='transfer' and to_account='caja'
  union all
  select currency,-amount from public.expense_records where incurred_on=p_day and voided_at is null and account='caja'
  union all
  select currency,-(goods_amount+shipping_amount) from public.purchase_shipments where incurred_on=p_day and account='caja'
 )
 select jsonb_build_object(
  'invoices',(select count(*) from sales), 'units',(select coalesce(sum(units),0) from sales),
  'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.description) from (select i.product_id,i.description,sum(i.quantity) units from public.document_items i join sales s on s.id=i.document_id group by i.product_id,i.description)p),'[]'::jsonb),
  'payments',coalesce((select jsonb_agg(jsonb_build_object('method',payment_method,'currency',currency,'invoices',invoices,'amount',amount,'units',units) order by payment_method,currency) from payments),'[]'::jsonb),
  'cashMovementNio',coalesce((select sum(amount) from cash where currency='NIO'),0),
  'cashMovementUsd',coalesce((select sum(amount) from cash where currency='USD'),0),
  'expectedNio',b.opening_nio+coalesce((select sum(amount) from cash where currency='NIO'),0),
  'expectedUsd',b.opening_usd+coalesce((select sum(amount) from cash where currency='USD'),0)
 ) from public.business_days b where b.day=p_day;
$$;
revoke all on function private.business_day_report(date) from public,anon,authenticated;

create function private.get_business_day(p_day date default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b public.business_days%rowtype; v_day date:=coalesce(p_day,(now() at time zone 'America/Managua')::date); v_admin boolean:=private.staff_role()='admin';
begin
 if auth.uid() is null or private.staff_role() is null then raise insufficient_privilege; end if;
 select * into b from public.business_days where day=v_day;
 return jsonb_build_object('today',(now() at time zone 'America/Managua')::date,'day',v_day,
  'status',case when b.day is null then 'not_opened' when b.closed_at is null then 'open' else 'closed' end,
  'openDay',(select day from public.business_days where closed_at is null),
  'openedAt',b.opened_at,'closedAt',b.closed_at,
  'openingNio',case when v_admin then b.opening_nio end,'openingUsd',case when v_admin then b.opening_usd end,
  'report',case when v_admin then coalesce(b.report,private.business_day_report(v_day)) end);
end $$;

create function private.open_business_day(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_day date:=(now() at time zone 'America/Managua')::date; b public.business_days%rowtype;
 v_request uuid:=(p_input->>'requestId')::uuid; v_nio numeric; v_usd numeric;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_request is null then raise exception 'Falta el identificador de apertura.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 select * into b from public.business_days where opening_request=v_request;
 if found then
  if b.opened_by<>auth.uid() or b.opening_payload<>p_input then raise exception 'La solicitud de apertura cambió.'; end if;
  return private.get_business_day(b.day);
 end if;
 if exists(select 1 from public.business_days where closed_at is null) then raise exception 'Primero cierra la jornada pendiente.'; end if;
 if exists(select 1 from public.business_days where day=v_day) then raise exception 'Esta jornada ya fue cerrada.'; end if;
 v_nio:=private.accounting_number(p_input,'openingNio',100000000,2);
 v_usd:=private.accounting_number(p_input,'openingUsd',100000000,2);
 insert into public.business_days(day,opening_nio,opening_usd,opened_by,opening_request,opening_payload)
 values(v_day,v_nio,v_usd,auth.uid(),v_request,p_input);
 return private.get_business_day(v_day);
end $$;

create function private.close_business_day(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.business_days%rowtype; v_day date:=(p_input->>'day')::date; v_report jsonb;
 v_request uuid:=(p_input->>'requestId')::uuid; v_nio numeric; v_usd numeric; v_note text:=btrim(coalesce(p_input->>'note',''));
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_request is null then raise exception 'Falta el identificador del cierre.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 select * into b from public.business_days where day=v_day for update;
 if not found then raise exception 'La jornada no está abierta.'; end if;
 if b.closed_at is not null then
  if b.closing_request=v_request and b.closing_payload=p_input and b.closed_by=auth.uid() then return private.get_business_day(v_day); end if;
  raise exception 'La jornada ya está cerrada.';
 end if;
 v_nio:=private.accounting_number(p_input,'countedNio',100000000,2);
 v_usd:=private.accounting_number(p_input,'countedUsd',100000000,2);
 v_report:=private.business_day_report(v_day);
 if length(v_note)>1000 then raise exception 'La observación admite hasta 1000 caracteres.'; end if;
 if (v_nio<>(v_report->>'expectedNio')::numeric or v_usd<>(v_report->>'expectedUsd')::numeric) and v_note='' then
  raise exception 'Indica el motivo de la diferencia de caja.';
 end if;
 update public.business_days set closed_at=now(),closed_by=auth.uid(),closing_request=v_request,closing_payload=p_input,
 report=v_report||jsonb_build_object('countedNio',v_nio,'countedUsd',v_usd,
 'differenceNio',v_nio-(v_report->>'expectedNio')::numeric,'differenceUsd',v_usd-(v_report->>'expectedUsd')::numeric,'note',v_note)
 where day=v_day;
 return private.get_business_day(v_day);
end $$;

-- Serialize mutations against closing, including a concurrent invoice. Never
-- allow changes to a frozen day through a different RPC or direct SQL API.
create function private.guard_business_day() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_day date; v_old_day date; v_row jsonb; v_old jsonb;
begin
 v_row:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 v_old:=case when tg_op='INSERT' then v_row else to_jsonb(old) end;
 if tg_table_name='documents' and v_row->>'kind'<>'invoice' and v_old->>'kind'<>'invoice' then
  if tg_op='DELETE' then return old; else return new; end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 if tg_table_name='documents' then
  v_day:=((v_row->>'created_at')::timestamptz at time zone 'America/Managua')::date;
  v_old_day:=((v_old->>'created_at')::timestamptz at time zone 'America/Managua')::date;
  if tg_op='INSERT' and not exists(select 1 from public.business_days where day=v_day and closed_at is null) then
   raise exception 'La tienda está cerrada. Un administrador debe abrir la jornada desde Inicio.';
  end if;
 else
  v_day:=coalesce((v_row->>'occurred_on')::date,(v_row->>'incurred_on')::date,((v_row->>'created_at')::timestamptz at time zone 'America/Managua')::date);
  v_old_day:=coalesce((v_old->>'occurred_on')::date,(v_old->>'incurred_on')::date,((v_old->>'created_at')::timestamptz at time zone 'America/Managua')::date);
 end if;
 if exists(select 1 from public.business_days where day in (v_day,v_old_day) and closed_at is not null) then
  raise exception 'La jornada está cerrada; sus operaciones no pueden modificarse.';
 end if;
 if tg_op='DELETE' then return old; else return new; end if;
end $$;
revoke all on function private.guard_business_day() from public,anon,authenticated;
create trigger business_day_guard before insert or update or delete on public.documents for each row execute function private.guard_business_day();
create trigger business_day_guard before insert or update or delete on public.finance_entries for each row execute function private.guard_business_day();
create trigger business_day_guard before insert or update or delete on public.expense_records for each row execute function private.guard_business_day();
create trigger business_day_guard before insert or update or delete on public.purchase_shipments for each row execute function private.guard_business_day();
create trigger business_day_guard before insert or update or delete on public.inventory_movements for each row execute function private.guard_business_day();

create function public.get_business_day(p_day date default null) returns jsonb language sql security invoker set search_path='' as $$ select private.get_business_day(p_day); $$;
create function public.open_business_day(p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.open_business_day(p_input); $$;
create function public.close_business_day(p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.close_business_day(p_input); $$;
revoke all on function private.get_business_day(date),private.open_business_day(jsonb),private.close_business_day(jsonb),public.get_business_day(date),public.open_business_day(jsonb),public.close_business_day(jsonb) from public,anon;
grant execute on function private.get_business_day(date),private.open_business_day(jsonb),private.close_business_day(jsonb),public.get_business_day(date),public.open_business_day(jsonb),public.close_business_day(jsonb) to authenticated;

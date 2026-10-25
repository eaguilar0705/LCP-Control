-- Las compras conservan su documento original. Una corrección devuelve su
-- efecto en la jornada actual y, opcionalmente, registra el reemplazo completo.
alter table public.purchase_shipments add column bank_ledger_account text references public.ledger_accounts(code);
alter table public.purchase_shipment_lines add column product_name text;
alter table public.purchase_shipment_lines add column product_sku text;
update public.purchase_shipment_lines l set product_name=p.name,product_sku=p.sku from public.products p where p.id=l.product_id;

create table private.purchase_product_revisions (
 product_id uuid primary key references public.products(id) on delete cascade, revision bigint not null default 0);
create function private.bump_purchase_product_revision() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' then
  if tg_table_name='inventory_balances' and (to_jsonb(new)->'quantity') is not distinct from (to_jsonb(old)->'quantity') then return new; end if;
  if tg_table_name='product_costs' and (to_jsonb(new)->'average_cost_nio') is not distinct from (to_jsonb(old)->'average_cost_nio') then return new; end if;
  if tg_table_name='inventory_value_balances' and (to_jsonb(new)->'quantity') is not distinct from (to_jsonb(old)->'quantity') and (to_jsonb(new)->'value_nio') is not distinct from (to_jsonb(old)->'value_nio') then return new; end if;
 end if;
 insert into private.purchase_product_revisions(product_id,revision) values(new.product_id,1)
 on conflict(product_id) do update set revision=private.purchase_product_revisions.revision+1;
 return new;
end $$;
revoke all on function private.bump_purchase_product_revision() from public,anon,authenticated;
create trigger purchase_revision after insert or update on public.inventory_balances for each row execute function private.bump_purchase_product_revision();
create trigger purchase_revision after insert or update on public.product_costs for each row execute function private.bump_purchase_product_revision();
create trigger purchase_revision after insert or update on private.inventory_value_balances for each row execute function private.bump_purchase_product_revision();
create table private.purchase_before_states (
 shipment_id uuid not null references public.purchase_shipments(id),product_id uuid not null references public.products(id),
 store_before integer not null,warehouse_before integer not null,cost_before numeric(24,6),
 value_before numeric(24,2) not null,quantity_before integer not null,revision_before bigint not null,revision_after bigint not null,
 primary key(shipment_id,product_id));
create table public.purchase_corrections (
 id uuid primary key default gen_random_uuid(),request_id uuid not null,request_payload jsonb not null,
 shipment_id uuid not null unique references public.purchase_shipments(id),replacement_id uuid references public.purchase_shipments(id),
 occurred_on date not null,reason text not null check(length(btrim(reason)) between 3 and 500),
 refunded_nio numeric(24,2) not null default 0,payment_treatment text not null check(payment_treatment in('refund','recording_error','keep_payments')),created_by uuid not null references private.business_actors(id),
 created_at timestamptz not null default now(),unique(created_by,request_id));
create table private.purchase_correction_refunds (
 id uuid primary key default gen_random_uuid(),correction_id uuid not null references public.purchase_corrections(id),
 finance_entry_id uuid references public.finance_entries(id),account text not null,currency text not null,
 exchange_rate numeric(14,6) not null,amount numeric(24,2) not null,amount_nio numeric(24,2) not null,ledger_account text not null references public.ledger_accounts(code));
create table private.purchase_payment_reallocations (
 correction_id uuid not null references public.purchase_corrections(id),finance_entry_id uuid not null references public.finance_entries(id),
 replacement_id uuid not null references public.purchase_shipments(id),amount_nio numeric(24,2) not null,
 primary key(correction_id,finance_entry_id));
create index purchase_correction_refunds_parent on private.purchase_correction_refunds(correction_id);
create index purchase_reallocations_replacement on private.purchase_payment_reallocations(replacement_id);
create index purchase_history_order on public.purchase_shipments(created_at desc,id desc);
alter table private.purchase_payment_reallocations enable row level security;
revoke all on private.purchase_payment_reallocations from public,anon,authenticated;
alter table private.purchase_product_revisions enable row level security;
alter table private.purchase_before_states enable row level security;
alter table private.purchase_correction_refunds enable row level security;
alter table public.purchase_corrections enable row level security;
revoke all on private.purchase_product_revisions,private.purchase_before_states,private.purchase_correction_refunds,public.purchase_corrections from public,anon,authenticated;
grant select on public.purchase_corrections to authenticated;
create policy purchase_correction_read on public.purchase_corrections for select to authenticated using(private.staff_role()='admin');
create trigger business_day_guard before insert or update or delete on public.purchase_corrections for each row execute function private.guard_business_day();
create trigger retired_operation before insert on public.purchase_corrections for each row execute function private.prevent_retired_operation('purchase-correction','created_by','request_id');

create function private.purchase_payments(p_id uuid) returns setof public.finance_entries
language sql stable security definer set search_path='' as $$
 select f.* from public.finance_entries f where f.shipment_id=p_id and f.voided_at is null
 union
 select f.* from public.finance_entries f join private.purchase_payment_reallocations a on a.finance_entry_id=f.id where a.replacement_id=p_id and f.voided_at is null;
$$;
revoke all on function private.purchase_payments(uuid) from public,anon,authenticated;

alter function private.record_shipment(jsonb) rename to record_shipment_before_purchase_control;
revoke all on function private.record_shipment_before_purchase_control(jsonb) from public,anon,authenticated;
create function private.record_shipment(p_input jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_old public.purchase_shipments%rowtype;v_id uuid;v_product uuid;v_total integer;v_avg numeric;v_store integer;v_warehouse integer;
 v_states jsonb:='[]';v_state jsonb;v_line record;v_value numeric;v_header numeric;v_allocated numeric:=0;v_weight numeric:=0;v_weight_total numeric;v_shipping_native numeric;v_units integer;v_index integer:=0;v_count integer;v_bank text:=nullif(p_input->>'bankLedgerAccount','');
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('shipment:'||auth.uid()::text||coalesce(p_input->>'requestId',''),0));
 select * into v_old from public.purchase_shipments where created_by=auth.uid() and request_id=(p_input->>'requestId')::uuid;
 if found then
  if v_old.request_payload<>p_input then raise exception 'La solicitud de compra cambió. Verifica el guardado original.'; end if;
  return v_old.id;
 end if;
 if not exists(select 1 from public.business_days where day=(now() at time zone 'America/Managua')::date and closed_at is null) then raise exception 'La tienda está cerrada. Abre la jornada de hoy desde Inicio para registrar la compra.'; end if;
 if coalesce(p_input->>'account','caja')='banco' then
  if v_bank is null or not exists(select 1 from public.ledger_accounts where code=v_bank and active and postable and
   ((p_input->>'currency'='NIO' and code in ('1120-001','1120-003','1120-005')) or
    (p_input->>'currency'='USD' and code in ('1120-002','1120-004','1120-006')))) then
   raise exception 'Selecciona BAC, LAFISE o Ficohsa en la moneda de la compra.';
  end if;
 elsif v_bank is not null then raise exception 'El banco pagador solo corresponde a una compra pagada por banco.';
 end if;
 if jsonb_typeof(p_input->'lines') is distinct from 'array' then raise exception 'Agrega los perfumes de la compra.'; end if;
 for v_product in select distinct (l->>'productId')::uuid from jsonb_array_elements(p_input->'lines') l order by 1 loop
  perform 1 from public.products where id=v_product and active for update;
  if not found then raise exception 'Producto no encontrado o inactivo. Actualiza el catálogo de la compra.'; end if;
  perform 1 from public.inventory_balances where product_id=v_product order by location for update;
  select max(quantity) filter(where location='store'),max(quantity) filter(where location='warehouse') into v_store,v_warehouse from public.inventory_balances where product_id=v_product;
  if v_store is null or v_warehouse is null then raise exception 'Registra primero el conteo en Tienda y Bodega del perfume de la compra.'; end if;
  v_total:=v_store+v_warehouse;
  select average_cost_nio into v_avg from public.product_costs where product_id=v_product;
  perform private.prepare_inventory_value(v_product,v_total,v_avg);
  select value_nio into v_value from private.inventory_value_balances where product_id=v_product;
  v_states:=v_states||jsonb_build_array(jsonb_build_object('product',v_product,'store',v_store,'warehouse',v_warehouse,'average',v_avg,'value',v_value,'quantity',v_total,'revision',(select revision from private.purchase_product_revisions where product_id=v_product)));
 end loop;
 v_id:=private.record_shipment_before_purchase_control(p_input);
 update public.purchase_shipments set bank_ledger_account=v_bank where id=v_id;
 update public.purchase_shipment_lines l set product_name=p.name,product_sku=p.sku from public.products p where p.id=l.product_id and l.shipment_id=v_id;
 select round(goods_amount*exchange_rate,2)+round(shipping_amount*exchange_rate,2),shipping_amount,units into v_header,v_shipping_native,v_units from public.purchase_shipments where id=v_id;
 select count(*) into v_count from public.purchase_shipment_lines where shipment_id=v_id;
 select sum(quantity*unit_price)+v_shipping_native into v_weight_total from public.purchase_shipment_lines where shipment_id=v_id;
 for v_line in select l.*,s.exchange_rate from public.purchase_shipment_lines l join public.purchase_shipments s on s.id=l.shipment_id where l.shipment_id=v_id order by l.product_id loop
  v_index:=v_index+1;
  select value into v_state from jsonb_array_elements(v_states) where value->>'product'=v_line.product_id::text;
  v_weight:=v_weight+v_line.quantity*v_line.unit_price+v_shipping_native*v_line.quantity/v_units;
  v_value:=case when v_index=v_count then v_header-v_allocated else round(v_header*v_weight/v_weight_total,2)-v_allocated end;
  if v_value<0 then raise exception 'El reparto del envío no es válido. Revisa el pedido.'; end if;
  v_allocated:=v_allocated+v_value;
  perform private.receive_inventory_value(v_line.product_id,v_line.quantity,v_value,(v_state->>'quantity')::integer,(v_state->>'average')::numeric);
  insert into private.purchase_before_states values(v_id,v_line.product_id,(v_state->>'store')::integer,(v_state->>'warehouse')::integer,(v_state->>'average')::numeric,(v_state->>'value')::numeric,(v_state->>'quantity')::integer,(v_state->>'revision')::bigint,
   (select revision from private.purchase_product_revisions where product_id=v_line.product_id));
 end loop;
 return v_id;
end $$;
revoke all on function private.record_shipment(jsonb) from public,anon;
grant execute on function private.record_shipment(jsonb) to authenticated;

create function private.purchase_correction_problem(p_id uuid) returns text
language sql stable security definer set search_path='' as $$
 select case
 when exists(select 1 from public.purchase_corrections where shipment_id=p_id) then 'Esta compra ya fue anulada. Abre su reemplazo, si existe.'
 when not exists(select 1 from private.purchase_before_states where shipment_id=p_id) then 'Esta compra es anterior al control de correcciones. Solicita una revisión contable del costo anterior; no dupliques entradas ni borres su historial.'
 when exists(select 1 from private.purchase_before_states s left join private.purchase_product_revisions r using(product_id) where s.shipment_id=p_id and s.revision_after is distinct from r.revision) then 'Hay operaciones posteriores que usan estas existencias o su costo. Esta compra no puede anularse automáticamente; solicita revisión contable y conserva su historial.'
 else null end;
$$;
revoke all on function private.purchase_correction_problem(uuid) from public,anon,authenticated;

create function private.correct_purchase(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_request uuid:=(p_input->>'requestId')::uuid;v_id uuid:=(p_input->>'shipmentId')::uuid;v_correction uuid;
 v_old public.purchase_corrections%rowtype;s public.purchase_shipments%rowtype;r record;v_reason text:=btrim(coalesce(p_input->>'reason',''));
 v_problem text;v_day date:=(now() at time zone 'America/Managua')::date;v_refund numeric:=0;v_paid numeric:=0;v_replacement uuid;v_payload jsonb;v_account text;
 v_treatment text:=coalesce(p_input->>'paymentTreatment','refund');v_opened timestamptz;v_new_total numeric;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_request is null or v_id is null then raise exception 'Falta la compra o la solicitud de corrección.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('finance-credit-ledger',0));
 select * into v_old from public.purchase_corrections where request_id=v_request and created_by=auth.uid();
 if found then
  if v_old.request_payload<>p_input then raise exception 'La solicitud de corrección cambió. Verifica el guardado original.'; end if;
  return jsonb_build_object('id',v_old.id,'replacementId',v_old.replacement_id);
 end if;
 if length(v_reason) not between 3 and 500 then raise exception 'Escribe el motivo de la corrección, entre 3 y 500 caracteres.'; end if;
 if not exists(select 1 from public.business_days where day=v_day and closed_at is null) then raise exception 'Abre la jornada de hoy desde Inicio para corregir una compra.'; end if;
 select opened_at into v_opened from public.business_days where day=v_day;
 if v_treatment not in('refund','recording_error','keep_payments') then raise exception 'Selecciona cómo se corregirán los pagos de la compra.'; end if;
 select * into s from public.purchase_shipments where id=v_id for update;
 if not found then raise exception 'La compra no existe. Actualiza el historial.'; end if;
 perform 1 from public.products where id in(select product_id from public.purchase_shipment_lines where shipment_id=v_id) order by id for update;
 v_problem:=private.purchase_correction_problem(v_id);
 if v_problem is not null then raise exception '%',v_problem; end if;
 select coalesce(sum(round(amount*exchange_rate,2)),0) into v_paid from private.purchase_payments(s.id);
 if v_treatment='keep_payments' and (s.account<>'credito' or p_input->'replacement' is null or p_input->'replacement'='null'::jsonb or (v_paid>0 and p_input->'replacement'->>'account' is distinct from 'credito')) then
  raise exception 'Para conservar los abonos, registra un reemplazo a crédito del proveedor. Después puedes pagar su saldo en Cobros y pagos.';
 end if;
 if v_treatment='recording_error' and ((s.account='caja' and (s.incurred_on<>v_day or s.created_at<v_opened)) or exists(select 1 from private.purchase_payments(s.id) f where f.account='caja' and (f.occurred_on<>v_day or f.created_at<v_opened))) then
  raise exception 'Los pagos de caja pertenecen a otra jornada. Conserva los abonos reales en el reemplazo o registra una devolución real; solicita revisión contable para un error histórico.';
 end if;
 v_refund:=case when v_treatment='keep_payments' then 0 when s.account in ('caja','banco') then round(s.goods_amount*s.exchange_rate,2)+round(s.shipping_amount*s.exchange_rate,2) else v_paid end;
 if (v_refund>0 or v_treatment='keep_payments' and v_paid>0) and (p_input->>'refundConfirmed') is distinct from 'true' then
  if v_treatment='refund' then raise exception 'Confirma la devolución real de los pagos a la misma caja o cuenta bancaria antes de anular la compra.';
  elsif v_treatment='recording_error' then raise exception 'Confirma que los pagos originales también fueron un error de registro.';
  else raise exception 'Confirma que los abonos reales se aplicarán al reemplazo sin devolver dinero.'; end if;
 end if;
 perform private.limit_catalog_writes();
 insert into public.purchase_corrections(request_id,request_payload,shipment_id,occurred_on,reason,refunded_nio,payment_treatment,created_by)
 values(v_request,p_input,s.id,v_day,v_reason,v_refund,v_treatment,auth.uid()) returning id into v_correction;
 if s.account in ('caja','banco') and v_treatment<>'keep_payments' then
  insert into private.purchase_correction_refunds(correction_id,account,currency,exchange_rate,amount,amount_nio,ledger_account)
  values(v_correction,s.account,s.currency,s.exchange_rate,s.goods_amount+s.shipping_amount,v_refund,coalesce(s.bank_ledger_account,private.money_ledger_account(s.account,s.currency)));
 elsif v_treatment<>'keep_payments' then
  insert into private.purchase_correction_refunds(correction_id,finance_entry_id,account,currency,exchange_rate,amount,amount_nio,ledger_account)
  select v_correction,id,account,currency,exchange_rate,amount,round(amount*exchange_rate,2),coalesce(bank_ledger_account,private.money_ledger_account(account,currency)) from private.purchase_payments(s.id);
 end if;
 for r in select * from private.purchase_before_states where shipment_id=s.id order by product_id loop
  update public.inventory_balances set quantity=case when location='store' then r.store_before else r.warehouse_before end,updated_at=now() where product_id=r.product_id;
  update private.inventory_value_balances set quantity=r.quantity_before,value_nio=r.value_before,updated_at=now() where product_id=r.product_id;
  -- Un costo desconocido antes de una primera compra no se sustituye por cero.
  if r.cost_before is null then delete from public.product_costs where product_id=r.product_id;
  else update public.product_costs set average_cost_nio=r.cost_before,updated_at=now() where product_id=r.product_id; end if;
  update private.purchase_product_revisions set revision=r.revision_before where product_id=r.product_id;
 end loop;
 if p_input->'replacement' is not null and p_input->'replacement'<>'null'::jsonb then
  v_payload:=(p_input->'replacement')||jsonb_build_object('requestId',gen_random_uuid(),'incurredOn',v_day);
  v_replacement:=private.record_shipment(v_payload);
  update public.purchase_corrections set replacement_id=v_replacement where id=v_correction;
  if v_treatment='keep_payments' then
   select round(goods_amount*exchange_rate,2)+round(shipping_amount*exchange_rate,2) into v_new_total from public.purchase_shipments where id=v_replacement;
   if v_paid>v_new_total then raise exception 'Los abonos superan el total corregido. Elige devolución real sólo si se reintegraron todos los pagos; para una devolución parcial solicita revisión contable del excedente.'; end if;
   insert into private.purchase_payment_reallocations(correction_id,finance_entry_id,replacement_id,amount_nio)
    select v_correction,id,v_replacement,round(amount*exchange_rate,2) from private.purchase_payments(s.id);
  end if;
 end if;
 return jsonb_build_object('id',v_correction,'replacementId',v_replacement);
end $$;
create function public.correct_purchase(p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.correct_purchase(p_input)$$;
revoke all on function private.correct_purchase(jsonb),public.correct_purchase(jsonb) from public,anon;
grant execute on function private.correct_purchase(jsonb),public.correct_purchase(jsonb) to authenticated;

-- Los pagos originales ya tienen su devolución compensatoria. No pueden
-- volver a abonarse ni anularse por fuera de la corrección auditada.
create function private.protect_corrected_purchase_payment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.shipment_id is not null and exists(select 1 from public.purchase_corrections where shipment_id=new.shipment_id) then
  raise exception 'Esta compra está anulada y sus pagos conservan su devolución. Registra el pago en la compra de reemplazo.';
 end if;
 return new;
end $$;
revoke all on function private.protect_corrected_purchase_payment() from public,anon,authenticated;
create trigger protect_corrected_purchase before insert or update on public.finance_entries for each row execute function private.protect_corrected_purchase_payment();

alter view private.operational_postings rename to operational_postings_before_purchase_corrections;
create view private.operational_postings as
 select o.day,o.source,o.source_id,
 case when o.source='purchase' and o.credit>0 and s.account='banco' then coalesce(s.bank_ledger_account,o.account) else o.account end account,o.debit,o.credit
 from private.operational_postings_before_purchase_corrections o left join public.purchase_shipments s on o.source='purchase' and s.id=o.source_id
 union all
 select c.occurred_on,'purchase_correction',c.id,case when s.account='credito' then '2111' else coalesce(s.bank_ledger_account,private.money_ledger_account(s.account,s.currency)) end,
 round(s.goods_amount*s.exchange_rate,2)+round(s.shipping_amount*s.exchange_rate,2),0::numeric
 from public.purchase_corrections c join public.purchase_shipments s on s.id=c.shipment_id
 union all
 select c.occurred_on,'purchase_correction',c.id,'1130',0::numeric,round(s.goods_amount*s.exchange_rate,2)+round(s.shipping_amount*s.exchange_rate,2)
 from public.purchase_corrections c join public.purchase_shipments s on s.id=c.shipment_id
 union all
 select c.occurred_on,'purchase_refund',c.id,r.ledger_account,r.amount_nio,0::numeric
 from private.purchase_correction_refunds r join public.purchase_corrections c on c.id=r.correction_id join public.purchase_shipments s on s.id=c.shipment_id where s.account='credito'
 union all
 select c.occurred_on,'purchase_refund',c.id,'2111',0::numeric,r.amount_nio
 from private.purchase_correction_refunds r join public.purchase_corrections c on c.id=r.correction_id join public.purchase_shipments s on s.id=c.shipment_id where s.account='credito';
revoke all on private.operational_postings,private.operational_postings_before_purchase_corrections from public,anon,authenticated;

alter function private.credit_accounts(date) rename to credit_accounts_before_purchase_corrections;
create function private.credit_accounts(p_at date) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r jsonb;
begin
 r:=private.credit_accounts_before_purchase_corrections(p_at);
 return jsonb_set(r,'{rows}',coalesce((select jsonb_agg(x||jsonb_build_object('paidNio',(x->>'paidNio')::numeric+allocated,'balanceNio',(x->>'balanceNio')::numeric-allocated) order by x->>'occurredOn',x->>'id') from jsonb_array_elements(r->'rows') x cross join lateral(select coalesce(sum(a.amount_nio),0) allocated from private.purchase_payment_reallocations a join public.purchase_corrections c on c.id=a.correction_id where a.replacement_id::text=x->>'shipmentId' and c.occurred_on<=p_at) v where not exists(select 1 from public.purchase_corrections c where c.shipment_id::text=x->>'shipmentId' and c.occurred_on<=p_at)),'[]'));
end $$;
revoke all on function private.credit_accounts_before_purchase_corrections(date),private.credit_accounts(date) from public,anon;
grant execute on function private.credit_accounts(date) to authenticated;
alter function private.cashflow_rows(date,date) rename to cashflow_rows_before_purchase_corrections;
create function private.cashflow_rows(p_from date,p_to date) returns table(day date,account text,category text,inflow_nio numeric,outflow_nio numeric,missing_sales bigint)
language sql stable security invoker set search_path='' as $$
 select * from private.cashflow_rows_before_purchase_corrections(p_from,p_to)
 union all select c.occurred_on,r.account,case when c.payment_treatment='recording_error' then 'purchase_correction' else 'purchase_refund' end,r.amount_nio,0::numeric,0::bigint from private.purchase_correction_refunds r join public.purchase_corrections c on c.id=r.correction_id where c.occurred_on between p_from and p_to;
$$;
revoke all on function private.cashflow_rows_before_purchase_corrections(date,date),private.cashflow_rows(date,date) from public,anon,authenticated;
alter function private.business_day_operational_report(date) rename to business_day_report_before_purchase_corrections;
create function private.business_day_operational_report(p_day date) returns jsonb language sql stable security definer set search_path='' as $$
 with base as(select private.business_day_report_before_purchase_corrections(p_day) r),refund as(
 select coalesce(sum(f.amount) filter(where f.currency='NIO'),0) nio,coalesce(sum(f.amount) filter(where f.currency='USD'),0) usd
 from private.purchase_correction_refunds f join public.purchase_corrections c on c.id=f.correction_id where c.occurred_on=p_day and f.account='caja' and c.created_at>=(select opened_at from public.business_days where day=p_day))
 select r||jsonb_build_object('cashMovementNio',(r->>'cashMovementNio')::numeric+nio,'cashMovementUsd',(r->>'cashMovementUsd')::numeric+usd,'expectedNio',(r->>'expectedNio')::numeric+nio,'expectedUsd',(r->>'expectedUsd')::numeric+usd) from base,refund;
$$;
revoke all on function private.business_day_report_before_purchase_corrections(date),private.business_day_operational_report(date) from public,anon,authenticated;

create function private.purchase_history(p_before timestamptz default null,p_before_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc,r.id desc),'[]') into v_result from (
 select s.*,coalesce((select jsonb_agg(to_jsonb(l) order by l.product_id) from public.purchase_shipment_lines l where l.shipment_id=s.id),'[]') lines,
 coalesce((select jsonb_agg(to_jsonb(b) order by b.product_id) from private.purchase_before_states b where b.shipment_id=s.id),'[]') before_states,
 (select to_jsonb(c)||jsonb_build_object('actor_name',a.display_name,'reallocated_nio',(select coalesce(sum(amount_nio),0) from private.purchase_payment_reallocations where correction_id=c.id)) from public.purchase_corrections c join private.business_actors a on a.id=c.created_by where c.shipment_id=s.id) correction,
 private.purchase_correction_problem(s.id) correction_problem,
 case when s.account in('caja','banco') then round(s.goods_amount*s.exchange_rate,2)+round(s.shipping_amount*s.exchange_rate,2) else (select coalesce(sum(round(f.amount*f.exchange_rate,2)),0) from private.purchase_payments(s.id) f) end refund_nio
 from public.purchase_shipments s where p_before is null or (s.created_at,s.id)<(p_before,p_before_id) order by s.created_at desc,s.id desc limit 51) r;
 return v_result;
end $$;
create function public.purchase_history(p_before timestamptz default null,p_before_id uuid default null) returns jsonb language sql security invoker set search_path='' as $$select private.purchase_history(p_before,p_before_id)$$;
revoke all on function private.purchase_history(timestamptz,uuid),public.purchase_history(timestamptz,uuid) from public,anon;
grant execute on function private.purchase_history(timestamptz,uuid),public.purchase_history(timestamptz,uuid) to authenticated;

-- Los informes incluyen la reversión en su propia fecha. No se reescribe la
-- compra original ni se la quita retroactivamente de un período cerrado.
create function private.purchase_report_events(p_from date,p_to date,p_start integer default 0,p_limit integer default 500) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 or p_start is null or p_start<0 or p_limit is null or p_limit not between 1 and 500 then raise exception 'Período o página de compras inválidos.'; end if;
 with events as (
  select s.incurred_on as day,s.id,to_jsonb(s)||jsonb_build_object('event_kind','purchase',
   'goods_nio',round(s.goods_amount*s.exchange_rate,2),'shipping_nio',round(s.shipping_amount*s.exchange_rate,2),
   'purchase_shipment_lines',(select jsonb_agg(to_jsonb(l) order by l.product_id) from public.purchase_shipment_lines l where l.shipment_id=s.id)) as event_row
  from public.purchase_shipments s where s.incurred_on between p_from and p_to
  union all
  select c.occurred_on,c.id,to_jsonb(s)||jsonb_build_object('id',c.id,'original_shipment_id',s.id,'incurred_on',c.occurred_on,'created_at',c.created_at,'event_kind','cancellation',
   'reference','Anulación: '||coalesce(nullif(s.reference,''),left(s.id::text,8)),'note',c.reason,
   'goods_amount',-s.goods_amount,'shipping_amount',-s.shipping_amount,'units',-s.units,
   'goods_nio',-round(s.goods_amount*s.exchange_rate,2),'shipping_nio',-round(s.shipping_amount*s.exchange_rate,2),
   'purchase_shipment_lines',(select jsonb_agg(to_jsonb(l)||jsonb_build_object('quantity',-l.quantity,'goods_amount',-l.goods_amount,'shipping_share',-l.shipping_share) order by l.product_id) from public.purchase_shipment_lines l where l.shipment_id=s.id),
   'refund_entries',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'request_id',c.request_id,'occurred_on',c.occurred_on,'created_at',c.created_at,
    'kind','supplier_payment','read_only',true,'compensation_kind',c.payment_treatment,'account',r.account,'to_account',null,'bank_ledger_account',f.bank_ledger_account,
    'amount',-r.amount,'amount_nio',-r.amount_nio,'currency',r.currency,'exchange_rate',r.exchange_rate,
    'counterparty',s.supplier,'description',case when c.payment_treatment='recording_error' then 'Corrección de pago registrado por error' else 'Devolución de pago por compra anulada' end,'reference',s.reference,'shipment_id',s.id,'document_id',null,'voided_at',null,'void_reason',null))
    from private.purchase_correction_refunds r join public.finance_entries f on f.id=r.finance_entry_id where r.correction_id=c.id),'[]'))
  from public.purchase_corrections c join public.purchase_shipments s on s.id=c.shipment_id where c.occurred_on between p_from and p_to
 ), page as(select event_row from events order by day,id offset p_start limit p_limit)
 select jsonb_build_object('rows',coalesce((select jsonb_agg(event_row) from page),'[]'),'count',(select count(*) from events)) into v_result;
 return v_result;
end $$;
create function public.purchase_report_events(p_from date,p_to date,p_start integer default 0,p_limit integer default 500) returns jsonb language sql security invoker set search_path='' as $$select private.purchase_report_events(p_from,p_to,p_start,p_limit)$$;
revoke all on function private.purchase_report_events(date,date,integer,integer),public.purchase_report_events(date,date,integer,integer) from public,anon;
grant execute on function private.purchase_report_events(date,date,integer,integer),public.purchase_report_events(date,date,integer,integer) to authenticated;
-- El pago real permanece una sola vez en el libro; su asignación auditada al
-- reemplazo se cuenta al validar un abono nuevo, sin simular una devolución.
do $migration$
declare s text;a text:='where shipment_id=v_shipment and voided_at is null;';
begin
 s:=pg_get_functiondef('private.record_finance_entry(jsonb)'::regprocedure);
 if position(a in s)=0 then raise exception 'No se encontró el cálculo esperado de abonos de compra.'; end if;
 s:=replace(s,a,a||chr(10)||'select v_paid+coalesce(sum(a.amount_nio),0) into v_paid from private.purchase_payment_reallocations a where a.replacement_id=v_shipment;');
 execute s;
end $migration$;
notify pgrst,'reload schema';


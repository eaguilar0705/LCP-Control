-- Crédito y abonos: cada cobro identifica su factura y cada pago su pedido.
-- Los saldos anteriores al arranque sólo existen como saldos iniciales;
-- no se reconstruyen con facturas antiguas ni se inventan asignaciones.
-- La autoría contable pertenece al actor permanente, independiente de sus
-- credenciales. El trigger remember_business_actor conserva actores nuevos;
-- el mismo patrón cubre cualquier registro anterior que aún no tenga actor.
insert into private.business_actors(id,display_name)
select u.id,coalesce(s.display_name,'Usuario') from auth.users u
left join public.staff_members s on s.user_id=u.id
where u.id in (select created_by from public.finance_entries union select voided_by from public.finance_entries)
on conflict(id) do nothing;
alter table public.finance_entries drop constraint finance_entries_created_by_fkey;
alter table public.finance_entries drop constraint finance_entries_voided_by_fkey;
alter table public.finance_entries add constraint finance_entries_created_by_fkey
 foreign key(created_by) references private.business_actors(id);
alter table public.finance_entries add constraint finance_entries_voided_by_fkey
 foreign key(voided_by) references private.business_actors(id);

alter table public.finance_entries
 add column document_id uuid references public.documents(id) on delete restrict,
 add column shipment_id uuid references public.purchase_shipments(id) on delete restrict,
 add column opening_settlement boolean not null default false,
 add constraint finance_credit_source_check check (
  (document_id is null or (kind='collection' and shipment_id is null))
  and (shipment_id is null or (kind='supplier_payment' and document_id is null))
  and (not opening_settlement or (kind in ('collection','supplier_payment') and document_id is null and shipment_id is null))
 );
create index finance_entries_document_idx on public.finance_entries(document_id) where document_id is not null;
create index finance_entries_shipment_idx on public.finance_entries(shipment_id) where shipment_id is not null;
alter table public.finance_entries drop constraint finance_entries_amount_check;
alter table public.finance_entries add constraint finance_entries_amount_check
 check(amount>0 or (amount=0 and kind='opening'));

-- Sólo una foto completa de todos los renglones de la factura permite cobrar.
create function private.credit_invoice_amount(p_id uuid) returns numeric
language sql stable security invoker set search_path='' as $$
 select case when count(i.id)>0 and count(c.document_item_id)=count(i.id)
  and bool_and(c.quantity=i.quantity and c.net_revenue_nio is not null and c.tax_nio is not null)
  then round(sum(c.net_revenue_nio+c.tax_nio),2) end
 from public.document_items i left join public.document_item_costs c
  on c.document_item_id=i.id and c.document_id=i.document_id and c.product_id=i.product_id
 where i.document_id=p_id
$$;
revoke all on function private.credit_invoice_amount(uuid) from public,anon,authenticated;

create or replace function private.record_finance_entry(p_input jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 v_uid uuid:=auth.uid(); v_request uuid; v_existing public.finance_entries%rowtype;
 v_kind text:=p_input->>'kind'; v_account text:=p_input->>'account'; v_to text:=nullif(p_input->>'toAccount','');
 v_document uuid:=nullif(p_input->>'documentId','')::uuid;
 v_shipment uuid:=nullif(p_input->>'shipmentId','')::uuid;
 v_amount numeric; v_rate numeric; v_date date; v_id uuid; v_start date;
 v_doc public.documents%rowtype; v_purchase public.purchase_shipments%rowtype;
 v_original numeric; v_paid numeric; v_nio numeric; v_source_date date;
 v_initial boolean:=false; v_party text:=trim(coalesce(p_input->>'counterparty',''));
begin
 if v_uid is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 v_request:=(p_input->>'requestId')::uuid;
 if v_request is null then raise exception 'Falta el identificador de operación.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('finance:'||v_uid::text||v_request::text,0));
 select * into v_existing from public.finance_entries where created_by=v_uid and request_id=v_request;
 if found then
  if v_existing.request_payload<>p_input then raise exception 'La operación ya existe con otros datos.'; end if;
  return v_existing.id;
 end if;
 if v_kind is null or v_kind not in ('opening','capital','withdrawal','transfer','loan','supplier_payment','collection') then
  raise exception 'Tipo de movimiento inválido.'; end if;
 if v_account is null or v_account not in ('caja','banco','cobrar','prestamos','proveedores')
  or (v_kind<>'opening' and v_account not in ('caja','banco')) then raise exception 'Cuenta inválida.'; end if;
 if (v_kind='transfer') <> (v_to is not null) or (v_to is not null and (v_to not in ('caja','banco') or v_to=v_account)) then
  raise exception 'Elige la cuenta de destino.'; end if;
 if (v_document is not null and (v_kind<>'collection' or v_shipment is not null))
  or (v_shipment is not null and v_kind<>'supplier_payment') then raise exception 'La deuda no corresponde a este movimiento.'; end if;
 v_amount:=private.accounting_number(p_input,'amount',1000000000);
 v_rate:=private.accounting_rate(p_input); v_nio:=round(v_amount*v_rate,2);
 if v_amount<=0 and v_kind<>'opening' then raise exception 'Revisa el monto.'; end if;
 if v_kind<>'opening' and v_nio<=0 then raise exception 'El abono debe ser de al menos un centavo en córdobas.'; end if;
 v_date:=(p_input->>'occurredOn')::date;
 if v_date is null or v_date>(now() at time zone 'America/Managua')::date then raise exception 'Fecha inválida.'; end if;

 -- Serializa abonos entre distintos usuarios, sus anulaciones y las aperturas.
 -- El bloqueo de la fuente también se coordina con delete_invoice.
 perform pg_advisory_xact_lock(hashtextextended('finance-credit-ledger',0));
 select min(occurred_on) into v_start from public.finance_entries where kind='opening' and voided_at is null;
 if v_kind='opening' then
  if exists(select 1 from public.finance_entries where kind='opening' and account=v_account and voided_at is null) then
   raise exception 'Esta cuenta ya tiene saldo inicial. Para corregirlo, anula el registro original.'; end if;
  if v_start is not null and v_date<>v_start then raise exception 'Los saldos iniciales deben tener la misma fecha: %.',v_start; end if;
  -- Una apertura posterior a abonos ya vinculados rompería el seguimiento.
  if exists(select 1 from public.finance_entries e
   left join public.documents d on d.id=e.document_id left join public.purchase_shipments s on s.id=e.shipment_id
   where e.voided_at is null and (e.document_id is not null or e.shipment_id is not null)
   and (e.occurred_on<v_date or coalesce((d.created_at at time zone 'America/Managua')::date,s.incurred_on)<v_date)) then
   raise exception 'La apertura debe incluir la fecha de los abonos ya registrados.'; end if;
 end if;
 if v_kind in ('collection','supplier_payment') then
  if v_start is not null and v_date<v_start then raise exception 'El abono no puede ser anterior al saldo inicial.'; end if;
  if v_document is not null then
   select * into v_doc from public.documents where id=v_document for update;
   if not found or v_doc.kind<>'invoice' or v_doc.payment_method<>'pending' then raise exception 'Elige una factura a crédito existente.'; end if;
   v_source_date:=(v_doc.created_at at time zone 'America/Managua')::date;
   v_original:=private.credit_invoice_amount(v_document);
   if v_original is null then raise exception 'La factura no tiene un importe contable completo. Revisa su registro antes de cobrar.'; end if;
   v_party:=v_doc.customer_name;
   select coalesce(sum(round(amount*exchange_rate,2)),0) into v_paid from public.finance_entries
    where document_id=v_document and voided_at is null;
  elsif v_shipment is not null then
   select * into v_purchase from public.purchase_shipments where id=v_shipment for update;
   if not found or v_purchase.account<>'credito' then raise exception 'Elige un pedido a crédito existente.'; end if;
   v_source_date:=v_purchase.incurred_on;
   v_original:=round(v_purchase.goods_amount*v_purchase.exchange_rate,2)+round(v_purchase.shipping_amount*v_purchase.exchange_rate,2);
   v_party:=v_purchase.supplier;
   select coalesce(sum(round(amount*exchange_rate,2)),0) into v_paid from public.finance_entries
    where shipment_id=v_shipment and voided_at is null;
  else
   v_initial:=true; v_source_date:=v_start;
   if v_start is null then raise exception 'Selecciona una factura o pedido; no hay saldo inicial de deuda.'; end if;
   select coalesce(sum(round(amount*exchange_rate,2)),0) into v_original from public.finance_entries
    where kind='opening' and voided_at is null and account=case v_kind when 'collection' then 'cobrar' else 'proveedores' end;
   select coalesce(sum(round(amount*exchange_rate,2)),0) into v_paid from public.finance_entries
    where kind=v_kind and document_id is null and shipment_id is null and voided_at is null and occurred_on>=v_start;
  end if;
  if v_start is not null and v_source_date<v_start then
   raise exception 'Esta deuda es anterior a la apertura. Usa el saldo inicial pendiente para evitar duplicarla.'; end if;
  if v_date<v_source_date then raise exception 'El abono no puede ser anterior a la factura o pedido.'; end if;
  if v_nio>v_original-v_paid then raise exception 'El abono supera el saldo pendiente de C$ %.',greatest(0,v_original-v_paid); end if;
 end if;
 perform private.limit_catalog_writes();
 insert into public.finance_entries(request_id,request_payload,occurred_on,kind,account,to_account,amount,currency,exchange_rate,
  counterparty,description,reference,created_by,document_id,shipment_id,opening_settlement)
 values(v_request,p_input,v_date,v_kind,v_account,v_to,v_amount,p_input->>'currency',v_rate,
  v_party,trim(coalesce(p_input->>'description','')),trim(coalesce(p_input->>'reference','')),v_uid,v_document,v_shipment,v_initial)
 returning id into v_id;
 return v_id;
end $$;

create or replace function private.void_finance_entry(p_id uuid,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_entry public.finance_entries%rowtype;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if length(trim(coalesce(p_reason,''))) not between 1 and 500 then raise exception 'Indica el motivo de la anulación.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('finance-credit-ledger',0));
 select * into v_entry from public.finance_entries where id=p_id for update;
 if not found then raise exception 'Movimiento no encontrado.'; end if;
 if v_entry.voided_at is not null then
  if v_entry.void_reason<>trim(p_reason) then raise exception 'El movimiento ya fue anulado con otro motivo.'; end if;
  return p_id;
 end if;
 if v_entry.kind='opening' and v_entry.account in ('cobrar','proveedores') and exists(
  select 1 from public.finance_entries where kind=case v_entry.account when 'cobrar' then 'collection' else 'supplier_payment' end
   and document_id is null and shipment_id is null and voided_at is null and occurred_on>=v_entry.occurred_on
 ) then raise exception 'Anula primero los abonos aplicados al saldo inicial de esta deuda.'; end if;
 perform private.limit_catalog_writes();
 update public.finance_entries set voided_at=now(),voided_by=auth.uid(),void_reason=trim(p_reason) where id=p_id;
 return p_id;
end $$;

-- Una factura que respalda un abono conserva su historia incluso si se anuló
-- el abono. El DELETE completo revierte su inventario y tampoco puede pasar.
create function private.preserve_invoice_credit_history() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.finance_entries where document_id=old.id) then
  raise exception 'Esta factura tiene abonos registrados y debe conservarse para mantener el historial contable.';
 end if;
 return old;
end $$;
revoke all on function private.preserve_invoice_credit_history() from public,anon,authenticated;
create trigger preserve_invoice_credit_history before delete on public.documents
 for each row execute function private.preserve_invoice_credit_history();

create function private.credit_accounts(p_at date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_start date; v_rows jsonb; v_initial_receivables numeric; v_initial_payables numeric;
 v_paid_receivables numeric; v_paid_payables numeric; v_legacy bigint;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_at is null then raise exception 'Fecha inválida.'; end if;
 select min(occurred_on) into v_start from public.finance_entries where kind='opening' and voided_at is null and occurred_on<=p_at;
 with sources as (
  select d.id::text as id,'receivable'::text as kind,d.customer_name as counterparty,d.number as reference,
   (d.created_at at time zone 'America/Managua')::date as occurred_on,
   private.credit_invoice_amount(d.id) as original,
   (select coalesce(sum(round(e.amount*e.exchange_rate,2)),0) from public.finance_entries e
    where e.document_id=d.id and e.voided_at is null and e.occurred_on<=p_at) as paid,
   d.id as document_id,null::uuid as shipment_id
  from public.documents d where d.kind='invoice' and d.payment_method='pending'
   and (d.created_at at time zone 'America/Managua')::date<=p_at
   and (v_start is null or (d.created_at at time zone 'America/Managua')::date>=v_start)
  union all
  select s.id::text,'payable',s.supplier,coalesce(nullif(s.reference,''),'Pedido '||left(s.id::text,8)),s.incurred_on,
   round(s.goods_amount*s.exchange_rate,2)+round(s.shipping_amount*s.exchange_rate,2),
   (select coalesce(sum(round(e.amount*e.exchange_rate,2)),0) from public.finance_entries e
    where e.shipment_id=s.id and e.voided_at is null and e.occurred_on<=p_at),null::uuid,s.id
  from public.purchase_shipments s where s.account='credito' and s.incurred_on<=p_at
   and (v_start is null or s.incurred_on>=v_start)
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'counterparty',counterparty,'reference',reference,
  'occurredOn',occurred_on,'originalNio',original,'paidNio',paid,'balanceNio',original-paid,
  'documentId',document_id,'shipmentId',shipment_id) order by occurred_on,id),'[]'::jsonb)
 into v_rows from sources;
 select coalesce(sum(round(amount*exchange_rate,2)) filter(where account='cobrar'),0),
  coalesce(sum(round(amount*exchange_rate,2)) filter(where account='proveedores'),0)
 into v_initial_receivables,v_initial_payables from public.finance_entries
 where kind='opening' and voided_at is null and occurred_on<=p_at;
 select coalesce(sum(round(amount*exchange_rate,2)) filter(where kind='collection'),0),
  coalesce(sum(round(amount*exchange_rate,2)) filter(where kind='supplier_payment'),0),
  count(*) filter(where not opening_settlement)
 into v_paid_receivables,v_paid_payables,v_legacy from public.finance_entries
 where kind in ('collection','supplier_payment') and document_id is null and shipment_id is null
  and voided_at is null and occurred_on<=p_at and (v_start is null or occurred_on>=v_start);
 if v_start is not null and v_initial_receivables>0 then
  v_rows:=v_rows||jsonb_build_array(jsonb_build_object('id','opening:receivable','kind','receivable',
   'counterparty','Saldo inicial de clientes','reference','Apertura','occurredOn',v_start,
   'originalNio',v_initial_receivables,'paidNio',v_paid_receivables,'balanceNio',v_initial_receivables-v_paid_receivables,
   'documentId',null,'shipmentId',null));
 end if;
 if v_start is not null and v_initial_payables>0 then
  v_rows:=v_rows||jsonb_build_array(jsonb_build_object('id','opening:payable','kind','payable',
   'counterparty','Saldo inicial de proveedores','reference','Apertura','occurredOn',v_start,
   'originalNio',v_initial_payables,'paidNio',v_paid_payables,'balanceNio',v_initial_payables-v_paid_payables,
   'documentId',null,'shipmentId',null));
 end if;
 return jsonb_build_object('available',true,'at',p_at,'startOn',v_start,'rows',v_rows,
  'unallocatedNio',jsonb_build_object('receivables',greatest(0,v_initial_receivables-v_paid_receivables),
   'payables',greatest(0,v_initial_payables-v_paid_payables)),'legacyPayments',v_legacy);
end $$;
create function public.credit_accounts(p_at date) returns jsonb
language sql stable security invoker set search_path='' as $$select private.credit_accounts(p_at)$$;
revoke all on function private.credit_accounts(date),public.credit_accounts(date) from public,anon,authenticated;
grant execute on function private.credit_accounts(date),public.credit_accounts(date) to authenticated;

-- No sumar parcialmente una factura con renglones sin foto contable.
create or replace function private.finance_sales(p_from date,p_to date) returns jsonb
language sql stable security definer set search_path='' as $$
 with docs as (
  select d.id,d.payment_method,private.credit_invoice_amount(d.id) as amount
  from public.documents d where d.kind='invoice'
   and d.created_at>=(p_from::timestamp at time zone 'America/Managua')
   and d.created_at<((p_to+1)::timestamp at time zone 'America/Managua')
 )
 select jsonb_build_object(
  'caja',coalesce(sum(amount) filter(where payment_method='cash'),0),
  'banco',coalesce(sum(amount) filter(where payment_method not in ('cash','pending')),0),
  'cobrar',coalesce(sum(amount) filter(where payment_method='pending'),0),
  'missing',count(*) filter(where amount is null))
 from docs where private.staff_role()='admin'
$$;

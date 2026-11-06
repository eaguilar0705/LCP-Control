-- Recibir mercadería no la vuelve vendible ni reconoce una compra contable.
-- Las unidades y el costo informados permanecen aquí hasta que Contabilidad
-- revise el pedido y elija explícitamente su caja, banco o proveedor.
create table private.inventory_receipts (
 id uuid primary key default gen_random_uuid(),
 created_at timestamptz not null default now(),
 created_by uuid not null references private.business_actors(id),
 created_by_name text not null,
 request_id uuid not null,
 request_payload jsonb not null,
 revision integer not null default 0 check(revision>=0),
 status text not null default 'pending' check(status in ('pending','posted','cancelled')),
 incurred_on date not null,
 supplier text not null,
 agency text not null,
 reference text not null,
 note text not null,
 currency text not null check(currency in ('NIO','USD')),
 exchange_rate numeric(14,6) not null check(exchange_rate>0),
 shipping_amount numeric(24,2) not null check(shipping_amount>=0),
 units integer not null check(units>0),
 reviewed_at timestamptz,
 reviewed_by uuid references private.business_actors(id),
 reviewed_by_name text,
 shipment_id uuid unique references public.purchase_shipments(id),
 cancel_reason text,
 unique(created_by,request_id),
 check((status='pending' and reviewed_at is null and reviewed_by is null and reviewed_by_name is null and shipment_id is null and cancel_reason is null)
  or (status='posted' and reviewed_at is not null and reviewed_by is not null and reviewed_by_name is not null and shipment_id is not null and cancel_reason is null)
  or (status='cancelled' and reviewed_at is not null and reviewed_by is not null and reviewed_by_name is not null and shipment_id is null and cancel_reason is not null))
);
create index inventory_receipts_page on private.inventory_receipts(status,created_at desc,id desc);
create index inventory_receipts_created_by on private.inventory_receipts(created_by);
create index inventory_receipts_reviewed_by on private.inventory_receipts(reviewed_by);
create table private.inventory_receipt_lines (
 receipt_id uuid not null references private.inventory_receipts(id),
 line_number integer not null check(line_number between 1 and 200),
 product_id uuid not null references public.products(id),
 product_name text not null,
 sku text not null,
 location text not null check(location in ('store','warehouse')),
 quantity integer not null check(quantity between 1 and 1000000),
 unit_price numeric(24,2) not null check(unit_price>=0),
 primary key(receipt_id,line_number),
 unique(receipt_id,product_id)
);
create index inventory_receipt_lines_product on private.inventory_receipt_lines(product_id);
-- Las tres operaciones guardan su solicitud original y resultado. El intento
-- de contabilización conserva, además, el costeo y la contrapartida aprobados.
create table private.inventory_receipt_operations (
 actor_id uuid not null references private.business_actors(id),
 kind text not null check(kind in ('inventory-receipt','inventory-receipt-post','inventory-receipt-cancel')),
 request_id uuid not null,
 request_payload jsonb not null,
 receipt_id uuid not null references private.inventory_receipts(id),
 result_id uuid not null,
 created_at timestamptz not null default now(),
 primary key(actor_id,kind,request_id)
);
create index inventory_receipt_operations_receipt on private.inventory_receipt_operations(receipt_id);
alter table private.inventory_receipts enable row level security;
alter table private.inventory_receipt_lines enable row level security;
alter table private.inventory_receipt_operations enable row level security;
revoke all on private.inventory_receipts,private.inventory_receipt_lines,private.inventory_receipt_operations from public,anon,authenticated;
create trigger receipt_request_retired before insert on private.inventory_receipt_operations
 for each row when(new.kind='inventory-receipt')
 execute function private.prevent_retired_operation('inventory-receipt','actor_id','request_id');
create trigger receipt_post_request_retired before insert on private.inventory_receipt_operations
 for each row when(new.kind='inventory-receipt-post')
 execute function private.prevent_retired_operation('inventory-receipt-post','actor_id','request_id');
create trigger receipt_cancel_request_retired before insert on private.inventory_receipt_operations
 for each row when(new.kind='inventory-receipt-cancel')
 execute function private.prevent_retired_operation('inventory-receipt-cancel','actor_id','request_id');

create function private.record_inventory_receipt(p_input jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_role text:=private.staff_role();v_request uuid;v_id uuid;
 v_saved private.inventory_receipt_operations%rowtype;v_line jsonb;v_product public.products%rowtype;
 v_date date;v_rate numeric;v_shipping numeric;v_quantity integer;v_unit numeric;
 v_units integer:=0;v_goods numeric:=0;v_index integer:=0;v_key text;
begin
 if v_uid is null or v_role is null or v_role not in ('admin','warehouse') then raise insufficient_privilege; end if;
 if jsonb_typeof(p_input) is distinct from 'object' then raise exception 'Revisa los datos de la recepción.'; end if;
 v_request:=(p_input->>'requestId')::uuid;
 if v_request is null then raise exception 'Falta identificar la recepción.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('inventory-receipt:inventory-receipt:'||v_uid::text||v_request::text,0));
 select * into v_saved from private.inventory_receipt_operations where actor_id=v_uid and kind='inventory-receipt' and request_id=v_request;
 if found then
  if v_saved.request_payload is distinct from p_input then raise exception 'La solicitud de recepción cambió. Verifica el guardado original.'; end if;
  return v_saved.result_id;
 end if;
 if p_input ? 'account' or p_input ? 'bankLedgerAccount' then raise exception 'La contrapartida se completa al contabilizar la recepción.'; end if;
 v_date:=(p_input->>'incurredOn')::date;
 if v_date is null or v_date>(now() at time zone 'America/Managua')::date then raise exception 'Fecha de recepción inválida.'; end if;
 v_rate:=private.accounting_rate(p_input);
 v_shipping:=private.accounting_number(p_input,'shippingAmount',1000000000,2);
 foreach v_key in array array['supplier','agency','reference','note'] loop
  if jsonb_typeof(p_input->v_key) is distinct from 'string'
   or length(p_input->>v_key)>(case when v_key='note' then 2000 else 200 end) then
   raise exception 'Revisa el texto de % de la recepción.',v_key;
  end if;
 end loop;
 if jsonb_typeof(p_input->'lines') is distinct from 'array' then raise exception 'La recepción necesita entre 1 y 200 renglones.'; end if;
 if jsonb_array_length(p_input->'lines') not between 1 and 200 then raise exception 'La recepción necesita entre 1 y 200 renglones.'; end if;
 if (select count(distinct value->>'productId') from jsonb_array_elements(p_input->'lines'))<>jsonb_array_length(p_input->'lines') then
  raise exception 'Un producto no puede repetirse en la recepción.';
 end if;
 for v_line in select value from jsonb_array_elements(p_input->'lines') loop
  if jsonb_typeof(v_line) is distinct from 'object' or (v_line->>'productId')::uuid is null then raise exception 'Renglón sin producto.'; end if;
  v_quantity:=private.accounting_number(v_line,'quantity',1000000,0);
  v_unit:=private.accounting_number(v_line,'unitPrice',1000000000,2);
  if v_quantity<=0 then raise exception 'La cantidad recibida debe ser mayor que cero.'; end if;
  if coalesce(v_line->>'location','') not in ('store','warehouse') then raise exception 'Ubicación de recepción inválida.'; end if;
  if not exists(select 1 from public.products where id=(v_line->>'productId')::uuid and active) then raise exception 'Producto no encontrado o inactivo. Actualiza el inventario.'; end if;
  v_units:=v_units+v_quantity;
  v_goods:=v_goods+v_quantity*v_unit;
 end loop;
 if v_goods+v_shipping<=0 then raise exception 'Revisa el costo informado de los perfumes y el envío.'; end if;
 perform private.limit_catalog_writes();
 insert into private.inventory_receipts(created_by,created_by_name,request_id,request_payload,incurred_on,supplier,agency,reference,note,currency,exchange_rate,shipping_amount,units)
 values(v_uid,coalesce((select display_name from private.business_actors where id=v_uid),'Personal'),v_request,p_input,
  v_date,btrim(p_input->>'supplier'),btrim(p_input->>'agency'),btrim(p_input->>'reference'),btrim(p_input->>'note'),p_input->>'currency',v_rate,v_shipping,v_units)
 returning id into v_id;
 for v_line in select value from jsonb_array_elements(p_input->'lines') loop
  v_index:=v_index+1;
  select * into strict v_product from public.products where id=(v_line->>'productId')::uuid;
  insert into private.inventory_receipt_lines values(v_id,v_index,v_product.id,v_product.name,v_product.sku,v_line->>'location',(v_line->>'quantity')::integer,(v_line->>'unitPrice')::numeric);
 end loop;
 insert into private.inventory_receipt_operations values(v_uid,'inventory-receipt',v_request,p_input,v_id,v_id,now());
 return v_id;
end $$;

create function private.inventory_receipts(p_input jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_status text:=coalesce(p_input->>'status','pending');v_limit integer:=50;
 v_before_at timestamptz;v_before_id uuid;v_result jsonb;
begin
 if auth.uid() is null or private.staff_role() is null or private.staff_role() not in ('admin','warehouse') then raise insufficient_privilege; end if;
 if jsonb_typeof(p_input) is distinct from 'object' or v_status not in ('pending','posted','cancelled','all') then raise exception 'Filtro de recepciones inválido.'; end if;
 if p_input ? 'limit' then v_limit:=private.accounting_number(p_input,'limit',100,0); end if;
 if v_limit<1 then raise exception 'El límite de recepciones debe estar entre 1 y 100.'; end if;
 if p_input ? 'before' and jsonb_typeof(p_input->'before') is distinct from 'null' then
  if jsonb_typeof(p_input->'before') is distinct from 'object' then raise exception 'La página de recepciones cambió. Actualiza la lista.'; end if;
  v_before_at:=(p_input->'before'->>'createdAt')::timestamptz;
  v_before_id:=(p_input->'before'->>'id')::uuid;
  if v_before_at is null or v_before_id is null then raise exception 'Faltan los datos de la página de recepciones.'; end if;
 end if;
 with candidates as materialized (
  select r.* from private.inventory_receipts r
  where (v_status='all' or r.status=v_status)
   and (v_before_at is null or (r.created_at,r.id)<(v_before_at,v_before_id))
  order by r.created_at desc,r.id desc limit v_limit+1
 ), page as materialized (
  select * from candidates order by created_at desc,id desc limit v_limit
 ) select jsonb_build_object('hasMore',(select count(*)>v_limit from candidates),
  'receipts',coalesce((select jsonb_agg(jsonb_build_object(
   'id',r.id,'revision',r.revision,'status',r.status,'createdAt',r.created_at,
   'createdBy',r.created_by,'createdByName',r.created_by_name,
   'reviewedAt',r.reviewed_at,'reviewedByName',r.reviewed_by_name,'shipmentId',r.shipment_id,'cancelReason',r.cancel_reason,
   'posting',(select jsonb_build_object('incurredOn',s.incurred_on,'currency',s.currency,'exchangeRate',s.exchange_rate,
    'goodsAmount',s.goods_amount,'shippingAmount',s.shipping_amount,'account',s.account,'bankLedgerAccount',s.bank_ledger_account,
    'corrected',exists(select 1 from public.purchase_corrections c where c.shipment_id=s.id))
    from public.purchase_shipments s where s.id=r.shipment_id),
   'incurredOn',r.incurred_on,'supplier',r.supplier,'agency',r.agency,'reference',r.reference,'note',r.note,
   'currency',r.currency,'exchangeRate',r.exchange_rate,'shippingAmount',r.shipping_amount,'units',r.units,
   'lines',(select jsonb_agg(jsonb_build_object('productId',l.product_id,'productName',l.product_name,'sku',l.sku,
    'location',l.location,'quantity',l.quantity,'unitPrice',l.unit_price) order by l.line_number)
    from private.inventory_receipt_lines l where l.receipt_id=r.id)
  ) order by r.created_at desc,r.id desc) from page r),'[]')) into v_result;
 return v_result;
end $$;

create function private.post_inventory_receipt(p_input jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_request uuid;v_id uuid;v_revision integer;v_shipment uuid;v_purchase jsonb;
 v_saved private.inventory_receipt_operations%rowtype;r private.inventory_receipts%rowtype;
 v_expected jsonb;v_actual jsonb;
begin
 if v_uid is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if jsonb_typeof(p_input) is distinct from 'object' then raise exception 'Revisa los datos de contabilización.'; end if;
 v_request:=(p_input->>'requestId')::uuid;v_id:=(p_input->>'receiptId')::uuid;
 if v_request is null or v_id is null then raise exception 'Falta identificar la recepción y la solicitud.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('inventory-receipt:inventory-receipt-post:'||v_uid::text||v_request::text,0));
 select * into v_saved from private.inventory_receipt_operations where actor_id=v_uid and kind='inventory-receipt-post' and request_id=v_request;
 if found then
  if v_saved.request_payload is distinct from p_input then raise exception 'La solicitud de contabilización cambió. Verifica el guardado original.'; end if;
  return v_saved.result_id;
 end if;
 select * into r from private.inventory_receipts where id=v_id for update;
 if not found then raise exception 'No se encontró la recepción. Actualiza la lista.'; end if;
 v_revision:=private.accounting_number(p_input,'expectedRevision',2147483647,0);
 if r.revision<>v_revision then raise exception 'La recepción cambió. Actualiza la lista antes de contabilizar.'; end if;
 if r.status<>'pending' then raise exception 'Solo se puede contabilizar una recepción pendiente.'; end if;
 v_purchase:=p_input->'purchase';
 if jsonb_typeof(v_purchase) is distinct from 'object' then raise exception 'Completa el costeo y la contrapartida de la compra.'; end if;
 if v_purchase ? 'requestId' then raise exception 'La compra se identifica con la solicitud de contabilización.'; end if;
 if coalesce(v_purchase->>'account','') not in ('caja','banco','credito') then raise exception 'Selecciona explícitamente Caja, Banco o Crédito del proveedor.'; end if;
 if jsonb_typeof(v_purchase->'lines') is distinct from 'array' then raise exception 'Conserva los productos, ubicaciones y cantidades recibidos.'; end if;
 -- La igualdad compara el multiconjunto completo: ordenar no permite ocultar
 -- renglones duplicados ni sustituir unidades entre productos o ubicaciones.
 select jsonb_agg(jsonb_build_array(product_id::text,location,quantity) order by product_id::text,location,quantity)
 into v_expected from private.inventory_receipt_lines where receipt_id=v_id;
 select jsonb_agg(jsonb_build_array((value->>'productId')::uuid::text,value->>'location',
  private.accounting_number(value,'quantity',1000000,0)) order by (value->>'productId')::uuid::text,value->>'location',
  private.accounting_number(value,'quantity',1000000,0)) into v_actual from jsonb_array_elements(v_purchase->'lines');
 if v_actual is distinct from v_expected then raise exception 'Conserva los productos, ubicaciones y cantidades recibidos. Para corregirlos, cancela la recepción y registra otra.'; end if;
 -- record_shipment exige la jornada actual abierta, protege fechas históricas,
 -- valida el banco y conserva el promedio, los costos y los asientos existentes.
 -- Cualquier rechazo revierte todo y deja esta recepción pendiente.
 -- Sin una operación de revisión ya guardada, un requestId de una compra
 -- previa no puede usarse para hacer pasar esa compra por esta recepción.
 if exists(select 1 from public.purchase_shipments where created_by=v_uid and request_id=v_request) then
  raise exception 'Esta compra ya corresponde a otra operación. Actualiza la recepción.';
 end if;
 v_shipment:=private.record_shipment(v_purchase||jsonb_build_object('requestId',v_request));
 update private.inventory_receipts set status='posted',revision=revision+1,reviewed_at=now(),reviewed_by=v_uid,
  reviewed_by_name=coalesce((select display_name from private.business_actors where id=v_uid),'Administración'),shipment_id=v_shipment where id=v_id;
 insert into private.inventory_receipt_operations values(v_uid,'inventory-receipt-post',v_request,p_input,v_id,v_shipment,now());
 return v_shipment;
end $$;

create function private.cancel_inventory_receipt(p_input jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_role text:=private.staff_role();v_request uuid;v_id uuid;v_revision integer;v_reason text;
 v_saved private.inventory_receipt_operations%rowtype;r private.inventory_receipts%rowtype;
begin
 if v_uid is null or v_role is null or v_role not in ('admin','warehouse') then raise insufficient_privilege; end if;
 if jsonb_typeof(p_input) is distinct from 'object' then raise exception 'Revisa los datos de cancelación.'; end if;
 v_request:=(p_input->>'requestId')::uuid;v_id:=(p_input->>'receiptId')::uuid;
 if v_request is null or v_id is null then raise exception 'Falta identificar la recepción y la solicitud.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('inventory-receipt:inventory-receipt-cancel:'||v_uid::text||v_request::text,0));
 select * into v_saved from private.inventory_receipt_operations where actor_id=v_uid and kind='inventory-receipt-cancel' and request_id=v_request;
 if found then
  if v_saved.request_payload is distinct from p_input then raise exception 'La solicitud de cancelación cambió. Verifica el guardado original.'; end if;
  return v_saved.result_id;
 end if;
 select * into r from private.inventory_receipts where id=v_id for update;
 if not found then raise exception 'No se encontró la recepción. Actualiza la lista.'; end if;
 if v_role='warehouse' and r.created_by<>v_uid then raise insufficient_privilege; end if;
 v_revision:=private.accounting_number(p_input,'expectedRevision',2147483647,0);
 if r.revision<>v_revision then raise exception 'La recepción cambió. Actualiza la lista antes de cancelar.'; end if;
 if r.status<>'pending' then raise exception 'Solo se puede cancelar una recepción pendiente.'; end if;
 v_reason:=btrim(p_input->>'reason');
 if jsonb_typeof(p_input->'reason') is distinct from 'string' or length(coalesce(v_reason,'')) not between 3 and 500 then raise exception 'Escribe el motivo de cancelación, entre 3 y 500 caracteres.'; end if;
 perform private.limit_catalog_writes();
 update private.inventory_receipts set status='cancelled',revision=revision+1,reviewed_at=now(),reviewed_by=v_uid,
  reviewed_by_name=coalesce((select display_name from private.business_actors where id=v_uid),'Personal'),cancel_reason=v_reason where id=v_id;
 insert into private.inventory_receipt_operations values(v_uid,'inventory-receipt-cancel',v_request,p_input,v_id,v_id,now());
 return v_id;
end $$;

create function public.record_inventory_receipt(p_input jsonb) returns uuid
language sql security definer set search_path='' as $$select private.record_inventory_receipt(p_input);$$;
create function public.inventory_receipts(p_input jsonb default '{}') returns jsonb
language sql stable security definer set search_path='' as $$select private.inventory_receipts(p_input);$$;
create function public.post_inventory_receipt(p_input jsonb) returns uuid
language sql security definer set search_path='' as $$select private.post_inventory_receipt(p_input);$$;
create function public.cancel_inventory_receipt(p_input jsonb) returns uuid
language sql security definer set search_path='' as $$select private.cancel_inventory_receipt(p_input);$$;
revoke all on function private.record_inventory_receipt(jsonb),private.inventory_receipts(jsonb),private.post_inventory_receipt(jsonb),private.cancel_inventory_receipt(jsonb) from public,anon,authenticated;
revoke all on function public.record_inventory_receipt(jsonb),public.inventory_receipts(jsonb),public.post_inventory_receipt(jsonb),public.cancel_inventory_receipt(jsonb) from public,anon;
grant execute on function public.record_inventory_receipt(jsonb),public.inventory_receipts(jsonb),public.post_inventory_receipt(jsonb),public.cancel_inventory_receipt(jsonb) to authenticated;

-- Conservar sin cambios todos los tipos de recuperación previos. La consulta
-- y el retiro usan los mismos bloqueos que sus nuevos escritores.
alter function private.operation_confirmation(text,uuid,boolean) rename to operation_confirmation_before_inventory_receipts;
revoke all on function private.operation_confirmation_before_inventory_receipts(text,uuid,boolean) from public,anon,authenticated;
create function private.operation_confirmation(p_kind text,p_request_id uuid,p_retire boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_role text:=private.staff_role();v_saved private.inventory_receipt_operations%rowtype;
begin
 if p_kind is null or p_kind not in ('inventory-receipt','inventory-receipt-post','inventory-receipt-cancel') then
  return private.operation_confirmation_before_inventory_receipts(p_kind,p_request_id,p_retire);
 end if;
 if v_uid is null or v_role is null or (v_role<>'admin' and not(v_role='warehouse' and p_kind in ('inventory-receipt','inventory-receipt-cancel'))) then raise insufficient_privilege; end if;
 if p_request_id is null then raise exception 'Falta el identificador de la solicitud.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('inventory-receipt:'||p_kind||':'||v_uid::text||p_request_id::text,0));
 select * into v_saved from private.inventory_receipt_operations where actor_id=v_uid and kind=p_kind and request_id=p_request_id;
 if found then return jsonb_build_object('status','confirmed','id',v_saved.result_id); end if;
 if p_retire then
  perform private.limit_catalog_writes();
  insert into private.retired_operations(actor_id,kind,request_id) values(v_uid,p_kind,p_request_id) on conflict do nothing;
 end if;
 if exists(select 1 from private.retired_operations where actor_id=v_uid and kind=p_kind and request_id=p_request_id) then return jsonb_build_object('status','retired'); end if;
 return jsonb_build_object('status','missing');
end $$;
revoke all on function private.operation_confirmation(text,uuid,boolean) from public,anon,authenticated;
notify pgrst,'reload schema';

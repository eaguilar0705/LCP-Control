-- Per-user limits on the two write RPCs. Every write reaches the database through
-- create_document or record_inventory_movement, and both require a signed-in staff
-- account, so the limit keys on the verified auth.uid() instead of a client IP
-- header that can be forged or shared behind the store's router. anon cannot call
-- either function, and Supabase Auth already limits sign-in attempts per IP.
create table private.rate_limits (
 user_id uuid not null references auth.users(id) on delete cascade,
 action text not null, window_start timestamptz not null, hits integer not null check(hits>0),
 primary key(user_id,action)
);
alter table private.rate_limits enable row level security;
revoke all on private.rate_limits from public, anon, authenticated;

-- Fixed windows, one row per user and rule. Going over a rule answers HTTP 429 with
-- Retry-After through PostgREST. The error rolls the whole request back, so a
-- blocked call writes nothing; calls that fail validation roll back as well and do
-- not use up the allowance. An action without rules fails closed.
create function private.enforce_rate_limit(p_action text) returns void language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_limit integer; v_seconds integer; v_window timestamptz; v_hits integer; v_retry integer;
begin
 if v_uid is null then raise exception 'Acceso no autorizado.'; end if;
 for v_limit,v_seconds in
  select r.max_hits,r.seconds from (values('create_document',20,60),('create_document',300,3600),('record_inventory_movement',60,60),('record_inventory_movement',1000,3600)) r(action,max_hits,seconds)
  where r.action=p_action order by r.seconds
 loop
  v_window:=to_timestamp(floor(extract(epoch from now())/v_seconds)*v_seconds);
  insert into private.rate_limits as l (user_id,action,window_start,hits) values(v_uid,p_action||':'||v_seconds,v_window,1)
  on conflict(user_id,action) do update set hits=case when l.window_start=excluded.window_start then l.hits+1 else 1 end,window_start=excluded.window_start
  returning hits into v_hits;
  if v_hits>v_limit then
   v_retry:=greatest(1,ceil(extract(epoch from v_window+make_interval(secs=>v_seconds)-now()))::integer);
   raise sqlstate 'PGRST' using
    message=json_build_object('code','LCP429','message',format('Demasiadas operaciones seguidas. Espera %s segundos e inténtalo de nuevo.',v_retry))::text,
    detail=json_build_object('status',429,'headers',json_build_object('Retry-After',v_retry::text))::text;
  end if;
 end loop;
 if not found then raise exception 'Operación sin límite configurado.'; end if;
end $$;
revoke all on function private.enforce_rate_limit(text) from public, anon, authenticated;

-- Both RPCs check the limit right after their idempotent replay, so retrying a
-- request that already succeeded returns the stored result and never answers 429.
-- The bodies are unchanged otherwise.
create or replace function private.create_document(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_role text:=private.staff_role(); v_uid uuid:=auth.uid(); v_kind text:=p_payload->>'kind';
 v_currency text:=p_payload->>'currency'; v_tier text:=p_payload->>'tier'; v_location text:=p_payload->>'location';
 v_request uuid:=(p_payload->>'requestId')::uuid; v_customer public.customers%rowtype;
 v_doc public.documents%rowtype; v_product public.products%rowtype; v_line jsonb; v_items jsonb:='[]';
 v_qty integer; v_price numeric; v_total numeric:=0; v_before integer; v_counter bigint; v_valid date; v_issuer jsonb;
begin
 if v_uid is null or v_role is null then raise exception 'Acceso no autorizado.'; end if;
 if v_request is null then raise exception 'Falta el identificador de la operación.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_uid::text||v_request::text,0));
 select * into v_doc from public.documents where created_by=v_uid and request_id=v_request;
 if found then
  if v_doc.request_payload<>p_payload then raise exception 'La operación ya existe con otros datos.'; end if;
  return private.document_json(v_doc.id);
 end if;
 perform private.enforce_rate_limit('create_document');
 if v_kind is null or v_kind not in ('invoice','proforma') or v_currency is null or v_currency not in ('NIO','USD')
  or v_tier is null or v_tier not in ('emprendedor','vip','premium') then raise exception 'Tipo, moneda o lista de precios inválidos.'; end if;
 if jsonb_typeof(p_payload->'items') is distinct from 'array' then raise exception 'Agrega productos al documento.'; end if;
 if jsonb_array_length(p_payload->'items') not between 1 and 100 then raise exception 'El documento requiere entre 1 y 100 productos.'; end if;
 if (select count(distinct x->>'productId') from jsonb_array_elements(p_payload->'items') x)<>jsonb_array_length(p_payload->'items') then raise exception 'No repitas productos en el documento.'; end if;
 if length(coalesce(p_payload->>'notes',''))>2000 then raise exception 'La nota es demasiado larga.'; end if;
 if v_kind='invoice' and (v_location is null or v_location not in ('store','warehouse') or coalesce(p_payload->>'paymentMethod','') not in ('pending','cash','card_pos','bank_transfer')) then raise exception 'Selecciona ubicación y forma de pago.'; end if;
 if v_kind='proforma' then
  v_valid:=(p_payload->>'validUntil')::date;
  if v_valid is null or v_valid<(now() at time zone 'America/Managua')::date then raise exception 'Revisa la vigencia de la proforma.'; end if;
 end if;
 if nullif(p_payload->>'customerId','') is not null then
  select * into v_customer from public.customers where id=(p_payload->>'customerId')::uuid for update;
  if not found then raise exception 'Cliente no encontrado.'; end if;
 else
  if length(trim(coalesce(p_payload->>'customerName',''))) not between 1 and 160 then raise exception 'Ingresa el nombre del cliente.'; end if;
  if nullif(p_payload->>'customerPhone','') is not null then
   select * into v_customer from public.customers where phone=p_payload->>'customerPhone' for update;
  end if;
  if v_customer.id is null then
   if v_role<>'admin' and v_tier<>'emprendedor' then raise exception 'Un dueño debe asignar la lista del cliente.'; end if;
   insert into public.customers(name,phone,price_tier) values(trim(p_payload->>'customerName'),nullif(p_payload->>'customerPhone',''),v_tier) returning * into v_customer;
  end if;
 end if;
 if v_role<>'admin' and v_tier<>v_customer.price_tier then raise exception 'Usa la lista asignada al cliente por un dueño.'; end if;
 if v_role='admin' then update public.customers set price_tier=v_tier where id=v_customer.id; end if;
 select to_jsonb(b)-'id' into v_issuer from public.business_settings b where id;
 if v_issuer is null then raise exception 'Configura los datos del negocio.'; end if;
 -- Consistent row lock ordering prevents overselling and partial stock deductions.
 for v_line in select x from jsonb_array_elements(p_payload->'items') x order by x->>'productId' loop
  if jsonb_typeof(v_line->'quantity') is distinct from 'number' or (v_line->>'quantity')::numeric<>trunc((v_line->>'quantity')::numeric) then raise exception 'La cantidad debe ser entera.'; end if;
  v_qty:=(v_line->>'quantity')::integer;
  if v_qty not between 1 and 10000 then raise exception 'Cantidad fuera de rango.'; end if;
  select * into v_product from public.products where id=(v_line->>'productId')::uuid and active for update;
  if not found then raise exception 'Producto no disponible.'; end if;
  select amount into v_price from public.product_prices where product_id=v_product.id and tier_code=v_tier and currency=v_currency for share;
  if not found then raise exception 'No hay precio para la lista y moneda seleccionadas.'; end if;
  if v_kind='invoice' then
   select quantity into v_before from public.inventory_balances where product_id=v_product.id and location=v_location for update;
   if not found or v_before is null then raise exception 'Registra primero el conteo de inventario de %.',v_product.name; end if;
   if v_before<v_qty then raise exception 'Existencias insuficientes para %.',v_product.name; end if;
  end if;
  v_total:=v_total+v_qty*v_price;
  v_items:=v_items||jsonb_build_array(jsonb_build_object('product_id',v_product.id,'description',
   (select name from public.brands where id=v_product.brand_id)||' · '||v_product.name||case when v_product.size is null then '' else ' · '||trim(trailing '.' from trim(trailing '0' from v_product.size::text))||' '||v_product.unit end,
   'quantity',v_qty,'unit_price',v_price));
 end loop;
 update private.document_counters set last_value=last_value+1 where kind=v_kind returning last_value into v_counter;
 insert into public.documents(kind,number,request_id,request_payload,customer_id,customer_name,customer_phone,issuer,tier_code,currency,total,location,valid_until,payment_method,notes,created_by)
 values(v_kind,(case when v_kind='invoice' then 'FAC-' else 'PRO-' end)||lpad(v_counter::text,6,'0'),v_request,p_payload,v_customer.id,v_customer.name,v_customer.phone,v_issuer,v_tier,v_currency,v_total,
  case when v_kind='invoice' then v_location end,v_valid,case when v_kind='invoice' then p_payload->>'paymentMethod' end,coalesce(p_payload->>'notes',''),v_uid) returning * into v_doc;
 for v_line in select x from jsonb_array_elements(v_items) x loop
  insert into public.document_items(document_id,product_id,description,quantity,unit_price) values(v_doc.id,(v_line->>'product_id')::uuid,v_line->>'description',(v_line->>'quantity')::int,(v_line->>'unit_price')::numeric);
  if v_kind='invoice' then
   select quantity into v_before from public.inventory_balances where product_id=(v_line->>'product_id')::uuid and location=v_location;
   update public.inventory_balances set quantity=quantity-(v_line->>'quantity')::int,updated_at=now() where product_id=(v_line->>'product_id')::uuid and location=v_location;
   insert into public.inventory_movements(product_id,location,type,quantity,before_quantity,after_quantity,document_id,actor_id,note)
    values((v_line->>'product_id')::uuid,v_location,'SALE',(v_line->>'quantity')::int,v_before,v_before-(v_line->>'quantity')::int,v_doc.id,v_uid,v_doc.number);
  end if;
 end loop;
 return private.document_json(v_doc.id);
end $$;

create or replace function private.record_inventory_movement(p_payload jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_role text:=private.staff_role(); v_uid uuid:=auth.uid(); v_id uuid; v_existing public.inventory_movements%rowtype;
 v_product uuid:=(p_payload->>'productId')::uuid; v_location text:=p_payload->>'location'; v_type text:=p_payload->>'type';
 v_qty integer; v_before integer; v_after integer; v_request uuid:=(p_payload->>'requestId')::uuid;
begin
 if v_uid is null or v_role is null then raise exception 'Acceso no autorizado.'; end if;
 if v_request is null then raise exception 'Falta el identificador de operación.'; end if;
 if v_type is null or v_type not in ('ENTRY','EXIT','DAMAGED','ADJUSTMENT') then raise exception 'Movimiento inválido.'; end if;
 if v_role<>'admin' and v_type in ('ENTRY','ADJUSTMENT') then raise exception 'Solo un dueño puede registrar entradas y ajustes.'; end if;
 if jsonb_typeof(p_payload->'quantity') is distinct from 'number' or (p_payload->>'quantity')::numeric<>trunc((p_payload->>'quantity')::numeric) then raise exception 'La cantidad debe ser entera.'; end if;
 v_qty:=(p_payload->>'quantity')::integer;
 if v_qty<0 or v_qty>1000000 or (v_type<>'ADJUSTMENT' and v_qty=0) then raise exception 'Cantidad inválida.'; end if;
 if length(trim(coalesce(p_payload->>'note',''))) not between 1 and 2000 then raise exception 'Indica el motivo del movimiento.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_uid::text||v_request::text,0));
 select * into v_existing from public.inventory_movements where actor_id=v_uid and request_id=v_request;
 if found then
  if v_existing.product_id<>v_product or v_existing.location<>v_location or v_existing.type<>v_type or v_existing.quantity<>v_qty or v_existing.note<>p_payload->>'note' or v_existing.reference is distinct from nullif(p_payload->>'reference','') then raise exception 'La operación ya existe con otros datos.'; end if;
  return v_existing.id;
 end if;
 perform private.enforce_rate_limit('record_inventory_movement');
 perform 1 from public.products where id=v_product and active for update;
 if not found then raise exception 'Producto no encontrado.'; end if;
 select quantity into v_before from public.inventory_balances where product_id=v_product and location=v_location for update;
 if not found then raise exception 'Ubicación no encontrada.'; end if;
 if v_before is null and v_type<>'ADJUSTMENT' then raise exception 'Registra primero un conteo inicial mediante Ajuste.'; end if;
 v_after:=case when v_type='ADJUSTMENT' then v_qty when v_type='ENTRY' then v_before+v_qty else v_before-v_qty end;
 if v_after<0 then raise exception 'El movimiento dejaría inventario negativo.'; end if;
 update public.inventory_balances set quantity=v_after,updated_at=now() where product_id=v_product and location=v_location;
 insert into public.inventory_movements(request_id,product_id,location,type,quantity,before_quantity,after_quantity,actor_id,reference,note)
 values(v_request,v_product,v_location,v_type,v_qty,v_before,v_after,v_uid,nullif(p_payload->>'reference',''),p_payload->>'note') returning id into v_id;
 return v_id;
end $$;

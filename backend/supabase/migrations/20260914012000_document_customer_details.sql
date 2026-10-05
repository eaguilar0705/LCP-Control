-- Preserve new customer tax IDs and invalidate stale customer edits when a sale changes the assigned tier.
create or replace function private.create_document(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_role text:=private.staff_role(); v_uid uuid:=auth.uid(); v_kind text:=p_payload->>'kind';
 v_currency text:=p_payload->>'currency'; v_tier text:=p_payload->>'tier'; v_location text:=p_payload->>'location';
 v_request uuid:=(p_payload->>'requestId')::uuid; v_customer public.customers%rowtype;
 v_doc public.documents%rowtype; v_product public.products%rowtype; v_line jsonb; v_items jsonb:='[]';
 v_qty integer; v_price numeric; v_total numeric:=0; v_before integer; v_counter bigint; v_valid date; v_issuer jsonb;
begin
 if v_uid is null or v_role is null or v_role not in ('admin','operator') then raise insufficient_privilege; end if;
 if length(coalesce(p_payload->>'customerTaxId',''))>80 then raise exception 'RUC demasiado largo.'; end if;
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
  if not found or not v_customer.active then raise exception 'Cliente no encontrado o inactivo.'; end if;
 else
  if length(trim(coalesce(p_payload->>'customerName',''))) not between 1 and 160 then raise exception 'Ingresa el nombre del cliente.'; end if;
  if nullif(p_payload->>'customerPhone','') is not null then
   select * into v_customer from public.customers where phone=p_payload->>'customerPhone' for update;
  end if;
  if v_customer.id is null then
   if v_role<>'admin' and v_tier<>'emprendedor' then raise exception 'Un dueño debe asignar la lista del cliente.'; end if;
   insert into public.customers(name,phone,price_tier,tax_id) values(trim(p_payload->>'customerName'),nullif(p_payload->>'customerPhone',''),v_tier,coalesce(p_payload->>'customerTaxId','')) returning * into v_customer;
  end if;
 end if;
 if not v_customer.active then raise exception 'Cliente inactivo.'; end if;
 if v_role<>'admin' and v_tier<>v_customer.price_tier then raise exception 'Usa la lista asignada al cliente por un dueño.'; end if;
 if v_role='admin' then update public.customers set price_tier=v_tier,revision=revision+1 where id=v_customer.id and price_tier is distinct from v_tier; end if;
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
 insert into public.documents(kind,number,request_id,request_payload,customer_id,customer_name,customer_phone,customer_tax_id,issuer,tier_code,currency,total,location,valid_until,payment_method,notes,created_by)
 values(v_kind,(case when v_kind='invoice' then 'FAC-' else 'PRO-' end)||lpad(v_counter::text,6,'0'),v_request,p_payload,v_customer.id,v_customer.name,v_customer.phone,coalesce(nullif(p_payload->>'customerTaxId',''),v_customer.tax_id),v_issuer,v_tier,v_currency,v_total,
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

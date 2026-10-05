-- El precio que decide el dueño es el de dólares: se compra en dólares y los
-- 780 precios del catálogo cumplían exactamente córdobas = dólares × 37, con el
-- dólar en números redondos y el córdoba con la cola que saliera. Es decir, la
-- conversión ya existía, pero congelada dentro de las filas: cambiar la tasa en
-- Negocio no movía ningún precio y el catálogo se quedaba en la tasa del día en
-- que se importó hasta que alguien lo reimportara a mano.
--
-- A partir de aquí el precio en córdobas se deriva del precio en dólares con la
-- tasa vigente. Las filas en córdobas siguen existiendo —las leen la
-- facturación, los márgenes y los reportes sin enterarse— pero ya nadie las
-- teclea: las escribe `reprice_catalog` cada vez que cambia la tasa.

-- La tasa a la que se importó el catálogo. Sembrarla deja el sistema consistente
-- desde el primer minuto: al repreciar con ella, los 780 precios dan exactamente
-- lo que ya estaba guardado y nadie ve un cambio de precio ese día.
insert into public.exchange_rates(id,usd_to_nio) values(true,37)
on conflict(id) do nothing;

-- La tasa con la que se calcularon los precios del documento. Es distinta de
-- `exchange_rate`, que es la conversión contable: una factura en córdobas
-- convierte a 1 para la contabilidad y aun así necesita saber a qué tasa se
-- cotizó, para poder imprimir el equivalente en dólares.
alter table public.documents
 add column catalog_rate numeric(14,6) check(catalog_rate is null or catalog_rate>0);

create function private.reprice_catalog(p_rate numeric) returns integer
language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
 if p_rate is null or p_rate<=0 then raise exception 'Tipo de cambio inválido para repreciar.'; end if;
 -- Dos decimales, que es lo que admite un precio, y nunca cero: un perfume de
 -- un dólar a cualquier tasa sensata pasa de cero, pero el piso lo garantiza.
 update public.product_prices nio
 set amount=greatest(round(usd.amount*p_rate,2),0.01)
 from public.product_prices usd
 where usd.product_id=nio.product_id and usd.tier_code=nio.tier_code
   and usd.currency='USD' and nio.currency='NIO'
   and nio.amount is distinct from greatest(round(usd.amount*p_rate,2),0.01);
 get diagnostics v_count=row_count;
 return v_count;
end $$;
revoke all on function private.reprice_catalog(numeric) from public,anon,authenticated;

-- Cambiar la tasa es ahora cambiar la lista de precios en córdobas. Se hace en
-- la misma transacción: no existe un instante en que la tasa diga una cosa y los
-- precios otra.
create or replace function public.set_exchange_rate(p_rate numeric) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_rate is null or p_rate<=0 or p_rate>1000000 or p_rate<>round(p_rate,6) then
  raise exception 'Indica un tipo de cambio válido en córdobas por dólar.';
 end if;
 perform private.limit_catalog_writes();
 insert into public.exchange_rates(id,usd_to_nio,updated_by) values(true,p_rate,auth.uid())
 on conflict(id) do update set usd_to_nio=excluded.usd_to_nio,updated_at=now(),updated_by=excluded.updated_by;
 perform private.reprice_catalog(p_rate);
end $$;

-- El formulario del perfume manda los tres precios en dólares; los de córdobas
-- salen de la tasa vigente. Si llegaran precios en córdobas en el payload se
-- ignoran: dejar que alguien los fije a mano rompería la conversión al primer
-- cambio de tasa.
create or replace function public.save_catalog_product(p_payload jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 v_id uuid:=(p_payload->>'id')::uuid; v_old public.products%rowtype; v_new public.products%rowtype;
 v_brand uuid; v_tier text; v_usd numeric; v_nio numeric; v_rate numeric; v_image text:=nullif(p_payload->>'imagePath','');
 v_size numeric:=(p_payload->>'size')::numeric; v_min numeric:=(p_payload->>'minimumStock')::numeric;
 v_before jsonb; v_sku text; v_prices jsonb:='{}';
begin
 if (select private.staff_role()) is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_id is null then raise exception 'Falta el identificador del producto.'; end if;
 select usd_to_nio into v_rate from public.exchange_rates where id;
 if v_rate is null then raise exception 'Registra el tipo de cambio del dólar en Negocio antes de guardar precios.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog:'||v_id::text,0));
 select * into v_old from public.products where id=v_id for update;
 if found and v_old.revision is distinct from (p_payload->>'revision')::integer then
  raise exception 'Otro usuario cambió este perfume. Vuelve a abrirlo antes de guardar.';
 end if;
 if v_old.id is null and coalesce((p_payload->>'revision')::integer,0)<>0 then raise exception 'Producto no encontrado.'; end if;
 perform private.limit_catalog_writes();
 if length(trim(coalesce(p_payload->>'name',''))) not between 1 and 200
 or length(trim(coalesce(p_payload->>'brand',''))) not between 1 and 100 then raise exception 'Revisa el nombre y la marca.'; end if;
 if coalesce(p_payload->>'category','') not in ('arabian','designer','niche','unspecified')
 or coalesce(p_payload->>'gender','') not in ('male','female','unisex','unspecified')
 or coalesce(p_payload->>'unit','') not in ('oz','ml') then raise exception 'Revisa categoría, género y unidad.'; end if;
 if v_size is not null and (v_size<=0 or v_size>99999) then raise exception 'Tamaño inválido.'; end if;
 if v_min is null or v_min<>trunc(v_min) or v_min not between 0 and 1000000 then raise exception 'Mínimo de inventario inválido.'; end if;
 if nullif(p_payload->>'manufacturerBarcode','') is not null and (p_payload->>'manufacturerBarcode') !~ '^[0-9]{8}$|^[0-9]{12,14}$' then raise exception 'El código del fabricante requiere 8, 12, 13 o 14 dígitos.'; end if;
 if jsonb_typeof(p_payload->'active') is distinct from 'boolean' then raise exception 'Estado inválido.'; end if;
 if not (p_payload->>'active')::boolean and exists(select 1 from public.inventory_balances where product_id=v_id and quantity>0) then raise exception 'Registra la salida de las existencias antes de desactivar el perfume.'; end if;
 if v_image is not null and not exists(select 1 from storage.objects where bucket_id='product-images' and name=v_image) then raise exception 'La imagen todavía no está guardada. Vuelve a subirla.'; end if;
 if v_image is not null and v_image is distinct from v_old.image_path and split_part(v_image,'/',1)<>auth.uid()::text then raise exception 'Selecciona una imagen subida desde tu cuenta.'; end if;
 select to_jsonb(v_old)||jsonb_build_object('prices',(select jsonb_agg(to_jsonb(pp)) from public.product_prices pp where product_id=v_id)) into v_before;
 insert into public.brands(name) values(trim(p_payload->>'brand')) on conflict(name) do update set name=excluded.name returning id into v_brand;
 if v_old.id is null then
  v_sku:=nextval('private.product_sku_sequence')::text;
  v_sku:='LCP-'||lpad(v_sku,greatest(4,length(v_sku)),'0');
 else v_sku:=v_old.sku; end if;
 insert into public.products(id,sku,name,brand_id,size,unit,category,gender,barcode,minimum_stock,active,image_path)
 values(v_id,v_sku,trim(p_payload->>'name'),v_brand,v_size,p_payload->>'unit',nullif(p_payload->>'category','unspecified'),nullif(p_payload->>'gender','unspecified'),nullif(p_payload->>'manufacturerBarcode',''),v_min::int,(p_payload->>'active')::boolean,v_image)
 on conflict(id) do update set name=excluded.name,brand_id=excluded.brand_id,size=excluded.size,unit=excluded.unit,
 category=excluded.category,gender=excluded.gender,barcode=excluded.barcode,minimum_stock=excluded.minimum_stock,
 active=excluded.active,image_path=excluded.image_path,
 image_reference=case when products.image_path is not null and excluded.image_path is null then null else products.image_reference end,
 revision=products.revision+1,size_needs_review=excluded.size is null
 returning * into v_new;
 foreach v_tier in array array['emprendedor','vip','premium'] loop
  if jsonb_typeof(p_payload->'prices'->v_tier->'USD') is distinct from 'number' then raise exception 'Escribe el precio en dólares de las tres listas.'; end if;
  v_usd:=(p_payload->'prices'->v_tier->>'USD')::numeric;
  if v_usd<=0 or v_usd>10000000 or v_usd<>round(v_usd,2) then raise exception 'Los precios en dólares deben ser positivos y tener hasta dos decimales.'; end if;
  v_nio:=greatest(round(v_usd*v_rate,2),0.01);
  insert into public.product_prices(product_id,tier_code,currency,amount) values(v_id,v_tier,'USD',v_usd),(v_id,v_tier,'NIO',v_nio)
  on conflict(product_id,tier_code,currency) do update set amount=excluded.amount;
  v_prices:=v_prices||jsonb_build_object(v_tier,jsonb_build_object('USD',v_usd,'NIO',v_nio));
 end loop;
 insert into public.inventory_balances(product_id,location,quantity) values(v_id,'warehouse',null),(v_id,'store',null) on conflict do nothing;
 insert into private.catalog_changes(product_id,actor_id,action,before_data,after_data) values(v_id,auth.uid(),'save',v_before,to_jsonb(v_new)||jsonb_build_object('prices',v_prices,'catalogRate',v_rate));
 return v_id;
exception when unique_violation then raise exception 'Ese código ya pertenece a otro producto.';
end $$;

-- Cada documento guarda la tasa con la que se cotizó, para que el equivalente
-- impreso siga siendo el de su día aunque el dólar se mueva mañana.
create or replace function private.create_document(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_role text:=private.staff_role(); v_uid uuid:=auth.uid(); v_kind text:=p_payload->>'kind';
 v_currency text:=p_payload->>'currency'; v_tier text:=p_payload->>'tier'; v_location text:=p_payload->>'location';
 v_request uuid:=(p_payload->>'requestId')::uuid; v_customer public.customers%rowtype;
 v_doc public.documents%rowtype; v_product public.products%rowtype; v_line jsonb; v_items jsonb:='[]';
 v_qty integer; v_price numeric; v_total numeric:=0; v_before integer; v_counter bigint; v_valid date; v_issuer jsonb;
 v_catalog_rate numeric;
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
 select usd_to_nio into v_catalog_rate from public.exchange_rates where id;
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
 insert into public.documents(kind,number,request_id,request_payload,customer_id,customer_name,customer_phone,customer_tax_id,issuer,tier_code,currency,total,location,valid_until,payment_method,notes,catalog_rate,created_by)
 values(v_kind,(case when v_kind='invoice' then 'FAC-' else 'PRO-' end)||lpad(v_counter::text,6,'0'),v_request,p_payload,v_customer.id,v_customer.name,v_customer.phone,coalesce(nullif(p_payload->>'customerTaxId',''),v_customer.tax_id),v_issuer,v_tier,v_currency,v_total,
  case when v_kind='invoice' then v_location end,v_valid,case when v_kind='invoice' then p_payload->>'paymentMethod' end,coalesce(p_payload->>'notes',''),v_catalog_rate,v_uid) returning * into v_doc;
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

-- Deja el catálogo en la tasa sembrada. En este proyecto no mueve ni un precio:
-- los 780 ya cumplían córdobas = dólares × 37 exactamente.
select private.reprice_catalog((select usd_to_nio from public.exchange_rates where id));

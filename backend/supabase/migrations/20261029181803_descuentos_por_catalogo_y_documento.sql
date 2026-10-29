-- Una oferta pertenece a una ficha y a una sola lista. El visitante recibe
-- únicamente el precio público del catálogo que abrió.
create table private.storefront_offers (
 draft_id uuid not null references public.storefront_drafts(id) on delete cascade,
 tier_code text not null references public.price_tiers(code),
 final_price numeric(14,2) check(final_price>0 and final_price=ceil(final_price)),
 revision integer not null default 1,
 updated_by uuid not null references private.business_actors(id),
 updated_at timestamptz not null default now(), primary key(draft_id,tier_code)
);
alter table private.storefront_offers enable row level security;
revoke all on private.storefront_offers from public,anon,authenticated;
create function private.storefront_offers() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 return (select coalesce(jsonb_agg(to_jsonb(o)),'[]') from private.storefront_offers o);
end $$;
revoke all on function private.storefront_offers() from public,anon;
grant execute on function private.storefront_offers() to authenticated;
create function private.save_storefront_offer(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d public.storefront_drafts%rowtype; o private.storefront_offers%rowtype;
 v_tier text:=p_payload->>'tier'; v_base numeric; v_price numeric;
 v_revision integer:=private.accounting_number(p_payload,'revision',1000000000,0);
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 select * into d from public.storefront_drafts where id=(p_payload->>'draftId')::uuid for update;
 if not found then raise exception 'La ficha ya no está disponible.'; end if;
 if not exists(select 1 from private.storefront_catalog_links where tier_code=v_tier and enabled) then raise exception 'Selecciona un catálogo.'; end if;
 select * into o from private.storefront_offers where draft_id=d.id and tier_code=v_tier for update;
 if coalesce(o.revision,0)<>v_revision then raise exception 'La oferta cambió en otra sesión. Recarga y vuelve a revisarla.'; end if;
 if p_payload->'finalPrice' is distinct from 'null'::jsonb and p_payload ? 'finalPrice' then
  v_price:=private.accounting_number(p_payload,'finalPrice',10000000,0);
  select ceil(amount) into v_base from public.product_prices where product_id=d.source_product_id and tier_code=v_tier and currency='USD' for share;
  if d.source_product_id is null and not d.source_missing and v_tier='menudeo' then v_base:=ceil((d.content->>'price')::numeric); end if;
  if v_base is null or v_base<=0 then raise exception 'Agrega primero el precio de este catálogo.'; end if;
  if v_base is distinct from private.accounting_number(p_payload,'expectedBase',10000000,0) then raise exception 'El precio cambió. Recarga y revisa la oferta.'; end if;
  if v_price<=0 or v_price>=v_base then raise exception 'El precio de oferta debe ser un entero mayor que cero y menor al precio publicado.'; end if;
 end if;
 insert into private.storefront_offers(draft_id,tier_code,final_price,updated_by)
 values(d.id,v_tier,v_price,auth.uid()) on conflict(draft_id,tier_code) do update
 set final_price=excluded.final_price,revision=storefront_offers.revision+1,updated_by=auth.uid(),updated_at=now()
 returning * into o;
 return to_jsonb(o);
end $$;
revoke all on function private.save_storefront_offer(jsonb) from public,anon;
grant execute on function private.save_storefront_offer(jsonb) to authenticated;

create or replace function private.read_storefront_catalog(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_tier text; v_name text; v_products jsonb;
begin
 select l.tier_code,t.name into v_tier,v_name from private.storefront_catalog_links l
 join public.price_tiers t on t.code=l.tier_code
 where l.enabled and ((p_token is null and l.tier_code='menudeo') or l.token=p_token);
 if not found then raise exception 'Este catálogo no está disponible.' using errcode='22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'published_at',p.published_at,
  'content',(p.content-'originalPrice'-'discountPercent')||jsonb_build_object('price',
    case when o.final_price<base.amount then o.final_price else base.amount end)
    ||case when o.final_price<base.amount then jsonb_build_object('originalPrice',base.amount,
      'discountPercent',round(100*(base.amount-o.final_price)/base.amount,2)) else '{}'::jsonb end)
  order by p.id),'[]') into v_products
 from public.storefront_publications p join public.storefront_drafts d on d.id=p.id
 left join public.product_prices pr on pr.product_id=d.source_product_id and pr.tier_code=v_tier and pr.currency='USD'
 cross join lateral(select ceil(coalesce(pr.amount,case when d.source_product_id is null and not d.source_missing and v_tier='menudeo' then (p.content->>'price')::numeric else 0 end)) amount) base
 left join private.storefront_offers o on o.draft_id=d.id and o.tier_code=v_tier
 where p.visible;
 return jsonb_build_object('name',v_name,'products',v_products);
end $$;

-- Los descuentos se congelan junto con la venta; nunca se recalcula un
-- documento emitido al cambiar la lista o retirar una oferta de la web.
alter table public.documents add column original_total numeric(14,2),
 add column discount_amount numeric(14,2) not null default 0 check(discount_amount>=0),
 add column invoice_discount numeric(14,2) not null default 0 check(invoice_discount>=0);
alter table public.document_items add column original_unit_price numeric(14,2),
 add column invoice_discount numeric(14,2) not null default 0
 check(invoice_discount>=0 and invoice_discount<quantity*unit_price);
alter table public.document_items alter column line_total set expression as (quantity*unit_price-invoice_discount);

CREATE OR REPLACE FUNCTION private.create_document(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_role text:=private.staff_role(); v_uid uuid:=auth.uid(); v_kind text:=p_payload->>'kind';
 v_currency text:=p_payload->>'currency'; v_tier text:=p_payload->>'tier'; v_location text:=p_payload->>'location';
 v_request uuid:=(p_payload->>'requestId')::uuid; v_customer public.customers%rowtype;
 v_doc public.documents%rowtype; v_product public.products%rowtype; v_line jsonb; v_items jsonb:='[]';
 v_qty integer; v_price numeric; v_total numeric:=0; v_before integer; v_counter bigint; v_valid date; v_issuer jsonb;
 v_catalog_rate numeric; v_original numeric:=0; v_original_price numeric; v_discount numeric:=0; v_weight numeric:=0; v_allocated numeric:=0; v_share numeric; v_discounted_items jsonb:='[]';
begin
 if v_uid is null or v_role is null or v_role not in ('admin','operator') or (v_role='operator' and v_kind is distinct from 'invoice') then raise insufficient_privilege; end if;
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
  or v_tier is null or not exists(select 1 from public.price_tiers where code=v_tier) then raise exception 'Tipo, moneda o lista de precios inválidos.'; end if;
 if jsonb_typeof(p_payload->'items') is distinct from 'array' then raise exception 'Agrega productos al documento.'; end if;
 if jsonb_array_length(p_payload->'items') not between 1 and 100 then raise exception 'El documento requiere entre 1 y 100 productos.'; end if;
 if (select count(distinct x->>'productId') from jsonb_array_elements(p_payload->'items') x)<>jsonb_array_length(p_payload->'items') then raise exception 'No repitas productos en el documento.'; end if;
 if length(coalesce(p_payload->>'notes',''))>2000 then raise exception 'La nota es demasiado larga.'; end if;
 if v_kind='invoice' and (v_location is null or v_location not in ('store','warehouse') or coalesce(p_payload->>'paymentMethod','') not in ('pending','cash','card_pos','bank_transfer','bac_nio','bac_usd','lafise_nio','lafise_usd','ficohsa_nio','ficohsa_usd')) then raise exception 'Selecciona ubicación y forma de pago.'; end if;
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
  v_original_price:=v_price;
  v_original:=v_original+v_qty*v_price;
  if v_line ? 'finalUnitPrice' then
   v_price:=private.accounting_number(v_line,'finalUnitPrice',10000000,2);
   if v_price<=0 or v_price>v_original_price then raise exception 'El precio con descuento debe ser mayor que cero y no superar el precio de lista.'; end if;
  end if;
  v_total:=v_total+v_qty*v_price;
  v_items:=v_items||jsonb_build_array(jsonb_build_object('product_id',v_product.id,'description',
   (select name from public.brands where id=v_product.brand_id)||' · '||v_product.name||case when v_product.size is null then '' else ' · '||trim(trailing '.' from trim(trailing '0' from v_product.size::text))||' '||v_product.unit end,
   'quantity',v_qty,'unit_price',v_price,'original_unit_price',v_original_price));
 end loop;
 if p_payload ? 'invoiceDiscount' then v_discount:=private.accounting_number(p_payload,'invoiceDiscount',100000000000000,2); end if;
 if v_discount<0 or v_discount>=v_total then raise exception 'El descuento total debe ser menor al importe de los productos.'; end if;
 for v_line in select value from jsonb_array_elements(v_items) loop
  v_weight:=v_weight+(v_line->>'quantity')::integer*(v_line->>'unit_price')::numeric;
  v_share:=round(v_discount*v_weight/v_total,2)-v_allocated;
  v_allocated:=v_allocated+v_share;
  if v_share>=(v_line->>'quantity')::integer*(v_line->>'unit_price')::numeric then raise exception 'El descuento deja un producto sin importe. Reduce el descuento total.'; end if;
  v_discounted_items:=v_discounted_items||jsonb_build_array(v_line||jsonb_build_object('invoice_discount',v_share));
 end loop;
 v_items:=v_discounted_items;
 v_total:=v_total-v_discount;
 update private.document_counters set last_value=last_value+1 where kind=v_kind returning last_value into v_counter;
 insert into public.documents(kind,number,request_id,request_payload,customer_id,customer_name,customer_phone,customer_tax_id,issuer,tier_code,currency,total,location,valid_until,payment_method,notes,catalog_rate,created_by,original_total,discount_amount,invoice_discount)
 values(v_kind,(case when v_kind='invoice' then 'FAC-' else 'PRO-' end)||lpad(v_counter::text,6,'0'),v_request,p_payload,v_customer.id,v_customer.name,v_customer.phone,coalesce(nullif(p_payload->>'customerTaxId',''),v_customer.tax_id),v_issuer,v_tier,v_currency,v_total,
  case when v_kind='invoice' then v_location end,v_valid,case when v_kind='invoice' then p_payload->>'paymentMethod' end,coalesce(p_payload->>'notes',''),v_catalog_rate,v_uid,v_original,v_original-v_total,v_discount) returning * into v_doc;
 for v_line in select x from jsonb_array_elements(v_items) x loop
  insert into public.document_items(document_id,product_id,description,quantity,unit_price,original_unit_price,invoice_discount) values(v_doc.id,(v_line->>'product_id')::uuid,v_line->>'description',(v_line->>'quantity')::int,(v_line->>'unit_price')::numeric,(v_line->>'original_unit_price')::numeric,(v_line->>'invoice_discount')::numeric);
  if v_kind='invoice' then
   select quantity into v_before from public.inventory_balances where product_id=(v_line->>'product_id')::uuid and location=v_location;
   update public.inventory_balances set quantity=quantity-(v_line->>'quantity')::int,updated_at=now() where product_id=(v_line->>'product_id')::uuid and location=v_location;
   insert into public.inventory_movements(product_id,location,type,quantity,before_quantity,after_quantity,document_id,actor_id,note)
    values((v_line->>'product_id')::uuid,v_location,'SALE',(v_line->>'quantity')::int,v_before,v_before-(v_line->>'quantity')::int,v_doc.id,v_uid,v_doc.number);
  end if;
 end loop;
 return private.document_json(v_doc.id);
end $function$

;

-- La contabilidad y las devoluciones parten del importe neto congelado.
do $net$
declare definition text;
begin
 definition:=pg_get_functiondef('private.snapshot_sale_cost()'::regprocedure);
 definition:=replace(definition,'new.quantity*new.unit_price*v_rate','new.line_total*v_rate');
 execute definition;
 definition:=pg_get_functiondef('private.record_sales_return(jsonb)'::regprocedure);
 definition:=replace(definition,'round((v_returned+v_quantity)*i.unit_price,2)-round(v_returned*i.unit_price,2)',
 'round((v_returned+v_quantity)*i.line_total/i.quantity,2)-round(v_returned*i.line_total/i.quantity,2)');
 execute definition;
 definition:=pg_get_functiondef('private.invoice_return_detail(uuid)'::regprocedure);
 definition:=replace(definition,'''unitPrice'',i.unit_price','''unitPrice'',i.unit_price,''lineTotal'',i.line_total');
 execute definition;
end $net$;

-- Solo las operaciones nuevas usan cinco decimales de cálculo. Los valores
-- históricos del inventario y los costos ya congelados se conservan íntegros.
do $precision$
declare signature text; definition text;
begin
 foreach signature in array array[
 'private.record_shipment_before_purchase_control(jsonb)',
 'private.set_opening_cost(jsonb)',
 'private.receive_inventory_value(uuid,integer,numeric,integer,numeric)'
 ] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  definition:=regexp_replace(definition,',\s*6\)',',5)','g');
  definition:=replace(definition,'''unitPrice'',1000000000,5','''unitPrice'',1000000000,2');
  definition:=replace(definition,'''unitCost'',1000000000,5','''unitCost'',1000000000,2');
  execute definition;
 end loop;
end $precision$;

create function public.storefront_offers() returns jsonb language sql stable security invoker set search_path=''
begin atomic
 select private.storefront_offers();
end;
create function public.save_storefront_offer(p_payload jsonb) returns jsonb language sql security invoker set search_path=''
begin atomic
 select private.save_storefront_offer(p_payload);
end;
revoke all on function public.storefront_offers(),public.save_storefront_offer(jsonb) from public,anon;
grant execute on function public.storefront_offers(),public.save_storefront_offer(jsonb) to authenticated;

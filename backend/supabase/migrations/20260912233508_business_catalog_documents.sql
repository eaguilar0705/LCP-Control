-- Single-business workspace: RLS reads and transactional, authorized RPC writes.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
create table public.staff_members (
 user_id uuid primary key references auth.users(id) on delete cascade,
 display_name text not null, role text not null check(role in ('admin','operator')),
 active boolean not null default true
);
create function private.staff_role() returns text language sql stable security definer set search_path='' as $$
 select role from public.staff_members where user_id=(select auth.uid()) and active and auth.uid() is not null
$$;
revoke all on function private.staff_role() from public, anon;
grant execute on function private.staff_role() to authenticated;
create table public.business_settings (
 id boolean primary key default true check(id), name text not null, address text not null default '', phone text not null default ''
);
create table public.brands (id uuid primary key default gen_random_uuid(), name text not null unique check(length(trim(name))>0));
create table public.price_tiers (
 code text primary key check(code in ('emprendedor','vip','premium')), name text not null, sort_order integer not null
);
insert into public.price_tiers values ('emprendedor','Emprendedor',1),('vip','VIP',2),('premium','Premium',3);
create table public.products (
 id uuid primary key default gen_random_uuid(), import_key text unique, sku text not null unique, barcode text unique,
 name text not null check(length(trim(name))>0), brand_id uuid not null references public.brands(id),
 size numeric(8,3) check(size>0), unit text not null default 'oz' check(unit in ('oz','ml')), size_source text,
 size_needs_review boolean not null default false,
 category text check(category in ('arabian','designer')), gender text check(gender in ('male','female','unisex')),
 catalog_availability text check(catalog_availability in ('sold_out','unspecified')), image_reference text,
 minimum_stock integer not null default 0 check(minimum_stock>=0), active boolean not null default true,
 created_at timestamptz not null default now()
);
create index products_brand_idx on public.products(brand_id);
create table public.product_prices (
 product_id uuid not null references public.products(id), tier_code text not null references public.price_tiers(code),
 currency text not null check(currency in ('NIO','USD')), amount numeric(14,2) not null check(amount>0),
 primary key(product_id,tier_code,currency)
);
create index product_prices_tier_idx on public.product_prices(tier_code);
create table public.inventory_balances (
 product_id uuid not null references public.products(id), location text not null check(location in ('warehouse','store')),
 quantity integer check(quantity>=0), -- NULL means never counted; not zero.
 updated_at timestamptz not null default now(), primary key(product_id,location)
);
create table public.customers (
 id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name)) between 1 and 160),
 phone text unique check(phone ~ '^[1-9][0-9]{7,14}$'),
 price_tier text not null default 'emprendedor' references public.price_tiers(code), created_at timestamptz not null default now()
);
create index customers_tier_idx on public.customers(price_tier);
create table private.document_counters (kind text primary key check(kind in ('invoice','proforma')), last_value bigint not null default 0);
insert into private.document_counters(kind) values ('invoice'),('proforma');
create table public.documents (
 id uuid primary key default gen_random_uuid(), kind text not null check(kind in ('invoice','proforma')), number text not null unique,
 request_id uuid not null, request_payload jsonb not null, customer_id uuid not null references public.customers(id),
 customer_name text not null, customer_phone text, issuer jsonb not null, tier_code text not null references public.price_tiers(code),
 currency text not null check(currency in ('NIO','USD')), total numeric(14,2) not null check(total>0),
 status text not null default 'issued' check(status='issued'), location text check(location in ('warehouse','store')), valid_until date,
 payment_method text check(payment_method in ('pending','cash','card_pos','bank_transfer')), notes text not null default '',
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), unique(created_by,request_id),
 check((kind='invoice' and location is not null and valid_until is null and payment_method is not null)
   or (kind='proforma' and location is null and payment_method is null and valid_until is not null)),
 check((kind='invoice' and number like 'FAC-%') or (kind='proforma' and number like 'PRO-%'))
);
create index documents_customer_idx on public.documents(customer_id);
create index documents_tier_idx on public.documents(tier_code);
create index documents_kind_date_idx on public.documents(kind,created_at desc);
create table public.document_items (
 id uuid primary key default gen_random_uuid(), document_id uuid not null references public.documents(id),
 product_id uuid not null references public.products(id), description text not null, quantity integer not null check(quantity between 1 and 10000),
 unit_price numeric(14,2) not null check(unit_price>0), line_total numeric(14,2) generated always as (quantity*unit_price) stored,
 unique(document_id,product_id)
);
create index document_items_product_idx on public.document_items(product_id);
create table public.inventory_movements (
 id uuid primary key default gen_random_uuid(), request_id uuid, product_id uuid not null references public.products(id),
 location text not null check(location in ('warehouse','store')), type text not null check(type in ('ENTRY','EXIT','DAMAGED','ADJUSTMENT','SALE')),
 quantity integer not null check(quantity>=0), before_quantity integer check(before_quantity>=0), after_quantity integer not null check(after_quantity>=0),
 document_id uuid references public.documents(id), actor_id uuid not null references auth.users(id), reference text, note text not null,
 created_at timestamptz not null default now(), unique(actor_id,request_id)
);
create index movements_product_date_idx on public.inventory_movements(product_id,created_at desc);
create index movements_document_idx on public.inventory_movements(document_id);
create table private.import_sources (
 id uuid primary key default gen_random_uuid(), filename text not null, sha256 text not null unique, sheet_name text not null,
 imported_at timestamptz not null default now(), row_count integer not null
);
create table private.import_rows (
 source_id uuid not null references private.import_sources(id), row_number integer not null,
 product_id uuid not null references public.products(id), raw_values jsonb not null, primary key(source_id,row_number)
);
create index import_rows_product_idx on private.import_rows(product_id);
do $$ declare t text; begin
 foreach t in array array['staff_members','business_settings','brands','price_tiers','products','product_prices','inventory_balances','customers','documents','document_items','inventory_movements'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  if t<>'staff_members' then execute format('create policy staff_read on public.%I for select to authenticated using ((select private.staff_role()) in (''admin'',''operator''))',t); end if;
 end loop;
end $$;
alter table private.import_sources enable row level security;
alter table private.import_rows enable row level security;
alter table private.document_counters enable row level security;
revoke all on all tables in schema private from anon, authenticated;
create policy self_profile on public.staff_members for select to authenticated using(user_id=(select auth.uid()));
create function private.document_json(p_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$
 select (to_jsonb(d)-'request_payload')||jsonb_build_object('items',
 (select jsonb_agg(to_jsonb(i) order by i.description) from public.document_items i where i.document_id=d.id))
 from public.documents d where d.id=p_id
$$;
revoke all on function private.document_json(uuid) from public, anon;
grant execute on function private.document_json(uuid) to authenticated;
create function private.create_document(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
revoke all on function private.create_document(jsonb) from public, anon;
grant execute on function private.create_document(jsonb) to authenticated;
create function public.create_document(p_payload jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.create_document(p_payload) $$;
revoke all on function public.create_document(jsonb) from public, anon;
grant execute on function public.create_document(jsonb) to authenticated;

create function private.record_inventory_movement(p_payload jsonb) returns uuid language plpgsql security definer set search_path='' as $$
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
revoke all on function private.record_inventory_movement(jsonb) from public, anon;
grant execute on function private.record_inventory_movement(jsonb) to authenticated;
create function public.record_inventory_movement(p_payload jsonb) returns uuid language sql security invoker set search_path='' as $$ select private.record_inventory_movement(p_payload) $$;
revoke all on function public.record_inventory_movement(jsonb) from public, anon;
grant execute on function public.record_inventory_movement(jsonb) to authenticated;

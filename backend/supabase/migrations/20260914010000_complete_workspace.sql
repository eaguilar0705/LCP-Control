-- Persistent business records and explicitly provisioned staff accounts.
alter table public.staff_members drop constraint staff_members_role_check;
alter table public.staff_members add constraint staff_members_role_check check(role in ('superadmin','admin','operator','warehouse','viewer'));
create or replace function private.staff_role() returns text language sql stable security definer set search_path='' as $$
 select case when role='superadmin' then 'admin' else role end from public.staff_members where user_id=(select auth.uid()) and active
$$;
create function private.is_superadmin() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.staff_members where user_id=auth.uid() and active and role='superadmin')
$$;
revoke all on function private.is_superadmin() from public,anon,authenticated;

create table private.pending_staff (
 email text primary key check(email=lower(trim(email)) and length(email) between 3 and 254),
 display_name text not null check(length(trim(display_name)) between 1 and 100),
 role text not null check(role in ('superadmin','admin','operator','warehouse','viewer')),
 active boolean not null default true, created_at timestamptz not null default now()
);
alter table private.pending_staff enable row level security;
revoke all on private.pending_staff from public,anon,authenticated;
create function private.provision_staff() returns trigger language plpgsql security definer set search_path='' as $$
declare v_staff private.pending_staff%rowtype;
begin
 select * into v_staff from private.pending_staff where email=lower(new.email) and active for update;
 if not found then raise exception 'Cuenta no autorizada. Solicita acceso al administrador.'; end if;
 insert into public.staff_members(user_id,display_name,role,active) values(new.id,v_staff.display_name,v_staff.role,true);
 delete from private.pending_staff where email=v_staff.email;
 return new;
end $$;
revoke all on function private.provision_staff() from public,anon,authenticated;
create trigger provision_lcp_staff after insert on auth.users for each row execute function private.provision_staff();

create function public.list_staff_accounts() returns table(email text,display_name text,role text,active boolean,registered boolean)
language plpgsql security definer set search_path='' as $$
begin
 if private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 return query select u.email::text,s.display_name,s.role,s.active,true from public.staff_members s join auth.users u on u.id=s.user_id
 union all select p.email,p.display_name,p.role,p.active,false from private.pending_staff p;
end $$;
create function public.save_staff_account(p_email text,p_name text,p_role text,p_active boolean) returns void
language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_old text; v_email text:=lower(trim(p_email));
begin
 if private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-administration',0));
 perform private.limit_catalog_writes();
 if p_active is null or p_role is null or p_role not in ('superadmin','admin','operator','warehouse','viewer') or length(trim(coalesce(p_name,''))) not between 1 and 100 or v_email is null or v_email !~ '^[^@ ]+@[^@ ]+\.[^@ ]+$' or length(v_email)>254 then raise exception 'Revisa los datos de la cuenta.'; end if;
 select u.id,s.role into v_id,v_old from auth.users u left join public.staff_members s on s.user_id=u.id where lower(u.email)=v_email;
 if v_id is null then select role into v_old from private.pending_staff where email=v_email; end if;
 if (p_role='superadmin' or v_old='superadmin') and not private.is_superadmin() then raise insufficient_privilege; end if;
 if v_id=auth.uid() and (not p_active or p_role is distinct from v_old) then raise exception 'No puedes quitarte tus propios permisos.'; end if;
 if v_old='superadmin' and (not p_active or p_role<>'superadmin') and not exists(select 1 from public.staff_members where role='superadmin' and active and user_id<>v_id) then raise exception 'Debe quedar un SuperAdmin activo.'; end if;
 if v_id is null then
 insert into private.pending_staff(email,display_name,role,active) values(v_email,trim(p_name),p_role,p_active) on conflict(email) do update set display_name=excluded.display_name,role=excluded.role,active=excluded.active;
 else
 insert into public.staff_members(user_id,display_name,role,active) values(v_id,trim(p_name),p_role,p_active) on conflict(user_id) do update set display_name=excluded.display_name,role=excluded.role,active=excluded.active;
 end if;
end $$;

-- Read-only and warehouse staff can see the catalogue and balances, but do not
-- inherit sales or customer access from the UI.
do $$ declare t text; begin
 foreach t in array array['business_settings','brands','price_tiers','products','product_prices','inventory_balances'] loop
 execute format('drop policy staff_read on public.%I',t);
 execute format('create policy staff_read on public.%I for select to authenticated using ((select private.staff_role()) is not null)',t);
 end loop;
end $$;
drop policy product_images_read on storage.objects;
create policy product_images_read on storage.objects for select to authenticated using(bucket_id='product-images' and (select private.staff_role()) is not null);

alter table public.customers add column email text not null default '' check(length(email)<=254);
alter table public.customers add column tax_id text not null default '' check(length(tax_id)<=80);
alter table public.customers add column address text not null default '' check(length(address)<=600);
alter table public.customers add column notes text not null default '' check(length(notes)<=1500);
alter table public.customers add column active boolean not null default true;
alter table public.customers add column revision integer not null default 1;
alter table public.documents add column customer_tax_id text not null default '';
create function public.save_customer(p_payload jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid:=(p_payload->>'id')::uuid; v_old public.customers%rowtype; v_role text:=private.staff_role(); v_phone text:=nullif(p_payload->>'phone','');
begin
 if v_role is null or v_role not in ('admin','operator') then raise insufficient_privilege; end if;
 if v_id is null then raise exception 'Falta el identificador del cliente.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('customer:'||v_id::text,0));
 select * into v_old from public.customers where id=v_id for update;
 if v_old.id is not null and v_old.revision is distinct from (p_payload->>'revision')::int then raise exception 'Otro usuario modificó este cliente. Vuelve a abrirlo.'; end if;
 if v_old.id is null and coalesce((p_payload->>'revision')::int,0)<>0 then raise exception 'Cliente no encontrado.'; end if;
 if v_role<>'admin' and (coalesce(p_payload->>'priceTier','')<>coalesce(v_old.price_tier,'emprendedor') or (p_payload->>'active')::boolean is distinct from true) then raise insufficient_privilege; end if;
 if length(trim(coalesce(p_payload->>'name',''))) not between 1 and 160 or jsonb_typeof(p_payload->'active') is distinct from 'boolean' then raise exception 'Revisa el nombre y el estado del cliente.'; end if;
 perform private.limit_catalog_writes();
 insert into public.customers(id,name,phone,price_tier,email,tax_id,address,notes,active)
 values(v_id,trim(p_payload->>'name'),v_phone,p_payload->>'priceTier',coalesce(p_payload->>'email',''),coalesce(p_payload->>'taxId',''),coalesce(p_payload->>'address',''),coalesce(p_payload->>'notes',''),(p_payload->>'active')::boolean)
 on conflict(id) do update set name=excluded.name,phone=excluded.phone,price_tier=excluded.price_tier,email=excluded.email,tax_id=excluded.tax_id,address=excluded.address,notes=excluded.notes,active=excluded.active,revision=customers.revision+1;
 return v_id;
exception when unique_violation then raise exception 'Ese teléfono ya está registrado en otro cliente.';
end $$;

create table public.suppliers (
 id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name)) between 1 and 160),
 contact text not null default '' check(length(contact)<=160),phone text not null default '' check(length(phone)<=60),email text not null default '' check(length(email)<=254),
 tax_id text not null default '' check(length(tax_id)<=80),address text not null default '' check(length(address)<=600),brands text not null default '' check(length(brands)<=500),
 terms text not null default '' check(length(terms)<=500),notes text not null default '' check(length(notes)<=1500),active boolean not null default true,revision integer not null default 1,
 updated_by uuid references auth.users(id),updated_at timestamptz not null default now()
);
create index suppliers_updated_by_idx on public.suppliers(updated_by);
alter table public.suppliers enable row level security;
revoke all on public.suppliers from public,anon,authenticated;
grant select on public.suppliers to authenticated;
create policy supplier_read on public.suppliers for select to authenticated using((select private.staff_role()) in ('admin','warehouse'));
create function public.save_supplier(p_payload jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid:=(p_payload->>'id')::uuid; v_revision integer;
begin
 if private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_id is null then raise exception 'Falta el identificador del proveedor.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('supplier:'||v_id::text,0));
 select revision into v_revision from public.suppliers where id=v_id for update;
 if coalesce(v_revision,0) is distinct from coalesce((p_payload->>'revision')::int,0) then raise exception 'Otro usuario modificó este proveedor. Vuelve a abrirlo.'; end if;
 perform private.limit_catalog_writes();
 if jsonb_typeof(p_payload->'active') is distinct from 'boolean' then raise exception 'Estado inválido.'; end if;
 insert into public.suppliers(id,name,contact,phone,email,tax_id,address,brands,terms,notes,active,updated_by)
 values(v_id,trim(p_payload->>'name'),coalesce(p_payload->>'contact',''),coalesce(p_payload->>'phone',''),coalesce(p_payload->>'email',''),coalesce(p_payload->>'taxId',''),coalesce(p_payload->>'address',''),coalesce(p_payload->>'brands',''),coalesce(p_payload->>'terms',''),coalesce(p_payload->>'notes',''),(p_payload->>'active')::boolean,auth.uid())
 on conflict(id) do update set name=excluded.name,contact=excluded.contact,phone=excluded.phone,email=excluded.email,tax_id=excluded.tax_id,address=excluded.address,brands=excluded.brands,terms=excluded.terms,notes=excluded.notes,active=excluded.active,updated_by=excluded.updated_by,updated_at=now(),revision=suppliers.revision+1;
 return v_id;
end $$;

create table public.user_drafts (
 user_id uuid not null references auth.users(id) on delete cascade,
 namespace text not null check(namespace in ('lcp.drafts.proforma.v2','lcp.drafts.invoice.v2','lcp.movements.v1','lcp.reflections.v1')),
 items jsonb not null default '[]' check(jsonb_typeof(items)='array' and octet_length(items::text)<=1048576),revision integer not null default 1,
 updated_at timestamptz not null default now(),primary key(user_id,namespace)
);
alter table public.user_drafts enable row level security;
revoke all on public.user_drafts from public,anon,authenticated;
grant select on public.user_drafts to authenticated;
create policy own_drafts on public.user_drafts for select to authenticated using(user_id=(select auth.uid()) and (select private.staff_role()) is not null);
create function public.save_my_drafts(p_namespace text,p_items jsonb,p_revision integer) returns integer language plpgsql security definer set search_path='' as $$
declare v_revision integer;
begin
 if private.staff_role() is null then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_namespace,0));
 select revision into v_revision from public.user_drafts where user_id=auth.uid() and namespace=p_namespace for update;
 if coalesce(v_revision,0) is distinct from p_revision then raise exception 'Los borradores cambiaron en otro equipo. Recarga antes de guardar.'; end if;
 perform private.limit_catalog_writes();
 insert into public.user_drafts(user_id,namespace,items) values(auth.uid(),p_namespace,p_items)
 on conflict(user_id,namespace) do update set items=excluded.items,revision=user_drafts.revision+1,updated_at=now() returning revision into v_revision;
 return v_revision;
end $$;

create function public.save_business_settings(p_name text,p_address text,p_phone text) returns void language plpgsql security definer set search_path='' as $$
begin
 if private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if length(trim(coalesce(p_name,''))) not between 1 and 160 or length(coalesce(p_address,''))>600 or length(coalesce(p_phone,''))>60 then raise exception 'Revisa los datos del negocio.'; end if;
 perform private.limit_catalog_writes();
 insert into public.business_settings(id,name,address,phone) values(true,trim(p_name),coalesce(p_address,''),coalesce(p_phone,'')) on conflict(id) do update set name=excluded.name,address=excluded.address,phone=excluded.phone;
end $$;
do $$ declare f text; begin
 foreach f in array array['list_staff_accounts()','save_staff_account(text,text,text,boolean)','save_customer(jsonb)','save_supplier(jsonb)','save_my_drafts(text,jsonb,integer)','save_business_settings(text,text,text)'] loop
 execute 'revoke all on function public.'||f||' from public,anon';
 execute 'grant execute on function public.'||f||' to authenticated';
 end loop;
end $$;

create index products_image_path_idx on public.products(image_path) where image_path is not null;
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
   insert into public.customers(name,phone,price_tier) values(trim(p_payload->>'customerName'),nullif(p_payload->>'customerPhone',''),v_tier) returning * into v_customer;
  end if;
 end if;
 if not v_customer.active then raise exception 'Cliente inactivo.'; end if;
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

create or replace function private.record_inventory_movement(p_payload jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_role text:=private.staff_role(); v_uid uuid:=auth.uid(); v_id uuid; v_existing public.inventory_movements%rowtype;
 v_product uuid:=(p_payload->>'productId')::uuid; v_location text:=p_payload->>'location'; v_type text:=p_payload->>'type';
 v_qty integer; v_before integer; v_after integer; v_request uuid:=(p_payload->>'requestId')::uuid;
begin
 if v_uid is null or v_role is null or v_role not in ('admin','operator','warehouse') then raise insufficient_privilege; end if;
 if v_request is null then raise exception 'Falta el identificador de operación.'; end if;
 if v_type is null or v_type not in ('ENTRY','EXIT','DAMAGED','ADJUSTMENT') then raise exception 'Movimiento inválido.'; end if;
 if v_role not in ('admin','warehouse') and v_type in ('ENTRY','ADJUSTMENT') then raise exception 'Solo un dueño puede registrar entradas y ajustes.'; end if;
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

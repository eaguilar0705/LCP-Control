-- Precio de compra y porcentaje de ganancia por lista.
--
-- El dueño quiere fijar el precio de venta como «lo que me costó más un
-- porcentaje»: un perfume que costó C$ 500 con 20 % de ganancia se vende en
-- C$ 600. Cada lista (Emprendedor, VIP y Premium) lleva su propio porcentaje.
--
-- Reglas:
-- 1. El precio de compra y los porcentajes son del dueño. Sólo Administración y
--    SuperAdmin los leen; el personal de ventas sigue viendo únicamente el
--    precio de venta, como hasta ahora. Con el precio y sin el porcentaje no se
--    puede despejar el costo.
-- 2. Una lista con precio de compra y porcentaje se calcula:
--    venta = compra × (100 + %) / 100, al centavo, en la moneda de la compra.
--    La otra moneda sale de la tasa vigente. Si se compró en córdobas, el
--    precio en córdobas queda fijo y el de dólares se mueve con la tasa; si se
--    compró en dólares, al revés (como el resto del catálogo).
-- 3. Una lista sin porcentaje conserva su precio a mano, en dólares, igual que
--    antes. Nada cambia hasta que el dueño cargue un precio de compra y un
--    porcentaje: esta migración no toca ningún precio.
-- 4. Los precios siguen viviendo en `product_prices`: facturación, proformas,
--    márgenes y reportes los leen sin enterarse de cómo se calcularon.

create table public.product_pricing (
 product_id uuid primary key references public.products(id),
 purchase_price numeric(14,2) check(purchase_price is null or (purchase_price>0 and purchase_price<=10000000)),
 purchase_currency text not null default 'NIO' check(purchase_currency in ('NIO','USD')),
 markup_emprendedor numeric(7,2) check(markup_emprendedor is null or markup_emprendedor between 0 and 1000),
 markup_vip numeric(7,2) check(markup_vip is null or markup_vip between 0 and 1000),
 markup_premium numeric(7,2) check(markup_premium is null or markup_premium between 0 and 1000),
 updated_by uuid not null references private.business_actors(id),
 updated_at timestamptz not null default now()
);
create index product_pricing_updated_by_idx on public.product_pricing(updated_by);
alter table public.product_pricing enable row level security;
revoke all on public.product_pricing from public, anon, authenticated;
grant select on public.product_pricing to authenticated;
create policy owner_pricing_read on public.product_pricing for select to authenticated
 using ((select private.staff_role())='admin');

-- Una fila por lista calculada: tiene precio de compra y porcentaje.
create view private.markup_rules as
 select p.product_id, t.tier, p.purchase_price, p.purchase_currency, t.markup
 from public.product_pricing p
 cross join lateral (values ('emprendedor',p.markup_emprendedor),('vip',p.markup_vip),('premium',p.markup_premium)) as t(tier,markup)
 where p.purchase_price is not null and t.markup is not null;
revoke all on private.markup_rules from public, anon, authenticated;

-- Precio de venta: compra más el porcentaje, al centavo y nunca cero.
create function private.markup_price(p_cost numeric, p_percent numeric) returns numeric
language sql immutable set search_path='' as $$
 select greatest(round(p_cost*(100+p_percent)/100,2),0.01)
$$;
-- El mismo importe en la otra moneda, con la tasa vigente (córdobas por dólar).
create function private.convert_price(p_amount numeric, p_from text, p_to text, p_rate numeric) returns numeric
language sql immutable set search_path='' as $$
 select case when p_from=p_to then p_amount
             when p_to='NIO' then greatest(round(p_amount*p_rate,2),0.01)
             else greatest(round(p_amount/p_rate,2),0.01) end
$$;
revoke all on function private.markup_price(numeric,numeric), private.convert_price(numeric,text,text,numeric) from public, anon, authenticated;

-- Las listas calculadas de un perfume, en las dos monedas.
create function private.markup_prices(p_product uuid, p_rate numeric)
returns table(tier text, usd numeric, nio numeric)
language sql stable security definer set search_path='' as $$
 select r.tier,
  private.convert_price(private.markup_price(r.purchase_price,r.markup),r.purchase_currency,'USD',p_rate),
  private.convert_price(private.markup_price(r.purchase_price,r.markup),r.purchase_currency,'NIO',p_rate)
 from private.markup_rules r where r.product_id=p_product
$$;
revoke all on function private.markup_prices(uuid,numeric) from public, anon, authenticated;

-- Un número opcional del precio de compra o de un porcentaje: nulo, o un
-- número JSON dentro del rango y con hasta dos decimales.
create function private.pricing_number(p_value jsonb, p_min numeric, p_max numeric, p_message text) returns numeric
language plpgsql immutable set search_path='' as $$
declare v numeric;
begin
 if p_value is null or jsonb_typeof(p_value)='null' then return null; end if;
 if jsonb_typeof(p_value)<>'number' then raise exception '%', p_message; end if;
 v:=(p_value#>>'{}')::numeric;
 if v<p_min or v>p_max or v<>round(v,2) then raise exception '%', p_message; end if;
 return v;
end $$;
revoke all on function private.pricing_number(jsonb,numeric,numeric,text) from public, anon, authenticated;

-- Guarda el precio de compra y los porcentajes de un perfume (reemplaza lo que
-- hubiera) y escribe sus listas calculadas. Quien llama ya bloqueó el perfume,
-- comprobó su revisión y leyó la tasa.
create function private.write_product_pricing(p_product uuid, p_pricing jsonb, p_rate numeric) returns void
language plpgsql security definer set search_path='' as $$
declare v_price numeric; v_currency text; v_markups jsonb; v_emprendedor numeric; v_vip numeric; v_premium numeric;
 v_message text:='Cada porcentaje de ganancia va de 0 a 1000, con hasta dos decimales.';
begin
 if jsonb_typeof(p_pricing) is distinct from 'object' then raise exception 'Revisa el precio de compra y los porcentajes.'; end if;
 v_price:=private.pricing_number(p_pricing->'purchasePrice',0.01,10000000,'El precio de compra debe ser mayor que cero y tener hasta dos decimales.');
 v_currency:=coalesce(p_pricing->>'purchaseCurrency','NIO');
 if v_currency not in ('NIO','USD') then raise exception 'La moneda del precio de compra debe ser córdobas o dólares.'; end if;
 v_markups:=coalesce(p_pricing->'markups','{}'::jsonb);
 if jsonb_typeof(v_markups)<>'object' then raise exception '%', v_message; end if;
 v_emprendedor:=private.pricing_number(v_markups->'emprendedor',0,1000,v_message);
 v_vip:=private.pricing_number(v_markups->'vip',0,1000,v_message);
 v_premium:=private.pricing_number(v_markups->'premium',0,1000,v_message);
 if v_price is null and v_emprendedor is null and v_vip is null and v_premium is null then
  -- Sin nada que calcular: las tres listas vuelven a fijarse a mano.
  delete from public.product_pricing where product_id=p_product;
 else
  insert into public.product_pricing(product_id,purchase_price,purchase_currency,markup_emprendedor,markup_vip,markup_premium,updated_by)
  values(p_product,v_price,v_currency,v_emprendedor,v_vip,v_premium,auth.uid())
  on conflict(product_id) do update set purchase_price=excluded.purchase_price,purchase_currency=excluded.purchase_currency,
   markup_emprendedor=excluded.markup_emprendedor,markup_vip=excluded.markup_vip,markup_premium=excluded.markup_premium,
   updated_by=excluded.updated_by,updated_at=now();
 end if;
 if exists(select 1 from private.markup_rules r where r.product_id=p_product and private.markup_price(r.purchase_price,r.markup)>10000000) then
  raise exception 'El precio de venta calculado es demasiado alto. Revisa el precio de compra y el porcentaje.';
 end if;
 insert into public.product_prices(product_id,tier_code,currency,amount)
 select p_product,m.tier,c.currency,case c.currency when 'USD' then m.usd else m.nio end
 from private.markup_prices(p_product,p_rate) m cross join (values ('USD'),('NIO')) as c(currency)
 on conflict(product_id,tier_code,currency) do update set amount=excluded.amount;
 -- Una lista que deja de tener porcentaje conserva su precio en dólares y
 -- vuelve a la regla de siempre: córdobas = dólares × tasa.
 update public.product_prices nio set amount=greatest(round(usd.amount*p_rate,2),0.01)
 from public.product_prices usd
 where nio.product_id=p_product and usd.product_id=p_product and usd.tier_code=nio.tier_code
   and usd.currency='USD' and nio.currency='NIO'
   and nio.amount is distinct from greatest(round(usd.amount*p_rate,2),0.01)
   and not exists(select 1 from private.markup_rules r where r.product_id=p_product and r.tier=nio.tier_code);
end $$;
revoke all on function private.write_product_pricing(uuid,jsonb,numeric) from public, anon, authenticated;

-- Las tres listas del perfume como las guarda el historial: {lista: {USD, NIO}}.
create function private.product_price_snapshot(p_product uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_object_agg(t.tier_code,t.prices),'{}'::jsonb) from (
  select tier_code,jsonb_object_agg(currency,amount) as prices
  from public.product_prices where product_id=p_product group by tier_code
 ) t
$$;
revoke all on function private.product_price_snapshot(uuid) from public, anon, authenticated;

-- Cambiar la tasa recalcula las dos clases de listas:
-- · con porcentaje: desde el precio de compra, en su moneda;
-- · a mano: córdobas = dólares × tasa, como siempre.
create or replace function private.reprice_catalog(p_rate numeric) returns integer
language plpgsql security definer set search_path='' as $$
declare v_markup integer; v_manual integer;
begin
 if p_rate is null or p_rate<=0 then raise exception 'Tipo de cambio inválido para repreciar.'; end if;
 with target as (
  select r.product_id,r.tier,c.currency,
   private.convert_price(private.markup_price(r.purchase_price,r.markup),r.purchase_currency,c.currency,p_rate) as amount
  from private.markup_rules r cross join (values ('USD'),('NIO')) as c(currency)
 )
 update public.product_prices pr set amount=target.amount from target
 where pr.product_id=target.product_id and pr.tier_code=target.tier and pr.currency=target.currency
   and pr.amount is distinct from target.amount;
 get diagnostics v_markup=row_count;
 -- Dos decimales, que es lo que admite un precio, y nunca cero: un perfume de
 -- un dólar a cualquier tasa sensata pasa de cero, pero el piso lo garantiza.
 update public.product_prices nio
 set amount=greatest(round(usd.amount*p_rate,2),0.01)
 from public.product_prices usd
 where usd.product_id=nio.product_id and usd.tier_code=nio.tier_code
   and usd.currency='USD' and nio.currency='NIO'
   and nio.amount is distinct from greatest(round(usd.amount*p_rate,2),0.01)
   and not exists(select 1 from private.markup_rules r where r.product_id=nio.product_id and r.tier=nio.tier_code);
 get diagnostics v_manual=row_count;
 return v_markup+v_manual;
end $$;
revoke all on function private.reprice_catalog(numeric) from public,anon,authenticated;

-- El formulario del perfume puede mandar, además de los datos y los precios en
-- dólares, `pricing`: el precio de compra, su moneda y un porcentaje por lista.
-- Si no lo manda (una pantalla anterior a esta migración), lo guardado se
-- respeta. Una lista con porcentaje ignora el dólar del formulario: su precio
-- sale del precio de compra. Las listas sin porcentaje se guardan como antes.
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
 select to_jsonb(v_old)||jsonb_build_object('prices',(select jsonb_agg(to_jsonb(pp)) from public.product_prices pp where product_id=v_id),
  'pricing',(select to_jsonb(r) from public.product_pricing r where r.product_id=v_id)) into v_before;
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
 if jsonb_typeof(p_payload->'pricing')='object' then
  perform private.write_product_pricing(v_id,p_payload->'pricing',v_rate);
 elsif p_payload->'pricing' is not null and jsonb_typeof(p_payload->'pricing')<>'null' then
  raise exception 'Revisa el precio de compra y los porcentajes.';
 end if;
 foreach v_tier in array array['emprendedor','vip','premium'] loop
  select m.usd,m.nio into v_usd,v_nio from private.markup_prices(v_id,v_rate) m where m.tier=v_tier;
  if not found then
   if jsonb_typeof(p_payload->'prices'->v_tier->'USD') is distinct from 'number' then raise exception 'Escribe el precio en dólares de las listas sin porcentaje de ganancia.'; end if;
   v_usd:=(p_payload->'prices'->v_tier->>'USD')::numeric;
   if v_usd<=0 or v_usd>10000000 or v_usd<>round(v_usd,2) then raise exception 'Los precios en dólares deben ser positivos y tener hasta dos decimales.'; end if;
   v_nio:=greatest(round(v_usd*v_rate,2),0.01);
  end if;
  insert into public.product_prices(product_id,tier_code,currency,amount) values(v_id,v_tier,'USD',v_usd),(v_id,v_tier,'NIO',v_nio)
  on conflict(product_id,tier_code,currency) do update set amount=excluded.amount;
  v_prices:=v_prices||jsonb_build_object(v_tier,jsonb_build_object('USD',v_usd,'NIO',v_nio));
 end loop;
 insert into public.inventory_balances(product_id,location,quantity) values(v_id,'warehouse',null),(v_id,'store',null) on conflict do nothing;
 insert into private.catalog_changes(product_id,actor_id,action,before_data,after_data) values(v_id,auth.uid(),'save',v_before,
  to_jsonb(v_new)||jsonb_build_object('prices',v_prices,'catalogRate',v_rate,'pricing',(select to_jsonb(r) from public.product_pricing r where r.product_id=v_id)));
 return v_id;
exception when unique_violation then raise exception 'Ese código ya pertenece a otro producto.';
end $$;
revoke all on function public.save_catalog_product(jsonb) from public,anon;
grant execute on function public.save_catalog_product(jsonb) to authenticated;

-- Precio de compra y porcentajes de uno o varios perfumes a la vez: la ficha
-- de la pantalla Precios manda uno y la carga desde un archivo, todos los de
-- la hoja. Es todo o nada: si una fila no se puede guardar, no se guarda
-- ninguna y el mensaje dice cuál fue. Cada fila trae la revisión con la que se
-- leyó el perfume, para no pisar un cambio hecho mientras tanto.
create function public.save_product_pricing(p_rows jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare v_rate numeric; v_row jsonb; v_id uuid; v_old public.products%rowtype; v_before jsonb; v_count integer:=0;
begin
 if (select private.staff_role()) is distinct from 'admin' then raise insufficient_privilege; end if;
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 2000 then
  raise exception 'Guarda entre 1 y 2000 perfumes a la vez.';
 end if;
 if exists(select 1 from jsonb_array_elements(p_rows) x where jsonb_typeof(x) is distinct from 'object'
   or coalesce(x->>'productId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   or jsonb_typeof(x->'revision') is distinct from 'number') then
  raise exception 'Revisa los perfumes que vas a guardar.';
 end if;
 if (select count(distinct lower(x->>'productId')) from jsonb_array_elements(p_rows) x)<>jsonb_array_length(p_rows) then
  raise exception 'Un perfume aparece dos veces. Deja una sola fila por perfume.';
 end if;
 select usd_to_nio into v_rate from public.exchange_rates where id;
 if v_rate is null then raise exception 'Registra el tipo de cambio del dólar en Negocio antes de guardar precios.'; end if;
 perform private.limit_catalog_writes();
 -- Todos los perfumes se bloquean de una vez y en el mismo orden que usa la
 -- facturación, para que dos operaciones no se esperen en círculo.
 perform 1 from public.products where id in (select (x->>'productId')::uuid from jsonb_array_elements(p_rows) x) order by id for update;
 for v_row in select x from jsonb_array_elements(p_rows) x order by (x->>'productId')::uuid loop
  v_id:=(v_row->>'productId')::uuid;
  select * into v_old from public.products where id=v_id;
  if not found then raise exception 'Uno de los perfumes ya no existe. Vuelve a cargar la lista.'; end if;
  if v_old.revision is distinct from (v_row->>'revision')::numeric then
   raise exception 'Otro usuario cambió «%» hace un momento. Vuelve a abrirlo antes de guardar.', v_old.name;
  end if;
  v_before:=to_jsonb(v_old)||jsonb_build_object('prices',(select jsonb_agg(to_jsonb(pp)) from public.product_prices pp where product_id=v_id),
   'pricing',(select to_jsonb(r) from public.product_pricing r where r.product_id=v_id));
  begin
   perform private.write_product_pricing(v_id,v_row->'pricing',v_rate);
  exception when raise_exception then
   raise exception '«%»: %', v_old.name, sqlerrm;
  end;
  update public.products set revision=revision+1 where id=v_id;
  insert into private.catalog_changes(product_id,actor_id,action,before_data,after_data) values(v_id,auth.uid(),'pricing',v_before,
   jsonb_build_object('prices',private.product_price_snapshot(v_id),'catalogRate',v_rate,
    'pricing',(select to_jsonb(r) from public.product_pricing r where r.product_id=v_id)));
  v_count:=v_count+1;
 end loop;
 return v_count;
end $$;
revoke all on function public.save_product_pricing(jsonb) from public,anon,authenticated;
grant execute on function public.save_product_pricing(jsonb) to authenticated;

-- Un perfume que se elimina por haberse creado por error se lleva también su
-- precio de compra. Uno con historial sólo se desactiva y lo conserva.
create or replace function public.remove_catalog_product(p_id uuid,p_revision integer) returns text
language plpgsql security definer set search_path='' as $$
declare v_old public.products%rowtype; v_action text;
begin
 if (select private.staff_role()) is distinct from 'admin' then raise insufficient_privilege; end if;
 select * into v_old from public.products where id=p_id for update;
 if not found then raise exception 'Producto no encontrado.'; end if;
 if v_old.revision is distinct from p_revision then raise exception 'Otro usuario cambió este perfume. Vuelve a abrirlo.'; end if;
 perform private.limit_catalog_writes();
 if exists(select 1 from public.inventory_balances where product_id=p_id and quantity>0) then raise exception 'El perfume tiene existencias. Registra su salida antes de retirarlo.'; end if;
 if exists(select 1 from public.document_items where product_id=p_id)
 or exists(select 1 from public.inventory_movements where product_id=p_id)
 or exists(select 1 from private.import_rows where product_id=p_id) then
  update public.products set active=false,revision=revision+1 where id=p_id; v_action:='archived';
 else
  delete from public.product_pricing where product_id=p_id;
  delete from public.inventory_balances where product_id=p_id;
  delete from public.product_prices where product_id=p_id;
  delete from public.products where id=p_id; v_action:='deleted';
 end if;
 insert into private.catalog_changes(product_id,actor_id,action,before_data) values(p_id,auth.uid(),v_action,to_jsonb(v_old));
 return v_action;
end $$;
revoke all on function public.remove_catalog_product(uuid,integer) from public,anon;
grant execute on function public.remove_catalog_product(uuid,integer) to authenticated;

-- El historial de precios también cuenta cómo se calculó cada precio: el
-- porcentaje y el precio de compra que lo produjeron. Un cambio de porcentaje o
-- de precio de compra aparece aunque el precio en dólares no se haya movido
-- (un perfume comprado en córdobas puede cambiar sólo en córdobas).
drop function public.list_price_changes(uuid);
drop function private.price_history(uuid);
create function private.price_history(p_product uuid)
returns table(changed_at timestamptz, actor text, tier text, before_usd numeric, after_usd numeric, before_nio numeric, after_nio numeric,
 catalog_rate numeric, purchase_price numeric, purchase_currency text, markup numeric)
language plpgsql stable security definer set search_path='' as $$
begin
 if (select private.staff_role()) is distinct from 'admin' then raise insufficient_privilege; end if;
 return query
 select h.changed_at, h.actor, h.tier, h.before_usd, h.after_usd, h.before_nio, h.after_nio, h.catalog_rate,
        case when h.markup is not null then h.purchase_price end,
        case when h.markup is not null then h.purchase_currency end,
        h.markup
 from (
  select c.created_at as changed_at,
         coalesce(s.display_name,'Cuenta retirada') as actor,
         t.tier as tier,
         (case when jsonb_typeof(c.before_data->'prices')='array' then
           (select (e->>'amount')::numeric from jsonb_array_elements(c.before_data->'prices') e
             where e->>'tier_code'=t.tier and e->>'currency'='USD') end) as before_usd,
         (c.after_data->'prices'->t.tier->>'USD')::numeric as after_usd,
         (case when jsonb_typeof(c.before_data->'prices')='array' then
           (select (e->>'amount')::numeric from jsonb_array_elements(c.before_data->'prices') e
             where e->>'tier_code'=t.tier and e->>'currency'='NIO') end) as before_nio,
         (c.after_data->'prices'->t.tier->>'NIO')::numeric as after_nio,
         (c.after_data->>'catalogRate')::numeric as catalog_rate,
         (c.after_data->'pricing'->>'purchase_price')::numeric as purchase_price,
         c.after_data->'pricing'->>'purchase_currency' as purchase_currency,
         (case when c.after_data->'pricing'->>'purchase_price' is not null
           then (c.after_data->'pricing'->>('markup_'||t.tier))::numeric end) as markup,
         (c.before_data->'pricing'->>'purchase_price')::numeric as before_purchase_price,
         c.before_data->'pricing'->>'purchase_currency' as before_purchase_currency,
         (case when c.before_data->'pricing'->>'purchase_price' is not null
           then (c.before_data->'pricing'->>('markup_'||t.tier))::numeric end) as before_markup
  from private.catalog_changes c
  cross join unnest(array['emprendedor','vip','premium']) as t(tier)
  left join private.business_actors s on s.id=c.actor_id
  where c.product_id=p_product and c.action in ('save','pricing')
 ) h
 where h.after_usd is not null and (
  h.before_usd is distinct from h.after_usd or h.before_nio is distinct from h.after_nio
  or h.before_markup is distinct from h.markup
  or (h.markup is not null and (h.before_purchase_price is distinct from h.purchase_price
   or h.before_purchase_currency is distinct from h.purchase_currency)))
 order by h.changed_at desc, array_position(array['emprendedor','vip','premium'], h.tier)
 limit 200;
end $$;
create function public.list_price_changes(p_product uuid)
returns table(changed_at timestamptz, actor text, tier text, before_usd numeric, after_usd numeric, before_nio numeric, after_nio numeric,
 catalog_rate numeric, purchase_price numeric, purchase_currency text, markup numeric)
language sql security invoker set search_path='' as $$ select * from private.price_history(p_product) $$;
revoke all on function private.price_history(uuid), public.list_price_changes(uuid) from public,anon,authenticated;
grant execute on function private.price_history(uuid), public.list_price_changes(uuid) to authenticated;

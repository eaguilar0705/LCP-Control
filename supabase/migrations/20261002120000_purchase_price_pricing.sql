-- Precio de venta desde el precio de compra de cada perfume.
--
-- El dueño fija el precio de venta a partir de lo que pagó por el perfume, no
-- del costo promedio del inventario: escribe el precio de compra en la ficha
-- del perfume y un porcentaje por lista (Emprendedor, VIP y Premium).
--
--   precio de la lista = precio de compra × (1 + porcentaje / 100), al centavo
--
-- Reglas:
-- 1. La base de las listas calculadas vuelve a ser `product_pricing.purchase_price`
--    en su moneda (`purchase_currency`). El precio en esa moneda queda fijo y el
--    de la otra sale de la tasa vigente.
-- 2. El costo promedio (`product_costs`) sigue siendo la contabilidad del
--    inventario: márgenes, estado de resultados e inventario valorado. Cambiarlo
--    (pedido, costo inicial, factura eliminada) ya no mueve ningún precio.
-- 3. Una lista con porcentaje y sin precio de compra queda pendiente y conserva
--    su precio publicado. Una lista sin porcentaje sigue a mano en dólares.
-- 4. Guardar sólo porcentajes (una versión anterior de la pantalla o una carga
--    de archivo sin columna de compra) conserva el precio de compra guardado.
-- 5. Esta migración no cambia ningún precio publicado. Los precios de compra
--    que quedaron del modelo del 26-09-2026 se apartan en
--    `private.retired_purchase_prices` y se borran, para que un dato viejo no
--    recalcule nada sin que el dueño lo vea.

create table private.retired_purchase_prices as
 select product_id, purchase_price, purchase_currency, updated_at, now() as retired_at
 from public.product_pricing where purchase_price is not null;
revoke all on private.retired_purchase_prices from public, anon, authenticated;
update public.product_pricing set purchase_price=null where purchase_price is not null;

comment on column public.product_pricing.purchase_price is
 'Precio de compra del perfume, en purchase_currency. Base de las listas con porcentaje: precio = compra × (1 + % / 100).';
comment on column public.product_pricing.purchase_currency is
 'Moneda del precio de compra; el precio de venta en esa moneda queda fijo y el de la otra sale de la tasa.';

-- Una fila por lista calculada: tiene precio de compra y porcentaje.
drop view private.markup_rules;
create view private.markup_rules as
 select p.product_id, t.tier, p.purchase_price, p.purchase_currency, t.markup
 from public.product_pricing p
 cross join lateral (values ('emprendedor',p.markup_emprendedor),('vip',p.markup_vip),('premium',p.markup_premium)) as t(tier,markup)
 where p.purchase_price is not null and t.markup is not null;
revoke all on private.markup_rules from public, anon, authenticated;

-- Las listas calculadas de un perfume, en las dos monedas.
create or replace function private.markup_prices(p_product uuid, p_rate numeric)
returns table(tier text, usd numeric, nio numeric)
language sql stable security definer set search_path='' as $$
 select r.tier,
  private.convert_price(private.markup_price(r.purchase_price,r.markup),r.purchase_currency,'USD',p_rate),
  private.convert_price(private.markup_price(r.purchase_price,r.markup),r.purchase_currency,'NIO',p_rate)
 from private.markup_rules r where r.product_id=p_product
$$;
revoke all on function private.markup_prices(uuid,numeric) from public, anon, authenticated;

-- Escribe las listas calculadas del perfume y normaliza las demás (C$ = US$ ×
-- tasa). Devuelve cuántos importes cambiaron. Quien llama ya bloqueó el perfume.
create or replace function private.write_computed_prices(p_product uuid, p_rate numeric) returns integer
language plpgsql security definer set search_path='' as $$
declare v_computed integer; v_manual integer;
begin
 if p_rate is null or p_rate<=0 then
  raise exception 'Registra el tipo de cambio del dólar en Negocio antes de calcular precios.';
 end if;
 if exists(select 1 from private.markup_prices(p_product,p_rate) m where m.usd>10000000 or m.nio>10000000) then
  raise exception 'El precio de venta calculado de «%» es demasiado alto. Revisa su precio de compra y sus porcentajes.',
   coalesce((select name from public.products where id=p_product),'este perfume');
 end if;
 insert into public.product_prices(product_id,tier_code,currency,amount)
 select p_product,m.tier,c.currency,case c.currency when 'USD' then m.usd else m.nio end
 from private.markup_prices(p_product,p_rate) m cross join (values ('USD'),('NIO')) as c(currency)
 on conflict(product_id,tier_code,currency) do update set amount=excluded.amount
 where product_prices.amount is distinct from excluded.amount;
 get diagnostics v_computed=row_count;
 update public.product_prices nio set amount=greatest(round(usd.amount*p_rate,2),0.01)
 from public.product_prices usd
 where nio.product_id=p_product and usd.product_id=p_product and usd.tier_code=nio.tier_code
   and usd.currency='USD' and nio.currency='NIO'
   and nio.amount is distinct from greatest(round(usd.amount*p_rate,2),0.01)
   and not exists(select 1 from private.markup_rules r where r.product_id=p_product and r.tier=nio.tier_code);
 get diagnostics v_manual=row_count;
 return v_computed+v_manual;
end $$;
revoke all on function private.write_computed_prices(uuid,numeric) from public, anon, authenticated;

-- El historial guarda la base del cálculo: desde aquí, el precio de compra.
create or replace function private.pricing_after_data(p_product uuid, p_rate numeric) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'prices',private.product_price_snapshot(p_product),
  'catalogRate',p_rate,
  'pricing',(select to_jsonb(r) from public.product_pricing r where r.product_id=p_product),
  'averageCostNio',(select c.average_cost_nio from public.product_costs c where c.product_id=p_product),
  'base','purchase',
  'computed',coalesce((select jsonb_agg(r.tier order by r.tier) from private.markup_rules r where r.product_id=p_product),'[]'::jsonb))
$$;
revoke all on function private.pricing_after_data(uuid,numeric) from public, anon, authenticated;

-- El costo promedio vuelve a ser sólo contabilidad: el disparador conserva la
-- regla de que un promedio conocido no se borra, y ya no toca precios.
create or replace function private.sync_cost_prices() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and new.average_cost_nio is not distinct from old.average_cost_nio then return new; end if;
 if new.average_cost_nio is null then
  raise exception 'El costo promedio de «%» no se puede borrar. Registra la mercadería como compra con su costo.',
   coalesce((select name from public.products where id=new.product_id),'este perfume');
 end if;
 return new;
end $$;
revoke all on function private.sync_cost_prices() from public, anon, authenticated;
drop function private.apply_cost_prices(uuid,jsonb);

-- Guarda el precio de compra y los porcentajes de un perfume y escribe sus
-- listas. Sin la clave `purchasePrice` se conserva el precio de compra
-- guardado; con `null`, se borra. Quien llama ya bloqueó el perfume y leyó la
-- tasa.
create or replace function private.write_product_pricing(p_product uuid, p_pricing jsonb, p_rate numeric) returns void
language plpgsql security definer set search_path='' as $$
declare v_old public.product_pricing%rowtype; v_markups jsonb; v_price numeric; v_currency text;
 v_emprendedor numeric; v_vip numeric; v_premium numeric;
 v_message text:='Cada porcentaje de ganancia va de 0 a 1000, con hasta dos decimales.';
begin
 if jsonb_typeof(p_pricing) is distinct from 'object' then raise exception 'Revisa el precio de compra y los porcentajes de ganancia.'; end if;
 select * into v_old from public.product_pricing where product_id=p_product;
 if p_pricing ? 'purchasePrice' then
  v_price:=private.pricing_number(p_pricing->'purchasePrice',0.01,10000000,'El precio de compra debe ser mayor que cero y tener hasta dos decimales.');
 else
  v_price:=v_old.purchase_price;
 end if;
 v_currency:=coalesce(nullif(p_pricing->>'purchaseCurrency',''),v_old.purchase_currency,'USD');
 if v_currency not in ('NIO','USD') then raise exception 'La moneda del precio de compra debe ser córdobas o dólares.'; end if;
 v_markups:=coalesce(p_pricing->'markups','{}'::jsonb);
 if jsonb_typeof(v_markups)<>'object' then raise exception '%', v_message; end if;
 v_emprendedor:=private.pricing_number(v_markups->'emprendedor',0,1000,v_message);
 v_vip:=private.pricing_number(v_markups->'vip',0,1000,v_message);
 v_premium:=private.pricing_number(v_markups->'premium',0,1000,v_message);
 if v_price is null and v_emprendedor is null and v_vip is null and v_premium is null then
  -- Nada que calcular: las tres listas se fijan a mano y conservan su último precio.
  delete from public.product_pricing where product_id=p_product;
 else
  insert into public.product_pricing(product_id,purchase_price,purchase_currency,markup_emprendedor,markup_vip,markup_premium,updated_by)
  values(p_product,v_price,v_currency,v_emprendedor,v_vip,v_premium,auth.uid())
  on conflict(product_id) do update set purchase_price=excluded.purchase_price,purchase_currency=excluded.purchase_currency,
   markup_emprendedor=excluded.markup_emprendedor,markup_vip=excluded.markup_vip,markup_premium=excluded.markup_premium,
   updated_by=excluded.updated_by,updated_at=now();
 end if;
 perform private.write_computed_prices(p_product,p_rate);
end $$;
revoke all on function private.write_product_pricing(uuid,jsonb,numeric) from public, anon, authenticated;

-- Cambiar la tasa mueve sólo el equivalente en la otra moneda: en una lista
-- calculada queda fijo el precio en la moneda de la compra; en una a mano, el
-- dólar.
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

-- El historial dice con qué porcentaje y sobre qué base salió cada precio:
-- el precio de compra (registros con `base`), el costo promedio (del 27-09 al
-- 02-10-2026) o el precio de compra del primer modelo.
create or replace function private.price_history(p_product uuid)
returns table(changed_at timestamptz, actor text, tier text, before_usd numeric, after_usd numeric, before_nio numeric, after_nio numeric,
 catalog_rate numeric, purchase_price numeric, purchase_currency text, markup numeric,
 average_cost numeric, automatic boolean, cause text, cause_reference text)
language plpgsql stable security definer set search_path='' as $$
begin
 if (select private.staff_role()) is distinct from 'admin' then raise insufficient_privilege; end if;
 return query
 select h.changed_at, h.actor, h.tier, h.before_usd, h.after_usd, h.before_nio, h.after_nio, h.catalog_rate,
        case when (h.legacy and h.legacy_markup is not null) or (h.purchase_base and h.computed) then h.purchase_price end,
        case when (h.legacy and h.legacy_markup is not null) or (h.purchase_base and h.computed) then h.purchase_currency end,
        case when h.legacy then h.legacy_markup else h.raw_markup end,
        case when not h.legacy and not h.purchase_base and h.computed then h.average_cost end,
        h.action='cost_pricing',
        case when h.action='cost_pricing' then coalesce(h.cause_kind,'cost') end,
        case when h.action='cost_pricing' then h.cause_reference end
 from (
  select c.created_at as changed_at, c.action,
         case when c.actor_id is null then 'Sistema' else coalesce(s.display_name,'Cuenta retirada') end as actor,
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
         not (c.after_data ? 'computed') as legacy,
         coalesce(c.after_data->>'base','')='purchase' as purchase_base,
         coalesce(c.after_data->'computed' ? t.tier,false) as computed,
         (c.after_data->>'averageCostNio')::numeric as average_cost,
         (c.before_data->>'averageCostNio')::numeric as before_average_cost,
         (c.after_data->'pricing'->>('markup_'||t.tier))::numeric as raw_markup,
         (c.before_data->'pricing'->>('markup_'||t.tier))::numeric as before_raw_markup,
         (c.after_data->'pricing'->>'purchase_price')::numeric as purchase_price,
         c.after_data->'pricing'->>'purchase_currency' as purchase_currency,
         (case when c.after_data->'pricing'->>'purchase_price' is not null
           then (c.after_data->'pricing'->>('markup_'||t.tier))::numeric end) as legacy_markup,
         (c.before_data->'pricing'->>'purchase_price')::numeric as before_purchase_price,
         c.before_data->'pricing'->>'purchase_currency' as before_purchase_currency,
         (case when c.before_data->'pricing'->>'purchase_price' is not null
           then (c.before_data->'pricing'->>('markup_'||t.tier))::numeric end) as before_legacy_markup,
         c.after_data->'cause'->>'kind' as cause_kind,
         c.after_data->'cause'->>'reference' as cause_reference
  from private.catalog_changes c
  cross join unnest(array['emprendedor','vip','premium']) as t(tier)
  left join private.business_actors s on s.id=c.actor_id
  where c.product_id=p_product and c.action in ('save','pricing','cost_pricing')
 ) h
 where h.after_usd is not null and (
  h.before_usd is distinct from h.after_usd or h.before_nio is distinct from h.after_nio
  or (h.legacy and (h.before_legacy_markup is distinct from h.legacy_markup
   or (h.legacy_markup is not null and (h.before_purchase_price is distinct from h.purchase_price
    or h.before_purchase_currency is distinct from h.purchase_currency))))
  or (not h.legacy and h.before_raw_markup is distinct from h.raw_markup)
  or (not h.legacy and not h.purchase_base and h.computed and h.before_average_cost is distinct from h.average_cost)
  or (h.purchase_base and h.computed and (h.before_purchase_price is distinct from h.purchase_price
   or h.before_purchase_currency is distinct from h.purchase_currency)))
 order by h.changed_at desc, array_position(array['emprendedor','vip','premium'], h.tier)
 limit 200;
end $$;
revoke all on function private.price_history(uuid) from public,anon,authenticated;
grant execute on function private.price_history(uuid) to authenticated;

-- El formulario del perfume: igual que antes, con el aviso del precio a mano
-- referido al precio de compra.
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
 select to_jsonb(v_old)||jsonb_build_object('prices',private.product_price_rows(v_id),
  'pricing',(select to_jsonb(r) from public.product_pricing r where r.product_id=v_id),
  'averageCostNio',(select c.average_cost_nio from public.product_costs c where c.product_id=v_id)) into v_before;
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
  raise exception 'Revisa los porcentajes de ganancia.';
 end if;
 foreach v_tier in array array['emprendedor','vip','premium'] loop
  select m.usd,m.nio into v_usd,v_nio from private.markup_prices(v_id,v_rate) m where m.tier=v_tier;
  if not found then
   if jsonb_typeof(p_payload->'prices'->v_tier->'USD') is distinct from 'number' then
    raise exception 'Escribe el precio en dólares de las listas que no se calculan desde el precio de compra.';
   end if;
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
  to_jsonb(v_new)||private.pricing_after_data(v_id,v_rate)||jsonb_build_object('prices',v_prices));
 return v_id;
exception when unique_violation then raise exception 'Ese código ya pertenece a otro producto.';
end $$;
revoke all on function public.save_catalog_product(jsonb) from public,anon;
grant execute on function public.save_catalog_product(jsonb) to authenticated;

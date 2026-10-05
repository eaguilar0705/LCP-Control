-- Tres cambios pensados para el día en que el personal empiece a contar
-- existencias y, más adelante, a mover precios.
--
-- 1. Un pedido ya no puede borrar un costo que no conoce. Antes, si el perfume
--    tenía existencias contadas y todavía no tenía costo promedio, el pedido se
--    guardaba y el promedio quedaba en nulo: el costo puesto del pedido —que sí
--    estaba documentado— se descartaba en silencio. Ahora el pedido se rechaza
--    y se dice qué falta. Es la única forma de que el orden correcto sea
--    obligatorio en lugar de recordado.
-- 2. Un ajuste de conteo deja de borrar el costo promedio. Corregir un conteo
--    de 10 a 12 corrige el conteo, no la valoración. Las entradas manuales de
--    mercadería sin costo lo siguen borrando, porque ahí sí llega mercadería
--    cuyo costo nadie declaró.
-- 3. El historial de precios de cada perfume, que la base ya venía guardando en
--    `private.catalog_changes` y que nadie podía leer.

-- 1 y 2 ------------------------------------------------------------------

-- Sólo una entrada de mercadería invalida el promedio: es mercadería nueva sin
-- costo declarado. `record_shipment` inserta su ENTRY y enseguida escribe el
-- promedio correcto, así que sigue funcionando igual. Un ajuste de conteo, en
-- cambio, conserva el costo: lo que se corrigió fue la cuenta de las unidades.
create or replace function private.account_inventory_movement() returns trigger language plpgsql security definer set search_path='' as $$
declare v_average numeric;
begin
 if auth.uid() is null or private.staff_role() is null then raise insufficient_privilege; end if;
 select average_cost_nio into v_average from public.product_costs where product_id=new.product_id;
 if new.type in ('EXIT','DAMAGED','ADJUSTMENT') and new.before_quantity>new.after_quantity then
  insert into public.inventory_movement_costs(movement_id,product_id,type,quantity,unit_cost_nio,created_at)
  values(new.id,new.product_id,new.type,new.before_quantity-new.after_quantity,v_average,new.created_at);
 end if;
 if new.type='ENTRY' and new.after_quantity>coalesce(new.before_quantity,0) then
  insert into public.product_costs(product_id,average_cost_nio) values(new.product_id,null)
  on conflict(product_id) do update set average_cost_nio=null,updated_at=now();
 end if;
 return new;
end $$;
revoke all on function private.account_inventory_movement() from public,anon,authenticated;

create or replace function private.record_shipment(p_input jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare
 v_uid uuid:=auth.uid(); v_request uuid; v_existing public.purchase_shipments%rowtype;
 v_rate numeric; v_shipping numeric; v_date date; v_lines jsonb; v_line jsonb;
 v_units integer:=0; v_goods numeric:=0; v_per_unit numeric; v_id uuid;
 v_product uuid; v_location text; v_quantity integer; v_unit numeric;
 v_total integer; v_before integer; v_average numeric; v_landed numeric; v_name text;
begin
 if v_uid is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 v_request:=(p_input->>'requestId')::uuid;
 if v_request is null then raise exception 'Falta el identificador de operación.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('shipment:'||v_uid::text||v_request::text,0));
 select * into v_existing from public.purchase_shipments where created_by=v_uid and request_id=v_request;
 if found then
  if v_existing.request_payload<>p_input then raise exception 'La operación ya existe con otros datos.'; end if;
  return v_existing.id;
 end if;

 v_shipping:=private.accounting_number(p_input,'shippingAmount',1000000000);
 v_rate:=private.accounting_rate(p_input);
 v_date:=(p_input->>'incurredOn')::date;
 if v_date is null or v_date>(now() at time zone 'America/Managua')::date then raise exception 'Fecha del pedido inválida.'; end if;
 v_lines:=p_input->'lines';
 if jsonb_typeof(v_lines) is distinct from 'array' or jsonb_array_length(v_lines) not between 1 and 200 then
  raise exception 'El pedido necesita entre 1 y 200 renglones.'; end if;
 if (select count(distinct value->>'productId') from jsonb_array_elements(v_lines)) <> jsonb_array_length(v_lines) then
  raise exception 'Un producto no puede repetirse en el mismo pedido.'; end if;

 -- Primera pasada: se validan todos los renglones y se conocen las unidades del
 -- paquete antes de tocar existencias. El envío se reparte por igual entre ellas.
 for v_line in select value from jsonb_array_elements(v_lines) loop
  v_quantity:=private.accounting_number(v_line,'quantity',1000000,0);
  v_unit:=private.accounting_number(v_line,'unitPrice',1000000000);
  if v_quantity<=0 then raise exception 'Revisa las cantidades del pedido.'; end if;
  if coalesce(v_line->>'location','') not in ('store','warehouse') then raise exception 'Ubicación inválida.'; end if;
  if (v_line->>'productId')::uuid is null then raise exception 'Renglón sin producto.'; end if;
  v_units:=v_units+v_quantity;
  v_goods:=v_goods+v_quantity*v_unit;
 end loop;
 if v_goods+v_shipping<=0 then raise exception 'Revisa el precio de los perfumes y el costo del envío.'; end if;
 v_per_unit:=round(v_shipping/v_units,6);

 perform private.limit_catalog_writes();
 insert into public.purchase_shipments(request_id,request_payload,incurred_on,supplier,agency,reference,note,currency,exchange_rate,shipping_amount,goods_amount,units,shipping_per_unit,created_by)
 values(v_request,p_input,v_date,coalesce(p_input->>'supplier',''),coalesce(p_input->>'agency',''),coalesce(p_input->>'reference',''),coalesce(p_input->>'note',''),p_input->>'currency',v_rate,v_shipping,round(v_goods,2),v_units,v_per_unit,v_uid)
 returning id into v_id;

 for v_line in select value from jsonb_array_elements(v_lines) loop
  v_product:=(v_line->>'productId')::uuid;
  v_location:=v_line->>'location';
  v_quantity:=(v_line->>'quantity')::integer;
  v_unit:=(v_line->>'unitPrice')::numeric;
  perform 1 from public.products where id=v_product and active for update;
  if not found then raise exception 'Producto no encontrado o inactivo.'; end if;
  perform 1 from public.inventory_balances where product_id=v_product order by location for update;
  if (select count(*) from public.inventory_balances where product_id=v_product and quantity is not null)<>2 then
   raise exception 'Registra primero el conteo de tienda y bodega.'; end if;
  select sum(quantity) into v_total from public.inventory_balances where product_id=v_product;
  select quantity into v_before from public.inventory_balances where product_id=v_product and location=v_location;
  select average_cost_nio into v_average from public.product_costs where product_id=v_product;
  -- No se puede promediar contra una base que nadie declaró. Antes esto dejaba
  -- el promedio en nulo y tiraba el costo del pedido; ahora se detiene el
  -- pedido completo y se dice exactamente qué falta y dónde se carga.
  if v_total>0 and v_average is null then
   select b.name||' '||p.name into v_name from public.products p join public.brands b on b.id=p.brand_id where p.id=v_product;
   raise exception 'Carga primero el costo inicial de «%»: ya tiene % unidades contadas y todavía no tiene costo. Reportes → Costos y precios → Cargar costos desde lista.', coalesce(v_name,'este perfume'), v_total;
  end if;
  -- Costo puesto en bodega: precio original del perfume más la parte del peso
  -- que le toca, convertido con el tipo de cambio guardado en el pedido.
  v_landed:=round((v_unit+v_per_unit)*v_rate,6);
  insert into public.purchase_shipment_lines(shipment_id,product_id,location,quantity,unit_price,goods_amount,shipping_share,landed_unit_cost_nio)
  values(v_id,v_product,v_location,v_quantity,v_unit,round(v_quantity*v_unit,2),round(v_quantity*v_per_unit,6),v_landed);
  update public.inventory_balances set quantity=quantity+v_quantity,updated_at=now() where product_id=v_product and location=v_location;
  insert into public.inventory_movements(product_id,location,type,quantity,before_quantity,after_quantity,actor_id,reference,note)
  values(v_product,v_location,'ENTRY',v_quantity,v_before,v_before+v_quantity,v_uid,nullif(p_input->>'reference',''),'Pedido de importación recibido');
  -- El movimiento genérico deja el promedio en blanco por ser una entrada sin
  -- costo. Sólo esta función autorizada lo reemplaza, con la base anterior ya
  -- bloqueada. El `case` ya no tiene hueco: la guardia de arriba garantiza que
  -- o no hay existencias previas, o su costo se conoce.
  insert into public.product_costs(product_id,average_cost_nio)
  values(v_product,case when v_total=0 then v_landed else round((v_average*v_total+v_landed*v_quantity)/(v_total+v_quantity),6) end)
  on conflict(product_id) do update set average_cost_nio=excluded.average_cost_nio,updated_at=now();
 end loop;
 return v_id;
end $$;
revoke all on function private.record_shipment(jsonb) from public,anon,authenticated;
grant execute on function private.record_shipment(jsonb) to authenticated;

-- 3 ----------------------------------------------------------------------

-- Cada guardado del catálogo ya venía anotando el antes y el después completos,
-- con su actor y su fecha, en `private.catalog_changes`. Nadie podía leerlo: el
-- esquema privado no se alcanza desde la API. Esto lo saca a la superficie
-- convertido en lo único que se le pregunta a esa tabla —a cómo estaba este
-- perfume, quién lo cambió y cuándo— y sólo para el dueño.
--
-- El «antes» guarda las filas de `product_prices` tal cual, y el «después» un
-- objeto por lista; las dos formas se normalizan aquí. Un guardado que no movió
-- el precio en dólares no aparece: el historial es de precios, no de guardados.
create function private.price_history(p_product uuid)
returns table(changed_at timestamptz, actor text, tier text, before_usd numeric, after_usd numeric, before_nio numeric, after_nio numeric, catalog_rate numeric)
language plpgsql stable security definer set search_path='' as $$
begin
 if (select private.staff_role()) is distinct from 'admin' then raise insufficient_privilege; end if;
 return query
 select h.changed_at, h.actor, h.tier, h.before_usd, h.after_usd, h.before_nio, h.after_nio, h.catalog_rate
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
         (c.after_data->>'catalogRate')::numeric as catalog_rate
  from private.catalog_changes c
  cross join unnest(array['emprendedor','vip','premium']) as t(tier)
  left join public.staff_members s on s.user_id=c.actor_id
  where c.product_id=p_product and c.action='save'
 ) h
 where h.after_usd is not null and h.before_usd is distinct from h.after_usd
 order by h.changed_at desc, array_position(array['emprendedor','vip','premium'], h.tier)
 limit 200;
end $$;

create function public.list_price_changes(p_product uuid)
returns table(changed_at timestamptz, actor text, tier text, before_usd numeric, after_usd numeric, before_nio numeric, after_nio numeric, catalog_rate numeric)
language sql security invoker set search_path='' as $$ select * from private.price_history(p_product) $$;
revoke all on function private.price_history(uuid), public.list_price_changes(uuid) from public,anon,authenticated;
grant execute on function private.price_history(uuid), public.list_price_changes(uuid) to authenticated;

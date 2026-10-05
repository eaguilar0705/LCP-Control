-- Precios calculados desde el costo promedio del inventario.
--
-- El dueño pidió (notas de voz y `Formulas.xlsx` del 26-09-2026) que el precio
-- de venta salga del costo promedio de lo que hay en tienda y bodega más un
-- porcentaje de ganancia por lista, con un porcentaje distinto por perfume y
-- por cada una de sus tres listas:
--
--   costo promedio nuevo = (existencias × promedio anterior
--                           + unidades que entran × costo de entrada)
--                          / (existencias + unidades que entran)
--   precio de la lista   = costo promedio × (1 + porcentaje / 100)
--
-- El porcentaje es un RECARGO SOBRE EL COSTO (lo que el dueño llama «margen»):
-- 13 unidades a C$ 15.675 y 20 que entran a C$ 16.675 dan 16.281060… de
-- promedio; con 25 % el precio es 20.3513…, publicado en C$ 20.35.
--
-- Reglas:
-- 1. Una sola fuente de costo: `product_costs.average_cost_nio`, el promedio
--    ponderado en córdobas con seis decimales que ya llevaba la contabilidad.
--    Es el costo puesto en bodega: precio del proveedor más la parte del envío
--    del pedido que le toca a cada unidad (el Excel sólo dice «costo nuevo»;
--    se usa el costo completo porque es lo que de verdad costó el perfume).
--    `product_pricing.purchase_price` deja de participar: se conserva sin
--    borrar como dato histórico y ya no se escribe.
-- 2. Una lista es «calculada» cuando tiene porcentaje y el perfume tiene costo
--    promedio: precio en C$ = round(costo × (100 + %) / 100, 2), redondeando
--    sólo el precio final; el de US$ sale de la tasa vigente. Una lista con
--    porcentaje y sin costo promedio queda «pendiente de costo»: conserva su
--    precio publicado y se comporta como una lista a mano hasta que haya costo.
--    Una lista sin porcentaje sigue siendo a mano (US$ fijo, C$ = US$ × tasa).
-- 3. Cada vez que cambia el costo promedio (pedido, costo inicial, factura
--    eliminada) un disparador recalcula en la misma transacción las listas
--    calculadas de ese perfume y anota el cambio en el historial como
--    automático, con su causa. No hay forma de guardar un costo nuevo sin sus
--    precios.
-- 4. Una entrada manual de mercadería ya no borra el costo: si el perfume tiene
--    costo promedio, se rechaza y se pide registrarla como compra con su costo.
--    Así nunca queda publicado un precio «calculado» sobre un promedio que dejó
--    de ser válido. Las salidas y los ajustes de conteo no mueven el promedio.
-- 5. Las facturas y proformas emitidas guardan sus importes: nada de esto las
--    toca. El cambio aplica a operaciones futuras.

comment on column public.product_pricing.purchase_price is
 'Obsoleto desde 20260927120000_cost_based_pricing: la base de las listas calculadas es product_costs.average_cost_nio. Se conserva como dato histórico y ya no se escribe.';
comment on column public.product_pricing.purchase_currency is
 'Obsoleto desde 20260927120000_cost_based_pricing: acompaña a purchase_price.';

-- El costo de entrada puede traer más de dos decimales (el ejemplo del cliente
-- recibe unidades a C$ 16.675). El precio por unidad de un pedido admite ahora
-- seis decimales, la misma precisión que el costo inicial y el promedio.
alter table public.purchase_shipment_lines alter column unit_price type numeric(18,6);

-- Los cambios automáticos no siempre tienen una persona detrás (la propia
-- migración recalcula lo que ya estaba cargado). El historial los muestra como
-- «Sistema» en lugar de atribuirlos a alguien que no los hizo.
alter table private.catalog_changes alter column actor_id drop not null;

-- Una fila por lista calculada: tiene porcentaje y el perfume tiene costo.
drop view private.markup_rules;
create view private.markup_rules as
 select p.product_id, t.tier, c.average_cost_nio as cost_nio, t.markup
 from public.product_pricing p
 join public.product_costs c on c.product_id=p.product_id
 cross join lateral (values ('emprendedor',p.markup_emprendedor),('vip',p.markup_vip),('premium',p.markup_premium)) as t(tier,markup)
 where c.average_cost_nio is not null and t.markup is not null;
revoke all on private.markup_rules from public, anon, authenticated;

-- Las listas calculadas de un perfume, en las dos monedas: el córdoba sale del
-- costo y el dólar, de la tasa. Quien llama garantiza una tasa válida.
create or replace function private.markup_prices(p_product uuid, p_rate numeric)
returns table(tier text, usd numeric, nio numeric)
language sql stable security definer set search_path='' as $$
 select r.tier,
  private.convert_price(private.markup_price(r.cost_nio,r.markup),'NIO','USD',p_rate),
  private.markup_price(r.cost_nio,r.markup)
 from private.markup_rules r where r.product_id=p_product
$$;
revoke all on function private.markup_prices(uuid,numeric) from public, anon, authenticated;

-- Las tres listas del perfume tal como están guardadas, en el formato del
-- «antes» del historial (filas de product_prices).
create function private.product_price_rows(p_product uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_agg(to_jsonb(pp) order by pp.tier_code,pp.currency) from public.product_prices pp where pp.product_id=p_product
$$;
revoke all on function private.product_price_rows(uuid) from public, anon, authenticated;

-- Escribe las listas calculadas del perfume y normaliza las demás (C$ = US$ ×
-- tasa). Devuelve cuántos importes cambiaron. Quien llama ya bloqueó el perfume.
create function private.write_computed_prices(p_product uuid, p_rate numeric) returns integer
language plpgsql security definer set search_path='' as $$
declare v_computed integer; v_manual integer;
begin
 if p_rate is null or p_rate<=0 then
  raise exception 'Registra el tipo de cambio del dólar en Negocio antes de calcular precios.';
 end if;
 if exists(select 1 from private.markup_rules r where r.product_id=p_product and private.markup_price(r.cost_nio,r.markup)>10000000) then
  raise exception 'El precio de venta calculado de «%» es demasiado alto. Revisa su costo y sus porcentajes.',
   coalesce((select name from public.products where id=p_product),'este perfume');
 end if;
 insert into public.product_prices(product_id,tier_code,currency,amount)
 select p_product,m.tier,c.currency,case c.currency when 'USD' then m.usd else m.nio end
 from private.markup_prices(p_product,p_rate) m cross join (values ('USD'),('NIO')) as c(currency)
 on conflict(product_id,tier_code,currency) do update set amount=excluded.amount
 where product_prices.amount is distinct from excluded.amount;
 get diagnostics v_computed=row_count;
 -- Una lista a mano (o pendiente de costo) conserva su precio en dólares y el
 -- córdoba vuelve a salir de la tasa.
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

-- Lo que el historial guarda después de cada cambio de precio: las listas, la
-- tasa, los porcentajes, el costo promedio que sirvió de base y qué listas
-- salieron de él.
create function private.pricing_after_data(p_product uuid, p_rate numeric) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'prices',private.product_price_snapshot(p_product),
  'catalogRate',p_rate,
  'pricing',(select to_jsonb(r) from public.product_pricing r where r.product_id=p_product),
  'averageCostNio',(select c.average_cost_nio from public.product_costs c where c.product_id=p_product),
  'computed',coalesce((select jsonb_agg(r.tier order by r.tier) from private.markup_rules r where r.product_id=p_product),'[]'::jsonb))
$$;
revoke all on function private.pricing_after_data(uuid,numeric) from public, anon, authenticated;

-- La causa de un cambio automático la deja quien cambia el costo (pedido,
-- costo inicial, factura eliminada) en una variable de la transacción. Es sólo
-- una etiqueta para el historial: no concede ni decide nada.
create function private.set_cost_cause(p_cause jsonb) returns void
language sql volatile set search_path='' as $$
 select set_config('lcp.cost_cause',p_cause::text,true)
$$;
revoke all on function private.set_cost_cause(jsonb) from public, anon, authenticated;

-- Recalcula las listas calculadas de un perfume desde su costo promedio y, si
-- algún precio cambió, sube la revisión del perfume y lo anota en el historial
-- como cambio automático con su causa.
create function private.apply_cost_prices(p_product uuid, p_cause jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_rate numeric; v_before jsonb; v_changed integer;
begin
 if not exists(select 1 from private.markup_rules r where r.product_id=p_product) then return false; end if;
 select usd_to_nio into v_rate from public.exchange_rates where id;
 if v_rate is null then
  raise exception 'Registra el tipo de cambio del dólar en Negocio: hace falta para actualizar los precios que salen del costo promedio.';
 end if;
 perform 1 from public.products where id=p_product for update;
 v_before:=(select to_jsonb(p) from public.products p where p.id=p_product)
  ||jsonb_build_object('prices',private.product_price_rows(p_product),
   'pricing',(select to_jsonb(r) from public.product_pricing r where r.product_id=p_product),
   'averageCostNio',p_cause->'previousAverageCostNio');
 v_changed:=private.write_computed_prices(p_product,v_rate);
 if v_changed=0 then return false; end if;
 update public.products set revision=revision+1 where id=p_product;
 insert into private.catalog_changes(product_id,actor_id,action,before_data,after_data)
 values(p_product,
  (select id from private.business_actors where id=auth.uid()),
  'cost_pricing',v_before,
  private.pricing_after_data(p_product,v_rate)||jsonb_build_object('cause',p_cause-'previousAverageCostNio'));
 return true;
end $$;
revoke all on function private.apply_cost_prices(uuid,jsonb) from public, anon, authenticated;

-- El disparador que une el costo con los precios: en la misma transacción que
-- cambia el promedio. Un promedio conocido no puede volver a quedar en blanco:
-- un precio calculado sobre él quedaría publicado como si siguiera valiendo.
create function private.sync_cost_prices() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_previous numeric:=case when tg_op='UPDATE' then old.average_cost_nio end; v_cause jsonb;
begin
 if new.average_cost_nio is not distinct from v_previous then return new; end if;
 if new.average_cost_nio is null then
  raise exception 'El costo promedio de «%» no se puede borrar. Registra la mercadería como compra con su costo.',
   coalesce((select name from public.products where id=new.product_id),'este perfume');
 end if;
 v_cause:=coalesce(nullif(current_setting('lcp.cost_cause',true),'')::jsonb,'{"kind":"cost"}'::jsonb)
  ||jsonb_build_object('averageCostNio',new.average_cost_nio,'previousAverageCostNio',v_previous);
 perform private.apply_cost_prices(new.product_id,v_cause);
 return new;
end $$;
revoke all on function private.sync_cost_prices() from public, anon, authenticated;
create trigger sync_cost_prices after insert or update of average_cost_nio on public.product_costs
 for each row execute function private.sync_cost_prices();

-- Las entradas de mercadería. La de un pedido (que se está registrando en esta
-- misma transacción y escribe enseguida el promedio con su costo) pasa. Una
-- entrada manual de un perfume que ya tiene costo se rechaza: traería unidades
-- sin costo y el promedio —y los precios que salen de él— dejaría de valer. Si
-- el perfume todavía no tiene costo, la entrada se registra y el costo sigue
-- pendiente, igual que antes. Salidas, mermas y ajustes de conteo no tocan el
-- promedio.
create or replace function private.account_inventory_movement() returns trigger language plpgsql security definer set search_path='' as $$
declare v_average numeric; v_name text;
begin
 if auth.uid() is null or private.staff_role() is null then raise insufficient_privilege; end if;
 select average_cost_nio into v_average from public.product_costs where product_id=new.product_id;
 if new.type in ('EXIT','DAMAGED','ADJUSTMENT') and new.before_quantity>new.after_quantity then
  insert into public.inventory_movement_costs(movement_id,product_id,type,quantity,unit_cost_nio,created_at)
  values(new.id,new.product_id,new.type,new.before_quantity-new.after_quantity,v_average,new.created_at);
 end if;
 if new.type='ENTRY' and new.after_quantity>coalesce(new.before_quantity,0) and v_average is not null
    and not exists(
     select 1 from public.purchase_shipment_lines l join public.purchase_shipments s on s.id=l.shipment_id
     where l.product_id=new.product_id and s.created_by=auth.uid() and s.created_at=now()) then
  select b.name||' '||p.name into v_name from public.products p join public.brands b on b.id=p.brand_id where p.id=new.product_id;
  raise exception '«%» ya tiene costo promedio. Registra esta mercadería como compra con su costo (Precios → Costo de inventario → Registrar compra) para que el promedio y los precios se actualicen.',
   coalesce(v_name,'Este perfume');
 end if;
 return new;
end $$;
revoke all on function private.account_inventory_movement() from public,anon,authenticated;

-- Pedido de mercadería: igual que antes, más la causa para el historial de
-- precios y el camino actualizado para cargar el costo inicial.
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

 for v_line in select value from jsonb_array_elements(v_lines) loop
  v_quantity:=private.accounting_number(v_line,'quantity',1000000,0);
  v_unit:=private.accounting_number(v_line,'unitPrice',1000000000,6);
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
 perform private.set_cost_cause(jsonb_build_object('kind','purchase','shipmentId',v_id,
  'reference',nullif(coalesce(nullif(p_input->>'reference',''),p_input->>'supplier'),'')));

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
  if v_total>0 and v_average is null then
   select b.name||' '||p.name into v_name from public.products p join public.brands b on b.id=p.brand_id where p.id=v_product;
   raise exception 'Carga primero el costo inicial de «%»: ya tiene % unidades contadas y todavía no tiene costo. Precios → Costo de inventario → Cargar costo inicial.', coalesce(v_name,'este perfume'), v_total;
  end if;
  -- Costo puesto en bodega: precio original del perfume más la parte del peso
  -- que le toca, convertido con el tipo de cambio guardado en el pedido.
  v_landed:=round((v_unit+v_per_unit)*v_rate,6);
  insert into public.purchase_shipment_lines(shipment_id,product_id,location,quantity,unit_price,goods_amount,shipping_share,landed_unit_cost_nio)
  values(v_id,v_product,v_location,v_quantity,v_unit,round(v_quantity*v_unit,2),round(v_quantity*v_per_unit,6),v_landed);
  update public.inventory_balances set quantity=quantity+v_quantity,updated_at=now() where product_id=v_product and location=v_location;
  insert into public.inventory_movements(product_id,location,type,quantity,before_quantity,after_quantity,actor_id,reference,note)
  values(v_product,v_location,'ENTRY',v_quantity,v_before,v_before+v_quantity,v_uid,nullif(p_input->>'reference',''),'Pedido de importación recibido');
  -- Promedio ponderado con la existencia total de tienda y bodega. Escribirlo
  -- dispara el recálculo de las listas calculadas del perfume.
  insert into public.product_costs(product_id,average_cost_nio)
  values(v_product,case when v_total=0 then v_landed else round((v_average*v_total+v_landed*v_quantity)/(v_total+v_quantity),6) end)
  on conflict(product_id) do update set average_cost_nio=excluded.average_cost_nio,updated_at=now();
 end loop;
 return v_id;
end $$;
revoke all on function private.record_shipment(jsonb) from public,anon,authenticated;
grant execute on function private.record_shipment(jsonb) to authenticated;

-- Costo inicial de las existencias contadas: igual que antes, con su causa.
create or replace function private.set_opening_cost(p_input jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_request uuid; v_product uuid; v_existing public.opening_cost_records%rowtype;
 v_unit numeric; v_rate numeric; v_total integer; v_id uuid; v_average numeric;
begin
 if v_uid is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 v_request:=(p_input->>'requestId')::uuid; v_product:=(p_input->>'productId')::uuid;
 if v_request is null then raise exception 'Falta el identificador de operación.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('opening:'||v_uid::text||v_request::text,0));
 select * into v_existing from public.opening_cost_records where created_by=v_uid and request_id=v_request;
 if found then
  if v_existing.request_payload<>p_input then raise exception 'La operación ya existe con otros datos.'; end if;
  return v_existing.id;
 end if;
 v_unit:=private.accounting_number(p_input,'unitCost',1000000000,6); v_rate:=private.accounting_rate(p_input);
 if length(trim(coalesce(p_input->>'note',''))) not between 1 and 2000 then raise exception 'Indica el respaldo del costo inicial.'; end if;
 perform private.limit_catalog_writes();
 perform 1 from public.products where id=v_product and active for update;
 if not found then raise exception 'Producto no encontrado o inactivo.'; end if;
 perform 1 from public.inventory_balances where product_id=v_product order by location for update;
 if (select count(*) from public.inventory_balances where product_id=v_product and quantity is not null)<>2 then raise exception 'Registra primero el conteo de tienda y bodega.'; end if;
 select sum(quantity) into v_total from public.inventory_balances where product_id=v_product;
 if v_total<=0 then raise exception 'El costo inicial requiere existencias contadas.'; end if;
 select average_cost_nio into v_average from public.product_costs where product_id=v_product;
 if v_average is not null then raise exception 'Este producto ya tiene costo promedio. Registra las compras para actualizarlo.'; end if;
 insert into public.opening_cost_records(request_id,request_payload,product_id,quantity,unit_cost,currency,exchange_rate,unit_cost_nio,note,created_by)
 values(v_request,p_input,v_product,v_total,v_unit,p_input->>'currency',v_rate,round(v_unit*v_rate,6),trim(p_input->>'note'),v_uid) returning id into v_id;
 perform private.set_cost_cause(jsonb_build_object('kind','opening_cost','openingId',v_id,'reference',left(trim(p_input->>'note'),120)));
 insert into public.product_costs(product_id,average_cost_nio) values(v_product,round(v_unit*v_rate,6))
 on conflict(product_id) do update set average_cost_nio=excluded.average_cost_nio,updated_at=now();
 return v_id;
end $$;

-- Eliminar una factura devuelve sus unidades con el costo que la venta había
-- congelado. El promedio se pondera ahora con la existencia TOTAL (tienda y
-- bodega), igual que en los pedidos; antes sólo contaba la ubicación de la
-- factura. Si el perfume no tenía existencias, las unidades devueltas fijan el
-- promedio con su costo congelado. Si la venta no congeló costo, el promedio
-- se conserva: las unidades vuelven al costo vigente, sin inventar otro.
create or replace function public.delete_invoice(p_id uuid,p_reason text default '') returns text
language plpgsql security definer set search_path='' as $$
declare
 v_uid uuid:=auth.uid(); v_doc public.documents%rowtype; v_item record;
 v_before integer; v_total integer; v_average numeric; v_reason text:=trim(coalesce(p_reason,''));
begin
 if v_uid is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_id is null then raise exception 'Falta el identificador de la factura.'; end if;
 if length(v_reason)>500 then raise exception 'El motivo es demasiado largo.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('document:'||p_id::text,0));
 select * into v_doc from public.documents where id=p_id for update;
 if v_doc.id is null then raise exception 'La factura ya no existe. Actualiza la lista.'; end if;
 if v_doc.kind<>'invoice' then raise exception 'Sólo se pueden eliminar facturas.'; end if;
 perform private.limit_catalog_writes();
 perform private.set_cost_cause(jsonb_build_object('kind','invoice_deleted','reference',v_doc.number));

 insert into private.document_deletions(document_id,number,kind,snapshot,reason,actor_id)
 values(v_doc.id,v_doc.number,v_doc.kind,
  to_jsonb(v_doc)||jsonb_build_object('items',
   (select coalesce(jsonb_agg(to_jsonb(i) order by i.description),'[]') from public.document_items i where i.document_id=v_doc.id),
   'costs',
   (select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.document_item_costs c where c.document_id=v_doc.id)),
  v_reason,v_uid);

 -- Mismo orden de bloqueo que create_document: producto y luego existencias.
 for v_item in
  select i.product_id,i.quantity,c.unit_cost_nio
  from public.document_items i left join public.document_item_costs c on c.document_item_id=i.id
  where i.document_id=v_doc.id order by i.product_id
 loop
  perform 1 from public.products where id=v_item.product_id for update;
  perform 1 from public.inventory_balances where product_id=v_item.product_id order by location for update;
  select quantity into v_before from public.inventory_balances
   where product_id=v_item.product_id and location=v_doc.location;
  if not found or v_before is null then
   raise exception 'No se puede devolver % al inventario: falta el conteo de %.',
    (select name from public.products where id=v_item.product_id),
    case v_doc.location when 'store' then 'Tienda' else 'Bodega' end;
  end if;
  select coalesce(sum(quantity),0) into v_total from public.inventory_balances where product_id=v_item.product_id;
  select average_cost_nio into v_average from public.product_costs where product_id=v_item.product_id for update;
  if v_item.unit_cost_nio is not null and (v_average is not null or v_total=0) then
   insert into public.product_costs(product_id,average_cost_nio)
   values(v_item.product_id,case when v_total=0 then v_item.unit_cost_nio
     else round((v_average*v_total+v_item.unit_cost_nio*v_item.quantity)/(v_total+v_item.quantity),6) end)
   on conflict(product_id) do update set average_cost_nio=excluded.average_cost_nio,updated_at=now();
  end if;
  update public.inventory_balances set quantity=v_before+v_item.quantity,updated_at=now()
   where product_id=v_item.product_id and location=v_doc.location;
  insert into public.inventory_movements(product_id,location,type,quantity,before_quantity,after_quantity,actor_id,reference,note)
  values(v_item.product_id,v_doc.location,'ADJUSTMENT',v_item.quantity,v_before,v_before+v_item.quantity,v_uid,v_doc.number,
   left('Factura '||v_doc.number||' eliminada'||case when v_reason<>'' then ': '||v_reason else '' end,2000));
 end loop;

 update public.inventory_movements set document_id=null where document_id=v_doc.id;
 delete from public.document_item_costs where document_id=v_doc.id;
 delete from public.document_items where document_id=v_doc.id;
 delete from public.documents where id=v_doc.id;
 return v_doc.number;
end $$;
revoke all on function public.delete_invoice(uuid,text) from public,anon,authenticated;
grant execute on function public.delete_invoice(uuid,text) to authenticated;

-- Guarda los porcentajes de un perfume (reemplaza los que hubiera) y escribe
-- sus listas. Ya no recibe precio de compra: la base es el costo promedio. Una
-- versión anterior de la aplicación que lo mande recibe un aviso claro en vez
-- de guardarse a medias. Quien llama ya bloqueó el perfume y leyó la tasa.
create or replace function private.write_product_pricing(p_product uuid, p_pricing jsonb, p_rate numeric) returns void
language plpgsql security definer set search_path='' as $$
declare v_markups jsonb; v_emprendedor numeric; v_vip numeric; v_premium numeric;
 v_message text:='Cada porcentaje de ganancia va de 0 a 1000, con hasta dos decimales.';
begin
 if jsonb_typeof(p_pricing) is distinct from 'object' then raise exception 'Revisa los porcentajes de ganancia.'; end if;
 if p_pricing ? 'purchasePrice' and jsonb_typeof(p_pricing->'purchasePrice')<>'null' then
  raise exception 'El precio de compra ya no se guarda: los precios salen del costo promedio del inventario. Actualiza la aplicación (recarga la página) y vuelve a intentarlo.';
 end if;
 v_markups:=coalesce(p_pricing->'markups','{}'::jsonb);
 if jsonb_typeof(v_markups)<>'object' then raise exception '%', v_message; end if;
 v_emprendedor:=private.pricing_number(v_markups->'emprendedor',0,1000,v_message);
 v_vip:=private.pricing_number(v_markups->'vip',0,1000,v_message);
 v_premium:=private.pricing_number(v_markups->'premium',0,1000,v_message);
 if v_emprendedor is null and v_vip is null and v_premium is null then
  -- Sin porcentajes: las tres listas se fijan a mano y conservan su último precio.
  delete from public.product_pricing where product_id=p_product;
 else
  insert into public.product_pricing(product_id,markup_emprendedor,markup_vip,markup_premium,updated_by)
  values(p_product,v_emprendedor,v_vip,v_premium,auth.uid())
  on conflict(product_id) do update set markup_emprendedor=excluded.markup_emprendedor,markup_vip=excluded.markup_vip,
   markup_premium=excluded.markup_premium,updated_by=excluded.updated_by,updated_at=now();
 end if;
 perform private.write_computed_prices(p_product,p_rate);
end $$;
revoke all on function private.write_product_pricing(uuid,jsonb,numeric) from public, anon, authenticated;

-- Cambiar la tasa mueve el equivalente en la otra moneda y nada más:
-- · listas calculadas: el córdoba sale del costo y el porcentaje (no cambia);
--   el dólar se recalcula con la tasa nueva;
-- · listas a mano o pendientes de costo: el dólar queda y el córdoba se mueve.
create or replace function private.reprice_catalog(p_rate numeric) returns integer
language plpgsql security definer set search_path='' as $$
declare v_markup integer; v_manual integer;
begin
 if p_rate is null or p_rate<=0 then raise exception 'Tipo de cambio inválido para repreciar.'; end if;
 with target as (
  select r.product_id,r.tier,c.currency,
   case c.currency when 'NIO' then private.markup_price(r.cost_nio,r.markup)
    else private.convert_price(private.markup_price(r.cost_nio,r.markup),'NIO','USD',p_rate) end as amount
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

-- El formulario del perfume: igual que antes, con `pricing` = porcentajes. Una
-- lista calculada ignora el dólar del formulario; una a mano o pendiente de
-- costo lo exige.
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
    raise exception 'Escribe el precio en dólares de las listas que no se calculan desde el costo promedio.';
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

-- Porcentajes de uno o varios perfumes a la vez (ficha de Precios o archivo):
-- todo o nada, con la revisión con que se leyó cada perfume.
create or replace function public.save_product_pricing(p_rows jsonb) returns integer
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
 perform 1 from public.products where id in (select (x->>'productId')::uuid from jsonb_array_elements(p_rows) x) order by id for update;
 for v_row in select x from jsonb_array_elements(p_rows) x order by (x->>'productId')::uuid loop
  v_id:=(v_row->>'productId')::uuid;
  select * into v_old from public.products where id=v_id;
  if not found then raise exception 'Uno de los perfumes ya no existe. Vuelve a cargar la lista.'; end if;
  if v_old.revision is distinct from (v_row->>'revision')::numeric then
   raise exception 'Otro usuario cambió «%» hace un momento. Vuelve a abrirlo antes de guardar.', v_old.name;
  end if;
  v_before:=to_jsonb(v_old)||jsonb_build_object('prices',private.product_price_rows(v_id),
   'pricing',(select to_jsonb(r) from public.product_pricing r where r.product_id=v_id),
   'averageCostNio',(select c.average_cost_nio from public.product_costs c where c.product_id=v_id));
  begin
   perform private.write_product_pricing(v_id,v_row->'pricing',v_rate);
  exception when raise_exception then
   raise exception '«%»: %', v_old.name, sqlerrm;
  end;
  update public.products set revision=revision+1 where id=v_id;
  insert into private.catalog_changes(product_id,actor_id,action,before_data,after_data)
  values(v_id,auth.uid(),'pricing',v_before,private.pricing_after_data(v_id,v_rate));
  v_count:=v_count+1;
 end loop;
 return v_count;
end $$;
revoke all on function public.save_product_pricing(jsonb) from public,anon,authenticated;
grant execute on function public.save_product_pricing(jsonb) to authenticated;

-- El historial explica cada precio: el porcentaje y la base que lo produjeron
-- (el costo promedio desde esta migración; el precio de compra antes), si fue
-- un cambio automático y por qué. Los registros anteriores se leen igual que
-- siempre.
drop function public.list_price_changes(uuid);
drop function private.price_history(uuid);
create function private.price_history(p_product uuid)
returns table(changed_at timestamptz, actor text, tier text, before_usd numeric, after_usd numeric, before_nio numeric, after_nio numeric,
 catalog_rate numeric, purchase_price numeric, purchase_currency text, markup numeric,
 average_cost numeric, automatic boolean, cause text, cause_reference text)
language plpgsql stable security definer set search_path='' as $$
begin
 if (select private.staff_role()) is distinct from 'admin' then raise insufficient_privilege; end if;
 return query
 select h.changed_at, h.actor, h.tier, h.before_usd, h.after_usd, h.before_nio, h.after_nio, h.catalog_rate,
        case when h.legacy and h.legacy_markup is not null then h.purchase_price end,
        case when h.legacy and h.legacy_markup is not null then h.purchase_currency end,
        case when h.legacy then h.legacy_markup else h.raw_markup end,
        case when not h.legacy and h.computed then h.average_cost end,
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
  or (not h.legacy and (h.before_raw_markup is distinct from h.raw_markup
   or (h.computed and h.before_average_cost is distinct from h.average_cost))))
 order by h.changed_at desc, array_position(array['emprendedor','vip','premium'], h.tier)
 limit 200;
end $$;
create function public.list_price_changes(p_product uuid)
returns table(changed_at timestamptz, actor text, tier text, before_usd numeric, after_usd numeric, before_nio numeric, after_nio numeric,
 catalog_rate numeric, purchase_price numeric, purchase_currency text, markup numeric,
 average_cost numeric, automatic boolean, cause text, cause_reference text)
language sql security invoker set search_path='' as $$ select * from private.price_history(p_product) $$;
revoke all on function private.price_history(uuid), public.list_price_changes(uuid) from public,anon,authenticated;
grant execute on function private.price_history(uuid), public.list_price_changes(uuid) to authenticated;

-- Puesta al día: los perfumes que ya tienen porcentajes y costo promedio pasan
-- a calcularse desde el costo, con su anotación automática en el historial.
-- Los que tienen porcentajes y todavía no tienen costo conservan el precio
-- publicado (quedan «pendientes de costo»). Ningún otro precio cambia.
do $$
declare v_product uuid;
begin
 if exists(select 1 from private.markup_rules) and not exists(select 1 from public.exchange_rates where id) then
  raise exception 'Hay perfumes con porcentaje y costo promedio pero no hay tipo de cambio: regístralo antes de aplicar esta migración.';
 end if;
 for v_product in select distinct r.product_id from private.markup_rules r order by 1 loop
  perform private.apply_cost_prices(v_product,
   jsonb_build_object('kind','migration','averageCostNio',(select average_cost_nio from public.product_costs where product_id=v_product)));
 end loop;
end $$;

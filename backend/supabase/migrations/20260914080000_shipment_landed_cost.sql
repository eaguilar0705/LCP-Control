-- La mercadería llega por agencia de envíos: una caja con varios perfumes donde
-- lo único que cobra la agencia es el peso del paquete. Se registra entonces el
-- precio original de cada perfume —ya con el descuento por volumen que dé el
-- proveedor— y el envío del pedido completo, que se reparte por igual entre las
-- unidades de la caja. No hay impuesto de compra que separar, así que el
-- impuesto sale del registro de compras y del de gastos.

drop function public.record_purchase(jsonb);
drop function private.record_purchase(jsonb);
drop table public.purchase_records;

create table public.purchase_shipments (
 id uuid primary key default gen_random_uuid(), request_id uuid not null,
 request_payload jsonb not null, incurred_on date not null,
 supplier text not null default '' check(length(supplier)<=160),
 agency text not null default '' check(length(agency)<=160),
 reference text not null default '' check(length(reference)<=200),
 note text not null default '' check(length(note)<=2000),
 currency text not null check(currency in ('NIO','USD')),
 exchange_rate numeric(14,6) not null check(exchange_rate>0 and (currency<>'NIO' or exchange_rate=1)),
 -- Lo cobrado por la agencia por el peso del paquete, y la mercadería que venía dentro.
 shipping_amount numeric(14,2) not null check(shipping_amount>=0),
 goods_amount numeric(16,2) not null check(goods_amount>=0),
 units integer not null check(units>0),
 shipping_per_unit numeric(18,6) not null check(shipping_per_unit>=0),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 unique(created_by,request_id), check(goods_amount+shipping_amount>0)
);
create index purchase_shipments_date_idx on public.purchase_shipments(incurred_on,id);

create table public.purchase_shipment_lines (
 id uuid primary key default gen_random_uuid(),
 shipment_id uuid not null references public.purchase_shipments(id),
 product_id uuid not null references public.products(id),
 location text not null check(location in ('store','warehouse')),
 quantity integer not null check(quantity between 1 and 1000000),
 unit_price numeric(14,2) not null check(unit_price>=0),
 goods_amount numeric(16,2) not null check(goods_amount>=0),
 shipping_share numeric(18,6) not null check(shipping_share>=0),
 landed_unit_cost_nio numeric(24,6) not null check(landed_unit_cost_nio>=0),
 -- Un perfume aparece una sola vez por pedido: dos renglones del mismo producto
 -- serían dos promedios ponderados sobre la misma existencia.
 unique(shipment_id,product_id)
);
create index purchase_shipment_lines_product_idx on public.purchase_shipment_lines(product_id);
create index purchase_shipment_lines_shipment_idx on public.purchase_shipment_lines(shipment_id);

do $$ declare t text; begin
 foreach t in array array['purchase_shipments','purchase_shipment_lines'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy owner_accounting_read on public.%I for select to authenticated using ((select private.staff_role())=''admin'')',t);
 end loop;
end $$;

-- Los gastos del negocio quedan en su importe, sin desglose tributario.
alter table public.expense_records drop column tax_amount, drop column recoverable_tax_amount;
alter table public.expense_records add constraint expense_records_amount_positive check(amount>0);

create function private.record_shipment(p_input jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare
 v_uid uuid:=auth.uid(); v_request uuid; v_existing public.purchase_shipments%rowtype;
 v_rate numeric; v_shipping numeric; v_date date; v_lines jsonb; v_line jsonb;
 v_units integer:=0; v_goods numeric:=0; v_per_unit numeric; v_id uuid;
 v_product uuid; v_location text; v_quantity integer; v_unit numeric;
 v_total integer; v_before integer; v_average numeric; v_landed numeric;
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
  -- Costo puesto en bodega: precio original del perfume más la parte del peso
  -- que le toca, convertido con el tipo de cambio guardado en el pedido.
  v_landed:=round((v_unit+v_per_unit)*v_rate,6);
  insert into public.purchase_shipment_lines(shipment_id,product_id,location,quantity,unit_price,goods_amount,shipping_share,landed_unit_cost_nio)
  values(v_id,v_product,v_location,v_quantity,v_unit,round(v_quantity*v_unit,2),round(v_quantity*v_per_unit,6),v_landed);
  update public.inventory_balances set quantity=quantity+v_quantity,updated_at=now() where product_id=v_product and location=v_location;
  insert into public.inventory_movements(product_id,location,type,quantity,before_quantity,after_quantity,actor_id,reference,note)
  values(v_product,v_location,'ENTRY',v_quantity,v_before,v_before+v_quantity,v_uid,nullif(p_input->>'reference',''),'Pedido de importación recibido');
  -- El movimiento genérico deja el promedio en blanco por ser una entrada sin
  -- costo. Sólo esta función autorizada lo reemplaza, con la base anterior ya bloqueada.
  insert into public.product_costs(product_id,average_cost_nio)
  values(v_product,case when v_total=0 then v_landed when v_average is not null then round((v_average*v_total+v_landed*v_quantity)/(v_total+v_quantity),6) end)
  on conflict(product_id) do update set average_cost_nio=excluded.average_cost_nio,updated_at=now();
 end loop;
 return v_id;
end $$;

create or replace function private.record_expense(p_input jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_request uuid; v_existing public.expense_records%rowtype;
 v_amount numeric; v_rate numeric; v_date date; v_id uuid;
begin
 if v_uid is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 v_request:=(p_input->>'requestId')::uuid;
 if v_request is null then raise exception 'Falta el identificador de operación.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('expense:'||v_uid::text||v_request::text,0));
 select * into v_existing from public.expense_records where created_by=v_uid and request_id=v_request;
 if found then
  if v_existing.request_payload<>p_input then raise exception 'La operación ya existe con otros datos.'; end if;
  return v_existing.id;
 end if;
 v_amount:=private.accounting_number(p_input,'amount',1000000000);
 v_rate:=private.accounting_rate(p_input);
 if v_amount<=0 then raise exception 'Revisa el monto del gasto.'; end if;
 v_date:=(p_input->>'incurredOn')::date;
 if v_date is null or v_date>(now() at time zone 'America/Managua')::date then raise exception 'Fecha de gasto inválida.'; end if;
 perform private.limit_catalog_writes();
 insert into public.expense_records(request_id,request_payload,incurred_on,category,description,amount,currency,exchange_rate,reference,created_by)
 values(v_request,p_input,v_date,p_input->>'category',trim(p_input->>'description'),v_amount,p_input->>'currency',v_rate,coalesce(p_input->>'reference',''),v_uid) returning id into v_id;
 return v_id;
end $$;

create function public.record_shipment(p_input jsonb) returns uuid language sql security invoker set search_path='' as $$select private.record_shipment(p_input)$$;
revoke all on function private.record_shipment(jsonb),public.record_shipment(jsonb) from public,anon,authenticated;
grant execute on function private.record_shipment(jsonb),public.record_shipment(jsonb) to authenticated;

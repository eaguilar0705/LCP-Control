-- Una compra ingresada por error como conteo ya tiene sus unidades y valor.
-- Se reclasifica su origen, conservando el movimiento y el respaldo anterior.
-- Nunca se repiten entradas, promedios, precios ni pagos.
create table private.inventory_purchase_adoptions (
 id uuid primary key references public.purchase_shipments(id) deferrable initially deferred,
 actor_id uuid not null references private.business_actors(id),
 actor_name text not null, request_id uuid not null, request_payload jsonb not null,
 transaction_id bigint not null, created_at timestamptz not null default now(),
 unique(actor_id,request_id)
);
create table private.inventory_purchase_links (
 movement_id uuid primary key references public.inventory_movements(id),
 shipment_id uuid not null references private.inventory_purchase_adoptions(id),
 gain_snapshot jsonb not null, movement_snapshot jsonb not null
);
create index inventory_purchase_links_shipment on private.inventory_purchase_links(shipment_id);
alter table private.inventory_purchase_adoptions enable row level security;
alter table private.inventory_purchase_links enable row level security;
revoke all on private.inventory_purchase_adoptions,private.inventory_purchase_links from public,anon,authenticated;

-- La corrección del origen se permite en una jornada cerrada únicamente en
-- el contexto privado y auditado de esta operación del SuperAdmin.
do $$ declare d text; begin
 d:=replace(pg_get_functiondef('private.guard_business_day()'::regprocedure),E'\r\n',E'\n');
 d:=replace(d,E'begin\n',E'begin\n if tg_table_name=''purchase_shipments'' and tg_op=''INSERT'' then\n  if private.is_superadmin() and exists(select 1 from private.inventory_purchase_adoptions a where a.id=new.id and a.actor_id=auth.uid() and a.transaction_id=txid_current()) then return new; end if;\n end if;\n');
 execute d;
end $$;

create function private.count_purchase_context(p_movement uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.inventory_movements%rowtype;g jsonb;v_shipment uuid;
begin
 if auth.uid() is null or not private.is_superadmin() then raise insufficient_privilege; end if;
 select * into m from public.inventory_movements where id=p_movement;
 if not found or m.type<>'ADJUSTMENT' or m.after_quantity<=coalesce(m.before_quantity,0) then
  raise exception 'Selecciona un ajuste que haya agregado existencias.';
 end if;
 select shipment_id,gain_snapshot into v_shipment,g from private.inventory_purchase_links where movement_id=p_movement;
 if v_shipment is null then select to_jsonb(x) into g from private.inventory_count_gains x where movement_id=p_movement; end if;
 if g is null or g->>'unit_cost_nio' is null then
  raise exception 'Este conteo no tiene un valor contable reconocido para reclasificar. Revisa primero el costo del ingreso.';
 end if;
 return jsonb_build_object('movementId',m.id,'shipmentId',v_shipment,'productName',(select name from public.products where id=m.product_id),
 'quantity',(g->>'quantity')::integer,'valueNio',round((g->>'quantity')::numeric*(g->>'unit_cost_nio')::numeric,2),
 'occurredOn',(m.created_at at time zone 'America/Managua')::date);
end $$;
create function public.count_purchase_context(p_movement uuid) returns jsonb
language sql security invoker set search_path='' as $$select private.count_purchase_context(p_movement)$$;

create function private.adopt_inventory_counts_as_purchase(p_input jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_request uuid;v_id uuid:=gen_random_uuid();a private.inventory_purchase_adoptions%rowtype;
 m public.inventory_movements%rowtype;g private.inventory_count_gains%rowtype;
 v_movement uuid;v_ids uuid[];v_day date;v_date date;v_units integer:=0;v_total numeric:=0;
 v_rows jsonb:='[]';v_row jsonb;v_payload jsonb;v_reference text;v_name text;
begin
 if auth.uid() is null or not private.is_superadmin() then raise insufficient_privilege; end if;
 if jsonb_typeof(p_input) is distinct from 'object' then raise exception 'Revisa los datos de la regularización.'; end if;
 v_request:=(p_input->>'requestId')::uuid;
 if v_request is null then raise exception 'Falta identificar la regularización.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('finance-credit-ledger',0));
 perform pg_advisory_xact_lock(hashtextextended('count-purchase:'||auth.uid()::text||v_request::text,0));
 select * into a from private.inventory_purchase_adoptions where actor_id=auth.uid() and request_id=v_request;
 if found then
  if a.request_payload is distinct from p_input then raise exception 'La solicitud cambió. Verifica el guardado original.'; end if;
  return a.id;
 end if;
 if jsonb_typeof(p_input->'movementIds') is distinct from 'array' or jsonb_array_length(p_input->'movementIds') not between 1 and 100 then
  raise exception 'Selecciona de uno a cien ingresos para regularizar.';
 end if;
 select array_agg(value::uuid order by value::uuid) into v_ids from jsonb_array_elements_text(p_input->'movementIds');
 if cardinality(v_ids)<>(select count(distinct x) from unnest(v_ids)x) then raise exception 'Cada ingreso debe aparecer una sola vez.'; end if;
 foreach v_movement in array v_ids loop
  select * into m from public.inventory_movements where id=v_movement for update;
  if not found or m.type<>'ADJUSTMENT' or m.after_quantity<=coalesce(m.before_quantity,0) or m.document_id is not null then
   raise exception 'Uno de los movimientos no es un ingreso de unidades por conteo.';
  end if;
  if exists(select 1 from private.inventory_purchase_links where movement_id=m.id) then
   raise exception 'Este ingreso ya se registró como compra. Consúltalo en Inventario → Compras.';
  end if;
  select * into g from private.inventory_count_gains where movement_id=m.id for update;
  if not found or g.unit_cost_nio is null or g.unit_cost_nio<=0 or g.quantity<>m.after_quantity-coalesce(m.before_quantity,0) then
   raise exception 'El ingreso necesita un valor contable reconocido antes de regularizarlo.';
  end if;
  v_date:=(m.created_at at time zone 'America/Managua')::date;
  if v_day is not null and v_date<>v_day then raise exception 'Agrupa únicamente ingresos del mismo día.'; end if;
  if exists(select 1 from jsonb_array_elements(v_rows)r where r->>'productId'=m.product_id::text) then
   raise exception 'Regulariza por separado los ingresos repetidos del mismo perfume.';
  end if;
  v_day:=v_date;v_units:=v_units+g.quantity;v_total:=v_total+round(g.quantity*g.unit_cost_nio,2);
  select name into v_name from public.products where id=m.product_id;
  v_rows:=v_rows||jsonb_build_array(jsonb_build_object('movementId',m.id,'productId',m.product_id,'productName',v_name,
   'location',m.location,'quantity',g.quantity,'unitPrice',g.unit_cost_nio,'amount',round(g.quantity*g.unit_cost_nio,2),
   'movementSnapshot',to_jsonb(m),'gainSnapshot',to_jsonb(g)));
 end loop;
 if v_total is distinct from (p_input->>'expectedTotalNio')::numeric then raise exception 'El valor del ingreso cambió. Actualiza y revisa la regularización.'; end if;
 v_reference:='REG-'||to_char(v_day,'YYYYMMDD')||'-'||left(v_id::text,8);
 select display_name into v_name from public.staff_members where user_id=auth.uid();
 insert into private.inventory_purchase_adoptions(id,actor_id,actor_name,request_id,request_payload,transaction_id)
 values(v_id,auth.uid(),coalesce(v_name,'SuperAdmin'),v_request,p_input,txid_current());
 v_payload:=jsonb_build_object('requestId',v_request,'incurredOn',v_day,'supplier','','agency','','reference',v_reference,
  'note','Compra regularizada desde un ingreso por conteo. Se conserva el valor previo; revisar costo, proveedor y clasificación.',
  'currency','NIO','exchangeRate',1,'account','pending','shippingAmount',0,
  'sourceMovementIds',p_input->'movementIds','lines',(select jsonb_agg(jsonb_build_object('productId',r->>'productId','location',r->>'location','quantity',r->'quantity','unitPrice',r->'unitPrice')) from jsonb_array_elements(v_rows)r));
 insert into public.purchase_shipments(id,request_id,request_payload,incurred_on,supplier,agency,reference,note,currency,exchange_rate,shipping_amount,goods_amount,units,shipping_per_unit,created_by,account)
 values(v_id,v_request,v_payload,v_day,'','',v_reference,v_payload->>'note','NIO',1,0,v_total,v_units,0,auth.uid(),'pending');
 for v_row in select value from jsonb_array_elements(v_rows) loop
  insert into private.inventory_purchase_links(movement_id,shipment_id,gain_snapshot,movement_snapshot)
  values((v_row->>'movementId')::uuid,v_id,v_row->'gainSnapshot',v_row->'movementSnapshot');
  insert into public.purchase_shipment_lines(shipment_id,product_id,location,quantity,unit_price,goods_amount,shipping_share,landed_unit_cost_nio,product_name,product_sku)
  values(v_id,(v_row->>'productId')::uuid,v_row->>'location',(v_row->>'quantity')::integer,(v_row->>'unitPrice')::numeric,
   (v_row->>'amount')::numeric,0,(v_row->>'unitPrice')::numeric,v_row->>'productName',(select sku from public.products where id=(v_row->>'productId')::uuid));
  -- Solo cambia la clasificación contable derivada. Su respaldo completo
  -- queda archivado arriba; el movimiento de inventario original permanece.
  delete from private.inventory_count_gains where movement_id=(v_row->>'movementId')::uuid;
 end loop;
 return v_id;
end $$;
create function public.adopt_inventory_counts_as_purchase(p_input jsonb) returns uuid
language sql security invoker set search_path='' as $$select private.adopt_inventory_counts_as_purchase(p_input)$$;
revoke all on function private.count_purchase_context(uuid),public.count_purchase_context(uuid),
 private.adopt_inventory_counts_as_purchase(jsonb),public.adopt_inventory_counts_as_purchase(jsonb) from public,anon,authenticated;
grant execute on function private.count_purchase_context(uuid),public.count_purchase_context(uuid),
 private.adopt_inventory_counts_as_purchase(jsonb),public.adopt_inventory_counts_as_purchase(jsonb) to authenticated;

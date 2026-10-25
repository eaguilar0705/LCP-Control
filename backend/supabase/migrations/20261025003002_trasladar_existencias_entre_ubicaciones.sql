-- Un traslado conserva la propiedad, el costo y las unidades totales.
-- Su historial es independiente de compras, ventas, salidas y mermas.
create table public.inventory_transfers (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null,
 request_payload jsonb not null,
 product_id uuid not null references public.products(id),
 product_sku text not null,
 product_name text not null,
 from_location text not null check(from_location in ('warehouse','store')),
 to_location text not null check(to_location in ('warehouse','store')),
 quantity integer not null check(quantity between 1 and 1000000),
 from_before integer not null check(from_before>=0),
 from_after integer not null check(from_after>=0),
 to_before integer not null check(to_before>=0),
 to_after integer not null check(to_after between 0 and 1000000),
 note text not null check(length(btrim(note)) between 1 and 2000),
 actor_id uuid not null references private.business_actors(id),
 actor_name text not null,
 created_at timestamptz not null default now(),
 unique(actor_id,request_id),
 check(from_location<>to_location),
 check(from_before-from_after=quantity and to_after-to_before=quantity)
);
create index inventory_transfers_product_created_idx on public.inventory_transfers(product_id,created_at desc,id desc);
create index inventory_transfers_created_idx on public.inventory_transfers(created_at desc,id desc);
alter table public.inventory_transfers enable row level security;
revoke all on public.inventory_transfers from anon,authenticated;
grant select on public.inventory_transfers to authenticated;
create policy staff_read_transfers on public.inventory_transfers for select to authenticated
 using ((select private.staff_role()) in ('admin','warehouse','viewer'));
create trigger business_day_guard before insert or update or delete on public.inventory_transfers
 for each row execute function private.guard_business_day();

create function private.transfer_inventory(p_input jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 v_uid uuid:=auth.uid(); v_role text:=private.staff_role();
 v_request uuid:=(p_input->>'requestId')::uuid;
 v_product uuid:=(p_input->>'productId')::uuid;
 v_from text:=p_input->>'fromLocation'; v_to text:=p_input->>'toLocation';
 v_qty integer; v_before_from integer; v_before_to integer;
 v_note text:=btrim(coalesce(p_input->>'note',''));
 v_old public.inventory_transfers%rowtype; v_id uuid; v_count integer; v_perfume public.products%rowtype;
begin
 if v_uid is null or v_role is null or v_role not in ('admin','warehouse') then raise insufficient_privilege; end if;
 if v_request is null or v_product is null then raise exception 'Selecciona un perfume y vuelve a intentar el traslado.'; end if;
 if v_from is null or v_to is null or v_from not in ('warehouse','store') or v_to not in ('warehouse','store') or v_from=v_to then
  raise exception 'Selecciona ubicaciones de origen y destino diferentes.';
 end if;
 if jsonb_typeof(p_input->'quantity') is distinct from 'number'
  or (p_input->>'quantity')::numeric<>trunc((p_input->>'quantity')::numeric)
  or (p_input->>'quantity')::numeric not between 1 and 1000000 then
  raise exception 'La cantidad del traslado debe ser entera, entre 1 y 1000000.';
 end if;
 v_qty:=(p_input->>'quantity')::integer;
 if length(v_note) not between 1 and 2000 then raise exception 'Indica el motivo del traslado (hasta 2000 caracteres).'; end if;
 -- Mismo orden que ventas y compras: jornada, solicitud, producto, ubicaciones.
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended(v_uid::text||v_request::text,0));
 select * into v_old from public.inventory_transfers where actor_id=v_uid and request_id=v_request;
 if found then
  if v_old.request_payload<>p_input then raise exception 'Este traslado ya se guardó con otros datos. Consulta su historial.'; end if;
  return v_old.id;
 end if;
 if not exists(select 1 from public.business_days where day=(now() at time zone 'America/Managua')::date and closed_at is null) then
  raise exception 'La tienda está cerrada. Un administrador debe abrir la jornada desde Inicio.';
 end if;
 perform private.enforce_rate_limit('record_inventory_movement');
 select * into v_perfume from public.products where id=v_product and active for update;
 if not found then raise exception 'El perfume ya no está disponible. Actualiza el inventario.'; end if;
 perform 1 from public.inventory_balances where product_id=v_product order by location for update;
 select quantity into v_before_from from public.inventory_balances where product_id=v_product and location=v_from;
 select quantity into v_before_to from public.inventory_balances where product_id=v_product and location=v_to;
 if v_before_from is null or v_before_to is null then
  raise exception 'Registra primero el conteo inicial en Bodega y Tienda, aunque sea cero. Solicítalo al administrador.';
 end if;
 if v_qty>v_before_from then
  raise exception 'Solo hay % unidades en %. Actualiza el inventario y revisa la cantidad.',v_before_from,case v_from when 'store' then 'Tienda' else 'Bodega' end;
 end if;
 if v_before_to::bigint+v_qty>1000000 then raise exception 'El destino superaría 1000000 unidades. Revisa la cantidad.'; end if;
 insert into public.inventory_transfers(request_id,request_payload,product_id,product_sku,product_name,from_location,to_location,quantity,
  from_before,from_after,to_before,to_after,note,actor_id,actor_name)
 values(v_request,p_input,v_product,v_perfume.sku,v_perfume.name,v_from,v_to,v_qty,v_before_from,v_before_from-v_qty,
  v_before_to,v_before_to+v_qty,v_note,v_uid,
  coalesce((select nullif(display_name,'') from public.staff_members where user_id=v_uid),'Usuario')) returning id into v_id;
 update public.inventory_balances set quantity=case location when v_from then v_before_from-v_qty else v_before_to+v_qty end,updated_at=now()
 where product_id=v_product and location in(v_from,v_to);
 get diagnostics v_count=row_count;
 if v_count<>2 then raise exception 'No se pudo confirmar ambas ubicaciones. Actualiza el inventario y vuelve a intentar.'; end if;
 return v_id;
end $$;
revoke all on function private.transfer_inventory(jsonb) from public,anon;
grant execute on function private.transfer_inventory(jsonb) to authenticated;
create function public.transfer_inventory(p_input jsonb) returns uuid
language sql security invoker set search_path='' as $$select private.transfer_inventory(p_input)$$;
revoke all on function public.transfer_inventory(jsonb) from public,anon;
grant execute on function public.transfer_inventory(jsonb) to authenticated;

-- El historial del traslado también impide borrar físicamente su perfume.
do $migration$
declare v_definition text;
 v_anchor text:='or exists(select 1 from private.import_rows where product_id=p_id) then';
begin
 v_definition:=pg_get_functiondef('public.remove_catalog_product(uuid,integer)'::regprocedure);
 if position(v_anchor in v_definition)=0 then raise exception 'No se encontró la protección del historial del perfume.'; end if;
 execute replace(v_definition,v_anchor,
  'or exists(select 1 from public.inventory_transfers where product_id=p_id) '||v_anchor);
end $migration$;
notify pgrst,'reload schema';

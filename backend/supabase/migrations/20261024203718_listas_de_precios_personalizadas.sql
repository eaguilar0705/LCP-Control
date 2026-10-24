-- Las listas adicionales comienzan sin importes. Ningún precio, existencia,
-- costo ni documento previo cambia al crear una lista.
alter table public.price_tiers drop constraint price_tiers_code_check;
alter table public.price_tiers add constraint price_tiers_code_check
 check(code ~ '^[a-z][a-z0-9_]{0,63}$');
alter table public.price_tiers add constraint price_tiers_name_check
 check(length(btrim(name)) between 1 and 80);
create unique index price_tiers_name_unique on public.price_tiers(lower(btrim(name)));

create table private.price_list_operations (
 actor_id uuid not null references private.business_actors(id),
 request_id uuid not null,
 kind text not null check(kind in ('create','prices')),
 payload jsonb not null,
 result jsonb not null,
 created_at timestamptz not null default now(),
 primary key(actor_id,request_id)
);
alter table private.price_list_operations enable row level security;
revoke all on private.price_list_operations from public,anon,authenticated;

create function private.create_price_tier(p_input jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare
 v_request uuid:=(p_input->>'requestId')::uuid;
 v_name text:=regexp_replace(btrim(coalesce(p_input->>'name','')),'\s+',' ','g');
 v_code text; v_order integer; v_saved private.price_list_operations%rowtype;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_request is null then raise exception 'Falta el identificador de la operación.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 select * into v_saved from private.price_list_operations where actor_id=auth.uid() and request_id=v_request;
 if found then
  if v_saved.kind<>'create' or v_saved.payload<>p_input then raise exception 'La operación ya existe con otros datos.'; end if;
  return v_saved.result#>>'{}';
 end if;
 if length(v_name) not between 1 and 80 then raise exception 'Escribe un nombre de lista de entre 1 y 80 caracteres.'; end if;
 if exists(select 1 from public.price_tiers where lower(btrim(name))=lower(v_name)) then raise exception 'Ya existe una lista con ese nombre.'; end if;
 if (select count(*) from public.price_tiers)>=50 then raise exception 'Se alcanzó el máximo de 50 listas de precios.'; end if;
 perform private.limit_catalog_writes();
 v_code:='lista_'||replace(v_request::text,'-','');
 select coalesce(max(sort_order),0)+1 into v_order from public.price_tiers;
 insert into public.price_tiers(code,name,sort_order) values(v_code,v_name,v_order);
 insert into private.price_list_operations(actor_id,request_id,kind,payload,result)
 values(auth.uid(),v_request,'create',p_input,to_jsonb(v_code));
 return v_code;
end $$;
revoke all on function private.create_price_tier(jsonb) from public,anon,authenticated;
grant execute on function private.create_price_tier(jsonb) to authenticated;
create function public.create_price_tier(p_input jsonb) returns text
language sql security invoker set search_path='' as $$select private.create_price_tier(p_input)$$;
revoke all on function public.create_price_tier(jsonb) from public,anon;
grant execute on function public.create_price_tier(jsonb) to authenticated;

create function private.save_price_list(p_input jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare
 v_request uuid:=(p_input->>'requestId')::uuid;
 v_tier text:=p_input->>'tier'; v_currency text:=p_input->>'currency';
 v_line jsonb; v_product public.products%rowtype; v_saved private.price_list_operations%rowtype;
 v_amount numeric; v_usd numeric; v_nio numeric; v_rate numeric; v_before jsonb; v_count integer:=0;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_request is null then raise exception 'Falta el identificador de la operación.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 select * into v_saved from private.price_list_operations where actor_id=auth.uid() and request_id=v_request;
 if found then
  if v_saved.kind<>'prices' or v_saved.payload<>p_input then raise exception 'La operación ya existe con otros datos.'; end if;
  return (v_saved.result#>>'{}')::integer;
 end if;
 if v_tier is null or not exists(select 1 from public.price_tiers where code=v_tier) then raise exception 'Lista de precios no encontrada.'; end if;
 if v_currency is null or v_currency not in ('NIO','USD') then raise exception 'Selecciona córdobas o dólares.'; end if;
 if jsonb_typeof(p_input->'rows') is distinct from 'array' then raise exception 'Agrega los precios que deseas guardar.'; end if;
 if jsonb_array_length(p_input->'rows') not between 1 and 1000 then raise exception 'Guarda entre 1 y 1000 precios por operación.'; end if;
 if (select count(distinct x->>'productId') from jsonb_array_elements(p_input->'rows') x)<>jsonb_array_length(p_input->'rows') then raise exception 'No repitas perfumes en la lista.'; end if;
 select usd_to_nio into v_rate from public.exchange_rates where id for share;
 if v_rate is null then raise exception 'Registra el tipo de cambio en Negocio antes de guardar precios.'; end if;
 perform private.limit_catalog_writes();
 -- El mismo orden de productos que la facturación evita bloqueos cruzados.
 for v_line in select x from jsonb_array_elements(p_input->'rows') x order by x->>'productId' loop
  select * into v_product from public.products where id=(v_line->>'productId')::uuid for update;
  if not found or not v_product.active then raise exception 'Un perfume ya no está disponible. Actualiza la lista.'; end if;
  if jsonb_typeof(v_line->'revision') is distinct from 'number'
   or (v_line->>'revision')::numeric<>trunc((v_line->>'revision')::numeric)
   or v_product.revision is distinct from (v_line->>'revision')::integer then
   raise exception 'Otro usuario cambió «%». Actualiza la lista antes de guardar.',v_product.name;
  end if;
  if jsonb_typeof(v_line->'amount') is distinct from 'number' then raise exception 'Escribe un precio para cada perfume modificado.'; end if;
  v_amount:=(v_line->>'amount')::numeric;
  if v_amount<=0 or v_amount>10000000 or v_amount<>round(v_amount,2) then raise exception 'Los precios deben ser positivos y tener hasta dos decimales.'; end if;
  if exists(select 1 from private.markup_rules where product_id=v_product.id and tier=v_tier) then
   raise exception 'El precio de «%» se calcula desde su precio de compra. Cámbialo desde su ficha.',v_product.name;
  end if;
  v_usd:=private.convert_price(v_amount,v_currency,'USD',v_rate);
  v_nio:=greatest(round(v_usd*v_rate,2),0.01);
  if v_usd>10000000 or v_nio>10000000 then raise exception 'El precio convertido es demasiado alto.'; end if;
  if (select count(*) from public.product_prices where product_id=v_product.id and tier_code=v_tier
      and ((currency='USD' and amount=v_usd) or (currency='NIO' and amount=v_nio)))=2 then continue; end if;
  v_before:=to_jsonb(v_product)||jsonb_build_object('prices',private.product_price_rows(v_product.id),
   'pricing',(select to_jsonb(r) from public.product_pricing r where r.product_id=v_product.id));
  insert into public.product_prices(product_id,tier_code,currency,amount)
  values(v_product.id,v_tier,'USD',v_usd),(v_product.id,v_tier,'NIO',v_nio)
  on conflict(product_id,tier_code,currency) do update set amount=excluded.amount;
  update public.products set revision=revision+1 where id=v_product.id returning * into v_product;
  insert into private.catalog_changes(product_id,actor_id,action,before_data,after_data)
  values(v_product.id,auth.uid(),'pricing',v_before,to_jsonb(v_product)||private.pricing_after_data(v_product.id,v_rate));
  v_count:=v_count+1;
 end loop;
 insert into private.price_list_operations(actor_id,request_id,kind,payload,result)
 values(auth.uid(),v_request,'prices',p_input,to_jsonb(v_count));
 return v_count;
end $$;
revoke all on function private.save_price_list(jsonb) from public,anon,authenticated;
grant execute on function private.save_price_list(jsonb) to authenticated;
create function public.save_price_list(p_input jsonb) returns integer
language sql security invoker set search_path='' as $$select private.save_price_list(p_input)$$;
revoke all on function public.save_price_list(jsonb) from public,anon;
grant execute on function public.save_price_list(jsonb) to authenticated;

-- Se conserva la implementación actual de ventas (jornadas, bancos, costos,
-- precios confirmados e idempotencia) y se amplía únicamente la lista válida.
do $migration$
declare v_definition text;
begin
 v_definition:=pg_get_functiondef('private.create_document(jsonb)'::regprocedure);
 if position($old$v_tier not in ('emprendedor','vip','premium')$old$ in v_definition)=0 then
  raise exception 'No se encontró la validación de listas de facturación esperada.';
 end if;
 v_definition:=replace(v_definition,$old$v_tier not in ('emprendedor','vip','premium')$old$,
  $new$not exists(select 1 from public.price_tiers where code=v_tier)$new$);
 execute v_definition;

 v_definition:=pg_get_functiondef('private.save_catalog_product_before_excel_import(jsonb)'::regprocedure);
 if position($old$foreach v_tier in array array['emprendedor','vip','premium'] loop$old$ in v_definition)=0 then
  raise exception 'No se encontró la edición de precios esperada.';
 end if;
 v_definition:=replace(v_definition,$old$foreach v_tier in array array['emprendedor','vip','premium'] loop$old$,
 $new$if jsonb_typeof(p_payload->'prices') is distinct from 'object' then raise exception 'Revisa los precios del perfume.'; end if;
 if exists(select 1 from jsonb_object_keys(p_payload->'prices') k where not exists(select 1 from public.price_tiers where code=k)) then
  raise exception 'Una lista de precios ya no está disponible. Vuelve a abrir el perfume.';
 end if;
 v_prices:=private.product_price_snapshot(v_id);
 for v_tier in select code from public.price_tiers order by sort_order,code loop
  if v_tier not in ('emprendedor','vip','premium') and not (p_payload->'prices' ? v_tier) then continue; end if;$new$);
 execute v_definition;

 v_definition:=pg_get_functiondef('private.price_history(uuid)'::regprocedure);
 if position($old$cross join unnest(array['emprendedor','vip','premium']) as t(tier)$old$ in v_definition)=0 then
  raise exception 'No se encontró el historial de precios esperado.';
 end if;
 v_definition:=replace(v_definition,$old$cross join unnest(array['emprendedor','vip','premium']) as t(tier)$old$,
  $new$cross join (select code as tier from public.price_tiers) t$new$);
 execute v_definition;
end $migration$;

notify pgrst,'reload schema';

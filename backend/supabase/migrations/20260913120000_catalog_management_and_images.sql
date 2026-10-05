-- Administrators manage the catalogue through transactional RPCs. Existing
-- documents retain their snapshots and stock is changed only by movement RPCs.
alter table public.products drop constraint products_category_check;
alter table public.products add constraint products_category_check check(category in ('arabian','designer','niche'));
alter table public.products add column image_path text;
alter table public.products add column revision integer not null default 1;
create sequence private.product_sku_sequence;
select setval('private.product_sku_sequence', greatest(1, coalesce((select max(substring(sku from '^LCP-([0-9]+)$')::bigint) from public.products),0)), exists(select 1 from public.products));
revoke all on sequence private.product_sku_sequence from public, anon, authenticated;

create table private.catalog_changes (
 id bigint generated always as identity primary key,
 product_id uuid not null, actor_id uuid not null references auth.users(id),
 action text not null, before_data jsonb, after_data jsonb, created_at timestamptz not null default now()
);
alter table private.catalog_changes enable row level security;
revoke all on private.catalog_changes from public, anon, authenticated;

create function private.limit_catalog_writes() returns void language plpgsql security definer set search_path='' as $$
declare v_hits integer; v_window timestamptz:=date_trunc('minute',now());
begin
 insert into private.rate_limits as l(user_id,action,window_start,hits) values(auth.uid(),'catalog',v_window,1)
 on conflict(user_id,action) do update set window_start=excluded.window_start,hits=case when l.window_start=excluded.window_start then l.hits+1 else 1 end
 returning hits into v_hits;
 if v_hits>120 then raise exception 'Demasiados cambios seguidos. Espera un minuto e inténtalo de nuevo.'; end if;
end $$;
revoke all on function private.limit_catalog_writes() from public,anon,authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('product-images','product-images',false,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy product_images_read on storage.objects for select to authenticated using (
 bucket_id='product-images' and (select private.staff_role()) in ('admin','operator')
);
create policy product_images_insert on storage.objects for insert to authenticated with check (
 bucket_id='product-images' and (select private.staff_role())='admin'
 and (storage.foldername(name))[1]=(select auth.uid())::text
);
-- Images are immutable: replacing one creates a new path, avoiding stale caches.
create policy product_images_remove_unused on storage.objects for delete to authenticated using (
 bucket_id='product-images' and (select private.staff_role())='admin'
 and not exists(select 1 from public.products p where p.image_path=storage.objects.name)
);

create function public.save_catalog_product(p_payload jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 v_id uuid:=(p_payload->>'id')::uuid; v_old public.products%rowtype; v_new public.products%rowtype;
 v_brand uuid; v_tier text; v_currency text; v_amount numeric; v_image text:=nullif(p_payload->>'imagePath','');
 v_size numeric:=(p_payload->>'size')::numeric; v_min numeric:=(p_payload->>'minimumStock')::numeric;
 v_before jsonb; v_sku text;
begin
 if (select private.staff_role()) is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_id is null then raise exception 'Falta el identificador del producto.'; end if;
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
 select to_jsonb(v_old)||jsonb_build_object('prices',(select jsonb_agg(to_jsonb(pp)) from public.product_prices pp where product_id=v_id)) into v_before;
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
 foreach v_tier in array array['emprendedor','vip','premium'] loop
  foreach v_currency in array array['NIO','USD'] loop
   if jsonb_typeof(p_payload->'prices'->v_tier->v_currency) is distinct from 'number' then raise exception 'Completa los seis precios.'; end if;
   v_amount:=(p_payload->'prices'->v_tier->>v_currency)::numeric;
   if v_amount<=0 or v_amount>10000000 or v_amount<>round(v_amount,2) then raise exception 'Los precios deben ser positivos y tener hasta dos decimales.'; end if;
   insert into public.product_prices(product_id,tier_code,currency,amount) values(v_id,v_tier,v_currency,v_amount)
   on conflict(product_id,tier_code,currency) do update set amount=excluded.amount;
  end loop;
 end loop;
 insert into public.inventory_balances(product_id,location,quantity) values(v_id,'warehouse',null),(v_id,'store',null) on conflict do nothing;
 insert into private.catalog_changes(product_id,actor_id,action,before_data,after_data) values(v_id,auth.uid(),'save',v_before,to_jsonb(v_new)||jsonb_build_object('prices',p_payload->'prices'));
 return v_id;
exception when unique_violation then raise exception 'Ese código ya pertenece a otro producto.';
end $$;
revoke all on function public.save_catalog_product(jsonb) from public,anon;
grant execute on function public.save_catalog_product(jsonb) to authenticated;

create function public.remove_catalog_product(p_id uuid,p_revision integer) returns text
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
  delete from public.inventory_balances where product_id=p_id;
  delete from public.product_prices where product_id=p_id;
  delete from public.products where id=p_id; v_action:='deleted';
 end if;
 insert into private.catalog_changes(product_id,actor_id,action,before_data) values(p_id,auth.uid(),v_action,to_jsonb(v_old));
 return v_action;
end $$;
revoke all on function public.remove_catalog_product(uuid,integer) from public,anon;
grant execute on function public.remove_catalog_product(uuid,integer) to authenticated;

create function public.update_my_profile(p_name text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if (select private.staff_role()) is null then raise insufficient_privilege; end if;
 perform private.limit_catalog_writes();
 if length(trim(coalesce(p_name,''))) not between 1 and 100 then raise exception 'Ingresa un nombre de hasta 100 caracteres.'; end if;
 update public.staff_members set display_name=trim(p_name) where user_id=auth.uid() and active;
end $$;
revoke all on function public.update_my_profile(text) from public,anon;
grant execute on function public.update_my_profile(text) to authenticated;

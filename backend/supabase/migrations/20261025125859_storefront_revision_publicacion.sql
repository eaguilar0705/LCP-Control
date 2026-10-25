-- Public storefront and editorial workflow. Internal inventory stays private.
create table public.storefront_drafts (
 id uuid primary key default gen_random_uuid(),
 source_product_id uuid unique references public.products(id) on delete set null,
 source_snapshot jsonb not null default '{}'::jsonb,
 source_missing boolean not null default false,
 source_version bigint not null default 0,
 reviewed_source_version bigint not null default 0,
 content jsonb not null default '{}'::jsonb,
 revision bigint not null default 1,
 status text not null default 'pending' check(status in ('pending','draft','published','hidden','archived')),
 updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id) on delete set null
);
create table public.storefront_publications (
 id uuid primary key references public.storefront_drafts(id) on delete cascade,
 content jsonb not null,
 visible boolean not null default true,
 published_at timestamptz not null default now()
);
create index storefront_publication_images on public.storefront_publications using gin ((content->'images')) where visible;
create index storefront_draft_status on public.storefront_drafts(status,updated_at);
create table private.storefront_events (
 id bigint generated always as identity primary key,
 draft_id uuid not null,
 actor_id uuid,
 action text not null,
 revision bigint not null,
 happened_at timestamptz not null default now()
);
alter table public.storefront_drafts enable row level security;
alter table public.storefront_publications enable row level security;
alter table private.storefront_events enable row level security;
revoke all on public.storefront_drafts,public.storefront_publications from public,anon,authenticated;
revoke all on private.storefront_events from public,anon,authenticated;
grant select on public.storefront_drafts to authenticated;
grant select on public.storefront_publications to anon,authenticated;
create policy storefront_draft_admin on public.storefront_drafts for select to authenticated
 using ((select private.staff_role())='admin');
create policy storefront_published_read on public.storefront_publications for select to anon,authenticated
 using (visible);
create policy storefront_published_admin on public.storefront_publications for select to authenticated
 using ((select private.staff_role())='admin');

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('storefront-media','storefront-media',false,5242880,array['image/jpeg','image/png','image/webp']);
create policy storefront_media_admin_read on storage.objects for select to authenticated
 using(bucket_id='storefront-media' and (select private.staff_role())='admin');
create policy storefront_media_admin_insert on storage.objects for insert to authenticated
 with check(bucket_id='storefront-media' and (select private.staff_role())='admin'
 and (storage.foldername(name))[1]=(select auth.uid())::text);
-- No update/delete permission: changing an image creates an immutable new object.
-- Public downloads only. In particular, this policy cannot mint signed URLs.
create policy storefront_media_published_read on storage.objects for select to anon,authenticated
 using(bucket_id='storefront-media' and storage.allow_only_operation('object.get_authenticated')
 and exists(select 1 from public.storefront_publications p where p.visible
 and p.content->'images' @> jsonb_build_array(jsonb_build_object('kind','upload','path',storage.objects.name))));

create function private.storefront_content(p jsonb, publishing boolean default false)
returns jsonb language plpgsql immutable set search_path='' as $$
declare v_image jsonb; v_price numeric; v_images jsonb:=coalesce(p->'images','[]'::jsonb);
begin
 if jsonb_typeof(p) is distinct from 'object'
 or length(trim(coalesce(p->>'name',''))) not between 1 and 200
 or length(trim(coalesce(p->>'brand',''))) not between 1 and 100
 or length(coalesce(p->>'description',''))>1500
 or length(coalesce(p->>'size',''))>30
 or coalesce(p->>'unit','') not in ('oz','ml','set')
 or coalesce(p->>'category','') not in ('arabian','designer','niche','gourmand','other')
 or coalesce(p->>'gender','') not in ('female','male','unisex')
 or coalesce(p->>'availability','') not in ('available','on_request','unavailable')
 or jsonb_typeof(p->'price') is distinct from 'number'
 or jsonb_typeof(v_images) is distinct from 'array'
 then raise exception 'Revisa nombre, marca, categoría, presentación y precio público.'; end if;
 v_price:=(p->>'price')::numeric;
 if v_price<0 or v_price>100000 or v_price<>round(v_price,2) or jsonb_array_length(v_images)>4
 then raise exception 'Revisa el precio y las fotografías.'; end if;
 for v_image in select value from jsonb_array_elements(v_images) loop
  if coalesce(v_image->>'kind','') not in ('local','upload','control')
  or length(coalesce(v_image->>'path','')) not between 1 and 240
  or v_image->>'path' like '%..%'
  or (v_image->>'kind'='local' and v_image->>'path' !~ '^images/productos/[A-Za-z0-9_-]+\.(webp|png|jpg|jpeg)$')
  or (v_image->>'kind'='upload' and v_image->>'path' !~ '^[a-f0-9-]{36}/[a-f0-9-]{36}\.(webp|png|jpg|jpeg)$')
  or (v_image->>'kind'='control' and (publishing or v_image->>'path' !~ '^[A-Za-z0-9_./-]+$'))
  then raise exception 'La fotografía no está preparada para publicar.'; end if;
 end loop;
 return jsonb_build_object('name',trim(p->>'name'),'brand',trim(p->>'brand'),
 'size',coalesce(p->>'size',''),'unit',p->>'unit','category',p->>'category','gender',p->>'gender',
 'price',v_price,'description',trim(coalesce(p->>'description','')),
 'availability',p->>'availability','featured',coalesce((p->>'featured')::boolean,false),
 'images',(select coalesce(jsonb_agg(jsonb_build_object('kind',value->>'kind','path',value->>'path')),'[]'::jsonb) from jsonb_array_elements(v_images)));
end $$;
revoke all on function private.storefront_content(jsonb,boolean) from public,anon,authenticated;

create function private.storefront_sync_one(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare p public.products%rowtype; s jsonb; c jsonb;
begin
 select * into p from public.products where id=p_id;
 if not found or p.sku like 'DEMO-%' then return; end if;
 s:=jsonb_build_object('name',p.name,'brand',(select name from public.brands where id=p.brand_id),
 'size',coalesce(p.size::text,''),'unit',p.unit,'category',coalesce(p.category,'other'),
 'gender',coalesce(p.gender,'unisex'),'active',p.active,'sku',p.sku,'image_path',p.image_path);
 c:=jsonb_build_object('name',s->>'name','brand',s->>'brand','size',s->>'size','unit',s->>'unit',
 'category',s->>'category','gender',s->>'gender','price',0,'description','',
 'availability','on_request','featured',false,'images',case when p.image_path is null then '[]'::jsonb
 else jsonb_build_array(jsonb_build_object('kind','control','path',p.image_path)) end);
 insert into public.storefront_drafts(id,source_product_id,source_snapshot,source_version,content)
 values(p.id,p.id,s,1,c)
 on conflict(source_product_id) do update set source_snapshot=excluded.source_snapshot,
 source_version=storefront_drafts.source_version+1,revision=storefront_drafts.revision+1,
 status=case when storefront_drafts.status='archived' then 'archived' else 'pending' end,updated_at=now()
 where storefront_drafts.source_snapshot is distinct from excluded.source_snapshot;
 if not p.active then
  update public.storefront_publications set visible=false where id=(select id from public.storefront_drafts where source_product_id=p_id);
 end if;
end $$;
revoke all on function private.storefront_sync_one(uuid) from public,anon,authenticated;
create function private.storefront_product_changed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' then
  update public.storefront_publications set visible=false where id=(select id from public.storefront_drafts where source_product_id=old.id);
  update public.storefront_drafts set source_missing=true,source_version=source_version+1,
    revision=revision+1,status='hidden',updated_at=now() where source_product_id=old.id;
  return old;
 end if;
 perform private.storefront_sync_one(new.id);
 return new;
end $$;
revoke all on function private.storefront_product_changed() from public,anon,authenticated;
create trigger storefront_product_sync after insert or update of name,brand_id,size,unit,category,gender,image_path,active on public.products
 for each row execute function private.storefront_product_changed();
create trigger storefront_product_removed before delete on public.products
 for each row execute function private.storefront_product_changed();
create function private.storefront_brand_changed() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
 if old.name is distinct from new.name then
  for v_id in select id from public.products where brand_id=new.id order by id for update loop
   perform private.storefront_sync_one(v_id);
  end loop;
 end if;
 return new;
end $$;
revoke all on function private.storefront_brand_changed() from public,anon,authenticated;
create trigger storefront_brand_sync after update of name on public.brands for each row execute function private.storefront_brand_changed();

create function private.storefront_action(p_action text,p_id uuid,p_revision bigint,p_content jsonb,p_source_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.storefront_drafts%rowtype; c jsonb; v_image jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_id is null then raise exception 'Falta el perfume.'; end if;
 -- Same lock order as the source trigger: product, draft, publication.
 perform 1 from public.products where id=(select source_product_id from public.storefront_drafts where id=p_id) for share;
 select * into d from public.storefront_drafts where id=p_id for update;
 if not found then
  if p_action<>'save' or p_revision is distinct from 0 then raise exception 'El perfume ya no está disponible.'; end if;
  c:=private.storefront_content(p_content,false);
  insert into public.storefront_drafts(id,content,status,updated_by) values(p_id,c,'draft',auth.uid()) returning * into d;
 else
  if d.revision is distinct from p_revision then raise exception 'El perfume cambió. Actualiza y revisa la nueva versión antes de continuar.'; end if;
  if p_action='save' then
   if p_source_version is distinct from d.source_version then raise exception 'Llegaron cambios desde LCP-Control. Actualiza antes de guardar.'; end if;
   c:=private.storefront_content(p_content,false);
   update public.storefront_drafts set content=c,reviewed_source_version=source_version,
    status='draft',revision=revision+1,updated_at=now(),updated_by=auth.uid() where id=p_id returning * into d;
  elsif p_action='publish' then
   if d.source_missing or (d.source_product_id is not null and not coalesce((d.source_snapshot->>'active')::boolean,false)) then
    raise exception 'El perfume fue retirado de LCP-Control. No puede publicarse.'; end if;
   if d.reviewed_source_version<>d.source_version then raise exception 'Revisa y guarda los cambios de LCP-Control antes de publicar.'; end if;
   if d.status='archived' then raise exception 'Guarda primero el perfume para recuperarlo.'; end if;
   c:=private.storefront_content(d.content,true);
   for v_image in select value from jsonb_array_elements(c->'images') loop
    if v_image->>'kind'='upload' and not exists(select 1 from storage.objects where bucket_id='storefront-media' and name=v_image->>'path') then
     raise exception 'La fotografía no terminó de subirse. Intenta de nuevo.';
    end if;
   end loop;
   insert into public.storefront_publications(id,content,visible) values(p_id,c,true)
    on conflict(id) do update set content=excluded.content,visible=true,published_at=now();
   update public.storefront_drafts set status='published',revision=revision+1,updated_at=now(),updated_by=auth.uid()
    where id=p_id returning * into d;
  elsif p_action in ('hide','archive') then
   update public.storefront_publications set visible=false where id=p_id;
   update public.storefront_drafts set status=case when p_action='archive' then 'archived' else 'hidden' end,
    revision=revision+1,updated_at=now(),updated_by=auth.uid() where id=p_id returning * into d;
  else raise exception 'Acción no válida.';
  end if;
 end if;
 insert into private.storefront_events(draft_id,actor_id,action,revision) values(d.id,auth.uid(),p_action,d.revision);
 return to_jsonb(d);
end $$;
revoke all on function private.storefront_action(text,uuid,bigint,jsonb,bigint) from public,anon;
grant execute on function private.storefront_action(text,uuid,bigint,jsonb,bigint) to authenticated;
create function public.storefront_action(p_action text,p_id uuid,p_revision bigint,p_content jsonb default null,p_source_version bigint default null)
returns jsonb language sql security invoker set search_path='' as $$
 select private.storefront_action(p_action,p_id,p_revision,p_content,p_source_version)
$$;
revoke all on function public.storefront_action(text,uuid,bigint,jsonb,bigint) from public,anon;
grant execute on function public.storefront_action(text,uuid,bigint,jsonb,bigint) to authenticated;
create function private.storefront_sync() returns integer
language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_count integer:=0;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 for v_id in select id from public.products where sku not like 'DEMO-%' order by id for update loop
  perform private.storefront_sync_one(v_id); v_count:=v_count+1;
 end loop;
 return v_count;
end $$;
revoke all on function private.storefront_sync() from public,anon;
grant execute on function private.storefront_sync() to authenticated;
create function public.storefront_sync() returns integer language sql security invoker set search_path='' as $$select private.storefront_sync()$$;
revoke all on function public.storefront_sync() from public,anon;
grant execute on function public.storefront_sync() to authenticated;
-- Import current source records as drafts. No product is published by this migration.
do $$ declare v_id uuid; begin
 for v_id in select id from public.products where sku not like 'DEMO-%' order by id loop
  perform private.storefront_sync_one(v_id);
 end loop;
end $$;

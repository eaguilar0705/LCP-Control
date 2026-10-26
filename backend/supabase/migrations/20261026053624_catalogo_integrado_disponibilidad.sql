-- Automatic availability, with explicit editorial decisions for source removal.
alter table public.storefront_drafts
 add column inventory_managed boolean not null default true,
 add column hide_unavailable boolean not null default false,
 add column inventory_state text not null default 'unknown' check(inventory_state in ('available','unavailable','unknown','retired','manual')),
 add column removal_state text check(removal_state in ('pending','kept','accepted'));
update public.storefront_drafts set inventory_managed=false where source_product_id is null and not source_missing;
alter table public.storefront_publications
 add column listed boolean not null default true,
 add column inventory_managed boolean not null default true,
 add column hide_unavailable boolean not null default false;
update public.storefront_publications p set listed=p.visible,inventory_managed=d.inventory_managed from public.storefront_drafts d where d.id=p.id;
-- Anonymous clients receive only approved public fields, never configuration or stock.
revoke select on public.storefront_publications from anon;
grant select(id,content,visible,published_at) on public.storefront_publications to anon;

create function private.storefront_stock(p_id uuid) returns text
language sql stable security definer set search_path='' as $$
 select case when coalesce(sum(quantity),0)>0 then 'available'
 when count(quantity)=2 then 'unavailable' else 'unknown' end
 from public.inventory_balances where product_id=p_id
$$;
revoke all on function private.storefront_stock(uuid) from public,anon,authenticated;

create function private.storefront_availability(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare d public.storefront_drafts%rowtype; state text; retired boolean;
begin
 select * into d from public.storefront_drafts where id=p_id for update;
 if not found then return; end if;
 retired:=d.source_missing or (d.source_product_id is not null and not coalesce((d.source_snapshot->>'active')::boolean,false));
 state:=case when retired then 'retired' when d.source_product_id is null then 'manual' else private.storefront_stock(d.source_product_id) end;
 update public.storefront_drafts set inventory_state=state where id=p_id and inventory_state is distinct from state;
 update public.storefront_publications p set
  content=case when retired or p.inventory_managed then jsonb_set(p.content,'{availability}',to_jsonb(case when state='available' then 'available' else 'unavailable' end)) else p.content end,
  visible=case when retired then p.visible and p.listed else p.listed and (not p.hide_unavailable or
   case when p.inventory_managed then state='available' else p.content->>'availability'='available' end) end
 where p.id=p_id;
end $$;
revoke all on function private.storefront_availability(uuid) from public,anon,authenticated;

create function private.storefront_balance_changed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op<>'DELETE' then
 perform private.storefront_availability((select id from public.storefront_drafts where source_product_id=new.product_id));
 end if;
 if tg_op='DELETE' or (tg_op='UPDATE' and old.product_id is distinct from new.product_id) then
 perform private.storefront_availability((select id from public.storefront_drafts where source_product_id=old.product_id));
 end if;
 return null;
end $$;
revoke all on function private.storefront_balance_changed() from public,anon,authenticated;
create trigger storefront_balance_sync after insert or update or delete on public.inventory_balances
 for each row execute function private.storefront_balance_changed();
create or replace function private.storefront_sync_one(p_id uuid) returns void
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
 update public.storefront_drafts set removal_state=case when p.active then null else coalesce(removal_state,'pending') end
 where source_product_id=p_id;
 perform private.storefront_availability((select id from public.storefront_drafts where source_product_id=p_id));
end $$;
revoke all on function private.storefront_sync_one(uuid) from public,anon,authenticated;
create or replace function private.storefront_product_changed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' then
  update public.storefront_drafts set source_missing=true,source_version=source_version+1,
    removal_state='pending',revision=revision+1,status=case when status='archived' then status else 'pending' end,updated_at=now() where source_product_id=old.id;
  perform private.storefront_availability((select id from public.storefront_drafts where source_product_id=old.id));
  return old;
 end if;
 perform private.storefront_sync_one(new.id);
 return new;
end $$;
revoke all on function private.storefront_product_changed() from public,anon,authenticated;
create or replace function private.storefront_action(p_action text,p_id uuid,p_revision bigint,p_content jsonb,p_source_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.storefront_drafts%rowtype; c jsonb; v_image jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_content ? 'inventory_managed' and jsonb_typeof(p_content->'inventory_managed')<>'boolean'
 or p_content ? 'hide_unavailable' and jsonb_typeof(p_content->'hide_unavailable')<>'boolean' then
 raise exception 'Revisa las opciones de disponibilidad.'; end if;
 if p_id is null then raise exception 'Falta el perfume.'; end if;
 -- Same lock order as the source trigger: product, draft, publication.
 perform 1 from public.products where id=(select source_product_id from public.storefront_drafts where id=p_id) for share;
 select * into d from public.storefront_drafts where id=p_id for update;
 if not found then
  if p_action<>'save' or p_revision is distinct from 0 then raise exception 'El perfume ya no está disponible.'; end if;
  c:=private.storefront_content(p_content,false);
  insert into public.storefront_drafts(id,content,status,updated_by,inventory_managed,hide_unavailable) values(p_id,c,'draft',auth.uid(),false,coalesce((p_content->>'hide_unavailable')::boolean,false)) returning * into d;
 else
  if d.revision is distinct from p_revision then raise exception 'El perfume cambió. Actualiza y revisa la nueva versión antes de continuar.'; end if;
  if p_action='save' then
   if p_source_version is distinct from d.source_version then raise exception 'Llegaron cambios desde LCP-Control. Actualiza antes de guardar.'; end if;
   c:=private.storefront_content(p_content,false);
   update public.storefront_drafts set content=c,reviewed_source_version=source_version,
    inventory_managed=case when source_product_id is null and not source_missing then false else coalesce((p_content->>'inventory_managed')::boolean,inventory_managed) end,
    hide_unavailable=coalesce((p_content->>'hide_unavailable')::boolean,hide_unavailable),
    status='draft',revision=revision+1,updated_at=now(),updated_by=auth.uid() where id=p_id returning * into d;
  elsif p_action='publish' then
   if (d.source_missing or (d.source_product_id is not null and not coalesce((d.source_snapshot->>'active')::boolean,false))) and d.removal_state is distinct from 'kept' then
    raise exception 'El perfume fue retirado de LCP-Control. No puede publicarse.'; end if;
   if d.reviewed_source_version<>d.source_version then raise exception 'Revisa y guarda los cambios de LCP-Control antes de publicar.'; end if;
   if d.status='archived' then raise exception 'Guarda primero el perfume para recuperarlo.'; end if;
   c:=private.storefront_content(d.content,true);
   for v_image in select value from jsonb_array_elements(c->'images') loop
    if v_image->>'kind'='upload' and not exists(select 1 from storage.objects where bucket_id='storefront-media' and name=v_image->>'path') then
     raise exception 'La fotografía no terminó de subirse. Intenta de nuevo.';
    end if;
   end loop;
   insert into public.storefront_publications(id,content,visible,listed,inventory_managed,hide_unavailable)
    values(p_id,c,true,true,d.inventory_managed,d.hide_unavailable)
    on conflict(id) do update set content=excluded.content,visible=true,listed=true,
    inventory_managed=excluded.inventory_managed,hide_unavailable=excluded.hide_unavailable,published_at=now();
   update public.storefront_drafts set status='published',revision=revision+1,updated_at=now(),updated_by=auth.uid()
    where id=p_id returning * into d;
  elsif p_action in ('accept_removal','keep_removed') then
   if d.removal_state is distinct from 'pending' then raise exception 'Esta baja ya fue revisada.'; end if;
   update public.storefront_publications set listed=case when p_action='accept_removal' then false else listed end,
    visible=case when p_action='accept_removal' then false else listed end,
    content=jsonb_set(content,'{availability}','"unavailable"') where id=p_id;
   update public.storefront_drafts set removal_state=case when p_action='accept_removal' then 'accepted' else 'kept' end,
    reviewed_source_version=source_version,revision=revision+1,updated_at=now(),updated_by=auth.uid(),
    status=case when p_action='accept_removal' then 'archived' when exists(select 1 from public.storefront_publications where id=p_id and listed) then 'published' else 'draft' end
    where id=p_id returning * into d;
  elsif p_action='dismiss_source' then
   if d.removal_state='pending' then raise exception 'Decide primero qué hacer con la baja.'; end if;
   update public.storefront_drafts set reviewed_source_version=source_version,revision=revision+1,updated_at=now(),updated_by=auth.uid(),
    status=case when exists(select 1 from public.storefront_publications where id=p_id and listed) then 'published' else 'draft' end
    where id=p_id returning * into d;
  elsif p_action in ('hide','archive') then
   update public.storefront_publications set visible=false,listed=false where id=p_id;
   update public.storefront_drafts set status=case when p_action='archive' then 'archived' else 'hidden' end,
    removal_state=case when p_action='archive' and removal_state='pending' then 'accepted' else removal_state end,
    revision=revision+1,updated_at=now(),updated_by=auth.uid() where id=p_id returning * into d;
  else raise exception 'Acción no válida.';
  end if;
 end if;
 insert into private.storefront_events(draft_id,actor_id,action,revision) values(d.id,auth.uid(),p_action,d.revision);
 perform private.storefront_availability(p_id);
 select * into d from public.storefront_drafts where id=p_id;
 return to_jsonb(d);
end $$;

-- Preserve existing publications and editorial choices. Only availability changes.
update public.storefront_drafts set removal_state='pending',status='pending'
 where status<>'archived' and (source_missing or (source_product_id is not null and not coalesce((source_snapshot->>'active')::boolean,false)));
do $$ declare v_id uuid; begin
 for v_id in select id from public.storefront_drafts order by id loop perform private.storefront_availability(v_id); end loop;
end $$;

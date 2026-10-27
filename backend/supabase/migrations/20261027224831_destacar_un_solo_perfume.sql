-- Una sola portada; cambiarla no publica otros cambios del borrador ni toca inventario.
create function private.storefront_clear_featured(p_selected uuid)
returns void language plpgsql set search_path='' as $$
declare r record;
begin
 for r in select d.id from public.storefront_drafts d where d.id<>p_selected
  and (d.content->>'featured'='true' or exists(select 1 from public.storefront_publications p where p.id=d.id and p.content->>'featured'='true'))
  order by d.id for update of d loop
  update public.storefront_publications set content=jsonb_set(content,'{featured}','false') where id=r.id and content->>'featured'='true';
  update public.storefront_drafts set content=jsonb_set(content,'{featured}','false'),revision=revision+1,
   updated_at=now(),updated_by=coalesce(auth.uid(),updated_by) where id=r.id;
  insert into private.storefront_events(draft_id,actor_id,action,revision)
   select id,auth.uid(),'unfeature',revision from public.storefront_drafts where id=r.id;
 end loop;
end $$;
revoke all on function private.storefront_clear_featured(uuid) from public,anon,authenticated;

-- Resolver las selecciones antiguas conservando la primera que mostraba la web
-- entre publicaciones con la misma fecha. No cambiar textos, precios ni cantidades.
do $$ declare v_id uuid; begin
 perform pg_advisory_xact_lock(hashtextextended('storefront-featured',0));
 select id into v_id from public.storefront_publications where content->>'featured'='true'
 order by visible desc,published_at desc,id limit 1;
 if v_id is not null then perform private.storefront_clear_featured(v_id); end if;
end $$;
create unique index storefront_single_featured on public.storefront_publications ((true))
 where content->>'featured'='true';

create or replace function private.storefront_action(p_action text,p_id uuid,p_revision bigint,p_content jsonb,p_source_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.storefront_drafts%rowtype; c jsonb; v_image jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_content ? 'inventory_managed' and jsonb_typeof(p_content->'inventory_managed')<>'boolean'
 or p_content ? 'hide_unavailable' and jsonb_typeof(p_content->'hide_unavailable')<>'boolean' then
 raise exception 'Revisa las opciones de disponibilidad.'; end if;
 if p_id is null then raise exception 'Falta el perfume.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('storefront-featured',0));
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
   if (c->>'featured')::boolean then perform private.storefront_clear_featured(p_id); end if;
   insert into public.storefront_publications(id,content,visible,listed,inventory_managed,hide_unavailable)
    values(p_id,c,true,true,d.inventory_managed,d.hide_unavailable)
    on conflict(id) do update set content=excluded.content,visible=true,listed=true,
    inventory_managed=excluded.inventory_managed,hide_unavailable=excluded.hide_unavailable,published_at=now();
   update public.storefront_drafts set status='published',revision=revision+1,updated_at=now(),updated_by=auth.uid()
    where id=p_id returning * into d;
  elsif p_action='feature' then
   if not exists(select 1 from public.storefront_publications where id=p_id and visible
     and jsonb_array_length(content->'images')>0) or d.removal_state='pending' then
    raise exception 'Elige un perfume visible, con fotografía y sin baja pendiente.';
   end if;
   perform private.storefront_clear_featured(p_id);
   update public.storefront_publications set content=jsonb_set(content,'{featured}','true') where id=p_id;
   update public.storefront_drafts set content=jsonb_set(content,'{featured}','true'),revision=revision+1,
    updated_at=now(),updated_by=auth.uid() where id=p_id returning * into d;
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

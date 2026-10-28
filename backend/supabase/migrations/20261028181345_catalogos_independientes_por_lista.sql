-- Cada enlace permite leer una sola lista; nunca se entregan las otras listas
-- ni los identificadores de origen, costos, cantidades o borradores al visitante.
create table private.storefront_catalog_links (
 tier_code text primary key references public.price_tiers(code),
 token uuid not null unique default gen_random_uuid(),
 enabled boolean not null default true
);
alter table private.storefront_catalog_links enable row level security;
revoke all on private.storefront_catalog_links from public,anon,authenticated;
insert into private.storefront_catalog_links(tier_code)
 select code from public.price_tiers where code in ('menudeo','emprendedor','vip','premium');

create function private.read_storefront_catalog(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_tier text; v_name text; v_products jsonb;
begin
 select l.tier_code,t.name into v_tier,v_name
 from private.storefront_catalog_links l join public.price_tiers t on t.code=l.tier_code
 where l.enabled and ((p_token is null and l.tier_code='menudeo') or l.token=p_token);
 if not found then raise exception 'Este catálogo no está disponible.' using errcode='22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'published_at',p.published_at,
  'content',jsonb_set(p.content,'{price}',to_jsonb(coalesce(pr.amount,
    case when d.source_product_id is null and not d.source_missing and v_tier='menudeo'
      then (p.content->>'price')::numeric else 0 end)))) order by p.id),'[]'::jsonb)
 into v_products
 from public.storefront_publications p
 join public.storefront_drafts d on d.id=p.id
 left join public.product_prices pr on pr.product_id=d.source_product_id
  and pr.tier_code=v_tier and pr.currency='USD'
 where p.visible;
 return jsonb_build_object('name',v_name,'products',v_products);
end $$;
revoke all on function private.read_storefront_catalog(uuid) from public;
grant execute on function private.read_storefront_catalog(uuid) to anon,authenticated;

-- El cuerpo SQL resuelto al crear la función no necesita conceder USAGE del
-- esquema privado a visitantes. El helper valida la capacidad del enlace.
create function public.read_storefront_catalog(p_token uuid default null)
returns jsonb language sql stable security invoker set search_path=''
begin atomic
 select private.read_storefront_catalog(p_token);
end;
revoke all on function public.read_storefront_catalog(uuid) from public;
grant execute on function public.read_storefront_catalog(uuid) to anon,authenticated;

create function private.storefront_catalog_links()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('code',t.code,'name',t.name,'token',l.token) order by t.sort_order),'[]')
  from private.storefront_catalog_links l join public.price_tiers t on t.code=l.tier_code where l.enabled);
end $$;
revoke all on function private.storefront_catalog_links() from public,anon;
grant execute on function private.storefront_catalog_links() to authenticated;
create function public.storefront_catalog_links()
returns jsonb language sql stable security invoker set search_path='' as $$
 select private.storefront_catalog_links();
$$;
revoke all on function public.storefront_catalog_links() from public,anon;
grant execute on function public.storefront_catalog_links() to authenticated;

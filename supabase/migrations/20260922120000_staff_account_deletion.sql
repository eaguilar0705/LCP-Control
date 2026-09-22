-- Keep business authorship independent of login credentials. Historical UUIDs,
-- names and financial records remain; deleted accounts cannot authenticate.
create table private.business_actors (
 id uuid primary key,
 display_name text not null,
 deleted_at timestamptz
);
alter table private.business_actors enable row level security;
revoke all on private.business_actors from public, anon, authenticated;
insert into private.business_actors(id,display_name)
select u.id,coalesce(s.display_name,'Usuario') from auth.users u
left join public.staff_members s on s.user_id=u.id;

create function private.remember_business_actor() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into private.business_actors(id,display_name) values(new.user_id,new.display_name)
 on conflict(id) do update set display_name=excluded.display_name;
 return new;
end $$;
revoke all on function private.remember_business_actor() from public,anon,authenticated;
create trigger remember_business_actor after insert or update of display_name on public.staff_members
for each row execute function private.remember_business_actor();

-- Only business-history foreign keys move. Staff, drafts, sessions and rate
-- limits continue to cascade with auth.users. No financial rows are deleted.
do $$
declare r record;
begin
 for r in
  select n.nspname,t.relname,c.conname,a.attname
  from pg_constraint c join pg_class t on t.oid=c.conrelid
  join pg_namespace n on n.oid=t.relnamespace
  join pg_attribute a on a.attrelid=t.oid and a.attnum=c.conkey[1]
  where c.contype='f' and c.confrelid='auth.users'::regclass
   and c.confdeltype='a' and array_length(c.conkey,1)=1
   and (n.nspname,t.relname) in (
    ('public','documents'),('public','inventory_movements'),('private','catalog_changes'),
    ('public','suppliers'),('public','purchase_records'),('public','opening_cost_records'),
    ('public','expense_records'),('public','exchange_rates'),('public','purchase_shipments'))
 loop
  execute format('alter table %I.%I drop constraint %I',r.nspname,r.relname,r.conname);
  execute format('alter table %I.%I add constraint %I foreign key (%I) references private.business_actors(id)',r.nspname,r.relname,r.conname,r.attname);
 end loop;
end $$;

create table private.staff_deletions (
 id bigint generated always as identity primary key,
 actor_id uuid not null references private.business_actors(id),
 target_id uuid references private.business_actors(id),
 target_name text not null, target_role text not null,
 registered boolean not null, deleted_at timestamptz not null default now()
);
alter table private.staff_deletions enable row level security;
revoke all on private.staff_deletions from public,anon,authenticated;

-- Serialize activation with staff administration so a removed invitation
-- cannot be activated by a concurrent signup.
create or replace function private.provision_staff() returns trigger language plpgsql security definer set search_path='' as $$
declare v_staff private.pending_staff%rowtype;
begin
 perform pg_advisory_xact_lock(hashtextextended('staff-administration',0));
 select * into v_staff from private.pending_staff where email=lower(new.email) and active for update;
 if not found then raise exception 'Cuenta no autorizada. Solicita acceso al administrador.'; end if;
 insert into public.staff_members(user_id,display_name,role,active) values(new.id,v_staff.display_name,v_staff.role,true);
 delete from private.pending_staff where email=v_staff.email;
 return new;
end $$;

drop function public.list_staff_accounts();
create function public.list_staff_accounts()
returns table(email text,display_name text,role text,active boolean,registered boolean,user_id uuid)
language plpgsql security definer set search_path='' as $$
begin
 if private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 return query select u.email::text,s.display_name,s.role,s.active,true,s.user_id
 from public.staff_members s join auth.users u on u.id=s.user_id
 union all select p.email,p.display_name,p.role,p.active,false,null::uuid from private.pending_staff p;
end $$;
revoke all on function public.list_staff_accounts() from public,anon,authenticated;
grant execute on function public.list_staff_accounts() to authenticated;

create function public.delete_staff_account(p_email text,p_user_id uuid,p_role text) returns void
language plpgsql security definer set search_path='' as $$
declare v_email text:=lower(trim(p_email)); v_id uuid; v_role text; v_name text;
begin
 perform pg_advisory_xact_lock(hashtextextended('staff-administration',0));
 if private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 perform private.limit_catalog_writes();
 select s.user_id,s.role,s.display_name into v_id,v_role,v_name
 from public.staff_members s join auth.users u on u.id=s.user_id where lower(u.email)=v_email for update of s;
 if v_id is null then
  select role,display_name into v_role,v_name from private.pending_staff where email=v_email for update;
 end if;
 if v_role is null then raise exception 'La cuenta ya no existe. Actualiza la lista.'; end if;
 if v_id is distinct from p_user_id or v_role is distinct from p_role then
  raise exception 'La cuenta cambió. Actualiza la lista antes de eliminarla.';
 end if;
 if v_id=auth.uid() then raise exception 'No puedes eliminar tu propia cuenta.'; end if;
 if v_role='superadmin' then
  if not private.is_superadmin() then raise insufficient_privilege; end if;
  if v_id is not null and not exists(select 1 from public.staff_members where role='superadmin' and active and user_id<>v_id) then
   raise exception 'Debe quedar un SuperAdmin activo.';
  end if;
 end if;
 insert into private.staff_deletions(actor_id,target_id,target_name,target_role,registered)
 values(auth.uid(),v_id,v_name,v_role,v_id is not null);
 delete from private.pending_staff where email=v_email;
 if v_id is not null then
  -- Transfer photo ownership, never delete Storage objects or change their paths.
  -- Both columns are supported by the current Supabase Storage schema.
  update storage.objects set owner=auth.uid(),owner_id=auth.uid()::text
  where bucket_id='product-images' and (owner=v_id or owner_id=v_id::text);
  update storage.buckets set owner=auth.uid(),owner_id=auth.uid()::text
  where id='product-images' and (owner=v_id or owner_id=v_id::text);
  if exists(select 1 from storage.objects where owner=v_id or owner_id=v_id::text)
    or exists(select 1 from storage.buckets where owner=v_id or owner_id=v_id::text) then
   raise exception 'La cuenta tiene archivos fuera del catálogo. Transfiere esos archivos antes de eliminarla.';
  end if;
  update private.business_actors set deleted_at=now() where id=v_id;
  delete from auth.users where id=v_id;
 end if;
end $$;
revoke all on function public.delete_staff_account(text,uuid,text) from public,anon,authenticated;
grant execute on function public.delete_staff_account(text,uuid,text) to authenticated;

-- Retain the author shown in price history after their login is deleted.
create or replace function private.price_history(p_product uuid)
returns table(changed_at timestamptz, actor text, tier text, before_usd numeric, after_usd numeric, before_nio numeric, after_nio numeric, catalog_rate numeric)
language plpgsql stable security definer set search_path='' as $$
begin
 if (select private.staff_role()) is distinct from 'admin' then raise insufficient_privilege; end if;
 return query
 select h.changed_at, h.actor, h.tier, h.before_usd, h.after_usd, h.before_nio, h.after_nio, h.catalog_rate
 from (
  select c.created_at as changed_at,
         coalesce(s.display_name,'Cuenta retirada') as actor,
         t.tier as tier,
         (case when jsonb_typeof(c.before_data->'prices')='array' then
           (select (e->>'amount')::numeric from jsonb_array_elements(c.before_data->'prices') e
             where e->>'tier_code'=t.tier and e->>'currency'='USD') end) as before_usd,
         (c.after_data->'prices'->t.tier->>'USD')::numeric as after_usd,
         (case when jsonb_typeof(c.before_data->'prices')='array' then
           (select (e->>'amount')::numeric from jsonb_array_elements(c.before_data->'prices') e
             where e->>'tier_code'=t.tier and e->>'currency'='NIO') end) as before_nio,
         (c.after_data->'prices'->t.tier->>'NIO')::numeric as after_nio,
         (c.after_data->>'catalogRate')::numeric as catalog_rate
  from private.catalog_changes c
  cross join unnest(array['emprendedor','vip','premium']) as t(tier)
  left join private.business_actors s on s.id=c.actor_id
  where c.product_id=p_product and c.action='save'
 ) h
 where h.after_usd is not null and h.before_usd is distinct from h.after_usd
 order by h.changed_at desc, array_position(array['emprendedor','vip','premium'], h.tier)
 limit 200;
end $$;


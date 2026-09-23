-- Eliminación segura de clientes y proveedores.
--
-- No modifica ni borra tablas existentes: agrega una bitácora privada y dos
-- funciones. Las reglas replican las del catálogo de perfumes:
--
-- * Un cliente con facturas o proformas no se borra: `documents.customer_id`
--   lo referencia y los documentos emitidos deben conservarse tal cual. Se
--   archiva (active=false) y deja de aparecer en la lista de activos.
-- * Un cliente sin documentos se elimina.
-- * Los proveedores no tienen referencias por clave foránea (las compras
--   guardan el nombre como texto), así que se eliminan.
--
-- Ambas exigen rol Administrador (igual que archivar desde save_customer y
-- guardar desde save_supplier), comprueban la revisión para no borrar datos
-- que otra persona acaba de cambiar y comparten el candado de guardado.

create table private.contact_deletions (
 id bigint generated always as identity primary key,
 kind text not null check(kind in ('customer','supplier')),
 contact_id uuid not null,
 contact_name text not null,
 outcome text not null check(outcome in ('deleted','archived')),
 actor_id uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now()
);
create index contact_deletions_actor_idx on private.contact_deletions(actor_id);
alter table private.contact_deletions enable row level security;
revoke all on private.contact_deletions from public,anon,authenticated;

create function public.delete_customer(p_id uuid,p_revision integer) returns text
language plpgsql security definer set search_path='' as $$
declare v_old public.customers%rowtype; v_outcome text;
begin
 if private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_id is null then raise exception 'Falta el identificador del cliente.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('customer:'||p_id::text,0));
 select * into v_old from public.customers where id=p_id for update;
 if v_old.id is null then raise exception 'El cliente ya no existe. Actualiza la lista.'; end if;
 if v_old.revision is distinct from p_revision then
  raise exception 'Otro usuario modificó este cliente. Vuelve a abrirlo.';
 end if;
 perform private.limit_catalog_writes();
 if exists(select 1 from public.documents where customer_id=p_id) then
  update public.customers set active=false,revision=revision+1 where id=p_id;
  v_outcome:='archived';
 else
  delete from public.customers where id=p_id;
  v_outcome:='deleted';
 end if;
 insert into private.contact_deletions(kind,contact_id,contact_name,outcome,actor_id)
 values('customer',p_id,v_old.name,v_outcome,auth.uid());
 return v_outcome;
end $$;

create function public.delete_supplier(p_id uuid,p_revision integer) returns text
language plpgsql security definer set search_path='' as $$
declare v_old public.suppliers%rowtype;
begin
 if private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_id is null then raise exception 'Falta el identificador del proveedor.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('supplier:'||p_id::text,0));
 select * into v_old from public.suppliers where id=p_id for update;
 if v_old.id is null then raise exception 'El proveedor ya no existe. Actualiza la lista.'; end if;
 if v_old.revision is distinct from p_revision then
  raise exception 'Otro usuario modificó este proveedor. Vuelve a abrirlo.';
 end if;
 perform private.limit_catalog_writes();
 delete from public.suppliers where id=p_id;
 insert into private.contact_deletions(kind,contact_id,contact_name,outcome,actor_id)
 values('supplier',p_id,v_old.name,'deleted',auth.uid());
 return 'deleted';
end $$;

revoke all on function public.delete_customer(uuid,integer) from public,anon,authenticated;
revoke all on function public.delete_supplier(uuid,integer) from public,anon,authenticated;
grant execute on function public.delete_customer(uuid,integer) to authenticated;
grant execute on function public.delete_supplier(uuid,integer) to authenticated;

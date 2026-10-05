-- Role-scoped reads. Admins read everything. Operators keep the catalogue, stock,
-- customers and business details they need to sell, but only the documents and
-- inventory movements they recorded themselves: the full sales history and the
-- movement log are financial records, the same boundary as finance.read in the app.
-- Accounts without an active staff_members row still read nothing, and anon holds
-- no privilege on any table.
drop policy staff_read on public.documents;
create policy role_scoped_read on public.documents for select to authenticated using (
 (select private.staff_role())='admin'
 or ((select private.staff_role())='operator' and created_by=(select auth.uid()))
);
drop policy staff_read on public.document_items;
create policy role_scoped_read on public.document_items for select to authenticated using (
 (select private.staff_role())='admin'
 or ((select private.staff_role())='operator' and exists(
  select 1 from public.documents d where d.id=document_items.document_id and d.created_by=(select auth.uid())))
);
drop policy staff_read on public.inventory_movements;
create policy role_scoped_read on public.inventory_movements for select to authenticated using (
 (select private.staff_role())='admin'
 or ((select private.staff_role())='operator' and actor_id=(select auth.uid()))
);

-- New objects start closed. Supabase grants anon and authenticated every privilege
-- on each table, sequence and function postgres creates in public, leaving RLS as
-- the only guard. From here on a migration grants explicitly what it exposes.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
-- PostgreSQL also grants EXECUTE to PUBLIC on every new function, in any schema,
-- and anon inherits it. A per-schema revoke cannot remove that global default.
alter default privileges for role postgres revoke execute on functions from public;

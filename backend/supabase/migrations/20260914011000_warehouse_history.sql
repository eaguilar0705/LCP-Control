-- Inventory staff can read their own movements, including initial counts.
alter policy role_scoped_read on public.inventory_movements using (
 (select private.staff_role())='admin'
 or ((select private.staff_role()) in ('operator','warehouse') and actor_id=(select auth.uid()))
);
create index catalog_changes_actor_idx on private.catalog_changes(actor_id);

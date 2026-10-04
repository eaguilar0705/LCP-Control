-- La factura eliminada conserva su identidad en la bitácora privada. Un
-- reintento tardío debe mantener la eliminación, sin crear otra venta ni
-- descontar inventario a los precios actuales.
create index document_deletions_request_idx on private.document_deletions
 ((snapshot->>'created_by'),(snapshot->>'request_id'));

-- Mismo bloqueo que create_document, pero con el autor ORIGINAL de la
-- factura: quien la elimina puede ser otro administrador.
create function private.lock_deleted_invoice_request() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.snapshot->>'created_by' is not null and new.snapshot->>'request_id' is not null then
  perform pg_advisory_xact_lock(hashtextextended(
   (new.snapshot->>'created_by')||(new.snapshot->>'request_id'),0));
 end if;
 return new;
end $$;
revoke all on function private.lock_deleted_invoice_request() from public,anon,authenticated;
create trigger document_deletions_lock_request before insert on private.document_deletions
 for each row execute function private.lock_deleted_invoice_request();

create function private.reject_deleted_invoice_replay() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.created_by::text||new.request_id::text,0));
 if exists(select 1 from private.document_deletions d
  where d.snapshot->>'created_by'=new.created_by::text
   and d.snapshot->>'request_id'=new.request_id::text) then
  raise exception 'La factura de esta operación ya fue eliminada. Actualiza la lista antes de registrar otra venta.';
 end if;
 return new;
end $$;
revoke all on function private.reject_deleted_invoice_replay() from public,anon,authenticated;
create trigger documents_reject_deleted_request before insert on public.documents
 for each row execute function private.reject_deleted_invoice_replay();

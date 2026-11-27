-- Identifica el asiento creado al contabilizar la recepción con anticipo.
-- Una reclasificación manual requiere revisar su propio comprobante.
create function private.original_receipt_advance(p_shipment uuid) returns uuid
language sql stable set search_path='' as $$
 select e.id from private.purchase_classifications c
 join public.journal_entries e on e.id=c.entry_id
 join private.inventory_receipt_operations op on op.result_id=c.shipment_id
   and op.kind='inventory-receipt-post' and op.request_id=e.request_id
 where c.shipment_id=p_shipment and op.request_payload ? 'advanceAccount'
   and e.revision=0 and e.voided_at is null
$$;
revoke all on function private.original_receipt_advance(uuid) from public, anon, authenticated;

create or replace function private.purchase_history(p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(x || private.receipt_snapshot((x->>'id')::uuid) ||
   jsonb_build_object('classification_entry_id',pc.entry_id,
     'advance_entry_id',private.original_receipt_advance((x->>'id')::uuid)) order by pos),'[]'::jsonb)
 from jsonb_array_elements(private.purchase_history_before_receipt_revisions(p_before,p_before_id))
   with ordinality as rows(x,pos)
 left join private.purchase_classifications pc on pc.shipment_id=(x->>'id')::uuid
$$;

create or replace function private.correct_purchase(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 shipment uuid := (p_input->>'shipmentId')::uuid;
 expected_entry uuid := (p_input->>'advanceEntryId')::uuid;
 entry_id uuid;
begin
 if not private.is_superadmin() or auth.uid() is null then
   raise insufficient_privilege using message='Solo un SuperAdmin puede anular una compra.';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('finance-credit-ledger',0));
 -- El reintento valida el mismo actor y contenido aunque el asiento ya esté anulado.
 if exists(select 1 from public.purchase_corrections where created_by=auth.uid()
   and request_id=(p_input->>'requestId')::uuid) then
   return private.correct_purchase_before_receipt_revisions(p_input);
 end if;
 perform 1 from public.purchase_shipments where id=shipment for update;
 if exists(select 1 from private.receipt_revisions where shipment_id=shipment) then
   raise exception 'Usa Editar recepción para conservar sus correcciones y su clasificación contable.';
 end if;
 select pc.entry_id into entry_id from private.purchase_classifications pc where pc.shipment_id=shipment;
 if entry_id is not null or expected_entry is not null then
   if expected_entry is null or entry_id is distinct from expected_entry
     or private.original_receipt_advance(shipment) is distinct from expected_entry
     or nullif(p_input->'replacement','null'::jsonb) is not null then
     raise exception 'Revisa la clasificación actual en Contabilidad antes de corregir esta compra.';
   end if;
   -- Si hay abonos, operaciones de inventario posteriores o la jornada está
   -- cerrada, cualquiera de las dos operaciones falla y se revierte el conjunto.
   perform private.void_journal_entry(entry_id,p_input->>'reason');
 end if;
 return private.correct_purchase_before_receipt_revisions(p_input);
end $$;

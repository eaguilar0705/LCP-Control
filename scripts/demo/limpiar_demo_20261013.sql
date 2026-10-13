-- Elimina exclusivamente DEMO-LCP-20261013. NO ejecutar hasta terminar la presentación.
-- Proyecto Supabase: xkpujpoocsbkychstrne. Ejecutar como administrador SQL.
-- Aborta si ya hay operaciones posteriores ajenas al lote: revisar primero.
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
SELECT set_config('request.jwt.claim.sub','fd458235-ac21-4e2c-9581-b4355a61425d',true);
DO $cleanup$
DECLARE
 batch text := 'DEMO-LCP-20261013';
 pids uuid[];
 cids uuid[];
 sids uuid[];
 dids uuid[];
 opening_id uuid;
BEGIN
 SELECT array_agg(md5(batch||':product:'||i)::uuid) INTO pids FROM generate_series(1,8) i;
 SELECT array_agg(md5(batch||':customer:'||i)::uuid) INTO cids FROM generate_series(1,5) i;
 SELECT array_agg(md5(batch||':supplier:'||i)::uuid) INTO sids FROM generate_series(1,2) i;
 SELECT array_agg(id) INTO dids FROM public.documents
  WHERE request_id IN (SELECT md5(batch||':invoice:'||i)::uuid FROM generate_series(1,72) i
   UNION ALL SELECT md5(batch||':proforma:'||i)::uuid FROM generate_series(1,12) i);
 SELECT id INTO opening_id FROM public.journal_entries WHERE request_id=md5(batch||':opening')::uuid;
 -- Al quitar la apertura, no se debe ocultar actividad real que ya dependa de ella.
 IF EXISTS(SELECT 1 FROM public.journal_entries WHERE reference<>batch)
 OR EXISTS(SELECT 1 FROM public.finance_entries WHERE occurred_on>=DATE '2026-10-13' AND reference NOT LIKE batch||'%')
 OR EXISTS(SELECT 1 FROM public.purchase_shipments WHERE incurred_on>=DATE '2026-10-13' AND reference NOT LIKE batch||'%')
 OR EXISTS(SELECT 1 FROM public.expense_records WHERE incurred_on>=DATE '2026-10-13' AND reference NOT LIKE batch||'%')
 OR EXISTS(SELECT 1 FROM public.documents WHERE kind='invoice' AND (created_at AT TIME ZONE 'America/Managua')::date>=DATE '2026-10-13'
   AND NOT(id=ANY(coalesce(dids,ARRAY[]::uuid[]))))
 OR EXISTS(SELECT 1 FROM public.inventory_movements WHERE (created_at AT TIME ZONE 'America/Managua')::date>=DATE '2026-10-13' AND NOT(product_id=ANY(pids)))
 THEN RAISE EXCEPTION 'Hay actividad ajena al lote desde su apertura. No se ha borrado nada; revisar la limpieza.'; END IF;
 -- Si se hicieron operaciones adicionales con estos perfumes/contactos, revisarlas.
 IF EXISTS(SELECT 1 FROM public.document_items WHERE product_id=ANY(pids) AND NOT(document_id=ANY(coalesce(dids,ARRAY[]::uuid[]))))
 OR EXISTS(SELECT 1 FROM public.documents WHERE customer_id=ANY(cids) AND NOT(id=ANY(coalesce(dids,ARRAY[]::uuid[]))))
 OR EXISTS(SELECT 1 FROM public.purchase_shipment_lines l JOIN public.purchase_shipments s ON s.id=l.shipment_id
   WHERE l.product_id=ANY(pids) AND s.reference NOT LIKE batch||'%')
 OR EXISTS(SELECT 1 FROM public.opening_cost_records WHERE product_id=ANY(pids))
 OR EXISTS(SELECT 1 FROM public.inventory_movements WHERE product_id=ANY(pids) AND document_id IS NULL
   AND coalesce(reference,'') NOT LIKE batch||'%')
 THEN RAISE EXCEPTION 'Los registros DEMO tienen operaciones adicionales. Revisar antes de eliminarlos.'; END IF;

 -- Quitar primero la jornada ficticia permite limpiar aunque haya sido cerrada.
 -- No se desactivan triggers, políticas ni controles del programa.
 DELETE FROM public.business_days WHERE opening_request=md5(batch||':business-day')::uuid;
 DELETE FROM public.finance_entries WHERE request_id IN
  (SELECT md5(batch||':collection:'||i)::uuid FROM generate_series(1,72) i
   UNION ALL SELECT md5(batch||':extra-capital:'||i)::uuid FROM generate_series(1,2) i
   UNION ALL SELECT md5(batch||':supplier-payment')::uuid);
 DELETE FROM public.expense_records WHERE request_id IN (SELECT md5(batch||':expense:'||i)::uuid FROM generate_series(1,13) i);
 DELETE FROM public.journal_lines WHERE entry_id=opening_id;
 DELETE FROM public.journal_entries WHERE id=opening_id;
 DELETE FROM public.document_item_costs WHERE document_id=ANY(coalesce(dids,ARRAY[]::uuid[]));
 DELETE FROM public.inventory_movement_costs WHERE product_id=ANY(pids);
 DELETE FROM private.inventory_count_gains WHERE product_id=ANY(pids);
 DELETE FROM public.inventory_movements WHERE product_id=ANY(pids);
 DELETE FROM public.document_items WHERE document_id=ANY(coalesce(dids,ARRAY[]::uuid[]));
 DELETE FROM public.documents WHERE id=ANY(coalesce(dids,ARRAY[]::uuid[]));
 DELETE FROM public.purchase_shipment_lines WHERE shipment_id IN
  (SELECT id FROM public.purchase_shipments WHERE request_id IN (SELECT md5(batch||':purchase:'||i)::uuid FROM generate_series(1,24) i));
 DELETE FROM public.purchase_shipments WHERE request_id IN (SELECT md5(batch||':purchase:'||i)::uuid FROM generate_series(1,24) i);
 DELETE FROM private.catalog_changes WHERE product_id=ANY(pids);
 DELETE FROM public.product_pricing WHERE product_id=ANY(pids);
 DELETE FROM public.product_prices WHERE product_id=ANY(pids);
 DELETE FROM public.product_costs WHERE product_id=ANY(pids);
 DELETE FROM public.inventory_balances WHERE product_id=ANY(pids);
 DELETE FROM public.products WHERE id=ANY(pids);
 DELETE FROM public.customers WHERE id=ANY(cids);
 DELETE FROM public.suppliers WHERE id=ANY(sids);
 -- Restaurar números sólo si no se emitieron otros documentos o eliminaciones.
 IF (SELECT last_value FROM private.document_counters WHERE kind='invoice')=74
  AND NOT EXISTS(SELECT 1 FROM public.documents WHERE kind='invoice' AND number>'FAC-000002')
  AND NOT EXISTS(SELECT 1 FROM private.document_deletions WHERE kind='invoice' AND number>'FAC-000002') THEN
  UPDATE private.document_counters SET last_value=2 WHERE kind='invoice';
 END IF;
 IF (SELECT last_value FROM private.document_counters WHERE kind='proforma')=12
  AND NOT EXISTS(SELECT 1 FROM public.documents WHERE kind='proforma') THEN
  UPDATE private.document_counters SET last_value=0 WHERE kind='proforma';
 END IF;
 -- La secuencia de comprobantes conserva saltos; no afecta los saldos.
 IF EXISTS(SELECT 1 FROM public.products WHERE id=ANY(pids))
  OR EXISTS(SELECT 1 FROM public.documents WHERE notes LIKE batch||'%')
  OR EXISTS(SELECT 1 FROM public.purchase_shipments WHERE reference LIKE batch||'%')
  OR EXISTS(SELECT 1 FROM public.finance_entries WHERE reference LIKE batch||'%')
  OR EXISTS(SELECT 1 FROM public.expense_records WHERE reference LIKE batch||'%')
  OR EXISTS(SELECT 1 FROM public.journal_entries WHERE reference=batch) THEN
  RAISE EXCEPTION 'Quedaron registros del lote: se revierte la limpieza.';
 END IF;
END $cleanup$;
COMMIT;

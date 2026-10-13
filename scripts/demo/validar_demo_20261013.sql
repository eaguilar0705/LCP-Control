-- Sólo lectura: comprueba cantidad de operaciones, inventario y balanza.
BEGIN;
SELECT set_config('request.jwt.claim.sub','fd458235-ac21-4e2c-9581-b4355a61425d',true);
DO $verify$
DECLARE
 batch text := 'DEMO-LCP-20261013';
 report jsonb;
 new_operations integer;
BEGIN
 SELECT
  (SELECT count(*) FROM public.documents WHERE request_id IN (SELECT md5(batch||':invoice:'||i)::uuid FROM generate_series(13,72) i))+
  (SELECT count(*) FROM public.documents WHERE request_id IN (SELECT md5(batch||':proforma:'||i)::uuid FROM generate_series(3,12) i))+
  (SELECT count(*) FROM public.purchase_shipments WHERE request_id IN (SELECT md5(batch||':purchase:'||i)::uuid FROM generate_series(5,24) i))+
  (SELECT count(*) FROM public.inventory_movements WHERE request_id IN (SELECT md5(batch||':movement:'||i)::uuid FROM generate_series(5,24) i))+
  (SELECT count(*) FROM public.expense_records WHERE request_id IN (SELECT md5(batch||':expense:'||i)::uuid FROM generate_series(4,13) i))+
  (SELECT count(*) FROM public.finance_entries WHERE request_id IN
   (SELECT md5(batch||':collection:'||i)::uuid FROM generate_series(18,72,6) i
    UNION ALL SELECT md5(batch||':extra-capital:'||i)::uuid FROM generate_series(1,2) i)) INTO new_operations;
 IF new_operations<>132 THEN RAISE EXCEPTION 'Ampliación incompleta: % de 132 operaciones.',new_operations; END IF;
 IF EXISTS(SELECT 1 FROM public.inventory_balances WHERE product_id IN (SELECT id FROM public.products WHERE sku LIKE 'DEMO-20261013-%') AND (quantity IS NULL OR quantity<0)) THEN RAISE EXCEPTION 'Inventario inválido.'; END IF;
 IF (SELECT sum(quantity) FROM public.inventory_balances WHERE product_id IN (SELECT id FROM public.products WHERE sku LIKE 'DEMO-20261013-%'))<>470 THEN RAISE EXCEPTION 'Revisar las 470 unidades de existencia esperadas.'; END IF;
 report := public.ledger_report('2026-10-13','2026-10-13');
 IF (report->>'missingCosts')::integer<>0 OR (report->>'missingSales')::integer<>0 THEN RAISE EXCEPTION 'Información contable incompleta.'; END IF;
 IF abs((SELECT sum((a->>'debit')::numeric-(a->>'credit')::numeric) FROM jsonb_array_elements(report->'accounts') a))>0.01 THEN RAISE EXCEPTION 'Balanza descuadrada.'; END IF;
END $verify$;
SELECT jsonb_build_object(
 'invoices',(SELECT count(*) FROM public.documents WHERE kind='invoice' AND notes LIKE 'DEMO-LCP-20261013%'),
 'proformas',(SELECT count(*) FROM public.documents WHERE kind='proforma' AND notes LIKE 'DEMO-LCP-20261013%'),
 'purchases',(SELECT count(*) FROM public.purchase_shipments WHERE reference LIKE 'DEMO-LCP-20261013%'),
 'expenses',(SELECT count(*) FROM public.expense_records WHERE reference LIKE 'DEMO-LCP-20261013%'),
 'financeEntries',(SELECT count(*) FROM public.finance_entries WHERE reference LIKE 'DEMO-LCP-20261013%'),
 'inventoryMovements',(SELECT count(*) FROM public.inventory_movements WHERE product_id IN (SELECT id FROM public.products WHERE sku LIKE 'DEMO-20261013-%')),
 'businessDay',public.get_business_day('2026-10-13')) verification;
COMMIT;

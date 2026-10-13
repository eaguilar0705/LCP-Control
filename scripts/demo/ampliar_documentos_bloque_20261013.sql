-- Cambiar block_no a 1, 2, 3 o 4 y ejecutar en ese orden, en minutos distintos.
-- Cada bloque contiene 15 facturas y 2/3 proformas, respetando 20 documentos/minuto.
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
SELECT set_config('request.jwt.claim.sub','fd458235-ac21-4e2c-9581-b4355a61425d',true);
DO $documents$
DECLARE
 batch text := 'DEMO-LCP-20261013';
 block_no integer := 1;
 rate numeric; i integer; pids uuid[]; cids uuid[]; v_currency text;
 methods text[] := ARRAY['cash','card_pos','bac_nio','lafise_nio','ficohsa_nio','pending'];
 tiers text[] := ARRAY['emprendedor','vip','premium'];
 result jsonb; report jsonb;
BEGIN
 SELECT usd_to_nio INTO rate FROM public.exchange_rates WHERE id;
 SELECT array_agg(md5(batch||':product:'||x)::uuid ORDER BY x) INTO pids FROM generate_series(1,8) x;
 SELECT array_agg(md5(batch||':customer:'||x)::uuid ORDER BY x) INTO cids FROM generate_series(1,5) x;
 FOR i IN (13+(block_no-1)*15)..(12+block_no*15) LOOP
  v_currency := CASE WHEN i%6=0 OR i%6=1 THEN 'USD' ELSE 'NIO' END;
  result := public.create_document(jsonb_build_object('requestId',md5(batch||':invoice:'||i)::uuid,
   'kind','invoice','customerId',cids[((i-1)%5)+1],'tier',tiers[((i-1)%3)+1],
   'currency',v_currency,'exchangeRate',CASE WHEN v_currency='USD' THEN rate ELSE 1 END,
   'location','store','paymentMethod',methods[((i-1)%6)+1],
   'notes',batch||': venta ficticia de ampliación '||i,
   'items',jsonb_build_array(jsonb_build_object('productId',pids[((i-1)%8)+1],'quantity',1+(i%3)),
    jsonb_build_object('productId',pids[(i%8)+1],'quantity',1))));
  IF i%6=0 THEN
   PERFORM public.record_finance_entry(jsonb_build_object('requestId',md5(batch||':collection:'||i)::uuid,
    'kind','collection','occurredOn','2026-10-13','account','caja','amount',round((result->>'total')::numeric/3,2),
    'currency',v_currency,'exchangeRate',CASE WHEN v_currency='USD' THEN rate ELSE 1 END,
    'documentId',(result->>'id')::uuid,'description',batch||': abono parcial de ampliación',
    'reference',batch||'-COBRO-'||i));
  END IF;
 END LOOP;
 FOR i IN (CASE block_no WHEN 1 THEN 3 WHEN 2 THEN 5 WHEN 3 THEN 8 ELSE 10 END)..
  (CASE block_no WHEN 1 THEN 4 WHEN 2 THEN 7 WHEN 3 THEN 9 ELSE 12 END) LOOP
  PERFORM public.create_document(jsonb_build_object('requestId',md5(batch||':proforma:'||i)::uuid,
   'kind','proforma','customerId',cids[((i-1)%5)+1],'tier',tiers[((i-1)%3)+1],
   'currency','USD','exchangeRate',rate,'validUntil','2026-10-20',
   'notes',batch||': cotización ficticia de ampliación '||i,
   'items',jsonb_build_array(jsonb_build_object('productId',pids[((i-1)%8)+1],'quantity',4),
    jsonb_build_object('productId',pids[(i%8)+1],'quantity',3))));
 END LOOP;
 report := public.ledger_report('2026-10-13','2026-10-13');
 IF (report->>'missingCosts')::integer<>0 OR (report->>'missingSales')::integer<>0 THEN RAISE EXCEPTION 'Costos pendientes.'; END IF;
 IF abs((SELECT sum((a->>'debit')::numeric-(a->>'credit')::numeric) FROM jsonb_array_elements(report->'accounts') a))>0.01 THEN RAISE EXCEPTION 'Balanza descuadrada.'; END IF;
END $documents$;
COMMIT;

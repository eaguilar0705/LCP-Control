-- Extensión: 60 facturas, 20 compras, 20 salidas/daños, 10 proformas,
-- 10 gastos, 10 cobros parciales y 2 aportes ficticios: 132 operaciones.
-- Ejecutar este bloque primero, y luego los cuatro bloques de documentos.
-- Entre bloques de documentos esperar al siguiente minuto: no se eluden límites.
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
SELECT set_config('request.jwt.claim.sub','fd458235-ac21-4e2c-9581-b4355a61425d',true);
DO $extend$
DECLARE
 batch text := 'DEMO-LCP-20261013';
 v_day date := DATE '2026-10-13';
 rate numeric; i integer; j integer; n integer;
 v_currency text; v_account text; v_location text;
 pids uuid[]; lines jsonb; report jsonb;
 costs numeric[] := ARRAY[18,22,26,24,35,50,65,40];
BEGIN
 IF (now() AT TIME ZONE 'America/Managua')::date<>v_day THEN RAISE EXCEPTION 'Revisar la fecha de presentación.'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.business_days WHERE day=v_day AND closed_at IS NULL) THEN RAISE EXCEPTION 'La jornada DEMO debe estar abierta.'; END IF;
 SELECT array_agg(md5(batch||':product:'||x)::uuid ORDER BY x) INTO pids FROM generate_series(1,8) x;
 IF (SELECT count(*) FROM public.products WHERE id=ANY(pids))<>8 THEN RAISE EXCEPTION 'Faltan perfumes del lote inicial.'; END IF;
 SELECT usd_to_nio INTO rate FROM public.exchange_rates WHERE id;
 -- Financiación ficticia para que las compras y gastos mantengan saldos positivos.
 FOR i IN 1..2 LOOP
  PERFORM public.record_finance_entry(jsonb_build_object('requestId',md5(batch||':extra-capital:'||i)::uuid,
   'occurredOn',v_day,'kind','capital','account',CASE WHEN i=1 THEN 'caja' ELSE 'banco' END,
   'bankLedgerAccount',CASE WHEN i=2 THEN '1120-000' ELSE NULL END,
   'amount',CASE WHEN i=1 THEN 100000 ELSE 200000 END,'currency','NIO','exchangeRate',1,
   'description',batch||': aporte ficticio para ampliación','reference',batch||'-APORTE-'||i));
 END LOOP;
 -- 20 compras, 600 unidades, precio y envío documentados. Reejecución idempotente.
 FOR i IN 5..24 LOOP
  n := i-4;
  v_currency := CASE WHEN n%3=0 THEN 'USD' ELSE 'NIO' END;
  v_account := CASE WHEN n%10=0 THEN 'caja' WHEN n%7=0 THEN 'banco' ELSE 'credito' END;
  v_location := CASE WHEN n%5=0 THEN 'warehouse' ELSE 'store' END;
  lines := '[]'::jsonb;
  FOR j IN 1..3 LOOP
   lines := lines||jsonb_build_array(jsonb_build_object('productId',pids[((3*(n-1)+j-1)%8)+1],
    'location',v_location,'quantity',10,
    'unitPrice',round((costs[((3*(n-1)+j-1)%8)+1]+(n%3)*0.5)*CASE WHEN v_currency='USD' THEN 1 ELSE rate END,2)));
  END LOOP;
  PERFORM public.record_shipment(jsonb_build_object('requestId',md5(batch||':purchase:'||i)::uuid,
   'incurredOn',v_day,'supplier',CASE WHEN n%2=0 THEN 'Importadora Aroma [DEMO]' ELSE 'Distribuidora Perfumes [DEMO]' END,
   'agency','Agencia de envíos [DEMO]','reference',batch||'-COMPRA-'||i,'note',batch||': compra ficticia de ampliación',
   'currency',v_currency,'exchangeRate',CASE WHEN v_currency='USD' THEN rate ELSE 1 END,
   'shippingAmount',CASE WHEN v_currency='USD' THEN 20 ELSE 732 END,'account',v_account,'lines',lines));
 END LOOP;
 FOR i IN 5..24 LOOP
  PERFORM public.record_inventory_movement(jsonb_build_object('requestId',md5(batch||':movement:'||i)::uuid,
   'productId',pids[((i-5)%8)+1],'location','store','type',CASE WHEN i%2=0 THEN 'DAMAGED' ELSE 'EXIT' END,
   'quantity',1,'reference',batch||'-MOV-'||i,
   'note',batch||': '||CASE WHEN i%2=0 THEN 'frasco dañado en manipulación' ELSE 'muestra de presentación' END));
 END LOOP;
 FOR i IN 4..13 LOOP
  PERFORM public.record_expense(jsonb_build_object('requestId',md5(batch||':expense:'||i)::uuid,
   'incurredOn',v_day,'category',CASE WHEN i%3=0 THEN 'marketing' WHEN i%3=1 THEN 'papeleria' ELSE 'limpieza' END,
   'description',batch||': gasto ficticio de ampliación '||i,'amount',100+25*i,
   'currency','NIO','exchangeRate',1,'account',CASE WHEN i%2=0 THEN 'caja' ELSE 'banco' END,'reference',batch||'-GASTO-'||i));
 END LOOP;
 report := public.ledger_report(v_day,v_day);
 IF (report->>'missingCosts')::integer<>0 THEN RAISE EXCEPTION 'Hay costos pendientes.'; END IF;
 IF EXISTS(SELECT 1 FROM public.inventory_balances WHERE product_id=ANY(pids) AND quantity<0) THEN RAISE EXCEPTION 'Inventario negativo.'; END IF;
END $extend$;
COMMIT;

-- Proyecto: xkpujpoocsbkychstrne. Lote: DEMO-LCP-20261013.
-- Operaciones de presentación; ejecutar una sola vez como administrador SQL.
-- Toda la carga revierte si falla una operación o validación.
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
SELECT set_config('request.jwt.claim.sub','fd458235-ac21-4e2c-9581-b4355a61425d',true);
DO $demo$
DECLARE
 batch text := 'DEMO-LCP-20261013';
 v_day date := (now() at time zone 'America/Managua')::date;
 uid uuid := auth.uid();
 rate numeric;
 p uuid; c uuid; result jsonb; report jsonb;
 i integer; j integer; before_count integer;
 names text[] := ARRAY['Hawas Black','Yara','Khamrah','Club de Nuit Intense','9 PM','Eros','Sauvage','Le Male'];
 v_brands text[] := ARRAY['Rasasi','Lataffa','Lataffa','Armaf','Afnan','Versace','Dior','Jean Paul Gaultier'];
 costs numeric[] := ARRAY[18,22,26,24,35,50,65,40];
 methods text[] := ARRAY['cash','cash','card_pos','bac_nio','pending','lafise_nio','cash','pending','card_pos','ficohsa_nio','cash','pending'];
 tiers text[] := ARRAY['emprendedor','vip','premium'];
 customer_names text[] := ARRAY['María López','Carlos Pérez','Boutique Aroma','Distribuidora Esencias','Ana Martínez'];
 product_ids uuid[] := ARRAY[]::uuid[];
 customer_ids uuid[] := ARRAY[]::uuid[];
 shipment_ids uuid[] := ARRAY[]::uuid[];
 invoice_ids uuid[] := ARRAY[]::uuid[];
 lines jsonb; currency text; account text; original_total numeric;
 ledger_difference numeric;
BEGIN
 IF v_day <> DATE '2026-10-13' THEN RAISE EXCEPTION 'Este lote corresponde al 13 de octubre de 2026.'; END IF;
 IF private.staff_role() IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Se requiere el administrador autorizado.'; END IF;
 IF EXISTS(SELECT 1 FROM public.products WHERE sku LIKE 'DEMO-20261013-%') THEN RAISE EXCEPTION 'El lote DEMO ya está cargado; no se duplicará.'; END IF;
 IF EXISTS(SELECT 1 FROM public.business_days WHERE business_days.day=v_day) THEN RAISE EXCEPTION 'Ya existe una jornada para la fecha de demostración.'; END IF;
 IF EXISTS(SELECT 1 FROM public.business_days WHERE closed_at IS NULL) THEN RAISE EXCEPTION 'Hay una jornada abierta; revisar antes de cargar.'; END IF;
 IF EXISTS(SELECT 1 FROM public.journal_entries) OR EXISTS(SELECT 1 FROM public.finance_entries) THEN RAISE EXCEPTION 'La contabilidad cambió; revisar la apertura antes de cargar.'; END IF;
 SELECT usd_to_nio INTO rate FROM public.exchange_rates WHERE id;
 IF rate IS NULL THEN RAISE EXCEPTION 'Falta el tipo de cambio.'; END IF;

 -- Productos nuevos con SKU propio: el catálogo existente no se modifica.
 FOR i IN 1..8 LOOP
  p := md5(batch||':product:'||i)::uuid;
  product_ids := array_append(product_ids,p);
  INSERT INTO public.products(id,sku,name,brand_id,size,unit,category,gender,minimum_stock)
  VALUES(p,'DEMO-20261013-'||lpad(i::text,2,'0'),names[i]||' [DEMO]',
   (SELECT b.id FROM public.brands b WHERE b.name=v_brands[i]),100,'ml',CASE WHEN i<=5 THEN 'arabian' ELSE 'designer' END,'unisex',5);
  INSERT INTO public.inventory_balances(product_id,location,quantity) VALUES(p,'store',NULL),(p,'warehouse',NULL);
  PERFORM private.write_product_pricing(p,jsonb_build_object('purchasePrice',costs[i],'purchaseCurrency','USD',
   'markups',jsonb_build_object('emprendedor',65,'vip',50,'premium',40)),rate);
  -- Conteos iniciales explícitos, seguidos de entradas mediante compras con costo.
  FOREACH account IN ARRAY ARRAY['store','warehouse'] LOOP
   PERFORM public.record_inventory_movement(jsonb_build_object('requestId',md5(batch||':count:'||i||':'||account)::uuid,
    'productId',p,'location',account,'type','ADJUSTMENT','quantity',0,'reference',batch||'-CONTEO',
    'note',batch||': conteo inicial de presentación en cero'));
  END LOOP;
 END LOOP;
 FOR i IN 1..5 LOOP
  c := md5(batch||':customer:'||i)::uuid;
  customer_ids := array_append(customer_ids,c);
  INSERT INTO public.customers(id,name,price_tier,email,address,notes)
   VALUES(c,customer_names[i]||' [DEMO]',tiers[((i-1)%3)+1],'cliente'||i||'@example.test','Managua - dirección ficticia',batch||': contacto ficticio');
 END LOOP;
 FOR i IN 1..2 LOOP
  INSERT INTO public.suppliers(id,name,contact,email,address,terms,notes,updated_by)
  VALUES(md5(batch||':supplier:'||i)::uuid,CASE WHEN i=1 THEN 'Importadora Aroma [DEMO]' ELSE 'Distribuidora Perfumes [DEMO]' END,
   'Contacto ficticio','proveedor'||i||'@example.test','Dirección ficticia',CASE WHEN i=1 THEN 'Contado' ELSE 'Crédito 30 días' END,batch,uid);
 END LOOP;

 -- Apertura contable ficticia equilibrada. Los dólares se valoran en NIO en el libro.
 PERFORM public.record_journal_entry(jsonb_build_object('requestId',md5(batch||':opening')::uuid,
  'kind','opening','occurredOn',v_day,'description',batch||': saldos iniciales de presentación','reference',batch,
  'currency','NIO','exchangeRate',1,'lines',jsonb_build_array(
   jsonb_build_object('account','1110-001','debit',30000,'credit',0),
   jsonb_build_object('account','1110-002','debit',1200*rate,'credit',0),
   jsonb_build_object('account','1120-000','debit',2000*rate,'credit',0),
   jsonb_build_object('account','1120-001','debit',100000,'credit',0),
   jsonb_build_object('account','3110-001','debit',0,'credit',130000+3200*rate))));
 PERFORM public.open_business_day(jsonb_build_object('requestId',md5(batch||':business-day')::uuid,'openingNio',30000,'openingUsd',1200));

 -- Cuatro compras: efectivo, banco y dos pedidos a crédito, en ambas ubicaciones.
 FOR i IN 1..4 LOOP
  lines := '[]'::jsonb;
  IF i IN (1,2) THEN
   FOR j IN (CASE WHEN i=1 THEN 1 ELSE 5 END)..(CASE WHEN i=1 THEN 4 ELSE 8 END) LOOP
    lines := lines||jsonb_build_array(jsonb_build_object('productId',product_ids[j],
     'location',CASE WHEN i=1 THEN 'store' ELSE 'warehouse' END,'quantity',CASE WHEN i=1 THEN 8 ELSE 6 END,'unitPrice',costs[j]));
   END LOOP;
  ELSIF i=3 THEN
   FOR j IN 5..8 LOOP
    lines := lines||jsonb_build_array(jsonb_build_object('productId',product_ids[j],'location','store','quantity',8,'unitPrice',round(costs[j]*rate,2)));
   END LOOP;
  ELSE
   FOREACH j IN ARRAY ARRAY[1,2,8] LOOP
    lines := lines||jsonb_build_array(jsonb_build_object('productId',product_ids[j],'location','warehouse','quantity',4,'unitPrice',costs[j]-1));
   END LOOP;
  END IF;
  shipment_ids := array_append(shipment_ids,public.record_shipment(jsonb_build_object(
   'requestId',md5(batch||':purchase:'||i)::uuid,'incurredOn',v_day,
   'supplier',CASE WHEN i IN (1,2) THEN 'Importadora Aroma [DEMO]' ELSE 'Distribuidora Perfumes [DEMO]' END,
   'agency','Agencia de envíos [DEMO]','reference',batch||'-COMPRA-'||i,'note',batch||': compra ficticia para presentación',
   'currency',CASE WHEN i=3 THEN 'NIO' ELSE 'USD' END,'exchangeRate',CASE WHEN i=3 THEN 1 ELSE rate END,
   'shippingAmount',CASE i WHEN 1 THEN 24 WHEN 2 THEN 30 WHEN 3 THEN 600 ELSE 12 END,
   'account',CASE i WHEN 1 THEN 'caja' WHEN 2 THEN 'banco' ELSE 'credito' END,'lines',lines)));
 END LOOP;

 -- Doce facturas con tres listas de precio y efectivo, tarjetas, bancos y crédito.
 FOR i IN 1..12 LOOP
  currency := CASE WHEN i IN (7,8) THEN 'USD' ELSE 'NIO' END;
  result := public.create_document(jsonb_build_object('requestId',md5(batch||':invoice:'||i)::uuid,
   'kind','invoice','customerId',customer_ids[((i-1)%5)+1],'tier',tiers[((i-1)%3)+1],
   'currency',currency,'exchangeRate',CASE WHEN currency='USD' THEN rate ELSE 1 END,
   'location','store','paymentMethod',methods[i],'notes',batch||': venta ficticia '||i,
   'items',jsonb_build_array(jsonb_build_object('productId',product_ids[((i-1)%8)+1],'quantity',CASE WHEN i%3=0 THEN 2 ELSE 1 END),
    jsonb_build_object('productId',product_ids[(i%8)+1],'quantity',1))));
  invoice_ids := array_append(invoice_ids,(result->>'id')::uuid);
 END LOOP;
 FOR i IN 1..2 LOOP
  PERFORM public.create_document(jsonb_build_object('requestId',md5(batch||':proforma:'||i)::uuid,
   'kind','proforma','customerId',customer_ids[i],'tier','emprendedor','currency','USD','exchangeRate',rate,
   'validUntil',v_day+7,'notes',batch||': cotización ficticia sin salida de inventario',
   'items',jsonb_build_array(jsonb_build_object('productId',product_ids[i],'quantity',3),jsonb_build_object('productId',product_ids[i+4],'quantity',2))));
 END LOOP;
 -- Salidas por daño, muestra y diferencia de conteo; sobrante contado con costo.
 FOR i IN 1..4 LOOP
  SELECT quantity INTO before_count FROM public.inventory_balances WHERE product_id=product_ids[i] AND location='store';
  PERFORM public.record_inventory_movement(jsonb_build_object('requestId',md5(batch||':movement:'||i)::uuid,
   'productId',product_ids[i],'location','store','type',CASE i WHEN 1 THEN 'DAMAGED' WHEN 2 THEN 'EXIT' ELSE 'ADJUSTMENT' END,
   'quantity',CASE i WHEN 1 THEN 1 WHEN 2 THEN 1 WHEN 3 THEN before_count-1 ELSE before_count+1 END,
   'reference',batch||'-MOV-'||i,'note',batch||': '||CASE i WHEN 1 THEN 'frasco dañado' WHEN 2 THEN 'muestra para exhibición' WHEN 3 THEN 'faltante de conteo' ELSE 'sobrante de conteo' END));
 END LOOP;
 -- Dos cobros parciales vinculados a sus facturas; conserva crédito pendiente.
 FOREACH i IN ARRAY ARRAY[5,8] LOOP
  SELECT d.total,d.currency INTO original_total,currency FROM public.documents d WHERE d.id=invoice_ids[i];
  PERFORM public.record_finance_entry(jsonb_build_object('requestId',md5(batch||':collection:'||i)::uuid,
   'kind','collection','occurredOn',v_day,'account','caja','amount',round(original_total/2,2),'currency',currency,
   'exchangeRate',CASE WHEN currency='USD' THEN rate ELSE 1 END,'documentId',invoice_ids[i],
   'description',batch||': abono del cliente del 50%','reference',batch||'-COBRO-'||i));
 END LOOP;
 PERFORM public.record_finance_entry(jsonb_build_object('requestId',md5(batch||':supplier-payment')::uuid,
  'kind','supplier_payment','occurredOn',v_day,'account','banco','bankLedgerAccount','1120-001',
  'amount',5000,'currency','NIO','exchangeRate',1,'shipmentId',shipment_ids[3],
  'description',batch||': abono parcial al proveedor','reference',batch||'-PAGO-PROVEEDOR'));
 FOR i IN 1..3 LOOP
  PERFORM public.record_expense(jsonb_build_object('requestId',md5(batch||':expense:'||i)::uuid,
   'incurredOn',v_day,'category',CASE i WHEN 1 THEN 'papeleria' WHEN 2 THEN 'marketing' ELSE 'renta' END,
   'description',batch||': gasto ficticio de presentación','amount',CASE i WHEN 1 THEN 150 WHEN 2 THEN 500 ELSE 3500 END,
   'currency','NIO','exchangeRate',1,'account',CASE WHEN i=3 THEN 'banco' ELSE 'caja' END,'reference',batch||'-GASTO-'||i));
 END LOOP;

 -- Ningún costo pendiente, inventario negativo ni descuadre contable.
 report := public.ledger_report(v_day,v_day);
 IF (report->>'missingCosts')::integer<>0 OR (report->>'missingSales')::integer<>0 THEN RAISE EXCEPTION 'Quedaron costos contables pendientes.'; END IF;
 SELECT sum((a->>'debit')::numeric-(a->>'credit')::numeric) INTO ledger_difference FROM jsonb_array_elements(report->'accounts') a;
 IF abs(ledger_difference)>0.01 THEN RAISE EXCEPTION 'La balanza no cuadra: %.',ledger_difference; END IF;
 IF EXISTS(SELECT 1 FROM public.inventory_balances WHERE product_id=ANY(product_ids) AND (quantity IS NULL OR quantity<0)) THEN RAISE EXCEPTION 'Inventario inválido.'; END IF;
 IF (SELECT count(*) FROM public.documents WHERE notes LIKE batch||'%')<>14 THEN RAISE EXCEPTION 'Cantidad de documentos inesperada.'; END IF;
END $demo$;
COMMIT;

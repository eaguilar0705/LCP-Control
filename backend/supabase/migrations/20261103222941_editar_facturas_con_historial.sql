alter table public.documents add column revision integer not null default 0 check(revision>=0);
-- La solicitud de emisión es inmutable para sus reintentos. Estos términos
-- contienen únicamente la tasa y los pagos vigentes tras una corrección.
alter table public.documents add column corrected_terms jsonb;
create table private.invoice_corrections (
 id uuid primary key default gen_random_uuid(), document_id uuid not null,
 revision integer not null check(revision>0), before_snapshot jsonb not null, after_snapshot jsonb,
 actor_id uuid not null references private.business_actors(id), actor_name text not null,
 created_at timestamptz not null default now(), transaction_id bigint not null default txid_current(),
 request_id uuid not null unique, request_payload jsonb not null, unique(document_id,revision)
);
create index invoice_corrections_actor on private.invoice_corrections(actor_id);
alter table private.invoice_corrections enable row level security;
revoke all on private.invoice_corrections from public,anon,authenticated;
create trigger prevent_retired_operation before insert on private.invoice_corrections
 for each row execute function private.prevent_retired_operation('invoice-correction','actor_id','request_id');

create function private.in_invoice_correction(p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and private.is_superadmin() and exists(
  select 1 from private.invoice_corrections where document_id=p_id and actor_id=auth.uid()
   and transaction_id=txid_current() and after_snapshot is null);
$$;
revoke all on function private.in_invoice_correction(uuid) from public,anon,authenticated;

create function private.invoice_snapshot(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select (to_jsonb(d)-'request_payload'-'request_id')||jsonb_build_object(
 'items',(select jsonb_agg(to_jsonb(i) order by i.id) from public.document_items i where i.document_id=d.id),
 'costs',coalesce((select jsonb_agg(to_jsonb(c) order by c.document_item_id) from public.document_item_costs c where c.document_id=d.id),'[]'),
 'payments',coalesce((select jsonb_agg(to_jsonb(p) order by p.line_no) from public.invoice_payments p where p.document_id=d.id),'[]'),
 'collections',coalesce((select jsonb_agg(to_jsonb(f)-'request_payload'-'request_id' order by f.id) from public.finance_entries f where f.document_id=d.id),'[]'))
 from public.documents d where d.id=p_id and d.kind='invoice';
$$;
revoke all on function private.invoice_snapshot(uuid) from public,anon,authenticated;

create function private.invoice_edit_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d jsonb;
begin
 if auth.uid() is null or not private.is_superadmin() then raise insufficient_privilege; end if;
 d:=private.invoice_snapshot(p_id);
 if d is null then raise exception 'La factura ya no existe. Actualiza el historial.'; end if;
 return jsonb_build_object('document',d,'hasReturns',exists(select 1 from public.sales_returns where document_id=p_id),
  'history',coalesce((select jsonb_agg(jsonb_build_object('id',id,'revision',revision,'actorName',actor_name,'createdAt',created_at,
   'before',before_snapshot,'after',after_snapshot) order by revision desc) from private.invoice_corrections where document_id=p_id),'[]'));
end $$;
revoke all on function private.invoice_edit_detail(uuid) from public,anon;
grant execute on function private.invoice_edit_detail(uuid) to authenticated;
create function public.invoice_edit_detail(p_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$select private.invoice_edit_detail(p_id);$$;
revoke all on function public.invoice_edit_detail(uuid) from public,anon;
grant execute on function public.invoice_edit_detail(uuid) to authenticated;

-- La reconstrucción escribe costos ya calculados: sólo consume/devuelve las
-- diferencias de unidades y conserva el costo histórico de las que permanecen.
do $triggers$ declare s text; begin
 s:=pg_get_functiondef('public.create_document(jsonb)'::regprocedure);
 if position('v_result:=private.create_document(p_payload);' in s)=0 then raise exception 'Revisar los reintentos del emisor.'; end if;
 s:=replace(s,'v_result:=private.create_document(p_payload);',E'v_result:=private.create_document(p_payload);\n if coalesce((v_result->>''revision'')::integer,0)>0 then return v_result; end if;');
 execute s;
 s:=pg_get_functiondef('private.save_invoice_payments(uuid,jsonb)'::regprocedure);
 if position('if d.created_by<>auth.uid() or d.request_payload<>p_payload then' in s)=0 then raise exception 'Revisar validación de pagos divididos.'; end if;
 s:=replace(s,'if d.created_by<>auth.uid() or d.request_payload<>p_payload then', 'if not private.in_invoice_correction(d.id) and (d.created_by<>auth.uid() or d.request_payload<>p_payload) then');
 s:=replace(s,'(d.request_payload->>''exchangeRate'')::numeric','coalesce((d.corrected_terms->>''exchangeRate'')::numeric,(d.request_payload->>''exchangeRate'')::numeric)');
 execute s;
 s:=pg_get_functiondef('private.snapshot_sale_cost()'::regprocedure);
 s:=regexp_replace(s,E'begin\\s*',E'begin\n if private.in_invoice_correction(new.document_id) then return new; end if;\n');
 execute s;
 s:=pg_get_functiondef('private.freeze_total_inventory_cost()'::regprocedure);
 s:=regexp_replace(s,E'begin\\s*',E'begin\n if tg_table_name=''document_item_costs'' then\n  if private.in_invoice_correction(new.document_id) then return new; end if;\n end if;\n');
 execute s;
 s:=pg_get_functiondef('private.guard_business_day()'::regprocedure);
 s:=regexp_replace(s,E'begin\\s*',E'begin\n if tg_op=''UPDATE'' and tg_table_name=''documents'' then\n  if private.in_invoice_correction(old.id) then return new; end if;\n elsif tg_op=''UPDATE'' and tg_table_name=''finance_entries'' then\n  if private.in_invoice_correction(old.document_id) then return new; end if;\n end if;\n');
 execute s;
end $triggers$;

alter table private.business_day_events drop constraint business_day_events_event_check;
alter table private.business_day_events add constraint business_day_events_event_check check(event in ('close','reopen','correct','invoice_corrected'));
alter table private.business_day_events drop constraint business_day_events_check;
alter table private.business_day_events add constraint business_day_events_check check(
 (event in ('close','invoice_corrected') and report is not null) or (event='reopen' and report is null) or event='correct');

create function private.correct_invoice(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 v_id uuid:=(p_input->>'documentId')::uuid; v_request uuid:=(p_input->>'requestId')::uuid;
 d public.documents%rowtype; saved private.invoice_corrections%rowtype; c public.customers%rowtype;
 b public.business_days%rowtype; v_before jsonb; v_after jsonb; v_items jsonb:='[]';
 x jsonb; old_item jsonb; v_product uuid; v_day date;
 v_currency text:=p_input->>'currency'; v_location text:=p_input->>'location'; v_payment text:=p_input->>'paymentMethod';
 v_shipping_method text:=nullif(p_input->>'shippingMethod',''); v_tier text:=p_input->>'tier';
 v_name text:=btrim(p_input->>'customerName'); v_phone text:=nullif(btrim(p_input->>'customerPhone'),'');
 v_tax text:=coalesce(p_input->>'customerTaxId',''); v_notes text:=coalesce(p_input->>'notes','');
 v_rate numeric; v_catalog_rate numeric; v_price numeric; v_original_price numeric; v_qty integer; v_original numeric:=0; v_goods numeric:=0;
 v_discount numeric; v_shipping numeric; v_total numeric; v_weight numeric:=0; v_allocated numeric:=0; v_share numeric;
 v_old_qty integer; v_keep integer; v_return integer; v_take integer; v_stock integer; v_all_stock integer;
 v_average numeric; v_old_cost numeric; v_cost numeric; v_return_cost numeric; v_take_cost numeric; v_unit_cost numeric;
 v_collected numeric; v_report jsonb; v_correction_id uuid;
begin
 if auth.uid() is null or not private.is_superadmin() then raise insufficient_privilege; end if;
 if v_id is null or v_request is null then raise exception 'Falta identificar la factura o la solicitud.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('document:'||v_id::text,0));
 select * into saved from private.invoice_corrections where request_id=v_request;
 if found then
  if saved.actor_id<>auth.uid() or saved.request_payload<>p_input then raise exception 'La solicitud de edición cambió.'; end if;
  return private.invoice_snapshot(saved.document_id);
 end if;
 select * into d from public.documents where id=v_id and kind='invoice' for update;
 if not found then raise exception 'La factura ya no existe. Actualiza el historial.'; end if;
 if not(p_input ? 'expectedRevision') or (p_input->>'expectedRevision')::integer is distinct from d.revision then
  raise exception 'La factura cambió desde que abriste la edición. Carga su última versión antes de guardar.';
 end if;
 if not exists(select 1 from public.business_days where day=(now() at time zone 'America/Managua')::date and closed_at is null) then
  raise exception 'Abre la tienda desde Inicio para registrar la corrección.';
 end if;
 if exists(select 1 from public.sales_returns where document_id=v_id) then
  raise exception 'Esta factura tiene notas de crédito. Conserva su detalle original y registra la corrección con una nueva factura o devolución.';
 end if;
 if v_currency is null or v_currency not in ('NIO','USD') or v_location is null or v_location not in ('store','warehouse')
  or v_payment is null or v_payment not in ('pending','cash','card_pos','bank_transfer','bac_nio','bac_usd','lafise_nio','lafise_usd','ficohsa_nio','ficohsa_usd')
  or not exists(select 1 from public.price_tiers where code=v_tier) then raise exception 'Revisa moneda, lista, ubicación y forma de pago.'; end if;
 if p_input ? 'payments' and jsonb_typeof(p_input->'payments') is distinct from 'array' then raise exception 'Revisa los pagos de la factura.'; end if;
 if not(p_input ? 'payments') or jsonb_array_length(p_input->'payments')=0 then
  if (v_payment like '%_nio' and v_currency<>'NIO') or (v_payment like '%_usd' and v_currency<>'USD') then
   raise exception 'Selecciona la cuenta bancaria en la moneda de la factura, o utiliza pagos divididos.';
  end if;
 end if;
 if length(coalesce(v_name,'')) not between 1 and 160 or length(coalesce(v_phone,''))>40 or length(v_tax)>80 or length(v_notes)>2000 then
  raise exception 'Revisa los datos del cliente y las notas.';
 end if;
 if jsonb_typeof(p_input->'items') is distinct from 'array' or jsonb_array_length(p_input->'items') not between 1 and 100 then raise exception 'La factura necesita entre 1 y 100 perfumes.'; end if;
 if (select count(distinct z->>'productId') from jsonb_array_elements(p_input->'items')z)<>jsonb_array_length(p_input->'items') then raise exception 'No repitas el mismo perfume. Cambia su cantidad.'; end if;
 v_rate:=case when v_currency='NIO' then 1 else private.accounting_rate(p_input) end;
 v_catalog_rate:=case when v_currency='USD' then v_rate when nullif(p_input->>'catalogRate','') is not null then private.accounting_number(p_input,'catalogRate',1000,6) else d.catalog_rate end;
 if v_catalog_rate<=0 then raise exception 'Revisa el tipo de cambio.'; end if;
 v_discount:=private.accounting_number(p_input,'invoiceDiscount',100000000000000,2);
 v_shipping:=private.accounting_number(p_input,'shippingAmount',10000000,2);
 if v_shipping_method is not null and v_shipping_method not in ('moto','cargotrans','buses') then raise exception 'Selecciona un tipo de envío válido.'; end if;
 if v_shipping_method is null and v_shipping<>0 then raise exception 'Selecciona el tipo de envío.'; end if;
 v_before:=private.invoice_snapshot(v_id);
 v_day:=(d.created_at at time zone 'America/Managua')::date;
 for v_product in select id from public.products where id in (
  select product_id from public.document_items where document_id=v_id union
  select (z->>'productId')::uuid from jsonb_array_elements(p_input->'items')z) order by id loop
  perform 1 from public.products where id=v_product for update;
  perform 1 from public.inventory_balances where product_id=v_product order by location for update;
 end loop;
 for x in select value from jsonb_array_elements(p_input->'items') loop
  v_product:=(x->>'productId')::uuid;
  select z into old_item from jsonb_array_elements(v_before->'items')z where (z->>'product_id')::uuid=v_product;
  if not exists(select 1 from public.products where id=v_product and (active or old_item is not null)) then raise exception 'El perfume ya no está disponible.'; end if;
  if jsonb_typeof(x->'quantity') is distinct from 'number' or (x->>'quantity')::numeric<>trunc((x->>'quantity')::numeric) then raise exception 'La cantidad debe ser entera.'; end if;
  v_qty:=(x->>'quantity')::integer;
  if v_qty not between 1 and 10000 then raise exception 'Cantidad fuera de rango.'; end if;
  v_original_price:=private.accounting_number(x,'unitPrice',10000000,2);
  v_price:=case when x ? 'finalUnitPrice' then private.accounting_number(x,'finalUnitPrice',10000000,2) else v_original_price end;
  if v_price<=0 or v_price>v_original_price then raise exception 'Revisa el precio unitario y su descuento.'; end if;
  v_original:=v_original+v_qty*v_original_price; v_goods:=v_goods+v_qty*v_price;
  v_items:=v_items||jsonb_build_array(jsonb_build_object('id',coalesce((old_item->>'id')::uuid,gen_random_uuid()),'productId',v_product,
   'quantity',v_qty,'unitPrice',v_price,'originalUnitPrice',v_original_price,'description',
   coalesce(old_item->>'description',(select br.name||' · '||p.name||case when p.size is null then '' else ' · '||p.size::text||' '||p.unit end from public.products p join public.brands br on br.id=p.brand_id where p.id=v_product))));
 end loop;
 if v_discount>=v_goods then raise exception 'El descuento total debe ser menor al importe de los productos.'; end if;
 v_total:=v_goods-v_discount+v_shipping;
 if p_input ? 'expectedTotal' and private.accounting_number(p_input,'expectedTotal',100000000000000,2)<>v_total then raise exception 'El total cambió. Revisa los importes antes de guardar.'; end if;
 select coalesce(sum(round(amount*exchange_rate,2)),0) into v_collected from public.finance_entries where document_id=v_id and kind='collection' and voided_at is null;
 if v_collected>round(v_total*v_rate,2) then raise exception 'El total es menor que los abonos ya recibidos. Revisa esos cobros o registra la devolución correspondiente.'; end if;
 if v_payment<>'pending' and exists(select 1 from public.finance_entries where document_id=v_id and voided_at is null and occurred_on<>v_day) then
  raise exception 'Hay abonos recibidos en otras fechas. Conserva la factura por cobrar y corrige esos pagos desde Cobros y pagos para respetar sus fechas.';
 end if;
 if nullif(p_input->>'customerId','') is not null then
  select * into c from public.customers where id=(p_input->>'customerId')::uuid and (active or id=d.customer_id);
  if not found then raise exception 'Cliente no disponible.'; end if;
 else
  select * into c from public.customers where active and ((name=v_name and phone is not distinct from v_phone) or (v_phone is not null and phone=v_phone)) order by id limit 1;
  if not found then insert into public.customers(name,phone,tax_id,price_tier) values(v_name,v_phone,v_tax,v_tier) returning * into c; end if;
 end if;
 perform private.limit_catalog_writes();
 insert into private.invoice_corrections(document_id,revision,before_snapshot,actor_id,actor_name,request_id,request_payload)
 values(v_id,d.revision+1,v_before,auth.uid(),coalesce((select display_name from private.business_actors where id=auth.uid()),'SuperAdmin'),v_request,p_input) returning id into v_correction_id;
 perform private.set_cost_cause(jsonb_build_object('kind','invoice_corrected','reference',d.number));
 -- Ajustar sólo las diferencias reales de existencias y de valor.
 for v_product in select id from public.products where id in (
  select (z->>'product_id')::uuid from jsonb_array_elements(v_before->'items')z union
  select (z->>'productId')::uuid from jsonb_array_elements(v_items)z) order by id loop
  select z into old_item from jsonb_array_elements(v_before->'items')z where (z->>'product_id')::uuid=v_product;
  select z into x from jsonb_array_elements(v_items)z where (z->>'productId')::uuid=v_product;
  v_old_qty:=coalesce((old_item->>'quantity')::integer,0); v_qty:=coalesce((x->>'quantity')::integer,0);
  select coalesce((z->>'total_cost_nio')::numeric,round((z->>'quantity')::integer*(z->>'unit_cost_nio')::numeric,2)) into v_old_cost
   from jsonb_array_elements(v_before->'costs')z where (z->>'product_id')::uuid=v_product;
  v_keep:=case when d.location=v_location then least(v_old_qty,v_qty) else 0 end;
  v_return:=v_old_qty-v_keep; v_take:=v_qty-v_keep;
  v_return_cost:=case when v_old_qty=0 then 0 else v_old_cost-coalesce(round(v_old_cost*v_keep/v_old_qty,2),0) end;
  if (v_return>0 or v_take>0) and v_old_qty>0 and v_old_cost is null then raise exception 'Falta el costo histórico de un perfume. Completa sus costos antes de cambiar cantidades.'; end if;
  select average_cost_nio into v_average from public.product_costs where product_id=v_product;
  if v_return>0 then
   select quantity into v_stock from public.inventory_balances where product_id=v_product and location=d.location;
   if v_stock is null then raise exception 'Falta el conteo de la ubicación original.'; end if;
   select coalesce(sum(quantity),0) into v_all_stock from public.inventory_balances where product_id=v_product;
   perform private.receive_inventory_value(v_product,v_return,v_return_cost,v_all_stock,v_average);
   update public.inventory_balances set quantity=quantity+v_return,updated_at=now() where product_id=v_product and location=d.location;
   insert into public.inventory_movements(product_id,location,type,quantity,before_quantity,after_quantity,document_id,actor_id,reference,note,is_invoice_reversal)
    values(v_product,d.location,'ADJUSTMENT',v_return,v_stock,v_stock+v_return,v_id,auth.uid(),d.number,'Corrección de factura '||d.number,true);
  end if;
  v_take_cost:=0;
  if v_take>0 then
   if not exists(select 1 from public.products where id=v_product and active) then raise exception 'Reactiva el perfume antes de agregar más unidades a la factura.'; end if;
   select quantity into v_stock from public.inventory_balances where product_id=v_product and location=v_location;
   if v_stock is null then raise exception 'Registra primero el conteo de la ubicación seleccionada.'; end if;
   if v_stock<v_take then raise exception 'Existencias insuficientes para «%»: puedes facturar hasta % unidades desde %, contando las que ya incluye esta factura.',
    (select name from public.products where id=v_product),v_stock+v_keep,case when v_location='store' then 'Tienda' else 'Bodega' end; end if;
   select average_cost_nio into v_average from public.product_costs where product_id=v_product;
   if v_average is null then raise exception 'Falta registrar el costo del perfume antes de agregar unidades.'; end if;
   select coalesce(sum(quantity),0) into v_all_stock from public.inventory_balances where product_id=v_product;
   v_take_cost:=private.consume_inventory_value(v_product,v_take,v_all_stock,v_average);
   update public.inventory_balances set quantity=quantity-v_take,updated_at=now() where product_id=v_product and location=v_location;
   insert into public.inventory_movements(product_id,location,type,quantity,before_quantity,after_quantity,document_id,actor_id,reference,note)
    values(v_product,v_location,'SALE',v_take,v_stock,v_stock-v_take,v_id,auth.uid(),d.number,'Corrección de factura '||d.number);
  end if;
  v_cost:=case when v_keep>0 then v_old_cost-v_return_cost else 0 end+v_take_cost;
  if v_old_qty=v_qty and d.location=v_location then
   v_cost:=v_old_cost;
   select (z->>'unit_cost_nio')::numeric into v_unit_cost from jsonb_array_elements(v_before->'costs')z where (z->>'product_id')::uuid=v_product;
  else v_unit_cost:=case when v_qty>0 then round(v_cost/v_qty,5) end; end if;
  if x is not null then
   v_items:=(select jsonb_agg(case when z->>'productId'=v_product::text then z||jsonb_build_object('cost',v_cost,'unitCost',v_unit_cost) else z end) from jsonb_array_elements(v_items)z);
  end if;
 end loop;
 if v_payment<>'pending' then
  update public.finance_entries set voided_at=now(),voided_by=auth.uid(),void_reason='Cobro incorporado a la forma de pago corregida de '||d.number
   where document_id=v_id and voided_at is null and kind='collection';
 end if;
 delete from public.invoice_payments where document_id=v_id;
 update public.documents set customer_id=c.id,customer_name=v_name,customer_phone=v_phone,customer_tax_id=v_tax,
  tier_code=v_tier,currency=v_currency,catalog_rate=v_catalog_rate,total=v_total,location=v_location,payment_method=v_payment,notes=v_notes,
  original_total=v_original,discount_amount=v_original-v_goods+v_discount,invoice_discount=v_discount,
  shipping_method=v_shipping_method,shipping_amount=v_shipping,shipping_nio=round(v_shipping*v_rate,2),revision=revision+1,
  corrected_terms=jsonb_build_object('exchangeRate',v_rate,'taxRate',0,'payments',coalesce(p_input->'payments','[]')) where id=v_id;
 delete from public.document_item_costs where document_id=v_id;
 delete from public.document_items where document_id=v_id and not exists(select 1 from jsonb_array_elements(v_items)z where z->>'id'=public.document_items.id::text);
 for x in select value from jsonb_array_elements(v_items) loop
  v_weight:=v_weight+(x->>'quantity')::integer*(x->>'unitPrice')::numeric;
  v_share:=round(v_discount*v_weight/v_goods,2)-v_allocated; v_allocated:=v_allocated+v_share;
  if v_share>=(x->>'quantity')::integer*(x->>'unitPrice')::numeric then raise exception 'El descuento deja un perfume sin importe.'; end if;
  insert into public.document_items(id,document_id,product_id,description,quantity,unit_price,original_unit_price,invoice_discount)
   values((x->>'id')::uuid,v_id,(x->>'productId')::uuid,x->>'description',(x->>'quantity')::integer,(x->>'unitPrice')::numeric,(x->>'originalUnitPrice')::numeric,v_share)
   on conflict(id) do update set quantity=excluded.quantity,unit_price=excluded.unit_price,original_unit_price=excluded.original_unit_price,invoice_discount=excluded.invoice_discount;
  insert into public.document_item_costs(document_item_id,document_id,product_id,quantity,unit_cost_nio,exchange_rate,tax_rate,net_revenue_nio,tax_nio,total_cost_nio)
   values((x->>'id')::uuid,v_id,(x->>'productId')::uuid,(x->>'quantity')::integer,(x->>'unitCost')::numeric,v_rate,0,
    round(((x->>'quantity')::integer*(x->>'unitPrice')::numeric-v_share)*v_rate,2),0,(x->>'cost')::numeric);
 end loop;
 if p_input ? 'payments' and jsonb_array_length(p_input->'payments')>0 then perform private.save_invoice_payments(v_id,p_input); end if;
 perform private.check_credit_pool(); perform private.check_pos_balance();
 if v_payment='pending' and v_collected>coalesce(private.credit_invoice_amount(v_id),0) then raise exception 'Los abonos superan el nuevo saldo de la factura.'; end if;
 select * into b from public.business_days where day=v_day for update;
 if b.closed_at is not null then
  v_report:=private.business_day_report(v_day)||jsonb_build_object('countedNio',(b.report->>'countedNio')::numeric,'countedUsd',(b.report->>'countedUsd')::numeric,'note',b.report->>'note');
  v_report:=v_report||jsonb_build_object('differenceNio',(v_report->>'countedNio')::numeric-(v_report->>'expectedNio')::numeric,
   'differenceUsd',(v_report->>'countedUsd')::numeric-(v_report->>'expectedUsd')::numeric);
  update public.business_days set report=v_report,revision=revision+1 where day=v_day returning * into b;
  insert into private.business_day_events(day,event,revision,actor_id,actor_name,reason,request_id,request_payload,report,opening_snapshot)
   values(v_day,'invoice_corrected',b.revision,auth.uid(),coalesce((select display_name from private.business_actors where id=auth.uid()),'SuperAdmin'),
    'Corrección de factura '||d.number,v_request,p_input,v_report,jsonb_build_object('openingNio',b.opening_nio,'openingUsd',b.opening_usd,'openedAt',b.opened_at,'closedAt',b.closed_at));
 end if;
 v_after:=private.invoice_snapshot(v_id);
 if v_after-'revision'-'corrected_terms'=v_before-'revision'-'corrected_terms' then raise exception 'No hay cambios para guardar.'; end if;
 update private.invoice_corrections set after_snapshot=v_after where id=v_correction_id;
 return v_after;
end $$;
revoke all on function private.correct_invoice(jsonb) from public,anon;
grant execute on function private.correct_invoice(jsonb) to authenticated;
create function public.correct_invoice(p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.correct_invoice(p_input);$$;
revoke all on function public.correct_invoice(jsonb) from public,anon;
grant execute on function public.correct_invoice(jsonb) to authenticated;

do $recovery$ declare s text; begin
 s:=pg_get_functiondef('private.operation_confirmation(text,uuid,boolean)'::regprocedure);
 if position('''opening-journal-correction'') then' in s)=0 then raise exception 'Revisar la recuperación de operaciones.'; end if;
 s:=replace(s,'''opening-journal-correction'') then','''opening-journal-correction'',''invoice-correction'') then');
 s:=replace(s,'when ''journal'' then','when ''invoice-correction'' then v_table:=''private.invoice_corrections'';v_actor:=''actor_id''; when ''journal'' then');
 execute s;
end $recovery$;
notify pgrst,'reload schema';

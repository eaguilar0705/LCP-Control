-- El borrador conserva el pago propuesto. Los dos comprobantes y el inventario
-- se confirman dentro de la misma transacción de revisión de la recepción.
alter table private.inventory_receipts
 add column freight_payment jsonb,
 add column freight_entry_id uuid unique references public.journal_entries(id);

create function private.check_receipt_freight(payment jsonb, currency_code text, shipping numeric)
returns void language plpgsql stable set search_path='' as $$
declare payment_code text:=payment->>'account'; payment_rate numeric;
begin
 if payment is null then return; end if;
 if jsonb_typeof(payment)<>'object' or shipping<=0 or payment_code is null
 or jsonb_typeof(payment->'reference') is distinct from 'string' or length(payment->>'reference')>200 then
  raise exception 'Revisa el pago y la referencia del flete.';
 end if;
 if payment_code='included' then return; end if;
 if payment_code not in ('1110-001','1120-001','1120-003','1120-005') and
   payment_code not in ('1110-002','1120-002','1120-004','1120-006') then
  raise exception 'Selecciona una caja o banco compatible con la moneda del flete.';
 end if;
 if currency_code='NIO' and payment_code in ('1110-002','1120-002','1120-004','1120-006') then
  payment_rate:=private.accounting_number(payment,'exchangeRate',1000,6);
  if coalesce(payment_rate,0)<=0 then raise exception 'Indica la tasa del pago del flete en dólares.'; end if;
  if round(round(shipping/payment_rate,2)*payment_rate,2)<>shipping then
   raise exception 'El flete en córdobas debe coincidir con los dólares pagados por la tasa. Revisa el importe y la tasa.';
  end if;
 end if;
 if not exists(select 1 from public.ledger_accounts a where a.code=payment_code and a.active and a.postable) then
  raise exception 'La cuenta seleccionada para el flete está inactiva.';
 end if;
end $$;

create function private.post_split_receipt_freight(p_shipment uuid, p_request uuid, purchase jsonb,
 advance_account text, payment jsonb) returns uuid language plpgsql set search_path='' as $$
declare
 s public.purchase_shipments%rowtype;
 goods numeric; freight numeric; source text; payer text:=payment->>'account';
 goods_usd boolean; freight_usd boolean; freight_rate numeric;
 description_ref text; journal_lines jsonb; freight_entry uuid;
 posting_day date:=(now() at time zone 'America/Managua')::date;
begin
 select * into strict s from public.purchase_shipments where id=p_shipment;
 goods:=round(s.goods_amount*s.exchange_rate,2);
 freight:=round(s.shipping_amount*s.exchange_rate,2);
 if not exists(select 1 from public.ledger_accounts where code='1160-002' and bucket='asset' and active and postable) then
  raise exception 'Activa la cuenta de fletes de adquisición 1160-002 antes de contabilizar.';
 end if;
 if advance_account is not null then
  if not exists(select 1 from public.ledger_accounts where code=advance_account and code<>'1160-002'
   and (code='1160' or parent='1160') and bucket='asset' and active and postable) then
   raise exception 'Selecciona una cuenta activa de anticipos para la mercadería.';
  end if;
  source:=advance_account;
 elsif purchase->>'account'='credito' then source:='2111';
 elsif purchase->>'account'='caja' then source:=case when s.currency='USD' then '1110-002' else '1110-001' end;
 elsif purchase->>'account'='banco' then
  source:=purchase->>'bankLedgerAccount';
  if source is null or not (case when s.currency='USD' then source in ('1120-002','1120-004','1120-006')
   else source in ('1120-001','1120-003','1120-005') end) then raise exception 'Revisa el banco pagador de la mercadería.'; end if;
 else raise exception 'Selecciona la contrapartida de la mercadería.';
 end if;
 description_ref:=coalesce(nullif(s.reference,''),'Recepción '||left(s.id::text,8));
 freight_usd:=payer in ('1110-002','1120-002','1120-004','1120-006');
 freight_rate:=case when not freight_usd then 1 when s.currency='USD' then s.exchange_rate
  else (payment->>'exchangeRate')::numeric end;
 goods_usd:=source in ('1110-002','1120-002','1120-004','1120-006');
 freight_entry:=private.record_journal_entry(jsonb_build_object('requestId',gen_random_uuid(),'kind','adjustment',
  'occurredOn',posting_day,'description','Pago de flete de adquisición · '||left(description_ref,120),
  'reference',coalesce(nullif(btrim(payment->>'reference'),''),description_ref),
  'lines',jsonb_build_array(
   jsonb_build_object('account','1160-002','currency','NIO','exchangeRate',1,'debit',freight,'credit',0),
   jsonb_build_object('account',payer,'currency',case when freight_usd then 'USD' else 'NIO' end,
    'exchangeRate',freight_rate,'debit',0,
    'credit',case when freight_usd and s.currency='USD' then s.shipping_amount else round(freight/freight_rate,2) end))));
 journal_lines:=jsonb_build_array(jsonb_build_object('account','1130','currency','NIO','exchangeRate',1,
  'debit',goods+freight,'credit',0));
 if goods>0 then
  journal_lines:=journal_lines||jsonb_build_array(jsonb_build_object('account',source,
   'currency',case when goods_usd then 'USD' else 'NIO' end,
   'exchangeRate',case when goods_usd then s.exchange_rate else 1 end,'debit',0,
   'credit',case when goods_usd then s.goods_amount else goods end));
 end if;
 perform private.classify_purchase(jsonb_build_object('shipmentId',s.id,'requestId',p_request,
  'occurredOn',posting_day,'description','Recepción de mercadería con flete · '||left(description_ref,120),
  'reference',description_ref,'lines',journal_lines||jsonb_build_array(jsonb_build_object(
  'account','1160-002','currency','NIO','exchangeRate',1,'debit',0,'credit',freight))));
 return freight_entry;
end $$;

revoke all on function private.check_receipt_freight(jsonb,text,numeric),
 private.post_split_receipt_freight(uuid,uuid,jsonb,text,jsonb) from public,anon,authenticated;

do $migration$
declare d text; marker text; old_block text;
begin
 d:=pg_get_functiondef('private.record_inventory_receipt(jsonb)'::regprocedure);
 marker:='insert into private.inventory_receipt_operations values';
 if position(marker in d)=0 then raise exception 'Revisar registro de recepciones'; end if;
 execute replace(d,marker,$new$
 perform private.check_receipt_freight(p_input->'freightPayment',p_input->>'currency',v_shipping);
 update private.inventory_receipts set freight_payment=p_input->'freightPayment' where id=v_id;
 $new$||marker);
 d:=pg_get_functiondef('private.inventory_receipts(jsonb)'::regprocedure);
 marker:='''shippingAmount'',r.shipping_amount';
 if position(marker in d)=0 then raise exception 'Revisar consulta de recepciones'; end if;
 d:=replace(d,marker,marker||',''freightPayment'',r.freight_payment');
 marker:='''goodsAmount'',s.goods_amount';
 if position(marker in d)=0 then raise exception 'Revisar detalle del comprobante de flete'; end if;
 execute replace(d,marker,$new$'freightVoucher',(select number from public.journal_entries where id=r.freight_entry_id),
   'receiptVoucher',(select e.number from private.purchase_classifications c join public.journal_entries e on e.id=c.entry_id where c.shipment_id=s.id),$new$||marker);
 d:=replace(pg_get_functiondef('private.post_inventory_receipt(jsonb)'::regprocedure),E'\r\n',E'\n');
 old_block:=$old$v_shipment:=private.record_shipment(v_purchase||jsonb_build_object('requestId',v_request));
  if p_input ? 'advanceAccount' then
   perform private.classify_receipt_advance(v_shipment,v_request,p_input->>'advanceAccount');
  end if;$old$;
 old_block:=replace(old_block,chr(13)||chr(10),chr(10));
 if position(old_block in d)=0 then raise exception 'Revisar contabilización de recepciones'; end if;
 execute replace(d,old_block,$new$
  perform private.check_receipt_freight(p_input->'freightPayment',v_purchase->>'currency',(v_purchase->>'shippingAmount')::numeric);
  if (v_purchase->>'shippingAmount')::numeric>0 and not p_input ? 'freightPayment'
     and (r.freight_payment is not null or p_input ? 'advanceAccount') then
   raise exception 'Selecciona cómo se pagó el flete antes de contabilizar.';
  end if;
  if p_input->'freightPayment'->>'account'<>'included' then
   v_shipment:=private.record_shipment((v_purchase-'bankLedgerAccount')||jsonb_build_object('requestId',v_request,'account','pending'));
   update private.inventory_receipts set freight_entry_id=private.post_split_receipt_freight(
    v_shipment,v_request,v_purchase,p_input->>'advanceAccount',p_input->'freightPayment') where id=v_id;
  else
   v_shipment:=private.record_shipment(v_purchase||jsonb_build_object('requestId',v_request));
   if p_input ? 'advanceAccount' then
    if p_input->>'advanceAccount'='1160-002' then raise exception 'Selecciona la cuenta de anticipo de la mercadería.'; end if;
    perform private.classify_receipt_advance(v_shipment,v_request,p_input->>'advanceAccount');
   end if;
  end if;
 $new$);
end $migration$;

create or replace function private.original_receipt_advance(p_shipment uuid) returns uuid
language sql stable set search_path='' as $$
 select e.id from private.purchase_classifications c
 join public.journal_entries e on e.id=c.entry_id
 join private.inventory_receipt_operations op on op.result_id=c.shipment_id
   and op.kind='inventory-receipt-post' and op.request_id=e.request_id
 where c.shipment_id=p_shipment and (op.request_payload ? 'advanceAccount'
   or op.request_payload->'freightPayment'->>'account'<>'included')
   and e.revision=0 and e.voided_at is null
$$;
do $migration$
declare d text; marker text;
begin
 d:=pg_get_functiondef('private.purchase_history(timestamptz,uuid)'::regprocedure);
 marker:='''advance_entry_id'',private.original_receipt_advance';
 if position(marker in d)=0 then raise exception 'Revisar historial de compras'; end if;
 execute replace(d,marker,$new$'freight_entry_id',(select r.freight_entry_id from private.inventory_receipts r
   where r.shipment_id=(x->>'id')::uuid),'advance_entry_id',private.original_receipt_advance$new$);
end $migration$;


-- Al anular la entrada, el superadmin distingue el pago real de un pago registrado por error.
do $migration$
declare d text:=pg_get_functiondef('private.correct_purchase(jsonb)'::regprocedure);
 marker text:='select pc.entry_id into entry_id';
begin
 if position(marker in d)=0 then raise exception 'Revisar anulación de compras'; end if;
 execute replace(d,marker,$new$
 declare freight_id uuid;
 begin
  select e.id into freight_id from private.inventory_receipts r join public.journal_entries e on e.id=r.freight_entry_id
   where r.shipment_id=shipment and e.voided_at is null for update of e;
  if freight_id is not null then
   if coalesce(p_input->>'freightTreatment','') not in ('keep','void') then
    raise exception 'Indica si el pago del flete fue real o se registró por error.';
   end if;
   if p_input->>'freightTreatment'='void' then
    perform private.void_journal_entry(freight_id,p_input->>'reason');
   end if;
  end if;
 end;
 $new$||marker);
end $migration$;

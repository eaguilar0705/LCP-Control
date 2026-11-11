-- Una recepción pagada por adelantado consume el activo del anticipo.
-- La entrada de existencias y su clasificación se confirman juntas.
create function private.classify_receipt_advance(p_shipment uuid,p_request uuid,p_account text)
returns void language plpgsql set search_path='' as $$
declare s public.purchase_shipments%rowtype; amount numeric;
begin
 if not exists(select 1 from public.ledger_accounts
  where code=p_account and (code='1160' or parent='1160')
   and bucket='asset' and active and postable) then
  raise exception 'Selecciona una cuenta activa de anticipos.';
 end if;
 select * into strict s from public.purchase_shipments where id=p_shipment;
 amount:=round(s.goods_amount*s.exchange_rate,2)+round(s.shipping_amount*s.exchange_rate,2);
 perform private.classify_purchase(jsonb_build_object(
  'shipmentId',s.id,'requestId',p_request,
  'occurredOn',(now() at time zone 'America/Managua')::date,
  'description','Aplicación de anticipo de compra','reference',s.reference,
  'lines',jsonb_build_array(
   jsonb_build_object('account','1130','currency','NIO','exchangeRate',1,'debit',amount,'credit',0),
   jsonb_build_object('account',p_account,'currency','NIO','exchangeRate',1,'debit',0,'credit',amount)
  )));
end $$;
revoke all on function private.classify_receipt_advance(uuid,uuid,text) from public,anon,authenticated;

do $receipt$
declare definition text; guard text; marker text;
begin
 definition:=pg_get_functiondef('private.post_inventory_receipt(jsonb)'::regprocedure);
 guard:=$old$if coalesce(v_purchase->>'account','') not in ('caja','banco','credito') then raise exception 'Selecciona explícitamente Caja, Banco o Crédito del proveedor.'; end if;$old$;
 marker:=$old$v_shipment:=private.record_shipment(v_purchase||jsonb_build_object('requestId',v_request));$old$;
 if position(guard in definition)=0 or position(marker in definition)=0 then
  raise exception 'Revisar la función vigente de contabilización de recepciones.';
 end if;
 definition:=replace(definition,guard,$new$
  if p_input ? 'advanceAccount' then
   if v_purchase->>'account' is distinct from 'pending'
    or jsonb_typeof(p_input->'advanceAccount') is distinct from 'string'
    or v_purchase ? 'bankLedgerAccount' then
    raise exception 'Revisa la cuenta del anticipo de la compra.';
   end if;
  elsif coalesce(v_purchase->>'account','') not in ('caja','banco','credito') then
   raise exception 'Selecciona explícitamente Caja, Banco o Crédito del proveedor.';
  end if;$new$);
 definition:=replace(definition,marker,marker||$new$
  if p_input ? 'advanceAccount' then
   perform private.classify_receipt_advance(v_shipment,v_request,p_input->>'advanceAccount');
  end if;$new$);
 execute definition;
end $receipt$;

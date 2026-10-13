-- Audit: a single opening for debt balances, conserved inventory cost,
-- counted gains and daily cash measured after the physical opening count.
alter table public.finance_entries add column bank_ledger_account text references public.ledger_accounts(code);
create index finance_entries_bank_ledger on public.finance_entries(bank_ledger_account) where bank_ledger_account is not null;
create function private.credit_opening(p_at date) returns table(day date,receivables numeric,payables numeric)
language sql stable security definer set search_path='' as $$
 with j as (select e.id,e.occurred_on from public.journal_entries e where kind='opening' and voided_at is null and occurred_on<=p_at),
 legacy as (select min(occurred_on) as day,coalesce(sum(round(amount*exchange_rate,2)) filter(where account='cobrar'),0) receivables,
 coalesce(sum(round(amount*exchange_rate,2)) filter(where account='proveedores'),0) payables from public.finance_entries where kind='opening' and voided_at is null and occurred_on<=p_at)
 select j.occurred_on,coalesce(sum(l.debit_nio-l.credit_nio) filter(where l.account='1140'),0),coalesce(sum(l.credit_nio-l.debit_nio) filter(where l.account='2111'),0)
 from j left join public.journal_lines l on l.entry_id=j.id group by j.occurred_on
 union all select * from legacy where not exists(select 1 from j);
$$;
revoke all on function private.credit_opening(date) from public,anon,authenticated;
create or replace function private.record_finance_entry(p_input jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 v_uid uuid:=auth.uid(); v_request uuid; v_existing public.finance_entries%rowtype;
 v_kind text:=p_input->>'kind'; v_account text:=p_input->>'account'; v_to text:=nullif(p_input->>'toAccount','');
 v_document uuid:=nullif(p_input->>'documentId','')::uuid;
 v_shipment uuid:=nullif(p_input->>'shipmentId','')::uuid;
 v_amount numeric; v_rate numeric; v_date date; v_id uuid; v_start date;
 v_doc public.documents%rowtype; v_purchase public.purchase_shipments%rowtype;
 v_original numeric; v_paid numeric; v_nio numeric; v_source_date date;
 v_initial boolean:=false; v_party text:=trim(coalesce(p_input->>'counterparty',''));
begin
 if v_uid is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 v_request:=(p_input->>'requestId')::uuid;
 if v_request is null then raise exception 'Falta el identificador de operación.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('finance:'||v_uid::text||v_request::text,0));
 select * into v_existing from public.finance_entries where created_by=v_uid and request_id=v_request;
 if found then
  if v_existing.request_payload<>p_input then raise exception 'La operación ya existe con otros datos.'; end if;
  return v_existing.id;
 end if;
 if v_kind is null or v_kind not in ('opening','capital','withdrawal','transfer','loan','supplier_payment','collection') then
  raise exception 'Tipo de movimiento inválido.'; end if;
 if v_account is null or v_account not in ('caja','banco','cobrar','prestamos','proveedores')
  or (v_kind<>'opening' and v_account not in ('caja','banco')) then raise exception 'Cuenta inválida.'; end if;
 if nullif(p_input->>'bankLedgerAccount','') is not null and
  (v_account<>'banco' or not exists(select 1 from public.ledger_accounts where code=p_input->>'bankLedgerAccount' and code like '1120-%' and postable and active)) then
  raise exception 'Selecciona una cuenta bancaria válida.';
 end if;
 if (v_kind='transfer') <> (v_to is not null) or (v_to is not null and (v_to not in ('caja','banco') or v_to=v_account)) then
  raise exception 'Elige la cuenta de destino.'; end if;
 if (v_document is not null and (v_kind<>'collection' or v_shipment is not null))
  or (v_shipment is not null and v_kind<>'supplier_payment') then raise exception 'La deuda no corresponde a este movimiento.'; end if;
 v_amount:=private.accounting_number(p_input,'amount',1000000000);
 v_rate:=private.accounting_rate(p_input); v_nio:=round(v_amount*v_rate,2);
 if v_amount<=0 and v_kind<>'opening' then raise exception 'Revisa el monto.'; end if;
 if v_kind<>'opening' and v_nio<=0 then raise exception 'El abono debe ser de al menos un centavo en córdobas.'; end if;
 v_date:=(p_input->>'occurredOn')::date;
 if v_date is null or v_date>(now() at time zone 'America/Managua')::date then raise exception 'Fecha inválida.'; end if;

 -- Serializa abonos entre distintos usuarios, sus anulaciones y las aperturas.
 -- El bloqueo de la fuente también se coordina con delete_invoice.
 perform pg_advisory_xact_lock(hashtextextended('finance-credit-ledger',0));
 select day into v_start from private.credit_opening('infinity'::date);
 if v_kind='opening' and exists(select 1 from public.journal_entries where kind='opening' and voided_at is null) then raise exception 'Los saldos iniciales se registran desde Comprobantes.'; end if;
 if v_kind='opening' then
  if exists(select 1 from public.finance_entries where kind='opening' and account=v_account and voided_at is null) then
   raise exception 'Esta cuenta ya tiene saldo inicial. Para corregirlo, anula el registro original.'; end if;
  if v_start is not null and v_date<>v_start then raise exception 'Los saldos iniciales deben tener la misma fecha: %.',v_start; end if;
  -- Una apertura posterior a abonos ya vinculados rompería el seguimiento.
  if exists(select 1 from public.finance_entries e
   left join public.documents d on d.id=e.document_id left join public.purchase_shipments s on s.id=e.shipment_id
   where e.voided_at is null and (e.document_id is not null or e.shipment_id is not null)
   and (e.occurred_on<v_date or coalesce((d.created_at at time zone 'America/Managua')::date,s.incurred_on)<v_date)) then
   raise exception 'La apertura debe incluir la fecha de los abonos ya registrados.'; end if;
 end if;
 if v_kind in ('collection','supplier_payment') then
  if v_start is not null and v_date<v_start then raise exception 'El abono no puede ser anterior al saldo inicial.'; end if;
  if v_document is not null then
   select * into v_doc from public.documents where id=v_document for update;
   if not found or v_doc.kind<>'invoice' or v_doc.payment_method<>'pending' then raise exception 'Elige una factura a crédito existente.'; end if;
   v_source_date:=(v_doc.created_at at time zone 'America/Managua')::date;
   v_original:=private.credit_invoice_amount(v_document);
   if v_original is null then raise exception 'La factura no tiene un importe contable completo. Revisa su registro antes de cobrar.'; end if;
   v_party:=v_doc.customer_name;
   select coalesce(sum(round(amount*exchange_rate,2)),0) into v_paid from public.finance_entries
    where document_id=v_document and voided_at is null;
  elsif v_shipment is not null then
   select * into v_purchase from public.purchase_shipments where id=v_shipment for update;
   if not found or v_purchase.account<>'credito' then raise exception 'Elige un pedido a crédito existente.'; end if;
   v_source_date:=v_purchase.incurred_on;
   v_original:=round(v_purchase.goods_amount*v_purchase.exchange_rate,2)+round(v_purchase.shipping_amount*v_purchase.exchange_rate,2);
   v_party:=v_purchase.supplier;
   select coalesce(sum(round(amount*exchange_rate,2)),0) into v_paid from public.finance_entries
    where shipment_id=v_shipment and voided_at is null;
  else
   v_initial:=true; v_source_date:=v_start;
   if v_start is null then raise exception 'Selecciona una factura o pedido; no hay saldo inicial de deuda.'; end if;
   select case v_kind when 'collection' then receivables else payables end into v_original from private.credit_opening(v_date);
   select coalesce(sum(round(amount*exchange_rate,2)),0) into v_paid from public.finance_entries
    where kind=v_kind and document_id is null and shipment_id is null and voided_at is null and occurred_on>=v_start;
  end if;
  if v_start is not null and v_source_date<v_start then
   raise exception 'Esta deuda es anterior a la apertura. Usa el saldo inicial pendiente para evitar duplicarla.'; end if;
  if v_date<v_source_date then raise exception 'El abono no puede ser anterior a la factura o pedido.'; end if;
  if v_nio>v_original-v_paid then raise exception 'El abono supera el saldo pendiente de C$ %.',greatest(0,v_original-v_paid); end if;
 end if;
 perform private.limit_catalog_writes();
 insert into public.finance_entries(request_id,request_payload,occurred_on,kind,account,to_account,amount,currency,exchange_rate,
  counterparty,description,reference,created_by,document_id,shipment_id,opening_settlement,bank_ledger_account)
 values(v_request,p_input,v_date,v_kind,v_account,v_to,v_amount,p_input->>'currency',v_rate,
  v_party,trim(coalesce(p_input->>'description','')),trim(coalesce(p_input->>'reference','')),v_uid,v_document,v_shipment,v_initial,nullif(p_input->>'bankLedgerAccount',''))
 returning id into v_id;
 return v_id;
end $$;
create or replace function private.credit_accounts(p_at date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_start date; v_rows jsonb; v_initial_receivables numeric; v_initial_payables numeric;
 v_paid_receivables numeric; v_paid_payables numeric; v_legacy bigint;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_at is null then raise exception 'Fecha inválida.'; end if;
 select day,receivables,payables into v_start,v_initial_receivables,v_initial_payables from private.credit_opening(p_at);
 with sources as (
  select d.id::text as id,'receivable'::text as kind,d.customer_name as counterparty,d.number as reference,
   (d.created_at at time zone 'America/Managua')::date as occurred_on,
   private.credit_invoice_amount(d.id) as original,
   (select coalesce(sum(round(e.amount*e.exchange_rate,2)),0) from public.finance_entries e
    where e.document_id=d.id and e.voided_at is null and e.occurred_on<=p_at) as paid,
   d.id as document_id,null::uuid as shipment_id
  from public.documents d where d.kind='invoice' and d.payment_method='pending'
   and (d.created_at at time zone 'America/Managua')::date<=p_at
   and (v_start is null or (d.created_at at time zone 'America/Managua')::date>=v_start)
  union all
  select s.id::text,'payable',s.supplier,coalesce(nullif(s.reference,''),'Pedido '||left(s.id::text,8)),s.incurred_on,
   round(s.goods_amount*s.exchange_rate,2)+round(s.shipping_amount*s.exchange_rate,2),
   (select coalesce(sum(round(e.amount*e.exchange_rate,2)),0) from public.finance_entries e
    where e.shipment_id=s.id and e.voided_at is null and e.occurred_on<=p_at),null::uuid,s.id
  from public.purchase_shipments s where s.account='credito' and s.incurred_on<=p_at
   and (v_start is null or s.incurred_on>=v_start)
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'counterparty',counterparty,'reference',reference,
  'occurredOn',occurred_on,'originalNio',original,'paidNio',paid,'balanceNio',original-paid,
  'documentId',document_id,'shipmentId',shipment_id) order by occurred_on,id),'[]'::jsonb)
 into v_rows from sources;

 select coalesce(sum(round(amount*exchange_rate,2)) filter(where kind='collection'),0),
  coalesce(sum(round(amount*exchange_rate,2)) filter(where kind='supplier_payment'),0),
  count(*) filter(where not opening_settlement)
 into v_paid_receivables,v_paid_payables,v_legacy from public.finance_entries
 where kind in ('collection','supplier_payment') and document_id is null and shipment_id is null
  and voided_at is null and occurred_on<=p_at and (v_start is null or occurred_on>=v_start);
 if v_start is not null and v_initial_receivables>0 then
  v_rows:=v_rows||jsonb_build_array(jsonb_build_object('id','opening:receivable','kind','receivable',
   'counterparty','Saldo inicial de clientes','reference','Apertura','occurredOn',v_start,
   'originalNio',v_initial_receivables,'paidNio',v_paid_receivables,'balanceNio',v_initial_receivables-v_paid_receivables,
   'documentId',null,'shipmentId',null));
 end if;
 if v_start is not null and v_initial_payables>0 then
  v_rows:=v_rows||jsonb_build_array(jsonb_build_object('id','opening:payable','kind','payable',
   'counterparty','Saldo inicial de proveedores','reference','Apertura','occurredOn',v_start,
   'originalNio',v_initial_payables,'paidNio',v_paid_payables,'balanceNio',v_initial_payables-v_paid_payables,
   'documentId',null,'shipmentId',null));
 end if;
 return jsonb_build_object('available',true,'at',p_at,'startOn',v_start,'rows',v_rows,
  'unallocatedNio',jsonb_build_object('receivables',greatest(0,v_initial_receivables-v_paid_receivables),
   'payables',greatest(0,v_initial_payables-v_paid_payables)),'legacyPayments',v_legacy);
end $$;
alter table public.inventory_movements add column is_invoice_reversal boolean not null default false;
create table private.inventory_count_gains (
 movement_id uuid primary key references public.inventory_movements(id) on delete cascade,
 product_id uuid not null references public.products(id), quantity integer not null check(quantity>0),
 unit_cost_nio numeric(24,6), created_at timestamptz not null);
create index inventory_count_gains_product on private.inventory_count_gains(product_id);
alter table private.inventory_count_gains enable row level security;
revoke all on private.inventory_count_gains from public,anon,authenticated;
create or replace function private.account_inventory_movement() returns trigger language plpgsql security definer set search_path='' as $$
declare v_average numeric; v_name text;
begin
 if auth.uid() is null or private.staff_role() is null then raise insufficient_privilege; end if;
 select average_cost_nio into v_average from public.product_costs where product_id=new.product_id;
 if new.type in ('EXIT','DAMAGED','ADJUSTMENT') and new.before_quantity>new.after_quantity then
  insert into public.inventory_movement_costs(movement_id,product_id,type,quantity,unit_cost_nio,created_at)
  values(new.id,new.product_id,new.type,new.before_quantity-new.after_quantity,v_average,new.created_at);
 end if;
 if new.type='ADJUSTMENT' and new.before_quantity is not null and new.after_quantity>new.before_quantity and not new.is_invoice_reversal then
  insert into private.inventory_count_gains values(new.id,new.product_id,new.after_quantity-new.before_quantity,v_average,new.created_at);
 end if;
 if new.type='ENTRY' and new.after_quantity>coalesce(new.before_quantity,0) and v_average is not null
    and not exists(
     select 1 from public.purchase_shipment_lines l join public.purchase_shipments s on s.id=l.shipment_id
     where l.product_id=new.product_id and s.created_by=auth.uid() and s.created_at=now()) then
  select b.name||' '||p.name into v_name from public.products p join public.brands b on b.id=p.brand_id where p.id=new.product_id;
  raise exception '«%» ya tiene costo promedio. Registra esta mercadería como compra con su costo (Precios → Costo de inventario → Registrar compra) para que el promedio y los precios se actualicen.',
   coalesce(v_name,'Este perfume');
 end if;
 return new;
end $$;
create or replace function public.delete_invoice(p_id uuid,p_reason text default '') returns text
language plpgsql security definer set search_path='' as $$
declare
 v_uid uuid:=auth.uid(); v_doc public.documents%rowtype; v_item record;
 v_before integer; v_total integer; v_average numeric; v_reason text:=trim(coalesce(p_reason,''));
begin
 if v_uid is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_id is null then raise exception 'Falta el identificador de la factura.'; end if;
 if length(v_reason)>500 then raise exception 'El motivo es demasiado largo.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('document:'||p_id::text,0));
 select * into v_doc from public.documents where id=p_id for update;
 if v_doc.id is null then raise exception 'La factura ya no existe. Actualiza la lista.'; end if;
 if v_doc.kind<>'invoice' then raise exception 'Sólo se pueden eliminar facturas.'; end if;
 if v_doc.payment_method='card_pos' and private.pos_receivable((now() at time zone 'America/Managua')::date)<private.credit_invoice_amount(v_doc.id) then
  raise exception 'La venta tiene tarjetas ya liquidadas. Anula la liquidación correspondiente antes de eliminar esta factura.';
 end if;
 perform private.limit_catalog_writes();
 perform private.set_cost_cause(jsonb_build_object('kind','invoice_deleted','reference',v_doc.number));

 insert into private.document_deletions(document_id,number,kind,snapshot,reason,actor_id)
 values(v_doc.id,v_doc.number,v_doc.kind,
  to_jsonb(v_doc)||jsonb_build_object('items',
   (select coalesce(jsonb_agg(to_jsonb(i) order by i.description),'[]') from public.document_items i where i.document_id=v_doc.id),
   'costs',
   (select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.document_item_costs c where c.document_id=v_doc.id)),
  v_reason,v_uid);

 -- Mismo orden de bloqueo que create_document: producto y luego existencias.
 for v_item in
  select i.product_id,i.quantity,c.unit_cost_nio
  from public.document_items i left join public.document_item_costs c on c.document_item_id=i.id
  where i.document_id=v_doc.id order by i.product_id
 loop
  perform 1 from public.products where id=v_item.product_id for update;
  perform 1 from public.inventory_balances where product_id=v_item.product_id order by location for update;
  select quantity into v_before from public.inventory_balances
   where product_id=v_item.product_id and location=v_doc.location;
  if not found or v_before is null then
   raise exception 'No se puede devolver % al inventario: falta el conteo de %.',
    (select name from public.products where id=v_item.product_id),
    case v_doc.location when 'store' then 'Tienda' else 'Bodega' end;
  end if;
  select coalesce(sum(quantity),0) into v_total from public.inventory_balances where product_id=v_item.product_id;
  select average_cost_nio into v_average from public.product_costs where product_id=v_item.product_id for update;
  if v_item.unit_cost_nio is not null and (v_average is not null or v_total=0) then
   insert into public.product_costs(product_id,average_cost_nio)
   values(v_item.product_id,case when v_total=0 then v_item.unit_cost_nio
     else round((v_average*v_total+v_item.unit_cost_nio*v_item.quantity)/(v_total+v_item.quantity),6) end)
   on conflict(product_id) do update set average_cost_nio=excluded.average_cost_nio,updated_at=now();
  end if;
  update public.inventory_balances set quantity=v_before+v_item.quantity,updated_at=now()
   where product_id=v_item.product_id and location=v_doc.location;
  insert into public.inventory_movements(product_id,location,type,quantity,before_quantity,after_quantity,actor_id,reference,note,is_invoice_reversal)
  values(v_item.product_id,v_doc.location,'ADJUSTMENT',v_item.quantity,v_before,v_before+v_item.quantity,v_uid,v_doc.number,
   left('Factura '||v_doc.number||' eliminada'||case when v_reason<>'' then ': '||v_reason else '' end,2000),true);
 end loop;

 update public.inventory_movements set document_id=null where document_id=v_doc.id;
 delete from public.document_item_costs where document_id=v_doc.id;
 delete from public.document_items where document_id=v_doc.id;
 delete from public.documents where id=v_doc.id;
 return v_doc.number;
end $$;
create or replace view private.operational_postings as
 with pairs as (
 select (d.created_at at time zone 'America/Managua')::date as day,'sale' source,d.id source_id,
 private.sale_ledger_account(d.payment_method,d.currency) debit_account,'4110'::text credit_account,c.net_revenue_nio amount
 from public.document_item_costs c join public.documents d on d.id=c.document_id
 union all
 select (d.created_at at time zone 'America/Managua')::date,'tax',d.id,private.sale_ledger_account(d.payment_method,d.currency),'2116',c.tax_nio
 from public.document_item_costs c join public.documents d on d.id=c.document_id where c.tax_nio>0
 union all
 select (d.created_at at time zone 'America/Managua')::date,'cost',d.id,'5120','1130',round(c.quantity*c.unit_cost_nio,2)
 from public.document_item_costs c join public.documents d on d.id=c.document_id
 union all
 select s.incurred_on,'purchase',s.id,'1130',case when s.account='credito' then '2111' else private.money_ledger_account(s.account,s.currency) end,round(s.goods_amount*s.exchange_rate,2)+round(s.shipping_amount*s.exchange_rate,2) from public.purchase_shipments s
 union all
 select e.incurred_on,'expense',e.id,
 case e.category when 'impuestos_dgi' then '6000' when 'impuestos_alma' then '5130-004' when 'prestamo_bancario' then '2113' when 'prestamo_acreedor' then '2112'
 when 'interes_bancario' then '5140-002' when 'interes_acreedor' then '5140-002' when 'renta' then '5130-002' when 'salario' then '5130-001'
 when 'papeleria' then '5130-006' when 'combustible' then '5130-007' when 'agua_luz' then '5130-003' when 'internet' then '5130-009'
 when 'limpieza' then '5130-009' when 'mobiliario' then '1210' when 'viatico' then '5130-007' when 'marketing' then '5130-008' else '5130-010' end,
 private.money_ledger_account(e.account,e.currency),round(e.amount*e.exchange_rate,2) from public.expense_records e where e.voided_at is null
 union all
 select f.occurred_on,'finance',f.id,
 case when f.kind in ('capital','loan','collection') then coalesce(f.bank_ledger_account,private.money_ledger_account(f.account,f.currency)) when f.kind='transfer' then private.money_ledger_account(f.to_account,f.currency) when f.kind='withdrawal' then '3110-001' else '2111' end,
 case when f.kind='capital' then '3110-001' when f.kind='loan' then '2113' when f.kind='collection' then '1140' else coalesce(f.bank_ledger_account,private.money_ledger_account(f.account,f.currency)) end,round(f.amount*f.exchange_rate,2)
 from public.finance_entries f where f.voided_at is null and f.kind<>'opening'
 union all
 select (m.created_at at time zone 'America/Managua')::date,'writeoff',m.movement_id,'5150','1130',round(m.quantity*m.unit_cost_nio,2) from public.inventory_movement_costs m
 union all
 select (m.created_at at time zone 'America/Managua')::date,'count_gain',m.movement_id,'1130','4190',round(m.quantity*m.unit_cost_nio,2) from private.inventory_count_gains m
 )
 select day,source,source_id,debit_account account,amount debit,0::numeric credit from pairs
 union all select day,source,source_id,credit_account,0::numeric,amount from pairs;

create or replace function private.ledger_report(p_from date,p_to date) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_start date; v_result jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then raise exception 'Período inválido.'; end if;
 select occurred_on into v_start from public.journal_entries where kind='opening' and voided_at is null;
 with postings as (
  select day,account,debit,credit from private.operational_postings where day>=v_start and day<=p_to
  union all
  select e.occurred_on,l.account,l.debit_nio,l.credit_nio from public.journal_entries e join public.journal_lines l on l.entry_id=e.id where e.voided_at is null and e.occurred_on<=p_to
 ), balances as (
  select a.*,coalesce(sum(p.debit-p.credit) filter(where p.day<p_from),0) opening,
  coalesce(sum(p.debit) filter(where p.day>=p_from),0) debit,coalesce(sum(p.credit) filter(where p.day>=p_from),0) credit,
  coalesce(sum(p.debit-p.credit),0) closing
  from public.ledger_accounts a left join postings p on p.account=a.code group by a.code
 )
 select jsonb_build_object('startOn',v_start,'from',p_from,'to',p_to,
 'missingCosts',(select count(*)/2 from private.operational_postings where day>=v_start and day<=p_to and (debit is null or credit is null)),
 'missingSales',(select count(*) from public.documents d where d.kind='invoice' and (d.created_at at time zone 'America/Managua')::date between v_start and p_to and private.credit_invoice_amount(d.id) is null),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('code',code,'name',name,'parent',parent,'bucket',bucket,'nature',nature,'postable',postable,'opening',opening,'debit',debit,'credit',credit,'closing',closing) order by code) from balances),'[]'::jsonb),
 'entries',coalesce((select jsonb_agg(to_jsonb(e) order by occurred_on desc,number desc) from (select id,number,occurred_on,kind,description,reference,currency,exchange_rate,voided_at,void_reason from public.journal_entries where occurred_on between p_from and p_to order by occurred_on desc,number desc limit 501)e),'[]'::jsonb)) into v_result;
 return v_result;
end $$;
create or replace function private.business_day_operational_report(p_day date) returns jsonb
language sql stable security definer set search_path='' as $$
 with start as (select opened_at from public.business_days where day=p_day), sales as (
  select d.*, coalesce((select sum(i.quantity) from public.document_items i where i.document_id=d.id),0) units
  from public.documents d where d.kind='invoice' and (d.created_at at time zone 'America/Managua')::date=p_day
 ), payments as (
  select payment_method,currency,count(*) invoices,sum(total) amount,sum(units) units
  from sales group by payment_method,currency
 ), cash as (
  select currency,total amount from sales where payment_method='cash' and created_at>=(select opened_at from start)
  union all
  select currency,case when kind in ('capital','loan','collection') then amount else -amount end
  from public.finance_entries where occurred_on=p_day and created_at>=(select opened_at from start) and voided_at is null and account='caja' and kind<>'opening'
  union all
  select currency,amount from public.finance_entries where occurred_on=p_day and created_at>=(select opened_at from start) and voided_at is null and kind='transfer' and to_account='caja'
  union all
  select currency,-amount from public.expense_records where incurred_on=p_day and created_at>=(select opened_at from start) and voided_at is null and account='caja'
  union all
  select currency,-(goods_amount+shipping_amount) from public.purchase_shipments where incurred_on=p_day and created_at>=(select opened_at from start) and account='caja'
 )
 select jsonb_build_object(
  'invoices',(select count(*) from sales), 'units',(select coalesce(sum(units),0) from sales),
  'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.description) from (select i.product_id,i.description,sum(i.quantity) units from public.document_items i join sales s on s.id=i.document_id group by i.product_id,i.description)p),'[]'::jsonb),
  'payments',coalesce((select jsonb_agg(jsonb_build_object('method',payment_method,'currency',currency,'invoices',invoices,'amount',amount,'units',units) order by payment_method,currency) from payments),'[]'::jsonb),
  'cashMovementNio',coalesce((select sum(amount) from cash where currency='NIO'),0),
  'cashMovementUsd',coalesce((select sum(amount) from cash where currency='USD'),0),
  'expectedNio',b.opening_nio+coalesce((select sum(amount) from cash where currency='NIO'),0),
  'expectedUsd',b.opening_usd+coalesce((select sum(amount) from cash where currency='USD'),0)
 ) from public.business_days b where b.day=p_day;
$$;
create or replace function private.business_day_report(p_day date) returns jsonb language sql stable security definer set search_path='' as $$
 with base as (select private.business_day_operational_report(p_day) r),
 cash as (select
 coalesce(sum(l.debit-l.credit) filter(where l.account='1110-001'),0) nio,
 coalesce(sum(l.debit-l.credit) filter(where l.account='1110-002'),0) usd
 from public.journal_entries e join public.journal_lines l on l.entry_id=e.id
 where e.occurred_on=p_day and e.voided_at is null and e.kind<>'opening' and e.created_at>=(select opened_at from public.business_days where day=p_day))
 select r||jsonb_build_object('cashMovementNio',(r->>'cashMovementNio')::numeric+nio,'cashMovementUsd',(r->>'cashMovementUsd')::numeric+usd,
 'expectedNio',(r->>'expectedNio')::numeric+nio,'expectedUsd',(r->>'expectedUsd')::numeric+usd) from base,cash;
$$;
-- Take the day lock before product, customer, request or credit locks. Taking it
-- only from row triggers can deadlock a sale against a purchase or cancellation.
-- These wrappers retain the existing permission checks in the private functions.
create or replace function public.create_document(p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 return private.create_document(p_payload);
end $$;
create or replace function public.record_inventory_movement(p_payload jsonb) returns uuid
language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 return private.record_inventory_movement(p_payload);
end $$;
create or replace function public.record_shipment(p_input jsonb) returns uuid
language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 return private.record_shipment(p_input);
end $$;
create or replace function public.record_expense(p_input jsonb) returns uuid
language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 return private.record_expense(p_input);
end $$;
create or replace function public.void_expense(p_id uuid,p_reason text) returns uuid
language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 return private.void_expense(p_id,p_reason);
end $$;
create or replace function public.void_finance_entry(p_id uuid,p_reason text) returns uuid
language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 return private.void_finance_entry(p_id,p_reason);
end $$;

-- POS settlement cannot create bank money without an outstanding card balance.
create function private.pos_receivable(p_day date) returns numeric
language sql stable security definer set search_path='' as $$
 select (a->>'closing')::numeric from
 (select private.ledger_report(p_day,p_day) r) report,
 jsonb_array_elements(r->'accounts') a
 where r->>'startOn' is not null and a->>'code'='1142';
$$;
revoke all on function private.pos_receivable(date) from public,anon,authenticated;
create or replace function private.record_journal_entry(p_input jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_date date:=(p_input->>'occurredOn')::date; v_request uuid:=(p_input->>'requestId')::uuid;
 v_rate numeric; v_line jsonb; v_index integer:=0; v_debit numeric; v_credit numeric; v_total numeric; v_old public.journal_entries%rowtype;
 v_gross numeric; v_fee numeric; v_withholding numeric; v_lines jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_request is null or v_date is null or v_date>(now() at time zone 'America/Managua')::date then raise exception 'Fecha o solicitud inválida.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 select * into v_old from public.journal_entries where request_id=v_request;
 if found then
  if v_old.created_by<>auth.uid() or v_old.request_payload<>p_input then raise exception 'La solicitud de comprobante cambió.'; end if;
  return v_old.id;
 end if;
 if jsonb_typeof(p_input->'lines') is distinct from 'array' or jsonb_array_length(p_input->'lines') not between 2 and 100 then raise exception 'El comprobante necesita entre 2 y 100 renglones.'; end if;
 v_rate:=private.accounting_rate(p_input);
 if p_input->>'kind'='card_settlement' then
  v_gross:=private.accounting_number(p_input,'gross',100000000,2);
  v_fee:=round(v_gross*private.accounting_number(p_input,'commissionRate',100,4)/100,2);
  if p_input->>'withholdingBase' not in ('gross','net_commission') or p_input->>'withholdingBase' is null then raise exception 'Selecciona la base de retención.'; end if;
  v_withholding:=round((case when p_input->>'withholdingBase'='gross' then v_gross else v_gross-v_fee end)*private.accounting_number(p_input,'withholdingRate',100,4)/100,2);
  if v_gross<=0 or v_fee+v_withholding>v_gross then raise exception 'Importe o deducciones inválidos.'; end if;
  if not exists(select 1 from public.ledger_accounts where code=p_input->>'bankAccount' and code like '1120-%' and postable and active) then raise exception 'Selecciona el banco que acredita.'; end if;
  select jsonb_agg(jsonb_build_object('account',account,'debit',debit,'credit',credit) order by n) into v_lines from (values
   (1,p_input->>'bankAccount',v_gross-v_fee-v_withholding,0::numeric),(2,'5140-001',v_fee,0::numeric),(3,'1340',v_withholding,0::numeric),(4,'1142',0::numeric,v_gross))l(n,account,debit,credit) where debit>0 or credit>0;
  if v_lines<>p_input->'lines' then raise exception 'Los renglones no coinciden con la liquidación calculada.'; end if;
  if round(v_gross*v_rate,2)>coalesce(private.pos_receivable(v_date),0) then
   raise exception 'El importe supera las tarjetas pendientes de acreditar. Revisa las ventas POS y las liquidaciones ya registradas.';
  end if;
 end if;
 if p_input->>'kind'='opening' and exists(select 1 from public.journal_entries where voided_at is null) then raise exception 'La apertura debe ser el primer comprobante.'; end if;
 if p_input->>'kind'<>'opening' and not exists(select 1 from public.journal_entries where kind='opening' and occurred_on<=v_date and voided_at is null) then raise exception 'Registra primero el comprobante de saldos iniciales.'; end if;
 insert into public.journal_entries(occurred_on,kind,description,reference,currency,exchange_rate,request_id,request_payload,created_by)
 values(v_date,p_input->>'kind',btrim(p_input->>'description'),coalesce(p_input->>'reference',''),p_input->>'currency',v_rate,v_request,p_input,auth.uid()) returning id into v_id;
 for v_line in select value from jsonb_array_elements(p_input->'lines') loop
  v_index:=v_index+1;
  if not exists(select 1 from public.ledger_accounts where code=v_line->>'account' and postable and active) then raise exception 'Cuenta no disponible para movimientos.'; end if;
  if p_input->>'kind'='opening' and not exists(select 1 from public.ledger_accounts where code=v_line->>'account' and bucket in ('asset','liability','equity')) then raise exception 'Los saldos iniciales corresponden a activo, pasivo y capital.'; end if;
  v_debit:=private.accounting_number(v_line,'debit',100000000,2); v_credit:=private.accounting_number(v_line,'credit',100000000,2);
  insert into public.journal_lines values(v_id,v_index,v_line->>'account',v_debit,v_credit,round(v_debit*v_rate,2),round(v_credit*v_rate,2));
 end loop;
 select sum(debit_nio-credit_nio) into v_total from public.journal_lines where entry_id=v_id;
 if v_total<>0 or (select sum(debit-credit) from public.journal_lines where entry_id=v_id)<>0 then raise exception 'El debe y el haber deben ser iguales, también al convertir a córdobas.'; end if;
 return v_id;
end $$;

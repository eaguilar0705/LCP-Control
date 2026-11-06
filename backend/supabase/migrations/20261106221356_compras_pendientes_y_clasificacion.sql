-- Las recepciones nuevas pueden esperar la clasificación del contador.
-- Ninguna compra histórica cambia de forma de pago al instalar la migración.
insert into public.ledger_accounts(code,name,parent,bucket,nature,postable)
 values('2190','Compras por clasificar','2100','liability','credit',true);
alter table public.purchase_shipments drop constraint purchase_shipments_account_check;
alter table public.purchase_shipments add constraint purchase_shipments_account_check check(account in ('caja','banco','credito','pending'));
create table private.purchase_classifications (
 shipment_id uuid primary key references public.purchase_shipments(id),entry_id uuid not null unique references public.journal_entries(id),
 created_by uuid not null references private.business_actors(id),created_at timestamptz not null default now());
create table private.purchase_classification_requests (
 request_id uuid primary key, actor_id uuid not null references private.business_actors(id),transaction_id bigint not null,
 payload jsonb not null,result jsonb,created_at timestamptz not null default now());
create table private.purchase_payment_links (
 finance_entry_id uuid primary key references public.finance_entries(id),shipment_id uuid not null references public.purchase_shipments(id),
 original_shipment_id uuid,original_opening_settlement boolean not null, request_id uuid not null references private.purchase_classification_requests(request_id));
create index purchase_payment_links_shipment_idx on private.purchase_payment_links(shipment_id);
alter table private.purchase_classifications enable row level security;
alter table private.purchase_classification_requests enable row level security;
alter table private.purchase_payment_links enable row level security;
revoke all on private.purchase_classifications,private.purchase_classification_requests,private.purchase_payment_links from public,anon,authenticated;

alter function private.record_shipment(jsonb) rename to record_shipment_before_classification;
create function private.record_shipment(p_input jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare old public.purchase_shipments%rowtype; v_id uuid; mapped jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_input->>'account' is distinct from 'pending' then return private.record_shipment_before_classification(p_input); end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('shipment:'||auth.uid()::text||coalesce(p_input->>'requestId',''),0));
 select * into old from public.purchase_shipments where created_by=auth.uid() and request_id=(p_input->>'requestId')::uuid;
 if found then
  if old.request_payload<>p_input then raise exception 'La solicitud de recepción cambió. Verifica el guardado original.'; end if;
  return old.id;
 end if;
 if nullif(p_input->>'bankLedgerAccount','') is not null then raise exception 'Elige el banco al clasificar la recepción en Contabilidad.'; end if;
 mapped:=p_input||jsonb_build_object('account','credito');
 v_id:=private.record_shipment_before_classification(mapped);
 update public.purchase_shipments set account='pending',request_payload=p_input where id=v_id;
 return v_id;
end $$;
revoke all on function private.record_shipment_before_classification(jsonb) from public,anon,authenticated;
revoke all on function private.record_shipment(jsonb) from public,anon;
grant execute on function private.record_shipment(jsonb) to authenticated;

-- La cuenta temporal sustituye únicamente la contrapartida de estas recepciones.
alter view private.operational_postings rename to operational_postings_before_classification;
create view private.operational_postings as
 select o.day,o.source,o.source_id,
 case when s.account='pending' and ((o.source='purchase' and o.credit>0) or (o.source='purchase_correction' and o.debit>0)) then '2190' else o.account end account,
 o.debit,o.credit from private.operational_postings_before_classification o
 left join public.purchase_corrections c on o.source='purchase_correction' and c.id=o.source_id
 left join public.purchase_shipments s on s.id=case when o.source='purchase' then o.source_id else c.shipment_id end;
revoke all on private.operational_postings,private.operational_postings_before_classification from public,anon,authenticated;

-- Las deudas identificadas de una recepción no forman parte del saldo inicial
-- sin asignar. Sus abonos se controlan con el mismo pedido.
do $$ declare d text; f text; begin
 foreach f in array array['private.credit_opening(date)','private.check_credit_pool()'] loop
  d:=replace(pg_get_functiondef(f::regprocedure),E'\r\n',E'\n');
  d:=replace(d,'e.voided_at is null','e.voided_at is null and not exists(select 1 from private.purchase_classifications pc where pc.entry_id=e.id)');
  execute d;
 end loop;
end $$;
alter function private.credit_accounts(date) rename to credit_accounts_before_classification;
create function private.credit_accounts(p_at date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r jsonb; extra jsonb;
begin
 r:=private.credit_accounts_before_classification(p_at);
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'kind','payable','shipmentId',s.id,'documentId',null,
 'occurredOn',e.occurred_on,'counterparty',s.supplier,'reference',s.reference,
 'originalNio',v.amount,'paidNio',p.paid,'balanceNio',v.amount-p.paid) order by e.occurred_on,s.id),'[]') into extra
 from private.purchase_classifications pc join public.purchase_shipments s on s.id=pc.shipment_id
 join public.journal_entries e on e.id=pc.entry_id
 cross join lateral(select coalesce(sum(l.credit_nio-l.debit_nio),0) amount from public.journal_lines l where l.entry_id=e.id and l.account='2111')v
 cross join lateral(select coalesce(sum(round(f.amount*f.exchange_rate,2)),0) paid from public.finance_entries f where f.shipment_id=s.id and f.voided_at is null and f.occurred_on<=p_at)p
 where e.voided_at is null and e.occurred_on<=p_at and v.amount>0;
 return jsonb_set(r,'{rows}',coalesce(r->'rows','[]')||extra);
end $$;

-- Registrar abonos de una recepción clasificada sigue limitado por su crédito real.
do $$ declare d text; begin
 d:=pg_get_functiondef('private.record_finance_entry(jsonb)'::regprocedure);
 d:=replace(d,$needle$v_purchase.account<>'credito'$needle$,$replacement$v_purchase.account not in ('credito','pending')$replacement$);
 d:=replace(d,'v_original:=round(v_purchase.goods_amount*v_purchase.exchange_rate,2)+round(v_purchase.shipping_amount*v_purchase.exchange_rate,2);',
 'v_original:=case when v_purchase.account=''pending'' then (select coalesce(sum(l.credit_nio-l.debit_nio),0) from private.purchase_classifications pc join public.journal_entries e on e.id=pc.entry_id join public.journal_lines l on l.entry_id=e.id where pc.shipment_id=v_shipment and e.voided_at is null and l.account=''2111'') else round(v_purchase.goods_amount*v_purchase.exchange_rate,2)+round(v_purchase.shipping_amount*v_purchase.exchange_rate,2) end;');
 execute d;
end $$;

create function private.validate_purchase_classification(p_shipment uuid,p_entry uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare total numeric; clearing numeric; payable numeric; paid numeric;
begin
 select round(goods_amount*exchange_rate,2)+round(shipping_amount*exchange_rate,2) into total from public.purchase_shipments where id=p_shipment;
 select coalesce(sum(debit_nio-credit_nio) filter(where account='2190'),0),coalesce(sum(credit_nio-debit_nio) filter(where account='2111'),0)
 into clearing,payable from public.journal_lines where entry_id=p_entry;
 if clearing<>total then raise exception 'La clasificación debe cancelar C$ % de Compras por clasificar.',total; end if;
 if exists(select 1 from public.journal_lines where entry_id=p_entry and account='1130') then raise exception 'El inventario ya fue recibido. Clasifica el pago sin volver a cargar Inventario.'; end if;
 select coalesce(sum(round(amount*exchange_rate,2)),0) into paid from public.finance_entries where shipment_id=p_shipment and voided_at is null;
 if payable<paid then raise exception 'La cuenta Proveedores debe cubrir los C$ % de abonos ya registrados. Revisa su vinculación.',paid; end if;
 if exists(select 1 from public.finance_entries f join public.journal_entries e on e.id=p_entry where f.shipment_id=p_shipment and f.voided_at is null and f.occurred_on<e.occurred_on) then
  raise exception 'La clasificación no puede quedar después de un abono vinculado. Revisa la fecha.'; end if;
end $$;

create function private.classify_purchase(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.purchase_shipments%rowtype; pc private.purchase_classifications%rowtype; old private.purchase_classification_requests%rowtype;
 v_entry uuid; v_result jsonb; f_id uuid; f public.finance_entries%rowtype; d date:=(p_input->>'occurredOn')::date;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('finance-credit-ledger',0));
 perform pg_advisory_xact_lock(hashtextextended('purchase-classification:'||coalesce(p_input->>'requestId',''),0));
 select * into old from private.purchase_classification_requests where request_id=(p_input->>'requestId')::uuid;
 if found then
  if old.actor_id<>auth.uid() or old.payload<>p_input then raise exception 'La solicitud de clasificación cambió.'; end if;
  return old.result;
 end if;
 select * into s from public.purchase_shipments where id=(p_input->>'shipmentId')::uuid for update;
 if not found or s.account<>'pending' or exists(select 1 from public.purchase_corrections where shipment_id=s.id) then raise exception 'Selecciona una recepción pendiente o clasificada vigente.'; end if;
 if d<s.incurred_on or d is null then raise exception 'La clasificación no puede ser anterior a la recepción.'; end if;
 select * into pc from private.purchase_classifications where shipment_id=s.id;
 if found then
  if not private.is_superadmin() then raise insufficient_privilege; end if;
  if pc.entry_id is distinct from nullif(p_input->>'entryId','')::uuid then raise exception 'La recepción ya fue clasificada. Abre su comprobante actual.'; end if;
 end if;
 insert into private.purchase_classification_requests(request_id,actor_id,transaction_id,payload)
 values((p_input->>'requestId')::uuid,auth.uid(),txid_current(),p_input);
 if pc.entry_id is null then
  v_entry:=private.record_journal_entry(p_input||jsonb_build_object('kind','adjustment','currency','NIO','exchangeRate',1));
  insert into private.purchase_classifications(shipment_id,entry_id,created_by) values(s.id,v_entry,auth.uid());
 else
  perform private.correct_journal_entry(p_input||jsonb_build_object('entryId',pc.entry_id));
  v_entry:=pc.entry_id;
 end if;
 if jsonb_typeof(coalesce(p_input->'linkedPayments','[]')) is distinct from 'array' then raise exception 'Revisa los pagos vinculados.'; end if;
 for f_id in select finance_entry_id from private.purchase_payment_links where shipment_id=s.id loop
  if not coalesce(p_input->'linkedPayments','[]') ? f_id::text then
   update public.finance_entries fe set shipment_id=l.original_shipment_id,opening_settlement=l.original_opening_settlement
   from private.purchase_payment_links l where fe.id=f_id and l.finance_entry_id=fe.id;
   delete from private.purchase_payment_links where finance_entry_id=f_id;
  end if;
 end loop;
 for f_id in select value::uuid from jsonb_array_elements_text(coalesce(p_input->'linkedPayments','[]')) loop
  select * into f from public.finance_entries where id=f_id for update;
  if not found or f.kind<>'supplier_payment' or f.voided_at is not null or (f.shipment_id is not null and f.shipment_id<>s.id)
   or f.occurred_on<d then raise exception 'El pago no está disponible o es anterior a la clasificación. Revisa su fecha.'; end if;
  if f.shipment_id is null then
   insert into private.purchase_payment_links values(f.id,s.id,f.shipment_id,f.opening_settlement,(p_input->>'requestId')::uuid);
   update public.finance_entries set shipment_id=s.id,opening_settlement=false where id=f.id;
  end if;
 end loop;
 perform private.validate_purchase_classification(s.id,v_entry);
 perform private.check_credit_pool();
 v_result:=private.get_journal_entry(v_entry);
 update private.purchase_classification_requests set result=v_result where request_id=(p_input->>'requestId')::uuid;
 return v_result;
end $$;
create function public.classify_purchase(p_input jsonb) returns jsonb
language sql security invoker set search_path='' as $$select private.classify_purchase(p_input)$$;

-- El SuperAdmin puede editar el comprobante vinculado desde cualquiera de las
-- dos pantallas, conservando el mismo control de importe y pagos.
do $$ declare d text; begin
 d:=replace(pg_get_functiondef('private.correct_journal_entry(jsonb)'::regprocedure),E'\r\n',E'\n');
 d:=replace(d,'a:=private.journal_snapshot(e.id);',
 'perform private.validate_purchase_classification(pc.shipment_id,e.id) from private.purchase_classifications pc where pc.entry_id=e.id; a:=private.journal_snapshot(e.id);');
 execute d;
 d:=replace(pg_get_functiondef('private.guard_business_day()'::regprocedure),E'\r\n',E'\n');
 d:=replace(d,E'begin\n',E'begin\n if tg_table_name=''finance_entries'' and tg_op=''UPDATE'' and private.staff_role()=''admin'' and exists(select 1 from private.purchase_classification_requests c where c.actor_id=auth.uid() and c.transaction_id=txid_current()) and (to_jsonb(new)-''shipment_id''-''opening_settlement'')=(to_jsonb(old)-''shipment_id''-''opening_settlement'') then return new; end if;\n');
 execute d;
end $$;

create function private.purchase_accounting_rows(p_status text default 'all',p_before timestamptz default null,p_before_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 return (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc,r.id desc),'[]') from (
 select s.id,s.incurred_on,s.supplier,s.reference,s.currency,s.exchange_rate,s.goods_amount,s.shipping_amount,s.units,s.created_at,
 pc.entry_id,(pc.entry_id is not null and e.voided_at is null) classified,e.revision,
 coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'occurredOn',f.occurred_on,'amount',f.amount,'currency',f.currency,'reference',f.reference) order by f.occurred_on,f.id)
 from public.finance_entries f where f.kind='supplier_payment' and f.voided_at is null and (f.shipment_id is null or f.shipment_id=s.id)),'[]') payments,
 coalesce((select jsonb_agg(finance_entry_id) from private.purchase_payment_links where shipment_id=s.id),'[]') linked_payments
 from public.purchase_shipments s left join private.purchase_classifications pc on pc.shipment_id=s.id left join public.journal_entries e on e.id=pc.entry_id
 where s.account='pending' and not exists(select 1 from public.purchase_corrections where shipment_id=s.id)
 and (p_status='all' or (p_status='pending' and (pc.entry_id is null or e.voided_at is not null)))
 and (p_before is null or (s.created_at,s.id)<(p_before,p_before_id)) order by s.created_at desc,s.id desc limit 50)r);
end $$;
create function public.purchase_accounting_rows(p_status text default 'all',p_before timestamptz default null,p_before_id uuid default null) returns jsonb
language sql security invoker set search_path='' as $$select private.purchase_accounting_rows(p_status,p_before,p_before_id)$$;

revoke all on function private.classify_purchase(jsonb),public.classify_purchase(jsonb),private.credit_accounts(date),
private.purchase_accounting_rows(text,timestamptz,uuid),public.purchase_accounting_rows(text,timestamptz,uuid) from public,anon;
grant execute on function private.classify_purchase(jsonb),public.classify_purchase(jsonb),private.credit_accounts(date),
private.purchase_accounting_rows(text,timestamptz,uuid),public.purchase_accounting_rows(text,timestamptz,uuid) to authenticated;
revoke all on function private.credit_accounts_before_classification(date),private.validate_purchase_classification(uuid,uuid) from public,anon,authenticated;

do $$ declare d text; begin
 d:=pg_get_functiondef('private.record_finance_entry(jsonb)'::regprocedure);
 d:=replace(d,'v_source_date:=v_purchase.incurred_on;',
 'v_source_date:=greatest(v_purchase.incurred_on,case when v_purchase.account=''pending'' then (select e.occurred_on from private.purchase_classifications pc join public.journal_entries e on e.id=pc.entry_id where pc.shipment_id=v_shipment and e.voided_at is null) else v_purchase.incurred_on end);');
 execute d;
end $$;

-- Recuperación tras cortes de red: las solicitudes nuevas comparten el mismo
-- control de retiro que facturas, compras y comprobantes anteriores.
alter function private.operation_confirmation(text,uuid,boolean) rename to operation_confirmation_before_classification;
create function private.operation_confirmation(p_kind text,p_request_id uuid,p_retire boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;
begin
 if p_kind not in ('journal-correction','purchase-classification') then return private.operation_confirmation_before_classification(p_kind,p_request_id,p_retire); end if;
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 if p_kind='journal-correction' then select after_snapshot into r from private.journal_corrections where actor_id=auth.uid() and request_id=p_request_id;
 else select result into r from private.purchase_classification_requests where actor_id=auth.uid() and request_id=p_request_id; end if;
 if r is not null then return jsonb_build_object('status','confirmed','id',r->'id','number',r->'number'); end if;
 if p_retire then insert into private.retired_operations(actor_id,kind,request_id) values(auth.uid(),p_kind,p_request_id) on conflict do nothing; end if;
 if exists(select 1 from private.retired_operations where actor_id=auth.uid() and kind=p_kind and request_id=p_request_id) then return jsonb_build_object('status','retired'); end if;
 return jsonb_build_object('status','missing');
end $$;
create trigger retired_operation before insert on private.journal_corrections for each row execute function private.prevent_retired_operation('journal-correction','actor_id','request_id');
create trigger retired_operation before insert on private.purchase_classification_requests for each row execute function private.prevent_retired_operation('purchase-classification','actor_id','request_id');
revoke all on function private.operation_confirmation(text,uuid,boolean),private.operation_confirmation_before_classification(text,uuid,boolean) from public,anon,authenticated;
notify pgrst,'reload schema';

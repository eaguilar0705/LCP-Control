-- Una corrección posterior no vuelve a comprar ni modifica los costos que ya
-- quedaron congelados en facturas. El contador distribuye expresamente el
-- cambio entre inventario actual y costo reconocido, mediante un ajuste ligado.
create table private.receipt_revisions (
 id uuid primary key default gen_random_uuid(), shipment_id uuid not null references public.purchase_shipments(id),revision integer not null,
 request_id uuid not null unique,request_payload jsonb not null,actor_id uuid not null references private.business_actors(id),actor_name text not null,
 before_snapshot jsonb not null,after_snapshot jsonb not null,impacts jsonb not null,
 journal_entry_id uuid references public.journal_entries(id),transaction_id bigint not null,created_at timestamptz not null default now(),unique(shipment_id,revision));
create index receipt_revision_journal_idx on private.receipt_revisions(journal_entry_id);
create table private.receipt_inventory_changes (
 movement_id uuid primary key,revision_id uuid not null references private.receipt_revisions(id));
create index receipt_inventory_changes_revision_idx on private.receipt_inventory_changes(revision_id);
alter table private.receipt_revisions enable row level security;
alter table private.receipt_inventory_changes enable row level security;
revoke all on private.receipt_revisions,private.receipt_inventory_changes from public,anon,authenticated;

create function private.receipt_snapshot(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce((select after_snapshot from private.receipt_revisions where shipment_id=s.id order by revision desc limit 1),
 to_jsonb(s)-'request_payload'||jsonb_build_object('revision',0,'lines',(select jsonb_agg(to_jsonb(l) order by product_id) from public.purchase_shipment_lines l where shipment_id=s.id)))
 from public.purchase_shipments s where id=p_id;
$$;
create function private.receipt_edit_context(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.is_superadmin() then raise insufficient_privilege; end if;
 if private.receipt_snapshot(p_id) is null then raise exception 'No se encontró la compra.'; end if;
 return jsonb_build_object('receipt',private.receipt_snapshot(p_id),'products',(
 select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'sku',p.sku,'store',b.store,'warehouse',b.warehouse,
 'value',coalesce(v.value_nio,round((b.store+b.warehouse)*c.average_cost_nio,2)),
 'average',c.average_cost_nio) order by p.name)
 from public.products p cross join lateral(select max(quantity) filter(where location='store') store,max(quantity) filter(where location='warehouse') warehouse from public.inventory_balances where product_id=p.id)b
 left join private.inventory_value_balances v on v.product_id=p.id left join public.product_costs c on c.product_id=p.id
 where p.active or exists(select 1 from jsonb_array_elements(private.receipt_snapshot(p_id)->'lines')l where l->>'product_id'=p.id::text)),
 'accounts',(select jsonb_agg(jsonb_build_object('code',code,'displayCode',coalesce(display_code,code),'name',name,'bucket',bucket) order by code) from public.ledger_accounts where postable and active),
 'history',coalesce((select jsonb_agg(jsonb_build_object('id',id,'revision',revision,'actorName',actor_name,'createdAt',created_at,'before',before_snapshot,'after',after_snapshot,'journalEntryId',journal_entry_id) order by revision desc) from private.receipt_revisions where shipment_id=p_id),'[]'));
end $$;
create function public.receipt_edit_context(p_id uuid) returns jsonb language sql security invoker set search_path='' as $$select private.receipt_edit_context(p_id)$$;

-- El movimiento de una corrección ya lleva su contabilidad explícita. No puede
-- disparar otra merma, sobrante ni consumo de valor por segunda vez.
do $$ declare d text; f text; begin
 foreach f in array array['private.account_inventory_movement()','private.freeze_total_inventory_cost()'] loop
  d:=replace(pg_get_functiondef(f::regprocedure),E'\r\n',E'\n');
  if f='private.account_inventory_movement()' then
   d:=replace(d,E'begin\n',E'begin\n if exists(select 1 from private.receipt_inventory_changes m join private.receipt_revisions r on r.id=m.revision_id where m.movement_id=new.id and r.actor_id=auth.uid() and r.transaction_id=txid_current()) then return new; end if;\n');
  else
   d:=replace(d,E'begin\n',E'begin\n if tg_table_name=''inventory_movement_costs'' then if exists(select 1 from private.receipt_inventory_changes m join private.receipt_revisions r on r.id=m.revision_id where m.movement_id=new.movement_id and r.actor_id=auth.uid() and r.transaction_id=txid_current()) then new.total_cost_nio:=0; return new; end if; end if;\n');
  end if;
  execute d;
 end loop;
end $$;

create function private.revise_purchase_receipt(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.purchase_shipments%rowtype; old private.receipt_revisions%rowtype;b jsonb;a jsonb;v_input_line jsonb;impact jsonb;v_lines jsonb:='[]';
 v_id uuid;v_product uuid;v_movement uuid;v_journal uuid;v_request uuid:=(p_input->>'requestId')::uuid;actor text;
 v_rate numeric;v_currency text:=p_input->>'currency';v_shipping numeric;v_goods numeric:=0;v_units integer:=0;v_quantity integer;v_unit numeric;
 v_new_total numeric;v_old_total numeric;v_delta numeric;v_inventory_delta numeric:=0;v_remainder numeric;v_postings jsonb:='[]';
 v_store integer;v_warehouse integer;v_before integer;v_after integer;v_delta_store integer;v_delta_warehouse integer;
 v_value numeric;v_target numeric;v_average numeric;v_loc text;v_old_q integer;v_new_q integer;
 v_counterpart text:=p_input->>'counterpart';v_cost_account text:=p_input->>'costAccount';
begin
 if auth.uid() is null or not private.is_superadmin() then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('finance-credit-ledger',0));
 perform pg_advisory_xact_lock(hashtextextended('receipt-revision:'||coalesce(v_request::text,''),0));
 select * into old from private.receipt_revisions where request_id=v_request;
 if found then
  if old.actor_id<>auth.uid() or old.request_payload<>p_input then raise exception 'La solicitud de corrección cambió.'; end if;
  return jsonb_build_object('id',old.id,'receipt',old.after_snapshot,'journalEntryId',old.journal_entry_id);
 end if;
 select * into s from public.purchase_shipments where id=(p_input->>'shipmentId')::uuid for update;
 if not found or exists(select 1 from public.purchase_corrections where shipment_id=s.id) then raise exception 'Selecciona una compra vigente.'; end if;
 b:=private.receipt_snapshot(s.id);
 if (b->>'revision')::integer is distinct from (p_input->>'expectedRevision')::integer then raise exception 'La compra cambió. Actualiza su detalle antes de corregirla.'; end if;
 if not exists(select 1 from public.business_days where day=(now() at time zone 'America/Managua')::date and closed_at is null) then raise exception 'Abre la jornada de hoy para registrar la corrección de inventario.'; end if;
 if (p_input->>'incurredOn')::date is null or (p_input->>'incurredOn')::date>(now() at time zone 'America/Managua')::date then raise exception 'Revisa la fecha de recepción.'; end if;
 if length(coalesce(p_input->>'supplier',''))>160 or length(coalesce(p_input->>'reference',''))>200 or length(coalesce(p_input->>'note',''))>2000 then raise exception 'Revisa la longitud del proveedor, referencia o nota.'; end if;
 if jsonb_typeof(p_input->'impacts') is distinct from 'array' or jsonb_array_length(p_input->'impacts')>200 then raise exception 'Revisa el valor final de cada perfume.'; end if;
 v_rate:=private.accounting_rate(p_input);v_shipping:=private.accounting_number(p_input,'shippingAmount',100000000,2);
 if jsonb_typeof(p_input->'lines') is distinct from 'array' or jsonb_array_length(p_input->'lines') not between 1 and 100 then raise exception 'Agrega los productos de la compra.'; end if;
 if exists(select 1 from jsonb_array_elements(p_input->'lines')l group by l->>'productId' having count(*)>1) then raise exception 'Registra cada perfume una sola vez y selecciona su ubicación.'; end if;
 for v_input_line in select value from jsonb_array_elements(p_input->'lines') loop
  v_quantity:=private.accounting_number(v_input_line,'quantity',1000000,0);v_unit:=private.accounting_number(v_input_line,'unitPrice',100000000,6);
  if v_quantity<=0 or v_input_line->>'location' not in ('store','warehouse') then raise exception 'Revisa las cantidades y ubicaciones.'; end if;
  perform 1 from public.products where id=(v_input_line->>'productId')::uuid;
  if not found then raise exception 'Uno de los perfumes ya no está disponible.'; end if;
  v_goods:=v_goods+v_quantity*v_unit;v_units:=v_units+v_quantity;
  v_lines:=v_lines||jsonb_build_array(jsonb_build_object('product_id',v_input_line->>'productId','location',v_input_line->>'location','quantity',v_quantity,'unit_price',v_unit,
   'product_name',(select name from public.products where id=(v_input_line->>'productId')::uuid),'product_sku',(select sku from public.products where id=(v_input_line->>'productId')::uuid)));
 end loop;
 v_goods:=round(v_goods,2);
 v_new_total:=round(v_goods*v_rate,2)+round(v_shipping*v_rate,2);
 v_old_total:=round((b->>'goods_amount')::numeric*(b->>'exchange_rate')::numeric,2)+round((b->>'shipping_amount')::numeric*(b->>'exchange_rate')::numeric,2);
 if v_new_total<=0 then raise exception 'El costo total debe ser positivo.'; end if;
 v_delta:=v_new_total-v_old_total;
 if s.account='pending' then v_counterpart:='2190'; end if;
 if not exists(select 1 from public.ledger_accounts where code=v_counterpart and active and postable and code<>'1130') then raise exception 'Selecciona la contrapartida de la corrección.'; end if;
 if not exists(select 1 from public.ledger_accounts where code=v_cost_account and active and postable and bucket in ('cost','expense')) then raise exception 'Selecciona la cuenta de costo o gasto para la parte ya consumida.'; end if;
 a:=b||jsonb_build_object('incurred_on',p_input->>'incurredOn','supplier',btrim(coalesce(p_input->>'supplier','')),'reference',coalesce(p_input->>'reference',''),
 'note',coalesce(p_input->>'note',''),'currency',v_currency,'exchange_rate',v_rate,'shipping_amount',v_shipping,'goods_amount',v_goods,'units',v_units,'lines',v_lines,'revision',(b->>'revision')::integer+1);
 select display_name into actor from private.business_actors where id=auth.uid();
 insert into private.receipt_revisions(shipment_id,revision,request_id,request_payload,actor_id,actor_name,before_snapshot,after_snapshot,impacts,transaction_id)
 values(s.id,(b->>'revision')::integer+1,v_request,p_input,auth.uid(),coalesce(actor,'SuperAdmin'),b,a,p_input->'impacts',txid_current()) returning id into v_id;
 for v_product in select product_id::uuid from (
  select l->>'product_id' product_id from jsonb_array_elements(b->'lines')l union select l->>'product_id' from jsonb_array_elements(v_lines)l)q order by 1 loop
  perform 1 from public.products where id=v_product for update;
  perform 1 from public.inventory_balances where product_id=v_product order by location for update;
  select max(quantity) filter(where location='store'),max(quantity) filter(where location='warehouse') into v_store,v_warehouse from public.inventory_balances where product_id=v_product;
  if v_store is null or v_warehouse is null then raise exception 'Completa el conteo del perfume antes de corregir su recepción.'; end if;
  select average_cost_nio into v_average from public.product_costs where product_id=v_product;
  perform private.prepare_inventory_value(v_product,v_store+v_warehouse,v_average);
  select value_nio into v_value from private.inventory_value_balances where product_id=v_product for update;
  select value into impact from jsonb_array_elements(p_input->'impacts') where value->>'productId'=v_product::text;
  if impact is null or (impact->>'expectedStore')::integer is distinct from v_store or (impact->>'expectedWarehouse')::integer is distinct from v_warehouse
   or (impact->>'expectedValueNio')::numeric is distinct from v_value then raise exception 'Las existencias o el valor cambiaron. Actualiza la compra y revisa nuevamente el ajuste.'; end if;
  v_target:=private.accounting_number(impact,'targetValueNio',1000000000,2);
  v_delta_store:=0;v_delta_warehouse:=0;
  foreach v_loc in array array['store','warehouse'] loop
   select coalesce(sum((l->>'quantity')::integer),0) into v_old_q from jsonb_array_elements(b->'lines')l where l->>'product_id'=v_product::text and l->>'location'=v_loc;
   select coalesce(sum((l->>'quantity')::integer),0) into v_new_q from jsonb_array_elements(v_lines)l where l->>'product_id'=v_product::text and l->>'location'=v_loc;
   v_before:=case when v_loc='store' then v_store else v_warehouse end;v_after:=v_before+v_new_q-v_old_q;
   if v_after<0 then raise exception 'La corrección dejaría existencias negativas en %. Revisa las unidades que realmente quedan.',v_loc; end if;
   if v_loc='store' then v_delta_store:=v_new_q-v_old_q;else v_delta_warehouse:=v_new_q-v_old_q;end if;
   if v_new_q<>v_old_q then
    v_movement:=gen_random_uuid();insert into private.receipt_inventory_changes values(v_movement,v_id);
    update public.inventory_balances set quantity=v_after,updated_at=now() where product_id=v_product and location=v_loc;
    insert into public.inventory_movements(id,product_id,location,type,quantity,before_quantity,after_quantity,actor_id,reference,note)
    values(v_movement,v_product,v_loc,'ADJUSTMENT',abs(v_new_q-v_old_q),v_before,v_after,auth.uid(),coalesce(p_input->>'reference',''),'Corrección de recepción de mercancía');
    insert into public.inventory_movement_costs(movement_id,product_id,type,quantity,unit_cost_nio,total_cost_nio)
    values(v_movement,v_product,'ADJUSTMENT',abs(v_new_q-v_old_q),0,0);
   end if;
  end loop;
  if v_store+v_warehouse+v_delta_store+v_delta_warehouse=0 and v_target<>0 then raise exception 'Un perfume sin existencias debe quedar con valor de inventario cero.'; end if;
  update private.inventory_value_balances set quantity=v_store+v_warehouse+v_delta_store+v_delta_warehouse,value_nio=v_target,updated_at=now() where product_id=v_product;
  if v_store+v_warehouse+v_delta_store+v_delta_warehouse>0 then
   insert into public.product_costs(product_id,average_cost_nio) values(v_product,round(v_target/(v_store+v_warehouse+v_delta_store+v_delta_warehouse),6))
   on conflict(product_id) do update set average_cost_nio=excluded.average_cost_nio,updated_at=now();
  end if;
  v_inventory_delta:=v_inventory_delta+v_target-v_value;
 end loop;
 v_remainder:=v_delta-v_inventory_delta;
 select coalesce(jsonb_agg(jsonb_build_object('account',account,'currency','NIO','exchangeRate',1,'debit',greatest(amount,0),'credit',greatest(-amount,0))),'[]') into v_postings
 from (values('1130',v_inventory_delta),(v_cost_account,v_remainder),(v_counterpart,-v_delta))p(account,amount) where amount<>0;
 if jsonb_array_length(v_postings)>0 then
  v_journal:=private.record_journal_entry(jsonb_build_object('requestId',gen_random_uuid(),'occurredOn',(now() at time zone 'America/Managua')::date,'kind','adjustment',
  'currency','NIO','exchangeRate',1,'description','Corrección de recepción: '||left(coalesce(p_input->>'reference',s.reference),180),'reference',coalesce(p_input->>'reference',s.reference),'lines',v_postings));
  update private.receipt_revisions set journal_entry_id=v_journal where id=v_id;
 end if;
 return jsonb_build_object('id',v_id,'receipt',a,'journalEntryId',v_journal);
end $$;
create function public.revise_purchase_receipt(p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.revise_purchase_receipt(p_input)$$;

alter function private.purchase_history(timestamptz,uuid) rename to purchase_history_before_receipt_revisions;
create function private.purchase_history(p_before timestamptz default null,p_before_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r jsonb;
begin
 r:=private.purchase_history_before_receipt_revisions(p_before,p_before_id);
 return coalesce((select jsonb_agg(x||private.receipt_snapshot((x->>'id')::uuid)||jsonb_build_object('classification_entry_id',(select entry_id from private.purchase_classifications where shipment_id=(x->>'id')::uuid))) from jsonb_array_elements(r)x),'[]');
end $$;

-- La clasificación siempre cancela el importe efectivo, incluso después de una
-- corrección cuyo asiento quedó en la fecha actual.
do $$ declare d text; begin
 d:=pg_get_functiondef('private.validate_purchase_classification(uuid,uuid)'::regprocedure);
 d:=replace(d,'select round(goods_amount*exchange_rate,2)+round(shipping_amount*exchange_rate,2) into total from public.purchase_shipments where id=p_shipment;',
 'select round((s->>''goods_amount'')::numeric*(s->>''exchange_rate'')::numeric,2)+round((s->>''shipping_amount'')::numeric*(s->>''exchange_rate'')::numeric,2) into total from (select private.receipt_snapshot(p_shipment) s)q;');
 execute d;
end $$;

-- Evitar que la anulación antigua ignore una edición con asiento vinculado.
alter function private.correct_purchase(jsonb) rename to correct_purchase_before_receipt_revisions;
create function private.correct_purchase(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.receipt_revisions where shipment_id=(p_input->>'shipmentId')::uuid)
 or exists(select 1 from private.purchase_classifications where shipment_id=(p_input->>'shipmentId')::uuid) then
  raise exception 'Usa Editar recepción para conservar sus correcciones y su clasificación contable.'; end if;
 return private.correct_purchase_before_receipt_revisions(p_input);
end $$;
revoke all on function private.receipt_snapshot(uuid),private.purchase_history_before_receipt_revisions(timestamptz,uuid),private.correct_purchase_before_receipt_revisions(jsonb) from public,anon,authenticated;
revoke all on function private.receipt_edit_context(uuid),public.receipt_edit_context(uuid),private.revise_purchase_receipt(jsonb),public.revise_purchase_receipt(jsonb),private.purchase_history(timestamptz,uuid),private.correct_purchase(jsonb) from public,anon;
grant execute on function private.receipt_edit_context(uuid),public.receipt_edit_context(uuid),private.revise_purchase_receipt(jsonb),public.revise_purchase_receipt(jsonb),private.purchase_history(timestamptz,uuid),private.correct_purchase(jsonb) to authenticated;

create or replace function private.purchase_accounting_rows(p_status text default 'all',p_before timestamptz default null,p_before_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 return (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc,r.id desc),'[]') from (
 select s.id,(snap.r->>'incurred_on')::date incurred_on,snap.r->>'supplier' supplier,snap.r->>'reference' reference,
 snap.r->>'currency' currency,(snap.r->>'exchange_rate')::numeric exchange_rate,(snap.r->>'goods_amount')::numeric goods_amount,
 (snap.r->>'shipping_amount')::numeric shipping_amount,(snap.r->>'units')::integer units,s.created_at,
 pc.entry_id,classification.ok classified,e.revision,
 coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'occurredOn',f.occurred_on,'amount',f.amount,'currency',f.currency,'reference',f.reference) order by f.occurred_on,f.id)
 from public.finance_entries f where f.kind='supplier_payment' and f.voided_at is null and (f.shipment_id is null or f.shipment_id=s.id)),'[]') payments,
 coalesce((select jsonb_agg(finance_entry_id) from private.purchase_payment_links where shipment_id=s.id),'[]') linked_payments
 from public.purchase_shipments s cross join lateral(select private.receipt_snapshot(s.id) r)snap
 left join private.purchase_classifications pc on pc.shipment_id=s.id left join public.journal_entries e on e.id=pc.entry_id
 cross join lateral(select pc.entry_id is not null and e.voided_at is null and
 coalesce((select sum(l.debit_nio-l.credit_nio) from public.journal_lines l where l.entry_id=e.id and l.account='2190'),0)=
 round((snap.r->>'goods_amount')::numeric*(snap.r->>'exchange_rate')::numeric,2)+round((snap.r->>'shipping_amount')::numeric*(snap.r->>'exchange_rate')::numeric,2) ok)classification
 where s.account='pending' and not exists(select 1 from public.purchase_corrections where shipment_id=s.id)
 and (p_status='all' or (p_status='pending' and not coalesce(classification.ok,false)))
 and (p_before is null or (s.created_at,s.id)<(p_before,p_before_id)) order by s.created_at desc,s.id desc limit 50)r);
end $$;

alter function private.get_journal_entry(uuid) rename to get_journal_entry_before_receipt_links;
create function private.get_journal_entry(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 return private.get_journal_entry_before_receipt_links(p_id)||jsonb_build_object('sourceReceiptId',coalesce(
 (select shipment_id from private.purchase_classifications where entry_id=p_id),
 (select shipment_id from private.receipt_revisions where journal_entry_id=p_id)),
 'receiptCorrection',exists(select 1 from private.receipt_revisions where journal_entry_id=p_id));
end $$;
revoke all on function private.get_journal_entry_before_receipt_links(uuid),private.get_journal_entry(uuid) from public,anon;
revoke all on function private.get_journal_entry_before_receipt_links(uuid) from authenticated;
grant execute on function private.get_journal_entry(uuid) to authenticated;

alter function private.operation_confirmation(text,uuid,boolean) rename to operation_confirmation_before_receipt_edits;
create function private.operation_confirmation(p_kind text,p_request_id uuid,p_retire boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.receipt_revisions%rowtype;
begin
 if p_kind<>'receipt-revision' then return private.operation_confirmation_before_receipt_edits(p_kind,p_request_id,p_retire); end if;
 if auth.uid() is null or not private.is_superadmin() then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 select * into r from private.receipt_revisions where actor_id=auth.uid() and request_id=p_request_id;
 if found then return jsonb_build_object('status','confirmed','id',r.id); end if;
 if p_retire then insert into private.retired_operations(actor_id,kind,request_id) values(auth.uid(),p_kind,p_request_id) on conflict do nothing; end if;
 if exists(select 1 from private.retired_operations where actor_id=auth.uid() and kind=p_kind and request_id=p_request_id) then return jsonb_build_object('status','retired'); end if;
 return jsonb_build_object('status','missing');
end $$;
create trigger retired_operation before insert on private.receipt_revisions for each row execute function private.prevent_retired_operation('receipt-revision','actor_id','request_id');
revoke all on function private.operation_confirmation(text,uuid,boolean),private.operation_confirmation_before_receipt_edits(text,uuid,boolean) from public,anon,authenticated;
notify pgrst,'reload schema';

-- Anular un ajuste conserva el registro original y aplica su diferencia
-- inversa a las existencias actuales, con el valor histórico de la operación.
alter table public.inventory_movements
 add column voided_at timestamptz,
 add column void_reason text,
 add column voided_by uuid references private.business_actors(id),
 add column reversal_of uuid references public.inventory_movements(id),
 add constraint inventory_movement_void_metadata check(
  (voided_at is null and void_reason is null and voided_by is null)
  or (voided_at is not null and void_reason is not null and voided_by is not null)),
 add constraint inventory_movement_reversal_source check(reversal_of is null or (reversal_of<>id and type='ADJUSTMENT'));
create unique index inventory_movement_one_reversal on public.inventory_movements(reversal_of) where reversal_of is not null;

create table private.inventory_adjustment_voids (
 id uuid primary key default gen_random_uuid(),
 movement_id uuid not null unique references public.inventory_movements(id),
 reversal_movement_id uuid not null unique references public.inventory_movements(id) deferrable initially deferred,
 journal_entry_id uuid unique references public.journal_entries(id),
 actor_id uuid not null references private.business_actors(id),actor_name text not null,
 request_id uuid not null unique,request_payload jsonb not null,reason text not null,
 original_snapshot jsonb not null,reversal_snapshot jsonb,original_journal_snapshot jsonb,
 quantity_delta integer not null,value_delta_nio numeric(24,2) not null,
 occurred_on date not null,transaction_id bigint not null,created_at timestamptz not null default now()
);
alter table private.inventory_adjustment_voids enable row level security;
revoke all on private.inventory_adjustment_voids from public,anon,authenticated;
create trigger retired_operation before insert on private.inventory_adjustment_voids
 for each row execute function private.prevent_retired_operation('inventory-adjustment-void','actor_id','request_id');

create function private.inventory_adjustment_void_context(p_movement uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.inventory_movements%rowtype; state private.inventory_value_balances%rowtype;
 audit private.inventory_adjustment_voids%rowtype; original_delta integer; reverse_delta integer;
 current_quantity integer; total_quantity integer; resulting_quantity integer; resulting_total integer;
 average numeric; historical_value numeric; current_value numeric; value_delta numeric; resulting_value numeric;
 source_entry uuid; journal_snapshot jsonb; cost_snapshot jsonb; day_snapshot jsonb;
 problem text; result jsonb; product_name text; product_sku text; quantities jsonb;
begin
 if auth.uid() is null or not private.is_superadmin() then raise insufficient_privilege; end if;
 select * into m from public.inventory_movements where id=p_movement;
 if not found then raise exception 'No se encontró el movimiento de inventario.'; end if;
 select name,sku into product_name,product_sku from public.products where id=m.product_id;
 select quantity into current_quantity from public.inventory_balances where product_id=m.product_id and location=m.location;
 select jsonb_agg(to_jsonb(b) order by location),case when count(*)=2 and count(quantity)=2 then sum(quantity)::integer end
  into quantities,total_quantity from public.inventory_balances b where product_id=m.product_id;
 select * into state from private.inventory_value_balances where product_id=m.product_id;
 select average_cost_nio into average from public.product_costs where product_id=m.product_id;
 current_value:=case when state.product_id is not null then state.value_nio
  when total_quantity=0 then 0 when total_quantity is not null and average is not null then round(total_quantity*average,2) end;
 original_delta:=m.after_quantity-m.before_quantity;reverse_delta:=-original_delta;
 resulting_quantity:=current_quantity+reverse_delta;resulting_total:=total_quantity+reverse_delta;
 select jsonb_build_object('day',day,'revision',revision,'openedAt',opened_at,'closedAt',closed_at)
  into day_snapshot from public.business_days where day=(now() at time zone 'America/Managua')::date;
 select * into audit from private.inventory_adjustment_voids where movement_id=m.id;
 if m.voided_at is not null then
  reverse_delta:=0;value_delta:=0;resulting_quantity:=current_quantity;resulting_value:=current_value;
  problem:='Este ajuste ya fue anulado. Se conserva su registro y su reversión.';
 elsif m.type<>'ADJUSTMENT' or m.request_id is null or m.document_id is not null or m.is_invoice_reversal
  or m.reversal_of is not null then
  problem:='Solo se pueden anular ajustes manuales de inventario. Las ventas, devoluciones y reversiones se corrigen desde su operación de origen.';
 elsif exists(select 1 from private.receipt_inventory_changes where movement_id=m.id) then
  problem:='Este ajuste pertenece a una recepción. Corrige la recepción de origen.';
 elsif exists(select 1 from private.inventory_purchase_links where movement_id=m.id) then
  problem:='Este ajuste ya fue regularizado como compra. Corrige la recepción de origen.';
 elsif m.before_quantity is null then
  problem:='Un conteo inicial sin cantidad anterior no tiene una diferencia histórica que pueda revertirse. Registra el conteo correcto desde Inventario.';
 elsif original_delta=0 then
  problem:='Este ajuste no cambió las existencias y no necesita reversión.';
 else
  if original_delta<0 then
   select to_jsonb(c),coalesce(c.total_cost_nio,round(c.quantity*c.unit_cost_nio,2)) into cost_snapshot,historical_value
    from public.inventory_movement_costs c where c.movement_id=m.id and c.product_id=m.product_id
     and c.quantity=-original_delta and c.unit_cost_nio is not null and c.unit_cost_nio>=0;
  else
   select to_jsonb(g),round(g.quantity*g.unit_cost_nio,2) into cost_snapshot,historical_value
    from private.inventory_count_gains g where g.movement_id=m.id and g.product_id=m.product_id
     and g.quantity=original_delta and g.unit_cost_nio is not null and g.unit_cost_nio>=0;
  end if;
  value_delta:=case when original_delta<0 then historical_value else -historical_value end;
  resulting_value:=current_value+value_delta;
  if historical_value is null then problem:='Falta el costo histórico del ajuste. No se puede anular usando un costo inventado o el costo actual.';
  elsif total_quantity is null or current_quantity is null or current_value is null then
   problem:='Completa los conteos y el costo actual del perfume antes de anular el ajuste.';
  elsif state.product_id is not null and state.quantity<>total_quantity then
   problem:='Las cantidades y la valorización no coinciden. Revisa la conciliación de inventario antes de anular.';
  elsif resulting_quantity<0 or resulting_total<0 then
   problem:='La anulación dejaría existencias negativas. Revisa las operaciones posteriores antes de continuar.';
  elsif resulting_value<0 or (resulting_total=0 and resulting_value<>0) then
   problem:='La anulación dejaría una valorización inválida. Revisa los costos y las operaciones posteriores antes de continuar.';
  end if;
  if m.adjustment_kind='correction' then
   select entry_id into source_entry from private.inventory_adjustment_journals where movement_id=m.id;
   if source_entry is not null then
    select private.journal_snapshot(source_entry) into journal_snapshot;
    if journal_snapshot is null or journal_snapshot->>'voided_at' is not null or
     (select coalesce(sum(debit_nio-credit_nio),0) from public.journal_lines where entry_id=source_entry and account='1130')
      is distinct from (case when original_delta>0 then historical_value else -historical_value end) then
     problem:='El comprobante del ajuste no coincide con su costo histórico. Revisa el origen antes de anular.';
    end if;
   elsif historical_value<>0 then problem:='Falta el comprobante vinculado de la corrección. Revisa su origen antes de anular.'; end if;
  end if;
  if problem is null and (day_snapshot is null or day_snapshot->>'closedAt' is not null) then
   problem:='Abre la jornada de hoy para anular el ajuste de inventario.';
  end if;
 end if;
 result:=jsonb_build_object('movementId',m.id,'productName',product_name,'sku',product_sku,'location',m.location,
  'beforeQuantity',m.before_quantity,'afterQuantity',m.after_quantity,'originalQuantityDelta',original_delta,
  'currentQuantity',current_quantity,'resultingQuantity',resulting_quantity,'quantityDelta',reverse_delta,
  'currentValueNio',current_value,'resultingValueNio',resulting_value,'valueDeltaNio',value_delta,
  'canVoid',problem is null,'blockedReason',problem,'voidedAt',m.voided_at,'voidReason',m.void_reason,
  'reversalMovementId',audit.reversal_movement_id,'journalEntryId',audit.journal_entry_id);
 return result||jsonb_build_object('stateToken',md5(jsonb_build_object('movement',to_jsonb(m),
  'quantities',quantities,'value',to_jsonb(state),'average',average,'cost',cost_snapshot,
  'journal',journal_snapshot,'day',day_snapshot,'today',(now() at time zone 'America/Managua')::date)::text));
end $$;
create function public.inventory_adjustment_void_context(p_movement uuid) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.inventory_adjustment_void_context(p_movement); $$;
revoke all on function private.inventory_adjustment_void_context(uuid),public.inventory_adjustment_void_context(uuid) from public,anon;
grant execute on function private.inventory_adjustment_void_context(uuid),public.inventory_adjustment_void_context(uuid) to authenticated;

-- La excepción a la jornada cerrada solo permite añadir la marca de anulación
-- del original auditado por esta misma transacción; no permite editar sus datos.
do $guards$
declare definition text; marker text;
begin
 definition:=replace(pg_get_functiondef('private.guard_business_day()'::regprocedure),E'\r\n',E'\n');
 marker:=E'begin\n';
 if position(marker in definition)=0 then raise exception 'Revisar la protección de jornadas.'; end if;
 definition:=replace(definition,marker,marker||$exception$
 if tg_table_name='inventory_movements' and tg_op='UPDATE' and auth.uid() is not null and private.is_superadmin() then
  if old.voided_at is null and new.voided_at is not null
   and (to_jsonb(new)-'voided_at'-'void_reason'-'voided_by')=(to_jsonb(old)-'voided_at'-'void_reason'-'voided_by')
   and exists(select 1 from private.inventory_adjustment_voids v where v.movement_id=old.id
    and v.actor_id=auth.uid() and v.transaction_id=txid_current() and v.original_snapshot=to_jsonb(old)
    and new.voided_at=v.created_at and new.void_reason=v.reason and new.voided_by=v.actor_id) then return new; end if;
 end if;
$exception$);
 execute definition;
 definition:=replace(pg_get_functiondef('private.account_inventory_movement()'::regprocedure),E'\r\n',E'\n');
 if position(marker in definition)=0 then raise exception 'Revisar la contabilización del movimiento de inventario.'; end if;
 definition:=replace(definition,marker,marker||$exception$
 if new.reversal_of is not null and auth.uid() is not null and private.is_superadmin() and exists(
  select 1 from private.inventory_adjustment_voids v where v.reversal_movement_id=new.id
   and v.movement_id=new.reversal_of and v.actor_id=auth.uid() and v.transaction_id=txid_current()
   and new.product_id=(v.original_snapshot->>'product_id')::uuid
   and new.location=v.original_snapshot->>'location' and new.type='ADJUSTMENT'
   and new.after_quantity-new.before_quantity=v.quantity_delta) then return new; end if;
$exception$);
 execute definition;
end $guards$;

-- Una vez revertido, el aumento original ya no representa mercancía recibida
-- que pueda regularizarse como una compra nueva.
do $voided_adoptions$
declare definition text; signature text; marker text:='if m.adjustment_kind=''correction'' then';
begin
 foreach signature in array array['private.count_purchase_context(uuid)','private.adopt_inventory_counts_as_purchase(jsonb)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if position(marker in definition)=0 then raise exception 'Revisar la regularización de ajustes anulados.'; end if;
  definition:=replace(definition,marker,
   'if m.voided_at is not null or m.reversal_of is not null then raise exception ''Un ajuste anulado o su reversión no se pueden convertir en compra.''; end if; '||marker);
  execute definition;
 end loop;
end $voided_adoptions$;

create function private.void_inventory_adjustment(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.inventory_movements%rowtype; saved private.inventory_adjustment_voids%rowtype;
 context jsonb; request uuid:=(p_input->>'requestId')::uuid; movement uuid:=(p_input->>'movementId')::uuid;
 reason text:=btrim(p_input->>'reason'); reversal uuid:=gen_random_uuid(); audit_id uuid; entry uuid; source_entry uuid;
 source_snapshot jsonb; lines jsonb; row jsonb; n integer:=0; amount_nio numeric; current_total integer; resulting_total integer;
 current_average numeric; occurred date:=(now() at time zone 'America/Managua')::date; created timestamptz:=now();
begin
 if auth.uid() is null or not private.is_superadmin() then raise insufficient_privilege; end if;
 if request is null or movement is null then raise exception 'Falta identificar el ajuste y la solicitud de anulación.'; end if;
 if reason is null or length(reason) not between 3 and 500 then raise exception 'Escribe un motivo de anulación de entre 3 y 500 caracteres.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('finance-credit-ledger',0));
 perform pg_advisory_xact_lock(hashtextextended('inventory-adjustment-void:'||request::text,0));
 select * into saved from private.inventory_adjustment_voids where request_id=request;
 if found then
  if saved.actor_id<>auth.uid() or saved.request_payload is distinct from p_input then raise exception 'La solicitud de anulación cambió. Verifica el guardado original.'; end if;
  return jsonb_build_object('id',saved.id,'movementId',saved.movement_id,'reversalMovementId',saved.reversal_movement_id,
   'journalEntryId',saved.journal_entry_id,'voidedAt',saved.created_at,'voidReason',saved.reason);
 end if;
 select * into m from public.inventory_movements where id=movement for update;
 if not found then raise exception 'No se encontró el ajuste de inventario.'; end if;
 perform 1 from public.products where id=m.product_id for update;
 perform 1 from public.inventory_balances where product_id=m.product_id order by location for update;
 perform 1 from private.inventory_value_balances where product_id=m.product_id for update;
 context:=private.inventory_adjustment_void_context(m.id);
 if context->>'canVoid' is distinct from 'true' then raise exception '%',context->>'blockedReason'; end if;
 if nullif(p_input->>'stateToken','') is null or p_input->>'stateToken' is distinct from context->>'stateToken' then
  raise exception 'Las existencias, el costo o la jornada cambiaron. Actualiza y revisa nuevamente la anulación.';
 end if;
 select sum(quantity)::integer into current_total from public.inventory_balances where product_id=m.product_id;
 select average_cost_nio into current_average from public.product_costs where product_id=m.product_id;
 resulting_total:=current_total+(context->>'quantityDelta')::integer;
 amount_nio:=abs((context->>'valueDeltaNio')::numeric);
 if m.adjustment_kind='correction' then
  select entry_id into source_entry from private.inventory_adjustment_journals where movement_id=m.id;
  if source_entry is not null then
   source_snapshot:=private.journal_snapshot(source_entry);
   select jsonb_agg(jsonb_build_object('account',l.account,'currency',coalesce(c.currency,e.currency),
    'exchangeRate',coalesce(c.exchange_rate,e.exchange_rate),'debit',l.credit,'credit',l.debit,
    'debitNio',l.credit_nio,'creditNio',l.debit_nio) order by l.line_no) into lines
   from public.journal_lines l join public.journal_entries e on e.id=l.entry_id
   left join private.journal_line_currencies c on c.entry_id=l.entry_id and c.line_no=l.line_no where l.entry_id=source_entry;
  end if;
 elsif amount_nio>0 then
  lines:=case when (context->>'quantityDelta')::integer>0 then jsonb_build_array(
   jsonb_build_object('account','1130','currency','NIO','exchangeRate',1,'debit',amount_nio,'credit',0,'debitNio',amount_nio,'creditNio',0),
   jsonb_build_object('account','5150','currency','NIO','exchangeRate',1,'debit',0,'credit',amount_nio,'debitNio',0,'creditNio',amount_nio)) else jsonb_build_array(
   jsonb_build_object('account','4190','currency','NIO','exchangeRate',1,'debit',amount_nio,'credit',0,'debitNio',amount_nio,'creditNio',0),
   jsonb_build_object('account','1130','currency','NIO','exchangeRate',1,'debit',0,'credit',amount_nio,'debitNio',0,'creditNio',amount_nio)) end;
 end if;
 if jsonb_array_length(coalesce(lines,'[]'))>0 and not exists(
  select 1 from public.journal_entries where kind='opening' and voided_at is null and occurred_on<=occurred) then
  raise exception 'Registra los saldos iniciales antes de anular un ajuste con valor contable.';
 end if;
 insert into private.inventory_adjustment_voids(movement_id,reversal_movement_id,actor_id,actor_name,request_id,request_payload,reason,
  original_snapshot,original_journal_snapshot,quantity_delta,value_delta_nio,occurred_on,transaction_id,created_at)
 values(m.id,reversal,auth.uid(),coalesce((select display_name from private.business_actors where id=auth.uid()),'SuperAdmin'),
  request,p_input,reason,to_jsonb(m),source_snapshot,(context->>'quantityDelta')::integer,(context->>'valueDeltaNio')::numeric,occurred,txid_current(),created)
 returning id into audit_id;
 perform private.prepare_inventory_value(m.product_id,current_total,current_average);
 update public.inventory_balances set quantity=(context->>'resultingQuantity')::integer,updated_at=created
  where product_id=m.product_id and location=m.location;
 insert into public.inventory_movements(id,request_id,product_id,location,type,quantity,before_quantity,after_quantity,actor_id,reference,note,reversal_of,created_at)
 values(reversal,gen_random_uuid(),m.product_id,m.location,'ADJUSTMENT',abs((context->>'quantityDelta')::integer),
  (context->>'currentQuantity')::integer,(context->>'resultingQuantity')::integer,auth.uid(),left(coalesce(m.reference,''),200),
  left('Anulación del ajuste '||m.id::text||': '||reason,2000),m.id,created);
 update private.inventory_value_balances set quantity=resulting_total,value_nio=(context->>'resultingValueNio')::numeric,updated_at=created where product_id=m.product_id;
 if resulting_total>0 then
  insert into public.product_costs(product_id,average_cost_nio)
  values(m.product_id,round((context->>'resultingValueNio')::numeric/resulting_total,6))
  on conflict(product_id) do update set average_cost_nio=excluded.average_cost_nio,updated_at=created;
 end if;
 if jsonb_array_length(coalesce(lines,'[]'))>0 then
  if (select sum((x->>'debitNio')::numeric-(x->>'creditNio')::numeric) from jsonb_array_elements(lines)x)<>0 then
   raise exception 'El comprobante histórico no está balanceado. Revisa su origen antes de anular.';
  end if;
  -- Revertir las cuentas históricas también es válido si hoy están inactivas.
  -- Se copian sus importes y monedas exactos; no se calcula una tasa nueva.
  insert into public.journal_entries(occurred_on,kind,description,reference,currency,exchange_rate,request_id,request_payload,created_by)
  values(occurred,'adjustment',left('Anulación de ajuste de inventario: '||reason,300),left(coalesce(m.reference,''),200),
   'NIO',1,gen_random_uuid(),jsonb_build_object('inventoryAdjustmentVoidId',audit_id,'inventoryMovementId',m.id,'request',p_input),auth.uid()) returning id into entry;
  for row in select value from jsonb_array_elements(lines) loop
   n:=n+1;
   insert into private.journal_line_currencies values(entry,n,row->>'currency',(row->>'exchangeRate')::numeric);
   insert into public.journal_lines(entry_id,line_no,account,debit,credit,debit_nio,credit_nio)
   values(entry,n,row->>'account',(row->>'debit')::numeric,(row->>'credit')::numeric,(row->>'debitNio')::numeric,(row->>'creditNio')::numeric);
  end loop;
  perform private.check_credit_pool();perform private.check_pos_balance();
  insert into private.inventory_adjustment_journals values(reversal,entry);
 end if;
 update private.inventory_adjustment_voids set journal_entry_id=entry,
  reversal_snapshot=(select to_jsonb(r) from public.inventory_movements r where r.id=reversal) where id=audit_id;
 update public.inventory_movements set voided_at=created,void_reason=reason,voided_by=auth.uid() where id=m.id;
 return jsonb_build_object('id',audit_id,'movementId',m.id,'reversalMovementId',reversal,'journalEntryId',entry,'voidedAt',created,'voidReason',reason);
end $$;
create function public.void_inventory_adjustment(p_input jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select private.void_inventory_adjustment(p_input); $$;
revoke all on function private.void_inventory_adjustment(jsonb),public.void_inventory_adjustment(jsonb) from public,anon;
grant execute on function private.void_inventory_adjustment(jsonb),public.void_inventory_adjustment(jsonb) to authenticated;

create or replace function private.inventory_adjustment_journal_metadata(p_entry uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce((select jsonb_build_object('inventoryCorrection',true,'inventoryMovementId',j.movement_id)||
  case when v.id is not null then jsonb_build_object('inventoryAdjustmentVoid',true,'inventoryOriginalMovementId',v.movement_id) else '{}'::jsonb end
  from private.inventory_adjustment_journals j left join private.inventory_adjustment_voids v on v.journal_entry_id=j.entry_id
  where j.entry_id=p_entry),'{}'::jsonb);
$$;

alter function private.operation_confirmation(text,uuid,boolean) rename to operation_confirmation_before_inventory_voids;
create function private.operation_confirmation(p_kind text,p_request_id uuid,p_retire boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare audit private.inventory_adjustment_voids%rowtype;
begin
 if p_kind<>'inventory-adjustment-void' then return private.operation_confirmation_before_inventory_voids(p_kind,p_request_id,p_retire); end if;
 if auth.uid() is null or not private.is_superadmin() then raise insufficient_privilege; end if;
 if p_request_id is null then raise exception 'Falta identificar la solicitud de anulación.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 select * into audit from private.inventory_adjustment_voids where actor_id=auth.uid() and request_id=p_request_id;
 if found then return jsonb_build_object('status','confirmed','id',audit.id); end if;
 if p_retire then insert into private.retired_operations(actor_id,kind,request_id) values(auth.uid(),p_kind,p_request_id) on conflict do nothing; end if;
 if exists(select 1 from private.retired_operations where actor_id=auth.uid() and kind=p_kind and request_id=p_request_id) then return jsonb_build_object('status','retired'); end if;
 return jsonb_build_object('status','missing');
end $$;
revoke all on function private.operation_confirmation(text,uuid,boolean),private.operation_confirmation_before_inventory_voids(text,uuid,boolean) from public,anon,authenticated;

create function private.inventory_adjustment_void_postings(p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then raise exception 'Período inválido.'; end if;
 return (select coalesce(jsonb_agg(row order by row->>'occurredOn',row->>'movementId'),'[]') from (
  select jsonb_build_object('movementId',v.movement_id,'occurredOn',e.occurred_on,
   'inventoryWriteOffNio',coalesce(sum(l.debit_nio-l.credit_nio) filter(where l.account='5150'),0)) row
  from private.inventory_adjustment_voids v join public.journal_entries e on e.id=v.journal_entry_id
  join public.journal_lines l on l.entry_id=e.id where e.voided_at is null and e.occurred_on between p_from and p_to
  group by v.id,e.id having coalesce(sum(l.debit_nio-l.credit_nio) filter(where l.account='5150'),0)<>0)q);
end $$;
create function public.inventory_adjustment_void_postings(p_from date,p_to date) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.inventory_adjustment_void_postings(p_from,p_to); $$;
revoke all on function private.inventory_adjustment_void_postings(date,date),public.inventory_adjustment_void_postings(date,date) from public,anon;
grant execute on function private.inventory_adjustment_void_postings(date,date),public.inventory_adjustment_void_postings(date,date) to authenticated;

create function private.report_digest_with_inventory_voids(p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; reversals jsonb; amount numeric; months jsonb;
begin
 result:=private.report_digest_with_receipt_corrections(p_from,p_to);
 if jsonb_typeof(result->'ledger') is distinct from 'object' then return result; end if;
 reversals:=private.inventory_adjustment_void_postings(p_from,p_to);
 select coalesce(sum((x->>'inventoryWriteOffNio')::numeric),0) into amount from jsonb_array_elements(reversals)x;
 result:=jsonb_set(result,'{ledger,inventoryWriteOffNio}',to_jsonb((result#>>'{ledger,inventoryWriteOffNio}')::numeric+amount));
 with changes as(select left(x->>'occurredOn',7) month_key,sum((x->>'inventoryWriteOffNio')::numeric) amount
  from jsonb_array_elements(reversals)x group by 1),
 original as(select x->>'month' month_key,x from jsonb_array_elements(coalesce(result#>'{ledger,months}','[]'))x)
 select coalesce(jsonb_agg(coalesce(o.x,jsonb_build_object('month',c.month_key,'revenueNio',0,'shippingNio',0,'shippingExpenseNio',0,
  'salesTaxNio',0,'costOfSalesNio',0,'missingCostUnits',0,'missingRevenueLines',0,'soldUnits',0,'missingWriteOffUnits',0))||
  jsonb_build_object('inventoryWriteOffNio',coalesce((o.x->>'inventoryWriteOffNio')::numeric,0)+coalesce(c.amount,0))
  order by coalesce(o.month_key,c.month_key)),'[]') into months from original o full join changes c on c.month_key=o.month_key;
 return jsonb_set(result,'{ledger,months}',months);
end $$;
revoke all on function private.report_digest_with_inventory_voids(date,date) from public,anon;
grant execute on function private.report_digest_with_inventory_voids(date,date) to authenticated;
create or replace function public.report_digest(p_from date,p_to date) returns jsonb
language sql security invoker set search_path='' as $$ select private.report_digest_with_inventory_voids(p_from,p_to); $$;

-- Una reversión manual no es un faltante nuevo y no genera otro costo/gain.
do $missing_reversals$
declare definition text; marker text:='and m.adjustment_kind is distinct from ''correction''';
begin
 definition:=pg_get_functiondef('private.report_digest_before_receipt_corrections(date,date)'::regprocedure);
 if position(marker in definition)=0 then raise exception 'Revisar los faltantes sin costo en reportes.'; end if;
 execute replace(definition,marker,marker||' and m.reversal_of is null');
end $missing_reversals$;

notify pgrst,'reload schema';

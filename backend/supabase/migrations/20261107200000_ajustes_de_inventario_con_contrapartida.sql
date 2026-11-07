-- La corrección de un conteo conserva su costo exacto y permite elegir su
-- contrapartida de balance. La pérdida se registra únicamente al elegirla.
-- Los movimientos existentes y los ajustes internos conservan su tratamiento.
alter table public.inventory_movements
 add column adjustment_kind text check(adjustment_kind in ('correction','loss')),
 add column counter_account text references public.ledger_accounts(code),
 add constraint inventory_adjustment_classification check(coalesce(
  (adjustment_kind is null and counter_account is null)
  or (type='ADJUSTMENT' and adjustment_kind='correction' and counter_account is not null)
  or (type='ADJUSTMENT' and adjustment_kind='loss' and counter_account is null
      and before_quantity is not null and after_quantity<before_quantity),false));

create table private.inventory_adjustment_journals (
 movement_id uuid primary key references public.inventory_movements(id),
 entry_id uuid not null unique references public.journal_entries(id)
);
alter table private.inventory_adjustment_journals enable row level security;
revoke all on private.inventory_adjustment_journals from public,anon,authenticated;

-- El comprobante se genera con el valor congelado por los mismos triggers que
-- actualizan existencias y costo. Se utiliza el libro común para conservar los
-- auxiliares de caja, cuentas por cobrar/pagar y tarjetas pendientes.
create function private.post_inventory_adjustment(p_movement uuid) returns void
language plpgsql security definer set search_path='' as $$
declare m public.inventory_movements%rowtype; amount_nio numeric; entry uuid;
 inventory_line jsonb; counter_line jsonb; product_name text;
begin
 select * into m from public.inventory_movements where id=p_movement;
 if not found or m.adjustment_kind is distinct from 'correction' then return; end if;
 if exists(select 1 from private.inventory_adjustment_journals where movement_id=m.id) then return; end if;
 if m.after_quantity<m.before_quantity then
  select coalesce(total_cost_nio,round(quantity*unit_cost_nio,2)) into amount_nio
  from public.inventory_movement_costs where movement_id=m.id;
 else
  select round(quantity*unit_cost_nio,2) into amount_nio
  from private.inventory_count_gains where movement_id=m.id;
 end if;
 -- Un conteo inicial sin valor y una diferencia de costo cero no originan un
 -- comprobante con importes ficticios. Sus cantidades sí quedan auditadas.
 if coalesce(amount_nio,0)=0 then return; end if;
 select name into product_name from public.products where id=m.product_id;
 inventory_line:=jsonb_build_object('account','1130','currency','NIO','exchangeRate',1,
  'debit',case when m.after_quantity>coalesce(m.before_quantity,0) then amount_nio else 0 end,
  'credit',case when m.after_quantity<m.before_quantity then amount_nio else 0 end);
 counter_line:=jsonb_build_object('account',m.counter_account,'currency','NIO','exchangeRate',1,
  'debit',case when m.after_quantity<m.before_quantity then amount_nio else 0 end,
  'credit',case when m.after_quantity>coalesce(m.before_quantity,0) then amount_nio else 0 end);
 entry:=private.record_journal_entry(jsonb_build_object('requestId',gen_random_uuid(),
  'kind','adjustment','occurredOn',(m.created_at at time zone 'America/Managua')::date,
  'description',left('Corrección de inventario: '||coalesce(product_name,'Perfume')||' · '||m.note,300),
  'reference',coalesce(m.reference,''),'currency','NIO','exchangeRate',1,
  'inventoryMovementId',m.id,'lines',jsonb_build_array(inventory_line,counter_line)));
 insert into private.inventory_adjustment_journals values(m.id,entry);
end $$;
revoke all on function private.post_inventory_adjustment(uuid) from public,anon,authenticated;

-- La clasificación pertenece al mismo requestId que el conteo. Reintentar no
-- permite cambiar su tipo, cuenta ni conteo esperado y no repite el asiento.
do $movement$
declare definition text; marker text;
begin
 definition:=replace(pg_get_functiondef('private.record_inventory_movement(jsonb)'::regprocedure),E'\r\n',E'\n');
 marker:=' v_qty integer; v_before integer; v_after integer;';
 if position(marker in definition)=0 then raise exception 'Revisar las variables del movimiento de inventario.'; end if;
 definition:=replace(definition,marker,' v_adjustment_kind text:=p_payload->>''adjustmentKind''; v_counter_account text:=p_payload->>''counterAccount'';'||E'\n'||marker);
 marker:=' perform pg_advisory_xact_lock(hashtextextended(v_uid::text||v_request::text,0));';
 if position(marker in definition)=0 then raise exception 'Revisar la validación del movimiento de inventario.'; end if;
 definition:=replace(definition,marker,$validation$
 if p_payload ? 'adjustmentKind' or p_payload ? 'counterAccount' then
  if v_type<>'ADJUSTMENT' or v_adjustment_kind is null or v_adjustment_kind not in ('correction','loss') then
   raise exception 'Selecciona el tratamiento del ajuste de inventario.';
  end if;
  if not private.is_superadmin() then raise insufficient_privilege; end if;
  if v_adjustment_kind='loss' and p_payload ? 'counterAccount' then
   raise exception 'La pérdida utiliza Pérdidas de inventario; no admite otra contrapartida.';
  end if;
 end if;
 -- Mismo orden de bloqueo que comprobantes, cobros y compras.
 if v_adjustment_kind='correction' then
  perform pg_advisory_xact_lock(hashtextextended('finance-credit-ledger',0));
  perform pg_advisory_xact_lock(hashtextextended('ledger-accounts',0));
 end if;
$validation$||marker);
 marker:='  return v_existing.id;';
 if position(marker in definition)=0 then raise exception 'Revisar la recuperación del movimiento de inventario.'; end if;
 definition:=replace(definition,marker,$retry$
  if v_existing.adjustment_kind is distinct from v_adjustment_kind
   or v_existing.counter_account is distinct from v_counter_account then
   raise exception 'La operación ya existe con otra clasificación o contrapartida.';
  end if;
$retry$||marker);
 marker:=' update public.inventory_balances set quantity=v_after,updated_at=now()';
 if position(marker in definition)=0 then raise exception 'Revisar la actualización del inventario.'; end if;
 definition:=replace(definition,marker,$account$
 if v_adjustment_kind is not null then
  if v_before is null then raise exception 'Registra el conteo inicial sin clasificación contable.'; end if;
  if v_after=v_before then raise exception 'El ajuste debe cambiar las existencias actuales.'; end if;
  if v_adjustment_kind='loss' and v_after>=v_before then
   raise exception 'Una pérdida de inventario debe disminuir las existencias.';
  end if;
  if v_adjustment_kind='correction' then
   if v_counter_account in ('1110-002','1120-002','1120-004','1120-006') then
    raise exception 'El ajuste se valora en córdobas. Elige una contrapartida en córdobas; las cuentas financieras USD requieren un comprobante con su tipo de cambio.';
   end if;
   if not exists(select 1 from public.ledger_accounts where code=v_counter_account
    and active and postable and bucket in ('asset','liability','equity') and code not in ('1130','5150')) then
    raise exception 'Selecciona una cuenta de contrapartida activa de activo, pasivo o capital, distinta de Inventario y Pérdidas de inventario.';
   end if;
  end if;
 end if;
$account$||marker);
 marker:='insert into public.inventory_movements(request_id,product_id,location,type,quantity,before_quantity,after_quantity,actor_id,reference,note)';
 if position(marker in definition)=0 then raise exception 'Revisar el registro del movimiento.'; end if;
 definition:=replace(definition,marker,'insert into public.inventory_movements(request_id,product_id,location,type,quantity,before_quantity,after_quantity,actor_id,reference,note,adjustment_kind,counter_account)');
 marker:='v_uid,nullif(p_payload->>''reference'',''''),p_payload->>''note'') returning id into v_id;';
 if position(marker in definition)=0 then raise exception 'Revisar los datos del movimiento.'; end if;
 definition:=replace(definition,marker,'v_uid,nullif(p_payload->>''reference'',''''),p_payload->>''note'',v_adjustment_kind,v_counter_account) returning id into v_id;');
 marker:=' return v_id;';
 if position(marker in definition)=0 then raise exception 'Revisar la confirmación del movimiento.'; end if;
 definition:=replace(definition,marker,' perform private.post_inventory_adjustment(v_id);'||E'\n'||marker);
 execute definition;
end $movement$;

-- Las dos patas de la corrección ya están en su comprobante. Los costos y
-- ganancias congelados permanecen como respaldo sin duplicar el mayor.
alter view private.operational_postings rename to operational_postings_before_adjustment_accounts;
create view private.operational_postings as
 select p.* from private.operational_postings_before_adjustment_accounts p
 where not (p.source in ('writeoff','count_gain') and exists(
  select 1 from public.inventory_movements m where m.id=p.source_id and m.adjustment_kind='correction'));
revoke all on private.operational_postings,private.operational_postings_before_adjustment_accounts from public,anon,authenticated;

-- Los reportes operativos recorren esta base; el envoltorio de correcciones
-- de recepciones conserva sus costos y pérdidas reales sobre el resultado.
do $reports$
declare definition text; marker text;
begin
 definition:=replace(pg_get_functiondef('private.report_digest_before_receipt_corrections(date,date)'::regprocedure),E'\r\n',E'\n');
 marker:='where c.created_at >= v_from and c.created_at < v_until';
 if position(marker in definition)=0 then raise exception 'Revisar el costo de movimientos en los reportes.'; end if;
 definition:=replace(definition,marker,marker||E'\n        and not exists(select 1 from public.inventory_movements correction where correction.id=c.movement_id and correction.adjustment_kind=''correction'')');
 marker:='and not exists (select 1 from public.inventory_movement_costs c where c.movement_id = m.id)';
 if position(marker in definition)=0 then raise exception 'Revisar los movimientos sin costo en los reportes.'; end if;
 definition:=replace(definition,marker,'and m.adjustment_kind is distinct from ''correction'''||E'\n        '||marker);
 execute definition;
end $reports$;

-- La interfaz reconoce el origen automático tanto en el detalle como en las
-- dos consultas de comprobantes, sin perder etiquetas ni metadatos previos.
create function private.inventory_adjustment_journal_metadata(p_entry uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce((select jsonb_build_object('inventoryCorrection',true,'inventoryMovementId',movement_id)
  from private.inventory_adjustment_journals where entry_id=p_entry),'{}'::jsonb);
$$;
revoke all on function private.inventory_adjustment_journal_metadata(uuid) from public,anon,authenticated;
do $metadata$
declare definition text; marker text;
begin
 definition:=pg_get_functiondef('private.get_journal_entry(uuid)'::regprocedure);
 marker:='return r||jsonb_build_object(''purchaseInventoryDebit''';
 if position(marker in definition)=0 then raise exception 'Revisar el origen del detalle de comprobante.'; end if;
 definition:=replace(definition,marker,'return r||private.inventory_adjustment_journal_metadata(p_id)||jsonb_build_object(''purchaseInventoryDebit''');
 execute definition;
 definition:=pg_get_functiondef('public.journal_entries_page(date,date,integer,integer,timestamptz,integer)'::regprocedure);
 marker:='to_jsonb(e)-''request_payload''-''request_id''-''created_by'' as entry';
 if position(marker in definition)=0 then raise exception 'Revisar el origen de la página de comprobantes.'; end if;
 definition:=replace(definition,marker,'to_jsonb(e)-''request_payload''-''request_id''-''created_by''||private.inventory_adjustment_journal_metadata(e.id) as entry');
 execute definition;
 definition:=pg_get_functiondef('private.ledger_report_before_fixed_purchase(date,date)'::regprocedure);
 marker:='jsonb_agg(to_jsonb(e) order by occurred_on desc,number desc)';
 if position(marker in definition)=0 then raise exception 'Revisar el origen de comprobantes del mayor.'; end if;
 definition:=replace(definition,marker,'jsonb_agg(to_jsonb(e)||private.inventory_adjustment_journal_metadata(e.id) order by occurred_on desc,number desc)');
 execute definition;
end $metadata$;

-- Una corrección con comprobante no se puede volver a convertir en compra:
-- esa regularización solo corresponde al sobrante histórico sin clasificar.
do $adoption$
declare definition text; signature text; marker text;
begin
 foreach signature in array array['private.count_purchase_context(uuid)','private.adopt_inventory_counts_as_purchase(jsonb)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  marker:=case when signature='private.count_purchase_context(uuid)'
   then 'select * into m from public.inventory_movements where id=p_movement;'
   else 'select * into m from public.inventory_movements where id=v_movement for update;' end;
  if position(marker in definition)=0 then raise exception 'Revisar la regularización de conteos como compras.'; end if;
  definition:=replace(definition,marker,marker||E'\n if m.adjustment_kind=''correction'' then raise exception ''Este ajuste ya tiene una contrapartida contable. Las compras se registran desde su recepción de origen.''; end if;');
  execute definition;
 end loop;
end $adoption$;

-- Una edición independiente del comprobante desataría las unidades de su
-- valor. El movimiento original y su comprobante permanecen vinculados.
create function private.protect_inventory_adjustment_journal() returns trigger
language plpgsql security definer set search_path='' as $$
declare entry uuid; prior_entry uuid;
begin
 if tg_table_name='journal_entries' then entry:=old.id;
 else
  entry:=case when tg_op='DELETE' then old.entry_id else new.entry_id end;
  if tg_op='UPDATE' then prior_entry:=old.entry_id; end if;
 end if;
 if exists(select 1 from private.inventory_adjustment_journals where entry_id in (entry,prior_entry)) then
  raise exception 'Este comprobante pertenece a una corrección de inventario y no puede editarse ni anularse por separado. Registra una nueva corrección desde Inventario.';
 end if;
 if tg_op='DELETE' then return old; else return new; end if;
end $$;
revoke all on function private.protect_inventory_adjustment_journal() from public,anon,authenticated;
create trigger inventory_adjustment_journal_guard before update or delete on public.journal_entries
 for each row execute function private.protect_inventory_adjustment_journal();
create trigger inventory_adjustment_journal_guard before insert or update or delete on public.journal_lines
 for each row execute function private.protect_inventory_adjustment_journal();

notify pgrst,'reload schema';

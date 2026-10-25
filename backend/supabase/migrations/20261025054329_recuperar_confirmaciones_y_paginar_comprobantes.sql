-- Sólo se guardan identificadores de solicitudes retiradas, nunca el contenido
-- de un formulario. Un envío que llegue tarde debe fallar y revertirse completo.
create table private.retired_operations (
 actor_id uuid not null references private.business_actors(id),
 kind text not null,
 request_id uuid not null,
 retired_at timestamptz not null default now(),
 primary key(actor_id,kind,request_id)
);
alter table private.retired_operations enable row level security;
revoke all on private.retired_operations from public,anon,authenticated;

create function private.operation_confirmation(p_kind text,p_request_id uuid,p_retire boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_role text:=private.staff_role(); v_uid uuid:=auth.uid();
 v_table text; v_actor text:='created_by'; v_request text:='request_id';
 v_row jsonb; v_extra text:='';
begin
 if v_uid is null or v_role is null then raise insufficient_privilege; end if;
 if p_request_id is null then raise exception 'Falta el identificador de la solicitud.'; end if;
 if p_kind not in ('invoice','proforma','sales-return','purchase','purchase-correction',
  'finance-entry','expense','inventory-movement','inventory-transfer','price-tier-create',
  'price-list-prices','journal','opening-cost','business-import','inventory-valuation',
  'business-day-open','business-day-close','business-day-reopen') then
  raise exception 'Tipo de operación no reconocido. Consulta al administrador.';
 end if;
 if v_role<>'admin' and not
  (v_role='operator' and p_kind in ('invoice','proforma')) and not
  (v_role='warehouse' and p_kind in ('inventory-movement','inventory-transfer')) then
  raise insufficient_privilege;
 end if;
 -- Mismo orden de los escritores: jornada, solicitud y después productos.
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 case p_kind
 when 'invoice','proforma' then v_table:='public.documents'; v_extra:=format(' and t.kind=%L',p_kind);
 when 'sales-return' then v_table:='public.sales_returns';
 when 'purchase' then v_table:='public.purchase_shipments';
 when 'purchase-correction' then v_table:='public.purchase_corrections';
 when 'finance-entry' then v_table:='public.finance_entries';
 when 'expense' then v_table:='public.expense_records';
 when 'inventory-movement' then v_table:='public.inventory_movements';v_actor:='actor_id';
 when 'inventory-transfer' then v_table:='public.inventory_transfers';v_actor:='actor_id';
 when 'price-tier-create','price-list-prices' then
  v_table:='private.price_list_operations';v_actor:='actor_id';
  v_extra:=format(' and t.kind=%L',case when p_kind='price-tier-create' then 'create' else 'prices' end);
 when 'journal' then v_table:='public.journal_entries';
 when 'opening-cost' then v_table:='public.opening_cost_records';
 when 'business-import' then v_table:='private.business_excel_imports';v_actor:='actor_id';
 when 'inventory-valuation' then v_table:='private.inventory_value_reconciliations';
 when 'business-day-open' then v_table:='public.business_days';v_actor:='opened_by';v_request:='opening_request';
 when 'business-day-close','business-day-reopen' then
  v_table:='private.business_day_events';v_actor:='actor_id';
  v_extra:=format(' and t.event=%L',case when p_kind='business-day-close' then 'close' else 'reopen' end);
 end case;
 if to_regclass(v_table) is not null then
  execute format('select to_jsonb(t) from %s t where t.%I=$1 and t.%I=$2%s',v_table,v_actor,v_request,v_extra)
   into v_row using v_uid,p_request_id;
 end if;
 if v_row is not null then
  return jsonb_strip_nulls(jsonb_build_object('status','confirmed',
   'id',coalesce(v_row->'id',v_row->'result',v_row->'day'),'number',v_row->'number'));
 end if;
 -- Una factura anulada conserva su solicitud en el archivo de auditoría.
 if p_kind in ('invoice','proforma') then
  select snapshot into v_row from private.document_deletions
   where snapshot->>'created_by'=v_uid::text and snapshot->>'request_id'=p_request_id::text
    and snapshot->>'kind'=p_kind limit 1;
  if v_row is not null then return jsonb_build_object('status','confirmed',
   'id',v_row->'id','number',v_row->'number','cancelled',true); end if;
 end if;
 if p_retire then
  perform private.limit_catalog_writes();
  insert into private.retired_operations(actor_id,kind,request_id) values(v_uid,p_kind,p_request_id)
   on conflict do nothing;
 end if;
 if exists(select 1 from private.retired_operations where actor_id=v_uid and kind=p_kind and request_id=p_request_id) then
  return jsonb_build_object('status','retired');
 end if;
 return jsonb_build_object('status','missing');
end $$;
revoke all on function private.operation_confirmation(text,uuid,boolean) from public,anon,authenticated;
create function public.get_operation_confirmation(p_kind text,p_request_id uuid)
returns jsonb language sql security definer set search_path='' as $$
 select private.operation_confirmation(p_kind,p_request_id,false);
$$;
create function public.retire_unconfirmed_operation(p_kind text,p_request_id uuid)
returns jsonb language sql security definer set search_path='' as $$
 select private.operation_confirmation(p_kind,p_request_id,true);
$$;
revoke all on function public.get_operation_confirmation(text,uuid),public.retire_unconfirmed_operation(text,uuid) from public,anon;
grant execute on function public.get_operation_confirmation(text,uuid),public.retire_unconfirmed_operation(text,uuid) to authenticated;

create function private.prevent_retired_operation() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_row jsonb:=to_jsonb(new);v_kind text:=tg_argv[0];v_actor uuid;v_request uuid;
begin
 if v_kind='document' then v_kind:=v_row->>'kind'; end if;
 if v_kind='business-day-event' then v_kind:='business-day-'||(v_row->>'event'); end if;
 if v_kind='price-list-operation' then v_kind:=case when v_row->>'kind'='create' then 'price-tier-create' else 'price-list-prices' end; end if;
 v_actor:=(v_row->>tg_argv[1])::uuid;v_request:=(v_row->>tg_argv[2])::uuid;
 if v_request is null then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 if exists(select 1 from private.retired_operations where actor_id=v_actor and kind=v_kind and request_id=v_request) then
  raise exception 'Esta solicitud fue descartada después de verificar que no se guardó. Revisa el historial y registra de nuevo la operación.';
 end if;
 return new;
end $$;
revoke all on function private.prevent_retired_operation() from public,anon,authenticated;
do $$ declare r record;begin
 for r in select * from (values
  ('public.documents','document','created_by','request_id'),
  ('public.purchase_shipments','purchase','created_by','request_id'),
  ('public.finance_entries','finance-entry','created_by','request_id'),
  ('public.expense_records','expense','created_by','request_id'),
  ('public.inventory_movements','inventory-movement','actor_id','request_id'),
  ('public.inventory_transfers','inventory-transfer','actor_id','request_id'),
  ('public.opening_cost_records','opening-cost','created_by','request_id'),
  ('public.journal_entries','journal','created_by','request_id'),
  ('public.business_days','business-day-open','opened_by','opening_request'),
  ('private.business_day_events','business-day-event','actor_id','request_id'),
  ('private.price_list_operations','price-list-operation','actor_id','request_id'),
  ('private.business_excel_imports','business-import','actor_id','request_id'),
  ('public.sales_returns','sales-return','created_by','request_id'),
  ('public.purchase_corrections','purchase-correction','created_by','request_id')
 ) as kinds(table_name,kind,actor_column,request_column) loop
  if to_regclass(r.table_name) is not null then
   execute format('create trigger prevent_retired_operation before insert on %s for each row execute function private.prevent_retired_operation(%L,%L,%L)',r.table_name,r.kind,r.actor_column,r.request_column);
  end if;
 end loop;
end $$;
-- Esta operación antigua tomaba primero el bloqueo del producto. Se alinea el
-- envoltorio, conservando íntegros sus cálculos, permisos e idempotencia.
create or replace function public.set_opening_cost(p_input jsonb) returns uuid
language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 return private.set_opening_cost(p_input);
end $$;

-- La lista usa cabeceras paginadas, sin el límite histórico de 501. Los VE/CV
-- se calculan sólo para las fechas de la página solicitada (dos por día).
create function public.journal_entries_page(p_from date,p_to date,p_offset integer default 0,p_limit integer default 50,
 p_as_of timestamptz default null,p_expected_total integer default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_start date;v_as_of timestamptz:=coalesce(p_as_of,now());v_total integer;v_entries jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 or p_offset<0 or p_offset>1000000
 or p_limit<1 or p_limit>100 or v_as_of>now() then raise exception 'Período o página de comprobantes inválidos.'; end if;
 select occurred_on into v_start from public.journal_entries where kind='opening' and voided_at is null;
 with days as (
  select distinct (created_at at time zone 'America/Managua')::date as day from public.documents
  where kind='invoice' and created_at<=v_as_of and v_start is not null
   and (created_at at time zone 'America/Managua')::date between greatest(p_from,v_start) and p_to
 ), headers as (
  select id::text as id,number,occurred_on as day,kind from public.journal_entries
   where occurred_on between p_from and p_to and created_at<=v_as_of
  union all select kind||':'||day,0,day,kind from days cross join unnest(array['sales','sales_cost']) kind
 ) select count(*) into v_total from headers;
 if p_expected_total is not null and p_expected_total<>v_total then
  raise exception 'El historial cambió mientras lo consultabas. Actualiza los comprobantes para continuar.';
 end if;
 with days as (
  select distinct (created_at at time zone 'America/Managua')::date as day from public.documents
  where kind='invoice' and created_at<=v_as_of and v_start is not null
   and (created_at at time zone 'America/Managua')::date between greatest(p_from,v_start) and p_to
 ), headers as (
  select id::text as id,number,occurred_on as day,kind,to_jsonb(e)-'request_payload'-'request_id'-'created_by' as entry
   from public.journal_entries e where occurred_on between p_from and p_to and created_at<=v_as_of
  union all select kind||':'||day,0,day,kind,null::jsonb from days cross join unnest(array['sales','sales_cost']) kind
 ), page as materialized (
  select * from headers order by day desc,number desc,id limit p_limit offset p_offset
 ), automatic as materialized (
  select value entry from (select distinct day from page where entry is null) d
   cross join lateral jsonb_array_elements(private.sales_journal_entries(d.day,d.day))
 ) select coalesce(jsonb_agg(coalesce(p.entry,a.entry) order by p.day desc,p.number desc,p.id),'[]'::jsonb)
 into v_entries from page p left join automatic a on a.entry->>'id'=p.id;
 return jsonb_build_object('entries',v_entries,'total',v_total,'offset',p_offset,'limit',p_limit,'asOf',v_as_of,'from',p_from,'to',p_to);
end $$;
revoke all on function public.journal_entries_page(date,date,integer,integer,timestamptz,integer) from public,anon;
grant execute on function public.journal_entries_page(date,date,integer,integer,timestamptz,integer) to authenticated;

-- La regularización exige vista previa vigente, datos completos y motivo.
-- Nunca cambia costos históricos ni inventa cantidades para cuadrar el libro.
create table private.inventory_value_reconciliations (
 id uuid primary key default gen_random_uuid(),request_id uuid not null,
 created_by uuid not null references private.business_actors(id),
 occurred_on date not null,request_payload jsonb not null,preview jsonb not null,
 amount_nio numeric(24,2) not null,journal_entry_id uuid references public.journal_entries(id),
 note text not null,created_at timestamptz not null default now(),unique(created_by,request_id)
);
create index inventory_value_reconciliations_journal_idx on private.inventory_value_reconciliations(journal_entry_id);
alter table private.inventory_value_reconciliations enable row level security;
revoke all on private.inventory_value_reconciliations from public,anon,authenticated;
create trigger prevent_retired_operation before insert on private.inventory_value_reconciliations
 for each row execute function private.prevent_retired_operation('inventory-valuation','created_by','request_id');

create function private.inventory_valuation_preview() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_rows jsonb; v_target numeric; v_units bigint; v_uncounted integer; v_costs integer;
 v_book numeric; v_ledger jsonb; v_limit numeric; v_rows_count bigint; v_result jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 v_ledger:=private.ledger_report((now() at time zone 'America/Managua')::date,(now() at time zone 'America/Managua')::date);
 select (r->>'closing')::numeric into v_book from jsonb_array_elements(v_ledger->'accounts') r where r->>'code'='1130';
 with quantities as (
  select p.id,p.sku,p.name,p.active,coalesce(sum(b.quantity),0)::integer quantity,
   count(b.quantity)=2 counted,c.average_cost_nio,
   s.quantity recorded_quantity,s.value_nio
  from public.products p left join public.inventory_balances b on b.product_id=p.id
  left join public.product_costs c on c.product_id=p.id left join private.inventory_value_balances s on s.product_id=p.id
  group by p.id,c.average_cost_nio,s.quantity,s.value_nio
 ), valued as (
  select *,case when not counted or quantity>0 and average_cost_nio is null then null
   when recorded_quantity=quantity then value_nio else round(quantity*coalesce(average_cost_nio,0),2) end target
  from quantities where active or quantity<>0 or coalesce(value_nio,0)<>0
 ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'sku',sku,'name',name,'quantity',quantity,
  'counted',counted,'averageCostNio',average_cost_nio,'valueNio',target,
  'recordedQuantity',recorded_quantity,'recordedValueNio',value_nio) order by sku,id),'[]'),
  coalesce(sum(target),0),coalesce(sum(quantity),0),count(*)filter(where not counted),
  count(*)filter(where quantity>0 and average_cost_nio is null)
 into v_rows,v_target,v_units,v_uncounted,v_costs from valued;
 select (select count(*) from public.document_item_costs)+(select count(*) from public.inventory_movement_costs)
  +(select count(*) from public.purchase_shipment_lines)+(select count(*) from private.inventory_count_gains) into v_rows_count;
 v_limit:=greatest(0.01,round(v_rows_count*0.01+v_units*0.000001,2));
 v_result:=jsonb_build_object('day',(now() at time zone 'America/Managua')::date,
  'bookNio',coalesce(v_book,0),'valueNio',v_target,'differenceNio',coalesce(v_book,0)-v_target,
  'roundingLimitNio',v_limit,'uncounted',v_uncounted,'missingCosts',v_costs,
  'missingOpening',v_ledger->>'startOn' is null,'unknownHistoricalCosts',coalesce((v_ledger->>'missingCosts')::integer,0),
  'products',v_rows);
 return v_result||jsonb_build_object('token',md5(v_result::text),'history',
  (select coalesce(jsonb_agg(x order by x.created_at desc),'[]') from
   (select r.id,r.occurred_on,r.amount_nio,r.note,r.created_at,a.display_name actor_name,j.number journal_number
    from private.inventory_value_reconciliations r left join private.business_actors a on a.id=r.created_by
    left join public.journal_entries j on j.id=r.journal_entry_id order by r.created_at desc,r.id desc limit 20) x));
end $$;
revoke all on function private.inventory_valuation_preview() from public,anon;
grant execute on function private.inventory_valuation_preview() to authenticated;
create function public.inventory_valuation_preview() returns jsonb language sql security invoker set search_path='' as $$select private.inventory_valuation_preview()$$;
revoke all on function public.inventory_valuation_preview() from public,anon;
grant execute on function public.inventory_valuation_preview() to authenticated;

create function private.reconcile_inventory_value(p_input jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_request uuid:=(p_input->>'requestId')::uuid; v_old private.inventory_value_reconciliations%rowtype;
 v_preview jsonb; v_diff numeric; v_journal uuid; v_id uuid; v_product jsonb;
 v_note text:=btrim(coalesce(p_input->>'note','')); v_lines jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_request is null or length(v_note) not between 1 and 500 then raise exception 'Indica el motivo de la revisión de inventario.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||v_request::text,0));
 select * into v_old from private.inventory_value_reconciliations where created_by=auth.uid() and request_id=v_request;
 if found then
  if v_old.request_payload<>p_input then raise exception 'Esta conciliación ya se guardó con otros datos. Consulta su historial.'; end if;
  return v_old.id;
 end if;
 if not exists(select 1 from public.business_days where day=(now() at time zone 'America/Managua')::date and closed_at is null) then
  raise exception 'Abre la jornada desde Inicio antes de conciliar el inventario.';
 end if;
 perform 1 from public.products order by id for update;
 v_preview:=private.inventory_valuation_preview();
 if v_preview->>'token' is distinct from p_input->>'expectedToken' then raise exception 'La valorización cambió. Actualiza los importes y vuelve a revisarlos.'; end if;
 if (v_preview->>'uncounted')::integer>0 or (v_preview->>'missingCosts')::integer>0 then
  raise exception 'Completa los conteos y costos pendientes desde Inventario antes de conciliar.';
 end if;
 if (v_preview->>'missingOpening')::boolean then raise exception 'Registra primero los saldos iniciales en Contabilidad.'; end if;
 if (v_preview->>'unknownHistoricalCosts')::integer>0 then raise exception 'Hay costos históricos pendientes. Revísalos antes de conciliar el inventario.'; end if;
 v_diff:=(v_preview->>'differenceNio')::numeric;
 if abs(v_diff)>(v_preview->>'roundingLimitNio')::numeric then
  raise exception 'La diferencia supera un redondeo. Revisa conteos, costos y saldo 1130; corrige el asiento que corresponda y actualiza esta revisión.';
 end if;
 if v_diff<>0 then
  v_lines:=jsonb_build_array(jsonb_build_object('account','5120','debit',greatest(v_diff,0),'credit',greatest(-v_diff,0)),
   jsonb_build_object('account','1130','debit',greatest(-v_diff,0),'credit',greatest(v_diff,0)));
  v_journal:=private.record_journal_entry(jsonb_build_object('requestId',v_request,'kind','adjustment',
   'occurredOn',v_preview->>'day','description','Regularización de redondeo de inventario: '||left(v_note,230),
   'reference','VAL-'||left(v_request::text,8),'currency','NIO','exchangeRate',1,'lines',v_lines));
 end if;
 insert into private.inventory_value_reconciliations(request_id,created_by,occurred_on,request_payload,preview,amount_nio,journal_entry_id,note)
 values(v_request,auth.uid(),(v_preview->>'day')::date,p_input,v_preview,v_diff,v_journal,v_note) returning id into v_id;
 for v_product in select value from jsonb_array_elements(v_preview->'products') loop
  insert into private.inventory_value_balances(product_id,quantity,value_nio)
   values((v_product->>'id')::uuid,(v_product->>'quantity')::integer,(v_product->>'valueNio')::numeric)
  on conflict(product_id) do update set quantity=excluded.quantity,value_nio=excluded.value_nio,updated_at=now();
 end loop;
 return v_id;
end $$;
revoke all on function private.reconcile_inventory_value(jsonb) from public,anon;
grant execute on function private.reconcile_inventory_value(jsonb) to authenticated;
create function public.reconcile_inventory_value(p_input jsonb) returns uuid language sql security invoker set search_path='' as $$select private.reconcile_inventory_value(p_input)$$;
revoke all on function public.reconcile_inventory_value(jsonb) from public,anon;
grant execute on function public.reconcile_inventory_value(jsonb) to authenticated;

create function private.protect_inventory_reconciliation() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.voided_at is not null and old.voided_at is null and exists(select 1 from private.inventory_value_reconciliations where journal_entry_id=old.id) then
  raise exception 'Esta conciliación conserva el historial. Revisa la valorización actual antes de registrar otra corrección.';
 end if;
 return new;
end $$;
revoke all on function private.protect_inventory_reconciliation() from public,anon,authenticated;
create trigger protect_inventory_reconciliation before update on public.journal_entries
 for each row execute function private.protect_inventory_reconciliation();
notify pgrst,'reload schema';

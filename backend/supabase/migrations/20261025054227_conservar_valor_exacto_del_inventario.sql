-- El promedio unitario se muestra a seis decimales. El valor pendiente y cada
-- costo reconocido se conservan en centavos: la última unidad consume el saldo.
create table private.inventory_value_balances (
 product_id uuid primary key references public.products(id),
 quantity integer not null check(quantity>=0),
 value_nio numeric(24,2) not null check(value_nio>=0),
 updated_at timestamptz not null default now(),
 check(quantity<>0 or value_nio=0)
);
alter table private.inventory_value_balances enable row level security;
revoke all on private.inventory_value_balances from public,anon,authenticated;
alter table public.document_item_costs add column total_cost_nio numeric(24,2) check(total_cost_nio>=0);
alter table public.inventory_movement_costs add column total_cost_nio numeric(24,2) check(total_cost_nio>=0);

create function private.prepare_inventory_value(p_product uuid,p_before_quantity integer,p_before_average numeric)
returns void language plpgsql security definer set search_path='' as $$
declare v_state private.inventory_value_balances%rowtype;
begin
 if p_product is null or p_before_quantity is null or p_before_quantity<0
  or (p_before_quantity>0 and (p_before_average is null or p_before_average<0)) then
  raise exception 'Falta el conteo o el costo del perfume. Revisa Inventario antes de continuar.';
 end if;
 perform 1 from public.products where id=p_product for update;
 select * into v_state from private.inventory_value_balances where product_id=p_product for update;
 if not found then
  insert into private.inventory_value_balances(product_id,quantity,value_nio)
   values(p_product,p_before_quantity,round(p_before_quantity*coalesce(p_before_average,0),2));
 elsif v_state.quantity<>p_before_quantity then
  raise exception 'El conteo cambió fuera del registro de valor. Solicita a Administración revisar la valorización del inventario antes de continuar.';
 end if;
end $$;
create function private.consume_inventory_value(p_product uuid,p_quantity integer,p_before_quantity integer,p_before_average numeric)
returns numeric language plpgsql security definer set search_path='' as $$
declare v_state private.inventory_value_balances%rowtype; v_total numeric;
begin
 if p_quantity is null or p_quantity<=0 or p_quantity>p_before_quantity then raise exception 'Cantidad de salida inválida para las existencias.'; end if;
 perform private.prepare_inventory_value(p_product,p_before_quantity,p_before_average);
 select * into v_state from private.inventory_value_balances where product_id=p_product for update;
 v_total:=case when p_quantity=v_state.quantity then v_state.value_nio
  else round(v_state.value_nio*p_quantity/v_state.quantity,2) end;
 update private.inventory_value_balances set quantity=quantity-p_quantity,value_nio=value_nio-v_total,updated_at=now() where product_id=p_product;
 return v_total;
end $$;
create function private.receive_inventory_value(p_product uuid,p_quantity integer,p_value_nio numeric,p_before_quantity integer,p_before_average numeric)
returns void language plpgsql security definer set search_path='' as $$
declare v_state private.inventory_value_balances%rowtype;
begin
 if p_quantity is null or p_quantity<=0 or p_value_nio is null or p_value_nio<0 or p_value_nio<>round(p_value_nio,2) then
  raise exception 'La recepción necesita unidades y un costo total válido en córdobas.';
 end if;
 perform private.prepare_inventory_value(p_product,p_before_quantity,p_before_average);
 update private.inventory_value_balances set quantity=quantity+p_quantity,value_nio=value_nio+p_value_nio,updated_at=now()
  where product_id=p_product returning * into v_state;
 insert into public.product_costs(product_id,average_cost_nio)
 values(p_product,round(v_state.value_nio/v_state.quantity,6))
 on conflict(product_id) do update set average_cost_nio=excluded.average_cost_nio,updated_at=now();
end $$;
revoke all on function private.prepare_inventory_value(uuid,integer,numeric),
 private.consume_inventory_value(uuid,integer,integer,numeric),
 private.receive_inventory_value(uuid,integer,numeric,integer,numeric) from public,anon,authenticated;

create function private.freeze_total_inventory_cost() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_quantity integer;
begin
 if auth.uid() is null or private.staff_role() is null then raise insufficient_privilege; end if;
 if new.unit_cost_nio is null then new.total_cost_nio:=null; return new; end if;
 select coalesce(sum(quantity),0) into v_quantity from public.inventory_balances where product_id=new.product_id;
 -- La factura congela su costo antes de retirar unidades; el movimiento lo
 -- congela después de actualizarlas, por lo que recupera su cantidad anterior.
 if tg_table_name='inventory_movement_costs' then v_quantity:=v_quantity+new.quantity; end if;
 new.total_cost_nio:=private.consume_inventory_value(new.product_id,new.quantity,v_quantity,new.unit_cost_nio);
 return new;
end $$;
revoke all on function private.freeze_total_inventory_cost() from public,anon,authenticated;
create trigger freeze_total_inventory_cost before insert on public.document_item_costs
 for each row execute function private.freeze_total_inventory_cost();
create trigger freeze_total_inventory_cost before insert on public.inventory_movement_costs
 for each row execute function private.freeze_total_inventory_cost();

create function private.receive_count_gain_value() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_before integer;
begin
 select coalesce(sum(quantity),0)-new.quantity into v_before from public.inventory_balances where product_id=new.product_id;
 perform private.receive_inventory_value(new.product_id,new.quantity,round(new.quantity*new.unit_cost_nio,2),v_before,new.unit_cost_nio);
 return new;
end $$;
revoke all on function private.receive_count_gain_value() from public,anon,authenticated;
create trigger receive_count_gain_value after insert on private.inventory_count_gains
 for each row execute function private.receive_count_gain_value();

-- Un primer conteo de otra ubicación, después de comenzar a mover el perfume,
-- es un sobrante encontrado: ya no puede aumentar silenciosamente su valor.
do $migration$
declare v_definition text;
begin
 v_definition:=pg_get_functiondef('private.account_inventory_movement()'::regprocedure);
 v_definition:=replace(v_definition,
  'new.before_quantity is not null and new.after_quantity>new.before_quantity',
  '(new.before_quantity is not null or exists(select 1 from private.inventory_value_balances where product_id=new.product_id)) and new.after_quantity>coalesce(new.before_quantity,0)');
 v_definition:=replace(v_definition,'new.after_quantity-new.before_quantity,v_average,new.created_at',
  'new.after_quantity-coalesce(new.before_quantity,0),v_average,new.created_at');
 execute v_definition;
end $migration$;

alter view private.operational_postings rename to operational_postings_core;
create view private.operational_postings as
 select * from private.operational_postings_core where source not in ('cost','writeoff')
 union all
 select (d.created_at at time zone 'America/Managua')::date,'cost',d.id,'5120',
  case when c.unit_cost_nio is null then null else coalesce(c.total_cost_nio,round(c.quantity*c.unit_cost_nio,2)) end,0::numeric
 from public.document_item_costs c join public.documents d on d.id=c.document_id
 union all
 select (d.created_at at time zone 'America/Managua')::date,'cost',d.id,'1130',0::numeric,
  case when c.unit_cost_nio is null then null else coalesce(c.total_cost_nio,round(c.quantity*c.unit_cost_nio,2)) end
 from public.document_item_costs c join public.documents d on d.id=c.document_id
 union all
 select (m.created_at at time zone 'America/Managua')::date,'writeoff',m.movement_id,'5150',
  case when m.unit_cost_nio is null then null else coalesce(m.total_cost_nio,round(m.quantity*m.unit_cost_nio,2)) end,0::numeric
 from public.inventory_movement_costs m
 union all
 select (m.created_at at time zone 'America/Managua')::date,'writeoff',m.movement_id,'1130',0::numeric,
  case when m.unit_cost_nio is null then null else coalesce(m.total_cost_nio,round(m.quantity*m.unit_cost_nio,2)) end
 from public.inventory_movement_costs m;
revoke all on private.operational_postings,private.operational_postings_core from public,anon,authenticated;

-- Conservar la anulación completa antigua y devolver exactamente el importe
-- reconocido, sin reconstruirlo a partir del promedio unitario redondeado.
alter function public.delete_invoice(uuid,text) set schema private;
alter function private.delete_invoice(uuid,text) rename to delete_invoice_before_exact_value;
revoke all on function private.delete_invoice_before_exact_value(uuid,text) from public,anon,authenticated;
create function public.delete_invoice(p_id uuid,p_reason text default '') returns text
language plpgsql security definer set search_path='' as $$
declare v_row record; v_rows jsonb; v_number text;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform 1 from public.products where id in(select product_id from public.document_items where document_id=p_id) order by id for update;
 select coalesce(jsonb_agg(jsonb_build_object('product',i.product_id,'quantity',i.quantity,
  'value',coalesce(c.total_cost_nio,round(c.quantity*c.unit_cost_nio,2)),
  'beforeQuantity',(select coalesce(sum(quantity),0) from public.inventory_balances where product_id=i.product_id),
  'beforeAverage',(select average_cost_nio from public.product_costs where product_id=i.product_id))),'[]')
 into v_rows from public.document_items i left join public.document_item_costs c on c.document_item_id=i.id where i.document_id=p_id;
 v_number:=private.delete_invoice_before_exact_value(p_id,p_reason);
 for v_row in select * from jsonb_to_recordset(v_rows) as r(product uuid,quantity integer,value numeric,"beforeQuantity" integer,"beforeAverage" numeric) loop
  if v_row.value is not null then
   perform private.receive_inventory_value(v_row.product,v_row.quantity,v_row.value,v_row."beforeQuantity",v_row."beforeAverage");
  end if;
 end loop;
 return v_number;
end $$;
revoke all on function public.delete_invoice(uuid,text) from public,anon;
grant execute on function public.delete_invoice(uuid,text) to authenticated;

-- Los reportes utilizan el mismo total congelado que el libro mayor.
do $migration$
declare v_definition text;
begin
 v_definition:=pg_get_functiondef('public.report_digest(date,date)'::regprocedure);
 v_definition:=replace(v_definition,'s.unit_cost_nio, s.net_revenue_nio','s.unit_cost_nio, s.total_cost_nio, s.net_revenue_nio');
 v_definition:=replace(v_definition,'round(l.unit_cost_nio * l.quantity, 2)',
  'coalesce(l.total_cost_nio,round(l.unit_cost_nio * l.quantity, 2))');
 v_definition:=replace(v_definition,'round(c.quantity * c.unit_cost_nio, 2)',
  'coalesce(c.total_cost_nio,round(c.quantity * c.unit_cost_nio, 2))');
 execute v_definition;
 v_definition:=pg_get_functiondef('public.remove_catalog_product(uuid,integer)'::regprocedure);
 v_definition:=replace(v_definition,'or exists(select 1 from private.import_rows where product_id=p_id) then',
  'or exists(select 1 from private.inventory_value_balances where product_id=p_id) or exists(select 1 from private.import_rows where product_id=p_id) then');
 execute v_definition;
end $migration$;
-- El KPI y la rotación usan el mismo saldo que el control de valor; no vuelven
-- a multiplicar un promedio redondeado por las existencias.
create function private.inventory_value_rows(p_start integer default 0,p_limit integer default 500) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_start is null or p_start<0 or p_limit is null or p_limit not between 1 and 500 then raise exception 'Página de valorización inválida.'; end if;
 with quantities as (
  select p.id product_id,c.average_cost_nio,coalesce(c.updated_at,p.created_at) updated_at,
   coalesce(sum(b.quantity),0)::integer quantity,count(b.quantity)=2 counted,s.quantity recorded_quantity,s.value_nio
  from public.products p left join public.product_costs c on c.product_id=p.id
  left join public.inventory_balances b on b.product_id=p.id
  left join private.inventory_value_balances s on s.product_id=p.id
  group by p.id,c.average_cost_nio,c.updated_at,s.quantity,s.value_nio
 ), valued as (
  select product_id,average_cost_nio,updated_at,quantity,
   case when not counted or recorded_quantity is not null and recorded_quantity<>quantity then null
    when recorded_quantity=quantity then value_nio when quantity=0 then 0
    when average_cost_nio is null then null else round(quantity*average_cost_nio,2) end inventory_value_nio
  from quantities
 ), page as (select * from valued order by product_id offset p_start limit p_limit)
 select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(p) order by product_id) from page p),'[]'),
  'count',(select count(*) from valued)) into v_result;
 return v_result;
end $$;
create function public.inventory_value_rows(p_start integer default 0,p_limit integer default 500) returns jsonb
language sql security invoker set search_path='' as $$select private.inventory_value_rows(p_start,p_limit)$$;
revoke all on function private.inventory_value_rows(integer,integer),public.inventory_value_rows(integer,integer) from public,anon;
grant execute on function private.inventory_value_rows(integer,integer),public.inventory_value_rows(integer,integer) to authenticated;
notify pgrst,'reload schema';

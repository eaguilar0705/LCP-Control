-- Purchase costs are independent of the selling-price catalogue. All accounting
-- amounts and immutable cost snapshots are visible only to business owners.
create table public.product_costs (
 product_id uuid primary key references public.products(id),
 average_cost_nio numeric(24,6) check(average_cost_nio>=0),
 updated_at timestamptz not null default now()
);
insert into public.product_costs(product_id) select id from public.products;

create table public.purchase_records (
 id uuid primary key default gen_random_uuid(), request_id uuid not null,
 request_payload jsonb not null, product_id uuid not null references public.products(id),
 location text not null check(location in ('store','warehouse')),
 quantity integer not null check(quantity between 1 and 1000000),
 unit_price numeric(14,2) not null check(unit_price>=0),
 freight_amount numeric(14,2) not null check(freight_amount>=0),
 tax_amount numeric(14,2) not null check(tax_amount>=0),
 recoverable_tax_amount numeric(14,2) not null check(recoverable_tax_amount between 0 and tax_amount),
 currency text not null check(currency in ('NIO','USD')),
 exchange_rate numeric(14,6) not null check(exchange_rate>0 and (currency<>'NIO' or exchange_rate=1)),
 landed_unit_cost_nio numeric(24,6) not null check(landed_unit_cost_nio>=0),
 incurred_on date not null, supplier text not null default '' check(length(supplier)<=160),
 reference text not null default '' check(length(reference)<=200), note text not null default '' check(length(note)<=2000),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 unique(created_by,request_id)
);
create index purchase_records_date_idx on public.purchase_records(incurred_on,id);
create index purchase_records_product_idx on public.purchase_records(product_id);

create table public.opening_cost_records (
 id uuid primary key default gen_random_uuid(), request_id uuid not null, request_payload jsonb not null,
 product_id uuid not null references public.products(id), quantity integer not null check(quantity>0),
 unit_cost numeric(18,6) not null check(unit_cost>=0), currency text not null check(currency in ('NIO','USD')),
 exchange_rate numeric(14,6) not null check(exchange_rate>0 and (currency<>'NIO' or exchange_rate=1)),
 unit_cost_nio numeric(24,6) not null check(unit_cost_nio>=0),
 note text not null check(length(trim(note)) between 1 and 2000),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 unique(created_by,request_id)
);
create index opening_cost_records_product_idx on public.opening_cost_records(product_id);

create table public.expense_records (
 id uuid primary key default gen_random_uuid(), request_id uuid not null, request_payload jsonb not null,
 incurred_on date not null,
 category text not null check(category in ('alquiler','servicios','transporte','publicidad','salarios','impuestos','otros')),
 description text not null check(length(trim(description)) between 1 and 300),
 amount numeric(14,2) not null check(amount>=0), tax_amount numeric(14,2) not null check(tax_amount>=0),
 recoverable_tax_amount numeric(14,2) not null check(recoverable_tax_amount between 0 and tax_amount),
 currency text not null check(currency in ('NIO','USD')),
 exchange_rate numeric(14,6) not null check(exchange_rate>0 and (currency<>'NIO' or exchange_rate=1)),
 reference text not null default '' check(length(reference)<=200),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 voided_at timestamptz, voided_by uuid references auth.users(id), void_reason text,
 unique(created_by,request_id), check(amount+tax_amount>0),
 check((voided_at is null and voided_by is null and void_reason is null) or
 (voided_at is not null and voided_by is not null and length(trim(void_reason)) between 1 and 500))
);
create index expense_records_date_idx on public.expense_records(incurred_on,id);
create index expense_records_voided_by_idx on public.expense_records(voided_by);

create table public.document_item_costs (
 document_item_id uuid primary key references public.document_items(id),
 document_id uuid not null references public.documents(id), product_id uuid not null references public.products(id),
 quantity integer not null check(quantity>0), unit_cost_nio numeric(24,6) check(unit_cost_nio>=0),
 exchange_rate numeric(14,6) not null check(exchange_rate>0), tax_rate numeric(9,6) not null check(tax_rate between 0 and 100),
 net_revenue_nio numeric(24,2) not null check(net_revenue_nio>=0), tax_nio numeric(24,2) not null check(tax_nio>=0)
);
create index document_item_costs_document_idx on public.document_item_costs(document_id);
create index document_item_costs_product_idx on public.document_item_costs(product_id);

create table public.inventory_movement_costs (
 movement_id uuid primary key references public.inventory_movements(id),
 product_id uuid not null references public.products(id), type text not null check(type in ('EXIT','DAMAGED','ADJUSTMENT')),
 quantity integer not null check(quantity>0), unit_cost_nio numeric(24,6) check(unit_cost_nio>=0),
 created_at timestamptz not null default now()
);
create index inventory_movement_costs_product_idx on public.inventory_movement_costs(product_id);
create index inventory_movement_costs_date_idx on public.inventory_movement_costs(created_at,movement_id);

do $$ declare t text; begin
 foreach t in array array['product_costs','purchase_records','opening_cost_records','expense_records','document_item_costs','inventory_movement_costs'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy owner_accounting_read on public.%I for select to authenticated using ((select private.staff_role())=''admin'')',t);
 end loop;
end $$;

-- Bounded JSON numbers reject missing values, strings, NaN, infinities and silent
-- numeric rounding. Native monetary input uses cents; cost bases use six decimals.
create function private.accounting_number(p_input jsonb,p_key text,p_max numeric,p_scale integer default 2)
returns numeric language plpgsql immutable security invoker set search_path='' as $$
declare v numeric;
begin
 if jsonb_typeof(p_input->p_key) is distinct from 'number' then raise exception 'Valor numérico requerido: %.',p_key; end if;
 v:=(p_input->>p_key)::numeric;
 if v<0 or v>p_max or v<>round(v,p_scale) then raise exception 'Valor numérico inválido: %.',p_key; end if;
 return v;
end $$;
create function private.accounting_rate(p_input jsonb) returns numeric language plpgsql immutable security invoker set search_path='' as $$
declare v numeric; c text:=p_input->>'currency';
begin
 if c is null or c not in ('NIO','USD') then raise exception 'Moneda inválida.'; end if;
 v:=private.accounting_number(p_input,'exchangeRate',1000000,6);
 if v<=0 or (c='NIO' and v<>1) then raise exception 'Indica un tipo de cambio válido; para córdobas debe ser 1.'; end if;
 return v;
end $$;
revoke all on function private.accounting_number(jsonb,text,numeric,integer),private.accounting_rate(jsonb) from public,anon,authenticated;

-- All stock RPCs lock the product before the balances. The trigger participates
-- in their transaction and does not trust caller-controlled configuration flags.
create function private.account_inventory_movement() returns trigger language plpgsql security definer set search_path='' as $$
declare v_average numeric;
begin
 if auth.uid() is null or private.staff_role() is null then raise insufficient_privilege; end if;
 select average_cost_nio into v_average from public.product_costs where product_id=new.product_id;
 if new.type in ('EXIT','DAMAGED','ADJUSTMENT') and new.before_quantity>new.after_quantity then
  insert into public.inventory_movement_costs(movement_id,product_id,type,quantity,unit_cost_nio,created_at)
  values(new.id,new.product_id,new.type,new.before_quantity-new.after_quantity,v_average,new.created_at);
 end if;
 if new.after_quantity>coalesce(new.before_quantity,0) then
  insert into public.product_costs(product_id,average_cost_nio) values(new.product_id,null)
  on conflict(product_id) do update set average_cost_nio=null,updated_at=now();
 end if;
 return new;
end $$;
revoke all on function private.account_inventory_movement() from public,anon,authenticated;
create trigger account_inventory_movement after insert on public.inventory_movements for each row execute function private.account_inventory_movement();

-- Freeze unit cost and tax-inclusive revenue at issue time. No backfill invents
-- costs, exchange rates or tax treatment for historical invoices.
create function private.snapshot_sale_cost() returns trigger language plpgsql security definer set search_path='' as $$
declare d public.documents%rowtype; v_rate numeric; v_tax numeric; v_average numeric; v_gross numeric; v_net numeric;
begin
 if auth.uid() is null or private.staff_role() is null then raise insufficient_privilege; end if;
 select * into d from public.documents where id=new.document_id;
 if d.kind<>'invoice' then return new; end if;
 if d.currency='NIO' and not (d.request_payload ? 'exchangeRate') then v_rate:=1;
 else v_rate:=private.accounting_rate(d.request_payload); end if;
 if d.request_payload ? 'taxRate' then v_tax:=private.accounting_number(d.request_payload,'taxRate',100,6); else v_tax:=0; end if;
 select average_cost_nio into v_average from public.product_costs where product_id=new.product_id;
 v_gross:=round(new.quantity*new.unit_price*v_rate,2);
 v_net:=round(v_gross/(1+v_tax/100),2);
 insert into public.document_item_costs(document_item_id,document_id,product_id,quantity,unit_cost_nio,exchange_rate,tax_rate,net_revenue_nio,tax_nio)
 values(new.id,new.document_id,new.product_id,new.quantity,v_average,v_rate,v_tax,v_net,v_gross-v_net);
 return new;
end $$;
revoke all on function private.snapshot_sale_cost() from public,anon,authenticated;
create trigger snapshot_sale_cost after insert on public.document_items for each row execute function private.snapshot_sale_cost();

create function private.record_purchase(p_input jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare
 v_uid uuid:=auth.uid(); v_request uuid; v_product uuid; v_existing public.purchase_records%rowtype;
 v_quantity integer; v_unit numeric; v_freight numeric; v_tax numeric; v_recoverable numeric; v_rate numeric;
 v_total integer; v_before integer; v_average numeric; v_landed numeric; v_id uuid; v_date date;
begin
 if v_uid is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 v_request:=(p_input->>'requestId')::uuid; v_product:=(p_input->>'productId')::uuid;
 if v_request is null then raise exception 'Falta el identificador de operación.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('purchase:'||v_uid::text||v_request::text,0));
 select * into v_existing from public.purchase_records where created_by=v_uid and request_id=v_request;
 if found then
  if v_existing.request_payload<>p_input then raise exception 'La operación ya existe con otros datos.'; end if;
  return v_existing.id;
 end if;
 v_quantity:=private.accounting_number(p_input,'quantity',1000000,0);
 v_unit:=private.accounting_number(p_input,'unitPrice',1000000000);
 v_freight:=private.accounting_number(p_input,'freightAmount',1000000000);
 v_tax:=private.accounting_number(p_input,'taxAmount',1000000000);
 v_recoverable:=private.accounting_number(p_input,'recoverableTaxAmount',1000000000);
 v_rate:=private.accounting_rate(p_input);
 if v_quantity<=0 or v_recoverable>v_tax or v_quantity*v_unit+v_freight+v_tax<=0 then raise exception 'Revisa la cantidad, el costo y los impuestos de la compra.'; end if;
 if coalesce(p_input->>'location','') not in ('store','warehouse') then raise exception 'Ubicación inválida.'; end if;
 v_date:=(p_input->>'incurredOn')::date;
 if v_date is null or v_date>(now() at time zone 'America/Managua')::date then raise exception 'Fecha de compra inválida.'; end if;
 perform private.limit_catalog_writes();
 perform 1 from public.products where id=v_product and active for update;
 if not found then raise exception 'Producto no encontrado o inactivo.'; end if;
 perform 1 from public.inventory_balances where product_id=v_product order by location for update;
 if (select count(*) from public.inventory_balances where product_id=v_product and quantity is not null)<>2 then raise exception 'Registra primero el conteo de tienda y bodega.'; end if;
 select sum(quantity) into v_total from public.inventory_balances where product_id=v_product;
 select quantity into v_before from public.inventory_balances where product_id=v_product and location=p_input->>'location';
 select average_cost_nio into v_average from public.product_costs where product_id=v_product;
 v_landed:=round((v_quantity*v_unit+v_freight+v_tax-v_recoverable)*v_rate/v_quantity,6);
 insert into public.purchase_records(request_id,request_payload,product_id,location,quantity,unit_price,freight_amount,tax_amount,recoverable_tax_amount,currency,exchange_rate,landed_unit_cost_nio,incurred_on,supplier,reference,note,created_by)
 values(v_request,p_input,v_product,p_input->>'location',v_quantity,v_unit,v_freight,v_tax,v_recoverable,p_input->>'currency',v_rate,v_landed,v_date,coalesce(p_input->>'supplier',''),coalesce(p_input->>'reference',''),coalesce(p_input->>'note',''),v_uid)
 returning id into v_id;
 update public.inventory_balances set quantity=quantity+v_quantity,updated_at=now() where product_id=v_product and location=p_input->>'location';
 insert into public.inventory_movements(product_id,location,type,quantity,before_quantity,after_quantity,actor_id,reference,note)
 values(v_product,p_input->>'location','ENTRY',v_quantity,v_before,v_before+v_quantity,v_uid,nullif(p_input->>'reference',''),'Compra registrada');
 -- The generic movement invalidates an uncosted entry. Only this authorized RPC
 -- can replace that invalidation using the locked, pre-purchase cost basis.
 insert into public.product_costs(product_id,average_cost_nio)
 values(v_product,case when v_total=0 then v_landed when v_average is not null then round((v_average*v_total+(v_quantity*v_unit+v_freight+v_tax-v_recoverable)*v_rate)/(v_total+v_quantity),6) end)
 on conflict(product_id) do update set average_cost_nio=excluded.average_cost_nio,updated_at=now();
 return v_id;
end $$;

create function private.set_opening_cost(p_input jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_request uuid; v_product uuid; v_existing public.opening_cost_records%rowtype;
 v_unit numeric; v_rate numeric; v_total integer; v_id uuid; v_average numeric;
begin
 if v_uid is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 v_request:=(p_input->>'requestId')::uuid; v_product:=(p_input->>'productId')::uuid;
 if v_request is null then raise exception 'Falta el identificador de operación.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('opening:'||v_uid::text||v_request::text,0));
 select * into v_existing from public.opening_cost_records where created_by=v_uid and request_id=v_request;
 if found then
  if v_existing.request_payload<>p_input then raise exception 'La operación ya existe con otros datos.'; end if;
  return v_existing.id;
 end if;
 v_unit:=private.accounting_number(p_input,'unitCost',1000000000,6); v_rate:=private.accounting_rate(p_input);
 if length(trim(coalesce(p_input->>'note',''))) not between 1 and 2000 then raise exception 'Indica el respaldo del costo inicial.'; end if;
 perform private.limit_catalog_writes();
 perform 1 from public.products where id=v_product and active for update;
 if not found then raise exception 'Producto no encontrado o inactivo.'; end if;
 perform 1 from public.inventory_balances where product_id=v_product order by location for update;
 if (select count(*) from public.inventory_balances where product_id=v_product and quantity is not null)<>2 then raise exception 'Registra primero el conteo de tienda y bodega.'; end if;
 select sum(quantity) into v_total from public.inventory_balances where product_id=v_product;
 if v_total<=0 then raise exception 'El costo inicial requiere existencias contadas.'; end if;
 select average_cost_nio into v_average from public.product_costs where product_id=v_product;
 if v_average is not null then raise exception 'Este producto ya tiene costo promedio. Registra las compras para actualizarlo.'; end if;
 insert into public.opening_cost_records(request_id,request_payload,product_id,quantity,unit_cost,currency,exchange_rate,unit_cost_nio,note,created_by)
 values(v_request,p_input,v_product,v_total,v_unit,p_input->>'currency',v_rate,round(v_unit*v_rate,6),trim(p_input->>'note'),v_uid) returning id into v_id;
 insert into public.product_costs(product_id,average_cost_nio) values(v_product,round(v_unit*v_rate,6))
 on conflict(product_id) do update set average_cost_nio=excluded.average_cost_nio,updated_at=now();
 return v_id;
end $$;

create function private.record_expense(p_input jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_request uuid; v_existing public.expense_records%rowtype;
 v_amount numeric; v_tax numeric; v_recoverable numeric; v_rate numeric; v_date date; v_id uuid;
begin
 if v_uid is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 v_request:=(p_input->>'requestId')::uuid;
 if v_request is null then raise exception 'Falta el identificador de operación.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('expense:'||v_uid::text||v_request::text,0));
 select * into v_existing from public.expense_records where created_by=v_uid and request_id=v_request;
 if found then
  if v_existing.request_payload<>p_input then raise exception 'La operación ya existe con otros datos.'; end if;
  return v_existing.id;
 end if;
 v_amount:=private.accounting_number(p_input,'amount',1000000000);
 v_tax:=private.accounting_number(p_input,'taxAmount',1000000000);
 v_recoverable:=private.accounting_number(p_input,'recoverableTaxAmount',1000000000);
 v_rate:=private.accounting_rate(p_input);
 if v_recoverable>v_tax or v_amount+v_tax<=0 then raise exception 'Revisa el monto y los impuestos del gasto.'; end if;
 v_date:=(p_input->>'incurredOn')::date;
 if v_date is null or v_date>(now() at time zone 'America/Managua')::date then raise exception 'Fecha de gasto inválida.'; end if;
 perform private.limit_catalog_writes();
 insert into public.expense_records(request_id,request_payload,incurred_on,category,description,amount,tax_amount,recoverable_tax_amount,currency,exchange_rate,reference,created_by)
 values(v_request,p_input,v_date,p_input->>'category',trim(p_input->>'description'),v_amount,v_tax,v_recoverable,p_input->>'currency',v_rate,coalesce(p_input->>'reference',''),v_uid) returning id into v_id;
 return v_id;
end $$;

create function private.void_expense(p_id uuid,p_reason text) returns uuid language plpgsql security definer set search_path='' as $$
declare v_expense public.expense_records%rowtype;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if length(trim(coalesce(p_reason,''))) not between 1 and 500 then raise exception 'Indica el motivo de la anulación.'; end if;
 select * into v_expense from public.expense_records where id=p_id for update;
 if not found then raise exception 'Gasto no encontrado.'; end if;
 if v_expense.voided_at is not null then
  if v_expense.void_reason<>trim(p_reason) then raise exception 'El gasto ya fue anulado con otro motivo.'; end if;
  return p_id;
 end if;
 perform private.limit_catalog_writes();
 update public.expense_records set voided_at=now(),voided_by=auth.uid(),void_reason=trim(p_reason) where id=p_id;
 return p_id;
end $$;

create function public.record_purchase(p_input jsonb) returns uuid language sql security invoker set search_path='' as $$select private.record_purchase(p_input)$$;
create function public.set_opening_cost(p_input jsonb) returns uuid language sql security invoker set search_path='' as $$select private.set_opening_cost(p_input)$$;
create function public.record_expense(p_input jsonb) returns uuid language sql security invoker set search_path='' as $$select private.record_expense(p_input)$$;
create function public.void_expense(p_id uuid,p_reason text) returns uuid language sql security invoker set search_path='' as $$select private.void_expense(p_id,p_reason)$$;
revoke all on function private.record_purchase(jsonb),private.set_opening_cost(jsonb),private.record_expense(jsonb),private.void_expense(uuid,text),public.record_purchase(jsonb),public.set_opening_cost(jsonb),public.record_expense(jsonb),public.void_expense(uuid,text) from public,anon,authenticated;
grant execute on function private.record_purchase(jsonb),private.set_opening_cost(jsonb),private.record_expense(jsonb),private.void_expense(uuid,text),public.record_purchase(jsonb),public.set_opening_cost(jsonb),public.record_expense(jsonb),public.void_expense(uuid,text) to authenticated;

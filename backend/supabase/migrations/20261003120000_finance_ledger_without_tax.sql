-- Contabilidad sin IVA y con caja, bancos y deudas.
--
-- 1. Las ventas nuevas ya no separan impuesto: toda la factura es venta neta.
--    Las filas anteriores se conservan tal como se guardaron.
-- 2. Cada gasto y cada pedido dice de dónde salió el dinero (caja o banco; un
--    pedido también puede quedar a crédito con el proveedor).
-- 3. `finance_entries` guarda lo que registra el contador y no es venta, compra
--    ni gasto: saldos iniciales, aportes y retiros del dueño, transferencias,
--    préstamos recibidos, pagos a proveedores y cobros a clientes.
-- 4. `finance_sales` suma lo facturado desde una fecha según la forma de pago,
--    para saber cuánto entró a caja, a bancos y cuánto quedó por cobrar.

-- 1. Ventas sin IVA. La tasa que llegue se sigue validando para no aceptar
-- basura, pero ya no se separa: la venta neta es el total de la línea.
create or replace function private.snapshot_sale_cost() returns trigger language plpgsql security definer set search_path='' as $$
declare d public.documents%rowtype; v_rate numeric; v_average numeric; v_gross numeric;
begin
 if auth.uid() is null or private.staff_role() is null then raise insufficient_privilege; end if;
 select * into d from public.documents where id=new.document_id;
 if d.kind<>'invoice' then return new; end if;
 if d.currency='NIO' and not (d.request_payload ? 'exchangeRate') then v_rate:=1;
 else v_rate:=private.accounting_rate(d.request_payload); end if;
 if d.request_payload ? 'taxRate' then perform private.accounting_number(d.request_payload,'taxRate',100,6); end if;
 select average_cost_nio into v_average from public.product_costs where product_id=new.product_id;
 v_gross:=round(new.quantity*new.unit_price*v_rate,2);
 insert into public.document_item_costs(document_item_id,document_id,product_id,quantity,unit_cost_nio,exchange_rate,tax_rate,net_revenue_nio,tax_nio)
 values(new.id,new.document_id,new.product_id,new.quantity,v_average,v_rate,0,v_gross,0);
 return new;
end $$;
revoke all on function private.snapshot_sale_cost() from public,anon,authenticated;

-- 2. De dónde salió el dinero. Las filas anteriores quedan en caja; sólo cuentan
-- para los saldos a partir del saldo inicial que registre el contador.
alter table public.expense_records add column account text not null default 'caja'
 check(account in ('caja','banco'));
alter table public.purchase_shipments add column account text not null default 'caja'
 check(account in ('caja','banco','credito'));

-- Las funciones que registran gastos y pedidos guardan la solicitud completa;
-- la cuenta se toma de ahí para no reescribirlas. Un valor inválido lo rechaza
-- la restricción de la columna.
create function private.payment_account_from_request() returns trigger language plpgsql security definer set search_path='' as $$
begin
 new.account:=coalesce(nullif(new.request_payload->>'account',''),'caja');
 return new;
end $$;
revoke all on function private.payment_account_from_request() from public,anon,authenticated;
create trigger expense_payment_account before insert on public.expense_records
 for each row execute function private.payment_account_from_request();
create trigger shipment_payment_account before insert on public.purchase_shipments
 for each row execute function private.payment_account_from_request();

-- 3. Movimientos del contador.
create table public.finance_entries (
 id uuid primary key default gen_random_uuid(), request_id uuid not null, request_payload jsonb not null,
 occurred_on date not null,
 kind text not null check(kind in ('opening','capital','withdrawal','transfer','loan','supplier_payment','collection')),
 account text not null check(account in ('caja','banco','cobrar','prestamos','proveedores')),
 to_account text check(to_account in ('caja','banco')),
 amount numeric(14,2) not null check(amount>0),
 currency text not null check(currency in ('NIO','USD')),
 exchange_rate numeric(14,6) not null check(exchange_rate>0 and (currency<>'NIO' or exchange_rate=1)),
 counterparty text not null default '' check(length(counterparty)<=160),
 description text not null default '' check(length(description)<=300),
 reference text not null default '' check(length(reference)<=200),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 voided_at timestamptz, voided_by uuid references auth.users(id), void_reason text,
 unique(created_by,request_id),
 -- Sólo el saldo inicial puede ir a cuentas por cobrar o a deudas; lo demás mueve dinero.
 check(kind='opening' or account in ('caja','banco')),
 check((kind='transfer')=(to_account is not null)),
 check(to_account is null or to_account<>account),
 check((voided_at is null and voided_by is null and void_reason is null) or
 (voided_at is not null and voided_by is not null and length(trim(void_reason)) between 1 and 500))
);
create index finance_entries_date_idx on public.finance_entries(occurred_on,id);
create index finance_entries_created_by_idx on public.finance_entries(created_by);
create index finance_entries_voided_by_idx on public.finance_entries(voided_by);
alter table public.finance_entries enable row level security;
revoke all on public.finance_entries from public,anon,authenticated;
grant select on public.finance_entries to authenticated;
create policy owner_accounting_read on public.finance_entries for select to authenticated
 using ((select private.staff_role())='admin');

create function private.record_finance_entry(p_input jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_request uuid; v_existing public.finance_entries%rowtype;
 v_kind text:=p_input->>'kind'; v_account text:=p_input->>'account'; v_to text:=nullif(p_input->>'toAccount','');
 v_amount numeric; v_rate numeric; v_date date; v_id uuid;
begin
 if v_uid is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
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
 if (v_kind='transfer') <> (v_to is not null) or (v_to is not null and (v_to not in ('caja','banco') or v_to=v_account)) then
  raise exception 'Elige la cuenta de destino.'; end if;
 v_amount:=private.accounting_number(p_input,'amount',1000000000);
 v_rate:=private.accounting_rate(p_input);
 if v_amount<=0 then raise exception 'Revisa el monto.'; end if;
 v_date:=(p_input->>'occurredOn')::date;
 if v_date is null or v_date>(now() at time zone 'America/Managua')::date then raise exception 'Fecha inválida.'; end if;
 perform private.limit_catalog_writes();
 insert into public.finance_entries(request_id,request_payload,occurred_on,kind,account,to_account,amount,currency,exchange_rate,counterparty,description,reference,created_by)
 values(v_request,p_input,v_date,v_kind,v_account,v_to,v_amount,p_input->>'currency',v_rate,
  trim(coalesce(p_input->>'counterparty','')),trim(coalesce(p_input->>'description','')),trim(coalesce(p_input->>'reference','')),v_uid)
 returning id into v_id;
 return v_id;
end $$;

create function private.void_finance_entry(p_id uuid,p_reason text) returns uuid language plpgsql security definer set search_path='' as $$
declare v_entry public.finance_entries%rowtype;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if length(trim(coalesce(p_reason,''))) not between 1 and 500 then raise exception 'Indica el motivo de la anulación.'; end if;
 select * into v_entry from public.finance_entries where id=p_id for update;
 if not found then raise exception 'Movimiento no encontrado.'; end if;
 if v_entry.voided_at is not null then
  if v_entry.void_reason<>trim(p_reason) then raise exception 'El movimiento ya fue anulado con otro motivo.'; end if;
  return p_id;
 end if;
 perform private.limit_catalog_writes();
 update public.finance_entries set voided_at=now(),voided_by=auth.uid(),void_reason=trim(p_reason) where id=p_id;
 return p_id;
end $$;

-- 4. Lo facturado entre dos días de Managua, en córdobas, según la forma de pago:
-- efectivo entra a caja, tarjeta y transferencias a bancos, y «pendiente» queda
-- por cobrar. El importe es el congelado al facturar; una factura sin esa foto
-- se cuenta aparte para no inventar su valor.
create function private.finance_sales(p_from date,p_to date) returns jsonb language sql stable security definer set search_path='' as $$
 with docs as (
  select d.id,d.payment_method,
   (select round(sum(c.net_revenue_nio+c.tax_nio),2) from public.document_item_costs c where c.document_id=d.id) as amount
  from public.documents d
  where d.kind='invoice'
   and d.created_at>=(p_from::timestamp at time zone 'America/Managua')
   and d.created_at<((p_to+1)::timestamp at time zone 'America/Managua')
 )
 select jsonb_build_object(
  'caja',coalesce(sum(amount) filter (where payment_method='cash'),0),
  'banco',coalesce(sum(amount) filter (where payment_method not in ('cash','pending')),0),
  'cobrar',coalesce(sum(amount) filter (where payment_method='pending'),0),
  'missing',count(*) filter (where amount is null))
 from docs
 where private.staff_role()='admin'
$$;

create function public.record_finance_entry(p_input jsonb) returns uuid language sql security invoker set search_path='' as $$select private.record_finance_entry(p_input)$$;
create function public.void_finance_entry(p_id uuid,p_reason text) returns uuid language sql security invoker set search_path='' as $$select private.void_finance_entry(p_id,p_reason)$$;
create function public.finance_sales(p_from date,p_to date) returns jsonb language sql stable security invoker set search_path='' as $$
 select case when private.staff_role()='admin' then private.finance_sales(p_from,p_to) else null end
$$;
revoke all on function private.record_finance_entry(jsonb),private.void_finance_entry(uuid,text),private.finance_sales(date,date),
 public.record_finance_entry(jsonb),public.void_finance_entry(uuid,text),public.finance_sales(date,date) from public,anon,authenticated;
grant execute on function private.record_finance_entry(jsonb),private.void_finance_entry(uuid,text),private.finance_sales(date,date),
 public.record_finance_entry(jsonb),public.void_finance_entry(uuid,text),public.finance_sales(date,date) to authenticated;

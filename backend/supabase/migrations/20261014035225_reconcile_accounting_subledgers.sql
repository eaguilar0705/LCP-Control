-- Keep the cash-flow report and debt subledgers tied to the same journal.
-- Legacy financial openings remain available until a matching journal opening
-- is registered. POS sales are receivables, never an immediate bank deposit.
create function private.cashflow_bases(p_at date)
returns table(account text,start_on date)
language sql stable security invoker set search_path='' as $$
 with opening as (
  select occurred_on from public.journal_entries
  where kind='opening' and voided_at is null and occurred_on<=p_at
 )
 select a.account,o.occurred_on from opening o cross join (values('caja'::text),('banco'::text)) a(account)
 union all
 select f.account,min(f.occurred_on) from public.finance_entries f
 where not exists(select 1 from opening) and f.kind='opening'
  and f.voided_at is null and f.occurred_on<=p_at and f.account in ('caja','banco')
 group by f.account;
$$;
revoke all on function private.cashflow_bases(date) from public,anon,authenticated;

create or replace function private.cashflow_rows(p_from date,p_to date)
returns table(day date,account text,category text,inflow_nio numeric,outflow_nio numeric,missing_sales bigint)
language sql stable security invoker set search_path='' as $$
 with opening as (
  select occurred_on from public.journal_entries where kind='opening' and voided_at is null and occurred_on<=p_to
 ), sales as (
  select (d.created_at at time zone 'America/Managua')::date as day,
   case when d.payment_method='cash' then 'caja' else 'banco' end account,
   private.credit_invoice_amount(d.id) amount
  from public.documents d where d.kind='invoice' and d.payment_method not in ('pending','card_pos')
   and (d.created_at at time zone 'America/Managua')::date between p_from and p_to
 ), entries as (
  select f.occurred_on as day,f.account,f.kind,round(f.amount*f.exchange_rate,2) amount,f.to_account
  from public.finance_entries f where f.voided_at is null and f.occurred_on between p_from and p_to
   and f.account in ('caja','banco') and (f.kind<>'opening' or not exists(select 1 from opening))
 ), vouchers as (
  select e.id,e.occurred_on as day,e.kind,
   case when l.account in ('1110-001','1110-002') then 'caja' else 'banco' end account,
   sum(l.debit_nio) debit,sum(l.credit_nio) credit
  from public.journal_entries e join public.journal_lines l on l.entry_id=e.id
  where e.voided_at is null and e.occurred_on between p_from and p_to
   and (l.account in ('1110-001','1110-002') or l.account like '1120-%')
  group by e.id,e.occurred_on,e.kind,case when l.account in ('1110-001','1110-002') then 'caja' else 'banco' end
 )
 select s.day,s.account,'sales'::text,coalesce(s.amount,0),0::numeric,
  case when s.amount is null then 1::bigint else 0::bigint end from sales s
 union all
 select e.day,e.account,e.kind,
  case when e.kind in ('opening','capital','loan','collection') then e.amount else 0 end,
  case when e.kind in ('withdrawal','transfer','supplier_payment') then e.amount else 0 end,0::bigint from entries e
 union all select e.day,e.to_account,'transfer',e.amount,0::numeric,0::bigint from entries e where e.kind='transfer'
 union all
 select s.incurred_on,s.account,'purchases',0::numeric,
  round(s.goods_amount*s.exchange_rate,2)+round(s.shipping_amount*s.exchange_rate,2),0::bigint
 from public.purchase_shipments s where s.incurred_on between p_from and p_to and s.account in ('caja','banco')
 union all
 select e.incurred_on,e.account,case when e.category in ('prestamo_acreedor','prestamo_bancario') then 'loan_payment' else 'expense' end,
  0::numeric,round(e.amount*e.exchange_rate,2),0::bigint
 from public.expense_records e where e.incurred_on between p_from and p_to and e.voided_at is null
 union all
 select v.day,v.account,case when v.kind='opening' then 'opening' when v.kind in ('transfer','deposit') then 'transfer' else 'journal' end,
  v.debit,v.credit,0::bigint from vouchers v;
$$;

create or replace function private.cashflow_balance(p_at date) returns jsonb
language sql stable security invoker set search_path='' as $$
 with bases as (select * from private.cashflow_bases(p_at)), amounts as (
  select b.account,b.start_on,sum(r.inflow_nio-r.outflow_nio) balance,coalesce(sum(r.missing_sales),0) missing
  from bases b left join lateral private.cashflow_rows(b.start_on,p_at) r on r.account=b.account
  group by b.account,b.start_on
 ) select jsonb_build_object(
  'startOn',(select min(start_on) from bases),'cashStartOn',(select start_on from bases where account='caja'),
  'caja',(select case when missing=0 then coalesce(balance,0) end from amounts where account='caja'),
  'banco',(select case when missing=0 then coalesce(balance,0) end from amounts where account='banco'),
  'missingSales',coalesce((select sum(missing) from amounts),0),
  'cashMissingSales',coalesce((select missing from amounts where account='caja'),0));
$$;

create or replace function private.finance_cashflow(p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_open jsonb; v_close jsonb; v_rows jsonb; v_totals jsonb; v_start date; v_missing bigint;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from+1>3660 then raise exception 'Selecciona un período válido de diez años o menos.'; end if;
 v_open:=private.cashflow_balance(p_from-1); v_close:=private.cashflow_balance(p_to); v_start:=(v_close->>'startOn')::date;
 with grouped as (
  select r.day,r.account,r.category,round(sum(r.inflow_nio),2) incoming,round(sum(r.outflow_nio),2) outgoing,
   count(*) operations,sum(r.missing_sales) missing
  from private.cashflow_rows(p_from,p_to) r left join private.cashflow_bases(p_to) b on b.account=r.account
  where b.start_on is null or r.day>=b.start_on group by r.day,r.account,r.category
 ) select coalesce(jsonb_agg(jsonb_build_object('day',g.day,'account',g.account,'category',g.category,
  'inflowNio',g.incoming,'outflowNio',g.outgoing,'operations',g.operations,'missingSales',g.missing)
  order by g.day,g.account,g.category),'[]'::jsonb),
  jsonb_build_object('inflowNio',coalesce(sum(g.incoming) filter(where g.category not in ('opening','transfer')),0),
   'outflowNio',coalesce(sum(g.outgoing) filter(where g.category not in ('opening','transfer')),0),
   'netNio',coalesce(sum(g.incoming-g.outgoing) filter(where g.category not in ('opening','transfer')),0))
 into v_rows,v_totals from grouped g;
 select coalesce(sum(r.missing_sales),0) into v_missing
 from private.cashflow_rows(least(coalesce(v_start,p_from),p_from),p_to) r
 left join private.cashflow_bases(p_to) b on b.account=r.account where b.start_on is null or r.day>=b.start_on;
 return jsonb_build_object('available',true,'from',p_from,'to',p_to,'startOn',v_start,
  'opening',jsonb_build_object('caja',v_open->'caja','banco',v_open->'banco'),
  'closing',jsonb_build_object('caja',v_close->'caja','banco',v_close->'banco'),
  'missingSales',v_missing,'rows',v_rows,'totals',v_totals);
end $$;

-- A manual debt adjustment belongs to the unallocated opening balance; linked
-- invoices and purchases retain their own balances. Include those adjustments
-- in the debt helper so the auxiliary ledger matches accounts 1140 and 2111.
create or replace function private.credit_opening(p_at date)
returns table(day date,receivables numeric,payables numeric)
language sql stable security definer set search_path='' as $$
 with opening as (
  select occurred_on from public.journal_entries where kind='opening' and voided_at is null and occurred_on<=p_at
 ), legacy as (
  select min(occurred_on) as day,coalesce(sum(round(amount*exchange_rate,2)) filter(where account='cobrar'),0) receivables,
   coalesce(sum(round(amount*exchange_rate,2)) filter(where account='proveedores'),0) payables
  from public.finance_entries where kind='opening' and voided_at is null and occurred_on<=p_at
 )
 select o.occurred_on,
  coalesce(sum(l.debit_nio-l.credit_nio) filter(where l.account='1140'),0),
  coalesce(sum(l.credit_nio-l.debit_nio) filter(where l.account='2111'),0)
 from opening o left join public.journal_entries e on e.voided_at is null and e.occurred_on between o.occurred_on and p_at
 left join public.journal_lines l on l.entry_id=e.id group by o.occurred_on
 union all select * from legacy where not exists(select 1 from opening);
$$;

create function private.check_credit_pool() returns void
language plpgsql security definer set search_path='' as $$
declare v_start date; v_day date;
begin
 select day into v_start from private.credit_opening('infinity'::date);
 if v_start is null then return; end if;
 -- One window calculation checks every effective day, including later payments
 -- affected by a backdate, without querying the full history once per date.
 with changes as (
  select e.occurred_on as day,
   coalesce(sum(l.debit_nio-l.credit_nio) filter(where l.account='1140'),0) receivables,
   coalesce(sum(l.credit_nio-l.debit_nio) filter(where l.account='2111'),0) payables
  from public.journal_entries e join public.journal_lines l on l.entry_id=e.id
  where e.voided_at is null and e.occurred_on>=v_start and l.account in ('1140','2111') group by e.occurred_on
  union all
  select occurred_on,coalesce(sum(round(amount*exchange_rate,2)) filter(where account='cobrar'),0),
   coalesce(sum(round(amount*exchange_rate,2)) filter(where account='proveedores'),0)
  from public.finance_entries where kind='opening' and voided_at is null
   and not exists(select 1 from public.journal_entries where kind='opening' and voided_at is null)
  group by occurred_on
  union all
  select occurred_on,-coalesce(sum(round(amount*exchange_rate,2)) filter(where kind='collection'),0),
   -coalesce(sum(round(amount*exchange_rate,2)) filter(where kind='supplier_payment'),0)
  from public.finance_entries where voided_at is null and document_id is null and shipment_id is null
   and occurred_on>=v_start and kind in ('collection','supplier_payment') group by occurred_on
 ), days as (select day,sum(receivables) receivables,sum(payables) payables from changes group by day),
 balances as (select day,sum(receivables) over(order by day) receivables,sum(payables) over(order by day) payables from days)
 select min(day) into v_day from balances where receivables<0 or payables<0;
 if v_day is not null then
  raise exception 'El ajuste deja negativo el saldo inicial y sus ajustes de deuda al %. Revisa o anula primero sus abonos; para una factura o pedido utiliza Cobros y pagos.',v_day;
 end if;
end $$;
revoke all on function private.check_credit_pool() from public,anon,authenticated;

create function private.check_finance_credit_pool() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.kind in ('collection','supplier_payment') and new.document_id is null and new.shipment_id is null then
  perform private.check_credit_pool();
 end if;
 return new;
end $$;
revoke all on function private.check_finance_credit_pool() from public,anon,authenticated;
create trigger finance_credit_pool after insert on public.finance_entries
 for each row execute function private.check_finance_credit_pool();

-- A backdated settlement also consumes the balance available to later
-- settlements. Checking only the requested date permits a negative POS asset.
create function private.check_pos_balance() returns void
language plpgsql security definer set search_path='' as $$
declare v_start date; v_day date;
begin
 select occurred_on into v_start from public.journal_entries where kind='opening' and voided_at is null;
 if v_start is null then return; end if;
 with postings as (
  select day,debit,credit from private.operational_postings where account='1142' and day>=v_start
  union all
  select e.occurred_on,l.debit_nio,l.credit_nio from public.journal_entries e join public.journal_lines l on l.entry_id=e.id
  where e.voided_at is null and e.occurred_on>=v_start and l.account='1142'
 ), days as (select day,sum(debit-credit) amount from postings group by day),
 balances as (select day,sum(amount) over(order by day) balance from days)
 select min(day) into v_day from balances where balance<0;
 if v_day is not null then
  raise exception 'El comprobante deja negativo el saldo de tarjetas pendientes de acreditar al %. Revisa las liquidaciones posteriores.',v_day;
 end if;
end $$;
revoke all on function private.check_pos_balance() from public,anon,authenticated;

create function private.check_deleted_pos_invoice() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if old.kind='invoice' and old.payment_method='card_pos' then perform private.check_pos_balance(); end if;
 return old;
end $$;
revoke all on function private.check_deleted_pos_invoice() from public,anon,authenticated;
create trigger deleted_pos_balance after delete on public.documents
 for each row execute function private.check_deleted_pos_invoice();

create function private.check_finance_bank_currency() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.kind<>'opening' and (
  (new.bank_ledger_account in ('1120-001','1120-003','1120-005') and new.currency<>'NIO')
  or (new.bank_ledger_account in ('1120-002','1120-004','1120-006') and new.currency<>'USD')) then
  raise exception 'La moneda del movimiento no coincide con la cuenta bancaria seleccionada.';
 end if;
 return new;
end $$;
revoke all on function private.check_finance_bank_currency() from public,anon,authenticated;
create trigger finance_bank_currency before insert on public.finance_entries
 for each row execute function private.check_finance_bank_currency();

create or replace function private.check_cash_line_currency() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_currency text; v_kind text;
begin
 select currency,kind into v_currency,v_kind from public.journal_entries where id=new.entry_id;
 -- Opening vouchers use base-currency balances, including the USD cash drawer.
 if v_kind='opening' then return new; end if;
 if (new.account in ('1110-001','1120-001','1120-003','1120-005') and v_currency<>'NIO')
  or (new.account in ('1110-002','1120-002','1120-004','1120-006') and v_currency<>'USD') then
  raise exception 'La moneda del comprobante no coincide con la caja o cuenta bancaria seleccionada.';
 end if;
 return new;
end $$;

create or replace function private.record_journal_entry(p_input jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_date date:=(p_input->>'occurredOn')::date; v_request uuid:=(p_input->>'requestId')::uuid;
 v_rate numeric; v_line jsonb; v_index integer:=0; v_debit numeric; v_credit numeric; v_total numeric; v_old public.journal_entries%rowtype;
 v_gross numeric; v_fee numeric; v_withholding numeric; v_lines jsonb; v_legacy record; v_opening numeric;
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
 if p_input->>'kind'='opening' then
  -- A journal adoption must carry forward existing financial opening balances,
  -- rather than silently replacing their date, cash or outstanding debt.
  for v_legacy in select account,min(occurred_on) as day,sum(round(amount*exchange_rate,2)) amount
   from public.finance_entries where kind='opening' and voided_at is null group by account loop
   if v_legacy.day<>v_date then raise exception 'La apertura contable debe conservar la fecha del saldo inicial existente: %.',v_legacy.day; end if;
   select coalesce(sum(case when v_legacy.account in ('prestamos','proveedores') then
    round((line->>'credit')::numeric*v_rate,2)-round((line->>'debit')::numeric*v_rate,2)
    else round((line->>'debit')::numeric*v_rate,2)-round((line->>'credit')::numeric*v_rate,2) end),0)
   into v_opening from jsonb_array_elements(p_input->'lines') line
   where case v_legacy.account when 'caja' then line->>'account' in ('1110-001','1110-002')
    when 'banco' then line->>'account' like '1120-%' when 'cobrar' then line->>'account'='1140'
    when 'prestamos' then line->>'account'='2113' when 'proveedores' then line->>'account'='2111' end;
   if v_opening<>v_legacy.amount then raise exception 'La apertura contable debe conservar el saldo inicial de %: C$ %. Usa un ajuste posterior para corregirlo.',v_legacy.account,v_legacy.amount; end if;
  end loop;
  if exists(select 1 from public.finance_entries f left join public.documents d on d.id=f.document_id
   left join public.purchase_shipments s on s.id=f.shipment_id
   where f.voided_at is null and (f.document_id is not null or f.shipment_id is not null)
    and (f.occurred_on<v_date or coalesce((d.created_at at time zone 'America/Managua')::date,s.incurred_on)<v_date)) then
   raise exception 'La apertura debe incluir la fecha de las deudas con abonos ya registrados.';
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
 if p_input->>'kind'='opening' and exists(select 1 from public.journal_lines where entry_id=v_id
  and account in ('1110-001','1110-002') group by account having sum(debit_nio-credit_nio)<0) then
  raise exception 'El saldo inicial de cada caja no puede ser negativo.';
 end if;
 if exists(select 1 from public.journal_lines where entry_id=v_id and account in ('1140','2111')) then
  perform private.check_credit_pool();
 end if;
 if exists(select 1 from public.journal_lines where entry_id=v_id and account='1142') then
  perform private.check_pos_balance();
 end if;
 return v_id;
end $$;

create or replace function private.void_journal_entry(p_id uuid,p_reason text) returns uuid language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 if length(btrim(p_reason)) not between 1 and 500 or p_reason is null then raise exception 'Indica el motivo de anulación.'; end if;
 if exists(select 1 from public.journal_entries where id=p_id and kind='opening') then raise exception 'La apertura se corrige mediante un comprobante de ajuste.'; end if;
 update public.journal_entries set voided_at=now(),voided_by=auth.uid(),void_reason=btrim(p_reason) where id=p_id and voided_at is null;
 if not found then raise exception 'El comprobante no existe o ya está anulado.'; end if;
 if exists(select 1 from public.journal_lines where entry_id=p_id and account in ('1140','2111')) then
  perform private.check_credit_pool();
 end if;
 if exists(select 1 from public.journal_lines where entry_id=p_id and account='1142') then
  perform private.check_pos_balance();
 end if;
 return p_id;
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
   'counterparty','Saldo inicial y ajustes de clientes','reference','Apertura y ajustes','occurredOn',v_start,
   'originalNio',v_initial_receivables,'paidNio',v_paid_receivables,'balanceNio',v_initial_receivables-v_paid_receivables,
   'documentId',null,'shipmentId',null));
 end if;
 if v_start is not null and v_initial_payables>0 then
  v_rows:=v_rows||jsonb_build_array(jsonb_build_object('id','opening:payable','kind','payable',
   'counterparty','Saldo inicial y ajustes de proveedores','reference','Apertura y ajustes','occurredOn',v_start,
   'originalNio',v_initial_payables,'paidNio',v_paid_payables,'balanceNio',v_initial_payables-v_paid_payables,
   'documentId',null,'shipmentId',null));
 end if;
 return jsonb_build_object('available',true,'at',p_at,'startOn',v_start,'rows',v_rows,
  'unallocatedNio',jsonb_build_object('receivables',greatest(0,v_initial_receivables-v_paid_receivables),
   'payables',greatest(0,v_initial_payables-v_paid_payables)),'legacyPayments',v_legacy);
end $$;


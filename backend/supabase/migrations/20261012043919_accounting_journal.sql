-- Journal vouchers complement operational sales/purchases. They never create
-- stock or duplicate historical opening balances from the cashflow module.
create table public.ledger_accounts (
 code text primary key check(code ~ '^[1-6][0-9]{3}(-[0-9]{3}){0,3}$'),
 name text not null check(length(btrim(name)) between 1 and 160),
 parent text references public.ledger_accounts(code),
 bucket text not null check(bucket in ('asset','liability','equity','revenue','cost','expense','tax')),
 nature text not null check(nature in ('debit','credit')),
 postable boolean not null default true,
 active boolean not null default true
);
insert into public.ledger_accounts(code,name,parent,bucket,nature,postable) values
 ('1000','Activo',null,'asset','debit',false),
 ('1100','Activo circulante','1000','asset','debit',false),
 ('1110','Caja','1100','asset','debit',false),
 ('1110-001','Caja córdobas','1110','asset','debit',true),
 ('1110-002','Caja dólares','1110','asset','debit',true),
 ('1120','Bancos','1100','asset','debit',false),
 ('1120-000','Banco por identificar','1120','asset','debit',true),
 ('1120-001','BAC C$','1120','asset','debit',true),
 ('1120-002','BAC US$','1120','asset','debit',true),
 ('1120-003','LAFISE C$','1120','asset','debit',true),
 ('1120-004','LAFISE US$','1120','asset','debit',true),
 ('1120-005','Ficohsa C$','1120','asset','debit',true),
 ('1120-006','Ficohsa US$','1120','asset','debit',true),
 ('1130','Inventario de perfumes','1100','asset','debit',true),
 ('1140','Cuentas por cobrar a clientes','1100','asset','debit',true),
 ('1142','Tarjetas pendientes de acreditar','1100','asset','debit',true),
 ('1200','Activo fijo','1000','asset','debit',false),
 ('1210','Mobiliario y equipo','1200','asset','debit',true),
 ('1290','Depreciación acumulada','1200','asset','credit',true),
 ('1300','Otros activos','1000','asset','debit',false),
 ('1340','Retenciones de IR acreditables','1300','asset','debit',true),
 ('2000','Pasivo',null,'liability','credit',false),
 ('2100','Pasivo circulante','2000','liability','credit',false),
 ('2111','Proveedores','2100','liability','credit',true),
 ('2112','Acreedores diversos','2100','liability','credit',true),
 ('2113','Préstamos por pagar','2100','liability','credit',true),
 ('2116','Impuestos por pagar','2100','liability','credit',true),
 ('3000','Capital',null,'equity','credit',false),
 ('3110','Capital aportado','3000','equity','credit',false),
 ('3110-001','Capital — Miguel','3110','equity','credit',true),
 ('3190','Resultados acumulados','3000','equity','credit',true),
 ('4000','Ingresos',null,'revenue','credit',false),
 ('4110','Ventas','4000','revenue','credit',true),
 ('4190','Otros ingresos','4000','revenue','credit',true),
 ('5000','Costos y gastos',null,'expense','debit',false),
 ('5120','Costo de venta','5000','cost','debit',true),
 ('5130','Gastos de administración y ventas','5000','expense','debit',false),
 ('5130-001','Sueldos','5130','expense','debit',true),
 ('5130-002','Alquiler','5130','expense','debit',true),
 ('5130-003','Agua y energía','5130','expense','debit',true),
 ('5130-004','Alcaldía: impuesto sobre ventas','5130','expense','debit',true),
 ('5130-005','Alcaldía: matrícula','5130','expense','debit',true),
 ('5130-006','Papelería y materiales','5130','expense','debit',true),
 ('5130-007','Transporte y combustible','5130','expense','debit',true),
 ('5130-008','Publicidad','5130','expense','debit',true),
 ('5130-009','Comunicaciones y limpieza','5130','expense','debit',true),
 ('5130-010','Otros gastos','5130','expense','debit',true),
 ('5140','Gastos financieros','5000','expense','debit',false),
 ('5140-001','Comisión de tarjetas','5140','expense','debit',true),
 ('5140-002','Intereses','5140','expense','debit',true),
 ('5150','Pérdidas de inventario','5000','expense','debit',true),
 ('6000','Impuesto sobre la renta',null,'tax','debit',true);

create table public.journal_entries (
 id uuid primary key default gen_random_uuid(),
 number bigint generated always as identity unique,
 occurred_on date not null,
 kind text not null check(kind in ('opening','income','expense','deposit','transfer','adjustment','card_settlement')),
 description text not null check(length(btrim(description)) between 1 and 300),
 reference text not null default '' check(length(reference)<=200),
 currency text not null check(currency in ('NIO','USD')),
 exchange_rate numeric(14,6) not null check(exchange_rate>0 and (currency<>'NIO' or exchange_rate=1)),
 request_id uuid not null unique, request_payload jsonb not null,
 created_by uuid not null references private.business_actors(id), created_at timestamptz not null default now(),
 voided_at timestamptz, voided_by uuid references private.business_actors(id), void_reason text,
 check((voided_at is null and voided_by is null and void_reason is null) or (voided_at is not null and voided_by is not null and length(btrim(void_reason)) between 1 and 500))
);
create unique index journal_one_opening on public.journal_entries ((true)) where kind='opening' and voided_at is null;
create index journal_entry_day on public.journal_entries(occurred_on);
create index journal_created_by on public.journal_entries(created_by);
create index journal_voided_by on public.journal_entries(voided_by);
create index ledger_account_parent on public.ledger_accounts(parent);
create table public.journal_lines (
 entry_id uuid not null references public.journal_entries(id),
 line_no integer not null,
 account text not null references public.ledger_accounts(code),
 debit numeric(18,2) not null check(debit>=0), credit numeric(18,2) not null check(credit>=0),
 debit_nio numeric(18,2) not null, credit_nio numeric(18,2) not null,
 primary key(entry_id,line_no), check ((debit>0 and credit=0) or (credit>0 and debit=0))
);
create index journal_line_account on public.journal_lines(account);
alter table public.ledger_accounts enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_lines enable row level security;
revoke all on public.ledger_accounts,public.journal_entries,public.journal_lines from public,anon,authenticated;
grant select on public.ledger_accounts,public.journal_entries,public.journal_lines to authenticated;
create policy accountant_accounts on public.ledger_accounts for select to authenticated using((select private.staff_role())='admin');
create policy accountant_entries on public.journal_entries for select to authenticated using((select private.staff_role())='admin');
create policy accountant_lines on public.journal_lines for select to authenticated using((select private.staff_role())='admin');
create trigger business_day_guard before insert or update or delete on public.journal_entries for each row execute function private.guard_business_day();

create function private.save_ledger_account(p_input jsonb) returns text language plpgsql security definer set search_path='' as $$
declare v_code text:=p_input->>'code'; p public.ledger_accounts%rowtype;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if exists(select 1 from public.ledger_accounts where code=v_code) then
  update public.ledger_accounts set name=btrim(p_input->>'name') where code=v_code;
 else
  select * into p from public.ledger_accounts where code=p_input->>'parent' and not postable;
  if not found or left(v_code,1)<>left(p.code,1) then raise exception 'Selecciona una cuenta mayor válida.'; end if;
  insert into public.ledger_accounts(code,name,parent,bucket,nature) values(v_code,btrim(p_input->>'name'),p.code,p.bucket,p.nature);
 end if;
 return v_code;
end $$;

create function private.record_journal_entry(p_input jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_date date:=(p_input->>'occurredOn')::date; v_request uuid:=(p_input->>'requestId')::uuid;
 v_rate numeric; v_line jsonb; v_index integer:=0; v_debit numeric; v_credit numeric; v_total numeric; v_old public.journal_entries%rowtype;
 v_gross numeric; v_fee numeric; v_withholding numeric; v_lines jsonb;
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
 return v_id;
end $$;
create function private.void_journal_entry(p_id uuid,p_reason text) returns uuid language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 if length(btrim(p_reason)) not between 1 and 500 or p_reason is null then raise exception 'Indica el motivo de anulación.'; end if;
 if exists(select 1 from public.journal_entries where id=p_id and kind='opening') then raise exception 'La apertura se corrige mediante un comprobante de ajuste.'; end if;
 update public.journal_entries set voided_at=now(),voided_by=auth.uid(),void_reason=btrim(p_reason) where id=p_id and voided_at is null;
 if not found then raise exception 'El comprobante no existe o ya está anulado.'; end if;
 return p_id;
end $$;

create function private.money_ledger_account(p_account text,p_currency text) returns text language sql immutable set search_path='' as $$
 select case when p_account='caja' then case when p_currency='USD' then '1110-002' else '1110-001' end else '1120-000' end;
$$;
create function private.sale_ledger_account(p_payment text,p_currency text) returns text language sql immutable set search_path='' as $$
 select case p_payment when 'cash' then private.money_ledger_account('caja',p_currency) when 'pending' then '1140' when 'card_pos' then '1142'
 when 'bac_nio' then '1120-001' when 'bac_usd' then '1120-002' when 'lafise_nio' then '1120-003' when 'lafise_usd' then '1120-004'
 when 'ficohsa_nio' then '1120-005' when 'ficohsa_usd' then '1120-006' else '1120-000' end;
$$;

-- A pair of equal debit/credit legs for each operational event; journal vouchers
-- supply the explicitly approved opening and additional entries. Unknown costs
-- remain NULL and make dependent statements incomplete.
create view private.operational_postings as
 with pairs as (
 select (d.created_at at time zone 'America/Managua')::date as day,'sale' source,d.id source_id,
 private.sale_ledger_account(d.payment_method,d.currency) debit_account,'4110'::text credit_account,c.net_revenue_nio amount
 from public.document_item_costs c join public.documents d on d.id=c.document_id
 union all
 select (d.created_at at time zone 'America/Managua')::date,'tax',d.id,private.sale_ledger_account(d.payment_method,d.currency),'2116',c.tax_nio
 from public.document_item_costs c join public.documents d on d.id=c.document_id where c.tax_nio>0
 union all
 select (d.created_at at time zone 'America/Managua')::date,'cost',d.id,'5120','1130',round(c.quantity*c.unit_cost_nio,2)
 from public.document_item_costs c join public.documents d on d.id=c.document_id
 union all
 select s.incurred_on,'purchase',s.id,'1130',case when s.account='credito' then '2111' else private.money_ledger_account(s.account,s.currency) end,round((s.goods_amount+s.shipping_amount)*s.exchange_rate,2) from public.purchase_shipments s
 union all
 select e.incurred_on,'expense',e.id,
 case e.category when 'impuestos_dgi' then '6000' when 'impuestos_alma' then '5130-004' when 'prestamo_bancario' then '2113' when 'prestamo_acreedor' then '2112'
 when 'interes_bancario' then '5140-002' when 'interes_acreedor' then '5140-002' when 'renta' then '5130-002' when 'salario' then '5130-001'
 when 'papeleria' then '5130-006' when 'combustible' then '5130-007' when 'agua_luz' then '5130-003' when 'internet' then '5130-009'
 when 'limpieza' then '5130-009' when 'mobiliario' then '1210' when 'viatico' then '5130-007' when 'marketing' then '5130-008' else '5130-010' end,
 private.money_ledger_account(e.account,e.currency),round(e.amount*e.exchange_rate,2) from public.expense_records e where e.voided_at is null
 union all
 select f.occurred_on,'finance',f.id,
 case when f.kind in ('capital','loan','collection') then private.money_ledger_account(f.account,f.currency) when f.kind='transfer' then private.money_ledger_account(f.to_account,f.currency) when f.kind='withdrawal' then '3110-001' else '2111' end,
 case when f.kind='capital' then '3110-001' when f.kind='loan' then '2113' when f.kind='collection' then '1140' else private.money_ledger_account(f.account,f.currency) end,round(f.amount*f.exchange_rate,2)
 from public.finance_entries f where f.voided_at is null and f.kind<>'opening'
 union all
 select (m.created_at at time zone 'America/Managua')::date,'writeoff',m.movement_id,'5150','1130',round(m.quantity*m.unit_cost_nio,2) from public.inventory_movement_costs m
 )
 select day,source,source_id,debit_account account,amount debit,0::numeric credit from pairs
 union all select day,source,source_id,credit_account,0::numeric,amount from pairs;
revoke all on private.operational_postings from public,anon,authenticated;

create function private.ledger_report(p_from date,p_to date) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_start date; v_result jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then raise exception 'Período inválido.'; end if;
 select occurred_on into v_start from public.journal_entries where kind='opening' and voided_at is null;
 with postings as (
  select day,account,debit,credit from private.operational_postings where day>=v_start and day<=p_to
  union all
  select e.occurred_on,l.account,l.debit_nio,l.credit_nio from public.journal_entries e join public.journal_lines l on l.entry_id=e.id where e.voided_at is null and e.occurred_on<=p_to
 ), balances as (
  select a.*,coalesce(sum(p.debit-p.credit) filter(where p.day<p_from),0) opening,
  coalesce(sum(p.debit) filter(where p.day>=p_from),0) debit,coalesce(sum(p.credit) filter(where p.day>=p_from),0) credit,
  coalesce(sum(p.debit-p.credit),0) closing
  from public.ledger_accounts a left join postings p on p.account=a.code group by a.code
 )
 select jsonb_build_object('startOn',v_start,'from',p_from,'to',p_to,
 'missingCosts',(select count(*)/2 from private.operational_postings where day>=v_start and day<=p_to and (debit is null or credit is null)),
 'missingSales',(select count(*) from public.documents d where d.kind='invoice' and (d.created_at at time zone 'America/Managua')::date between v_start and p_to and not exists(select 1 from public.document_item_costs c where c.document_id=d.id)),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('code',code,'name',name,'parent',parent,'bucket',bucket,'nature',nature,'postable',postable,'opening',opening,'debit',debit,'credit',credit,'closing',closing) order by code) from balances),'[]'::jsonb),
 'entries',coalesce((select jsonb_agg(to_jsonb(e) order by occurred_on desc,number desc) from (select id,number,occurred_on,kind,description,reference,currency,exchange_rate,voided_at,void_reason from public.journal_entries where occurred_on between p_from and p_to order by occurred_on desc,number desc limit 501)e),'[]'::jsonb)) into v_result;
 return v_result;
end $$;

create function public.ledger_report(p_from date,p_to date) returns jsonb language sql security invoker set search_path='' as $$ select private.ledger_report(p_from,p_to); $$;
create function public.record_journal_entry(p_input jsonb) returns uuid language sql security invoker set search_path='' as $$ select private.record_journal_entry(p_input); $$;
create function public.save_ledger_account(p_input jsonb) returns text language sql security invoker set search_path='' as $$ select private.save_ledger_account(p_input); $$;
create function public.void_journal_entry(p_id uuid,p_reason text) returns uuid language sql security invoker set search_path='' as $$ select private.void_journal_entry(p_id,p_reason); $$;
revoke all on function private.money_ledger_account(text,text),private.sale_ledger_account(text,text) from public,anon,authenticated;
revoke all on function private.ledger_report(date,date),private.record_journal_entry(jsonb),private.save_ledger_account(jsonb),private.void_journal_entry(uuid,text),public.ledger_report(date,date),public.record_journal_entry(jsonb),public.save_ledger_account(jsonb),public.void_journal_entry(uuid,text) from public,anon;
grant execute on function private.ledger_report(date,date),private.record_journal_entry(jsonb),private.save_ledger_account(jsonb),private.void_journal_entry(uuid,text),public.ledger_report(date,date),public.record_journal_entry(jsonb),public.save_ledger_account(jsonb),public.void_journal_entry(uuid,text) to authenticated;

-- Include cash vouchers in the same immutable daily cash report.
alter function private.business_day_report(date) rename to business_day_operational_report;
create function private.business_day_report(p_day date) returns jsonb language sql stable security definer set search_path='' as $$
 with base as (select private.business_day_operational_report(p_day) r),
 cash as (select
 coalesce(sum(l.debit-l.credit) filter(where l.account='1110-001'),0) nio,
 coalesce(sum(l.debit-l.credit) filter(where l.account='1110-002'),0) usd
 from public.journal_entries e join public.journal_lines l on l.entry_id=e.id
 where e.occurred_on=p_day and e.voided_at is null and e.kind<>'opening')
 select r||jsonb_build_object('cashMovementNio',(r->>'cashMovementNio')::numeric+nio,'cashMovementUsd',(r->>'cashMovementUsd')::numeric+usd,
 'expectedNio',(r->>'expectedNio')::numeric+nio,'expectedUsd',(r->>'expectedUsd')::numeric+usd) from base,cash;
$$;
revoke all on function private.business_day_report(date) from public,anon,authenticated;

-- Cash lines must use their physical currency so the cash count cannot be
-- inflated by recording dollars against the cordoba drawer or vice versa.
create function private.check_cash_line_currency() returns trigger language plpgsql security definer set search_path='' as $$
declare v_currency text; v_kind text;
begin
 select currency,kind into v_currency,v_kind from public.journal_entries where id=new.entry_id;
 if v_kind='opening' then return new; end if;
 if (new.account='1110-001' and v_currency<>'NIO') or (new.account='1110-002' and v_currency<>'USD') then raise exception 'La moneda del comprobante no coincide con la caja seleccionada.'; end if;
 return new;
end $$;
revoke all on function private.check_cash_line_currency() from public,anon,authenticated;
create trigger cash_line_currency before insert on public.journal_lines for each row execute function private.check_cash_line_currency();

create function private.get_journal_entry(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 select to_jsonb(e)-'request_payload'-'request_id'||jsonb_build_object('lines',
  (select jsonb_agg(to_jsonb(l)||jsonb_build_object('name',a.name) order by l.line_no) from public.journal_lines l join public.ledger_accounts a on a.code=l.account where l.entry_id=e.id))
 into result from public.journal_entries e where e.id=p_id;
 if result is null then raise exception 'No se encontró el comprobante.'; end if;
 return result;
end $$;
create function public.get_journal_entry(p_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.get_journal_entry(p_id); $$;
revoke all on function private.get_journal_entry(uuid),public.get_journal_entry(uuid) from public,anon;
grant execute on function private.get_journal_entry(uuid),public.get_journal_entry(uuid) to authenticated;

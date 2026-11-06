-- Cada renglón conserva su moneda; el libro mayor continúa expresado en NIO.
-- Se mantienen las columnas originales para no reinterpretar comprobantes previos.
create table private.journal_line_currencies (
 entry_id uuid not null references public.journal_entries(id), line_no integer not null,
 currency text not null check(currency in ('NIO','USD')),
 exchange_rate numeric(14,6) not null check(exchange_rate>0 and (currency<>'NIO' or exchange_rate=1)),
 primary key(entry_id,line_no));
create table private.journal_corrections (
 id uuid primary key default gen_random_uuid(), entry_id uuid not null references public.journal_entries(id),
 revision integer not null, request_id uuid not null unique, request_payload jsonb not null,
 actor_id uuid not null references private.business_actors(id), actor_name text not null,
 before_snapshot jsonb not null, after_snapshot jsonb not null,
 transaction_id bigint not null, created_at timestamptz not null default now(), unique(entry_id,revision));
alter table private.journal_line_currencies enable row level security;
alter table private.journal_corrections enable row level security;
revoke all on private.journal_line_currencies,private.journal_corrections from public,anon,authenticated;

create or replace function private.check_cash_line_currency() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_currency text; v_kind text;
begin
 select coalesce(c.currency,e.currency),e.kind into v_currency,v_kind
 from public.journal_entries e left join private.journal_line_currencies c
 on c.entry_id=e.id and c.line_no=new.line_no where e.id=new.entry_id;
 if v_kind='opening' then return new; end if;
 if (new.account in ('1110-001','1120-001','1120-003','1120-005') and v_currency<>'NIO')
 or (new.account in ('1110-002','1120-002','1120-004','1120-006') and v_currency<>'USD') then
  raise exception 'La moneda del renglón debe coincidir con la caja o banco seleccionado.';
 end if;
 return new;
end $$;

create or replace function private.journal_snapshot(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select to_jsonb(e)-'request_id'-'request_payload'||jsonb_build_object('lines',
 (select jsonb_agg(to_jsonb(l)||jsonb_build_object('name',a.name,'displayAccount',coalesce(a.display_code,a.code),
  'currency',coalesce(c.currency,e.currency),'exchange_rate',coalesce(c.exchange_rate,e.exchange_rate)) order by l.line_no)
 from public.journal_lines l join public.ledger_accounts a on a.code=l.account
 left join private.journal_line_currencies c on c.entry_id=l.entry_id and c.line_no=l.line_no where l.entry_id=e.id))
 from public.journal_entries e where e.id=p_id;
$$;

-- Solo las funciones internas que validan la operación pueden reemplazar renglones.
create function private.write_multicurrency_lines(p_id uuid,p_lines jsonb,p_currency text,p_rate numeric) returns void
language plpgsql security invoker set search_path='' as $$
declare l jsonb; n integer:=0; c text; r numeric; d numeric; h numeric; total numeric; kind text; prior_accounts text[];
begin
 if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 2 and 100 then
  raise exception 'Agrega entre 2 y 100 renglones al comprobante.'; end if;
 select e.kind into kind from public.journal_entries e where e.id=p_id;
 select array_agg(distinct account) into prior_accounts from public.journal_lines where entry_id=p_id;
 delete from private.journal_line_currencies where entry_id=p_id;
 delete from public.journal_lines where entry_id=p_id;
 for l in select value from jsonb_array_elements(p_lines) loop
  n:=n+1; c:=coalesce(l->>'currency',p_currency);
  if c not in ('NIO','USD') or c is null then raise exception 'Selecciona la moneda de cada renglón.'; end if;
  r:=case when c='NIO' then 1 else private.accounting_number(
   jsonb_build_object('rate',coalesce(l->'exchangeRate',to_jsonb(p_rate))),'rate',1000,6) end;
  if r<=0 then raise exception 'Indica un tipo de cambio válido en cada renglón en dólares.'; end if;
  if not exists(select 1 from public.ledger_accounts where code=l->>'account' and postable and (active or code=any(coalesce(prior_accounts,array[]::text[])))) then
   raise exception 'Selecciona una cuenta activa para cada renglón.'; end if;
  if kind='opening' and not exists(select 1 from public.ledger_accounts where code=l->>'account' and bucket in ('asset','liability','equity')) then
   raise exception 'La apertura solo admite activo, pasivo y capital.'; end if;
  d:=private.accounting_number(l,'debit',100000000,2); h:=private.accounting_number(l,'credit',100000000,2);
  if not ((d>0 and h=0) or (h>0 and d=0)) then raise exception 'Cada renglón debe tener un importe positivo solo en Debe o en Haber.'; end if;
  insert into private.journal_line_currencies values(p_id,n,c,r);
  insert into public.journal_lines(entry_id,line_no,account,debit,credit,debit_nio,credit_nio)
  values(p_id,n,l->>'account',d,h,round(d*r,2),round(h*r,2));
 end loop;
 select sum(debit_nio-credit_nio) into total from public.journal_lines where entry_id=p_id;
 if total<>0 then raise exception 'El Debe y el Haber deben coincidir en córdobas. Diferencia: C$ %.',total; end if;
 if exists(select 1 from public.journal_lines where entry_id=p_id and account in ('1140','2111')) then perform private.check_credit_pool(); end if;
 if exists(select 1 from public.journal_lines where entry_id=p_id and account='1142') then perform private.check_pos_balance(); end if;
end $$;

alter function private.record_journal_entry(jsonb) rename to record_journal_entry_before_multicurrency;
create function private.record_journal_entry(p_input jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_id uuid; old public.journal_entries%rowtype; d date:=(p_input->>'occurredOn')::date;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if jsonb_typeof(p_input->'lines') is distinct from 'array' then raise exception 'Agrega los renglones del comprobante.'; end if;
 if not exists(select 1 from jsonb_array_elements(p_input->'lines') l where l ? 'currency') then
  return private.record_journal_entry_before_multicurrency(p_input); end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('finance-credit-ledger',0));
 perform pg_advisory_xact_lock(hashtextextended('journal:'||coalesce(p_input->>'requestId',''),0));
 select * into old from public.journal_entries where request_id=(p_input->>'requestId')::uuid;
 if found then
  if old.created_by<>auth.uid() or old.request_payload<>p_input then raise exception 'La solicitud de comprobante cambió.'; end if;
  return old.id;
 end if;
 if d is null or d>(now() at time zone 'America/Managua')::date or p_input->>'requestId' is null then raise exception 'Revisa la fecha y la solicitud.'; end if;
 if p_input->>'kind' in ('opening','card_settlement') then raise exception 'Usa el formulario de apertura o liquidación para registrar este comprobante.'; end if;
 if not exists(select 1 from public.journal_entries where kind='opening' and voided_at is null and occurred_on<=d) then raise exception 'Registra primero los saldos iniciales.'; end if;
 insert into public.journal_entries(occurred_on,kind,description,reference,currency,exchange_rate,request_id,request_payload,created_by)
 values(d,p_input->>'kind',btrim(p_input->>'description'),coalesce(p_input->>'reference',''),'NIO',1,(p_input->>'requestId')::uuid,p_input,auth.uid()) returning id into v_id;
 perform private.write_multicurrency_lines(v_id,p_input->'lines',coalesce(p_input->>'currency','NIO'),coalesce((p_input->>'exchangeRate')::numeric,1));
 return v_id;
end $$;

-- La autorización excepcional queda ligada al actor y a la transacción, nunca
-- a una bandera que el cliente pueda activar con set_config.
do $$ declare d text; begin
 select replace(pg_get_functiondef('private.guard_business_day()'::regprocedure),E'\r\n',E'\n') into d;
 d:=replace(d,E'begin\n',E'begin\n if tg_table_name=''journal_entries'' and tg_op=''UPDATE'' then if private.is_superadmin() and exists(select 1 from private.journal_corrections c where c.entry_id=old.id and c.actor_id=auth.uid() and c.transaction_id=txid_current() and c.revision=old.revision+1) then return new; end if; end if;\n');
 execute d;
end $$;

create function private.correct_journal_entry(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.journal_entries%rowtype; c private.journal_corrections%rowtype; b jsonb; a jsonb; actor text; v_id uuid;
begin
 if auth.uid() is null or not private.is_superadmin() then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 perform pg_advisory_xact_lock(hashtextextended('finance-credit-ledger',0));
 perform pg_advisory_xact_lock(hashtextextended('journal-correction:'||coalesce(p_input->>'requestId',''),0));
 select * into c from private.journal_corrections where request_id=(p_input->>'requestId')::uuid;
 if found then
  if c.actor_id<>auth.uid() or c.request_payload<>p_input then raise exception 'La solicitud de edición cambió.'; end if;
  return c.after_snapshot;
 end if;
 select * into e from public.journal_entries where id=(p_input->>'entryId')::uuid for update;
 if not found or e.voided_at is not null then raise exception 'El comprobante no existe o está anulado.'; end if;
 if e.kind='opening' then raise exception 'Usa Editar saldos iniciales para corregir la apertura.'; end if;
 if e.revision is distinct from (p_input->>'expectedRevision')::integer then raise exception 'El comprobante cambió. Cierra y vuelve a abrir su versión actual.'; end if;
 if (p_input->>'occurredOn')::date is null or (p_input->>'occurredOn')::date>(now() at time zone 'America/Managua')::date
 or not exists(select 1 from public.journal_entries where kind='opening' and voided_at is null and occurred_on<=(p_input->>'occurredOn')::date) then raise exception 'Revisa la fecha del comprobante.'; end if;
 b:=private.journal_snapshot(e.id);
 select display_name into actor from private.business_actors where id=auth.uid();
 insert into private.journal_corrections(entry_id,revision,request_id,request_payload,actor_id,actor_name,before_snapshot,after_snapshot,transaction_id)
 values(e.id,e.revision+1,(p_input->>'requestId')::uuid,p_input,auth.uid(),coalesce(actor,'SuperAdmin'),b,'{}',txid_current()) returning id into v_id;
 update public.journal_entries set description=btrim(p_input->>'description'),reference=coalesce(p_input->>'reference',''),
  occurred_on=(p_input->>'occurredOn')::date,currency='NIO',exchange_rate=1,revision=revision+1 where id=e.id;
 perform private.write_multicurrency_lines(e.id,p_input->'lines','NIO',1);
 -- Quitar una cuenta también puede afectar los submayores pendientes.
 if exists(select 1 from jsonb_array_elements(b->'lines') l where l->>'account' in ('1140','2111')) then perform private.check_credit_pool(); end if;
 if exists(select 1 from jsonb_array_elements(b->'lines') l where l->>'account'='1142') then perform private.check_pos_balance(); end if;
 a:=private.journal_snapshot(e.id);
 update private.journal_corrections set after_snapshot=a where id=v_id;
 return a;
end $$;
create function public.correct_journal_entry(p_input jsonb) returns jsonb
language sql security invoker set search_path='' as $$select private.correct_journal_entry(p_input)$$;

alter function private.get_journal_entry(uuid) rename to get_journal_entry_before_edits;
create function private.get_journal_entry(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r jsonb;
begin
 r:=private.get_journal_entry_before_edits(p_id);
 return r||jsonb_build_object('editingAccounts',(select jsonb_agg(jsonb_build_object('code',a.code,'displayCode',coalesce(a.display_code,a.code),'name',a.name,'bucket',a.bucket) order by a.code)
  from public.ledger_accounts a where a.postable and (a.active or exists(select 1 from public.journal_lines l where l.entry_id=p_id and l.account=a.code))),
  'editHistory',coalesce((select jsonb_agg(jsonb_build_object('id',id,'revision',revision,'actorName',actor_name,'createdAt',created_at,'before',before_snapshot,'after',after_snapshot) order by revision desc)
  from private.journal_corrections where entry_id=p_id),'[]'));
end $$;
revoke all on function private.write_multicurrency_lines(uuid,jsonb,text,numeric),private.record_journal_entry_before_multicurrency(jsonb),private.get_journal_entry_before_edits(uuid) from public,anon,authenticated;
revoke all on function private.correct_journal_entry(jsonb),public.correct_journal_entry(jsonb) from public,anon;
grant execute on function private.correct_journal_entry(jsonb),public.correct_journal_entry(jsonb) to authenticated;
revoke all on function private.record_journal_entry(jsonb),private.get_journal_entry(uuid) from public,anon;
grant execute on function private.record_journal_entry(jsonb),private.get_journal_entry(uuid) to authenticated;

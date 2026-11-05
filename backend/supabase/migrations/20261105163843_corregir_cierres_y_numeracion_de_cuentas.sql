-- La numeración visible se puede corregir sin cambiar la identidad que usan
-- ventas, bancos, inventario, comprobantes e importaciones históricas.
alter table public.ledger_accounts add column display_code text;
create unique index ledger_accounts_display_code on public.ledger_accounts(coalesce(display_code,code));
create or replace function private.ledger_account_revision() returns trigger language plpgsql set search_path='' as $$
begin
 new.revision:=old.revision+case when row(new.name,new.parent,new.bucket,new.nature,new.postable,new.active,new.display_code)
  is distinct from row(old.name,old.parent,old.bucket,old.nature,old.postable,old.active,old.display_code) then 1 else 0 end;
 return new;
end $$;

do $edit$ declare s text; begin
 s:=pg_get_functiondef('private.change_ledger_account(jsonb)'::regprocedure);
 s:=replace(s,'v_restriction text;','v_restriction text; v_display text;');
 s:=replace(s,'if v_action=''rename'' then', $new$if v_action='rename' then
   v_display:=btrim(coalesce(p_input->>'newCode',a.display_code,a.code));
   if v_display !~ '^[1-6][0-9]{3}(-[0-9]{3}){0,3}$' or left(v_display,1)<>left(a.code,1) then
    raise exception 'El código debe conservar el tipo de cuenta y su formato numérico.';
   end if;
   if exists(select 1 from public.ledger_accounts x where x.code<>a.code and (x.code=v_display or coalesce(x.display_code,x.code)=v_display)) then
    raise exception 'Ese código ya está registrado. Selecciona uno diferente.';
   end if;
 $new$);
 s:=replace(s,'if v_name=a.name then','if v_name=a.name and v_display=coalesce(a.display_code,a.code) then');
 s:=replace(s,'set name=v_name where code=v_code','set name=v_name,display_code=nullif(v_display,v_code) where code=v_code');
 s:=replace(s,'if found then raise exception ''Ese código ya está registrado.',
  'if found or exists(select 1 from public.ledger_accounts where display_code=v_code) then raise exception ''Ese código ya está registrado.');
 if position('display_code=nullif' in s)=0 then raise exception 'Revisar la edición de cuentas.'; end if;
 execute s;
end $edit$;

-- Añadir etiquetas en las respuestas, manteniendo las claves internas de las
-- solicitudes. Los cálculos continúan usando la identidad original de la cuenta.
create function private.account_code_labels(p_value jsonb) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb; label text; parent_label text;
begin
 if jsonb_typeof(p_value)='array' then
  return coalesce((select jsonb_agg(private.account_code_labels(value) order by n) from jsonb_array_elements(p_value) with ordinality x(value,n)),'[]');
 elsif jsonb_typeof(p_value)<>'object' then return p_value; end if;
 select jsonb_object_agg(key,private.account_code_labels(value)) into result from jsonb_each(p_value);
 if p_value ? 'code' then
  select coalesce(display_code,code) into label from public.ledger_accounts where code=p_value->>'code';
  if label is not null then result:=result||jsonb_build_object('displayCode',label); end if;
 end if;
 if p_value ? 'account' then
  select coalesce(display_code,code) into label from public.ledger_accounts where code=p_value->>'account';
  if label is not null then result:=result||jsonb_build_object('displayAccount',label); end if;
 end if;
 if p_value ? 'parent' then
  select coalesce(display_code,code) into parent_label from public.ledger_accounts where code=p_value->>'parent';
  if parent_label is not null then result:=result||jsonb_build_object('displayParent',parent_label); end if;
 end if;
 return coalesce(result,p_value);
end $$;
revoke all on function private.account_code_labels(jsonb) from public,anon;
grant execute on function private.account_code_labels(jsonb) to authenticated;
do $labels$ declare s text; f text; begin
 foreach f in array array['public.ledger_report(date,date)','public.ledger_accounts_list()',
  'public.get_journal_entry(uuid)','public.sales_journal_entries(date,date)'] loop
  s:=pg_get_functiondef(f::regprocedure);
  -- Los envoltorios públicos mantienen permisos y validaciones privados.
  s:=regexp_replace(s,'select (private\.[a-z_]+\([^;]*\));','select private.account_code_labels(\1);','i');
  if position('private.account_code_labels' in s)=0 then raise exception 'Revisar etiquetas de %',f; end if;
  execute s;
 end loop;
end $labels$;

alter table private.business_day_events drop constraint business_day_events_event_check;
alter table private.business_day_events add constraint business_day_events_event_check
 check(event in ('close','reopen','correct','invoice_corrected','closing_corrected','cash_movement'));
alter table private.business_day_events drop constraint business_day_events_check;
alter table private.business_day_events add constraint business_day_events_check check(
 (event in ('close','invoice_corrected','closing_corrected') and report is not null)
 or (event='reopen' and report is null) or event in ('correct','cash_movement'));

create function private.correct_closing_business_day(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.business_days%rowtype; e private.business_day_events%rowtype;
 v_day date:=(p_input->>'day')::date; v_request uuid:=(p_input->>'requestId')::uuid;
 v_nio numeric; v_usd numeric; v_report jsonb; v_before jsonb; v_note text:=btrim(coalesce(p_input->>'note',''));
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_request is null then raise exception 'Falta identificar la corrección.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 select * into e from private.business_day_events where request_id=v_request;
 if found then
  if e.event<>'closing_corrected' or e.actor_id<>auth.uid() or e.request_payload<>p_input then raise exception 'La solicitud de corrección cambió.'; end if;
  return private.get_business_day(e.day);
 end if;
 select * into b from public.business_days where day=v_day for update;
 if not found or b.closed_at is null then raise exception 'Selecciona una jornada cerrada para corregir el conteo.'; end if;
 if not(p_input ? 'expectedRevision') or (p_input->>'expectedRevision')::integer is distinct from b.revision then
  raise exception 'La jornada cambió. Actualiza los datos antes de corregir el cierre.';
 end if;
 if exists(select 1 from public.business_days where opening_request=v_request)
  or exists(select 1 from private.business_day_opening_preparations where request_id=v_request) then raise exception 'El identificador corresponde a otra operación.'; end if;
 v_nio:=private.accounting_number(p_input,'countedNio',100000000,2);
 v_usd:=private.accounting_number(p_input,'countedUsd',100000000,2);
 if v_nio=(b.report->>'countedNio')::numeric and v_usd=(b.report->>'countedUsd')::numeric then raise exception 'El conteo ya tiene esos importes.'; end if;
 if length(v_note)>1000 then raise exception 'La observación admite hasta 1000 caracteres.'; end if;
 v_before:=b.report;
 v_report:=b.report||jsonb_build_object('countedNio',v_nio,'countedUsd',v_usd,
  'differenceNio',v_nio-(b.report->>'expectedNio')::numeric,'differenceUsd',v_usd-(b.report->>'expectedUsd')::numeric);
 update public.business_days set report=v_report,revision=revision+1 where day=v_day returning * into b;
 insert into private.business_day_events(day,event,revision,actor_id,actor_name,reason,request_id,request_payload,report,opening_snapshot)
 values(v_day,'closing_corrected',b.revision,auth.uid(),coalesce((select display_name from private.business_actors where id=auth.uid()),'Administrador'),
 v_note,v_request,p_input,v_report,jsonb_build_object('openingNio',b.opening_nio,'openingUsd',b.opening_usd,'openedAt',b.opened_at,'closedAt',b.closed_at,'before',v_before,'after',v_report));
 return private.get_business_day(v_day);
end $$;
create function public.correct_closing_business_day(p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.correct_closing_business_day(p_input);$$;
revoke all on function private.correct_closing_business_day(jsonb),public.correct_closing_business_day(jsonb) from public,anon;
grant execute on function private.correct_closing_business_day(jsonb),public.correct_closing_business_day(jsonb) to authenticated;

-- Un movimiento registra su contrapartida real. Nunca convertir un conteo en
-- ingreso/gasto automático ni mezclar la apertura diaria con el saldo contable.
create table private.cash_movement_requests (
 request_id uuid primary key, actor_id uuid not null references private.business_actors(id),
 transaction_id bigint not null, payload jsonb not null, created_at timestamptz not null default now()
);
create index cash_movement_requests_actor on private.cash_movement_requests(actor_id);
alter table private.cash_movement_requests enable row level security;
revoke all on private.cash_movement_requests from public,anon,authenticated;
do $guard$ declare s text; begin
 s:=pg_get_functiondef('private.guard_business_day()'::regprocedure);
 s:=regexp_replace(s,E'begin\\s*',E'begin\n if tg_op=''INSERT'' and tg_table_name=''journal_entries'' then\n  if new.kind=''adjustment'' and private.staff_role()=''admin'' and exists(\n   select 1 from private.cash_movement_requests c where c.request_id=new.request_id\n    and c.actor_id=auth.uid() and c.transaction_id=txid_current()\n    and c.payload=new.request_payload->''cashMovementInput''\n    and new.occurred_on=(c.payload->>''day'')::date) then return new; end if;\n end if;\n');
 execute s;
end $guard$;
create function private.record_cash_movement(p_input jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare b public.business_days%rowtype; a public.ledger_accounts%rowtype; saved public.journal_entries%rowtype;
 v_day date:=(p_input->>'day')::date; v_request uuid:=(p_input->>'requestId')::uuid; v_id uuid;
 v_currency text:=p_input->>'currency'; v_type text:=p_input->>'type'; v_cash text; v_in boolean;
 v_amount numeric; v_rate numeric; v_description text:=btrim(p_input->>'description'); v_lines jsonb; v_report jsonb; v_old jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_request is null then raise exception 'Falta identificar el movimiento.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 select * into saved from public.journal_entries where request_id=v_request;
 if found then
  if saved.created_by<>auth.uid() or saved.request_payload->'cashMovementInput' is distinct from p_input then raise exception 'La solicitud del movimiento cambió.'; end if;
  return saved.id;
 end if;
 select * into b from public.business_days where day=v_day for update;
 if not found or v_day>(now() at time zone 'America/Managua')::date then raise exception 'Selecciona una jornada registrada.'; end if;
 if not(p_input ? 'expectedRevision') or (p_input->>'expectedRevision')::integer is distinct from b.revision
  or p_input->>'expectedStateToken' is distinct from private.get_business_day(v_day)->>'stateToken' then
  raise exception 'La jornada cambió. Actualiza los importes antes de registrar el movimiento.';
 end if;
 if v_currency is null or v_currency not in ('NIO','USD') or v_type is null or v_type not in ('expense','owner_withdrawal','deposit','bank_withdrawal','income','other_out') then raise exception 'Selecciona tipo de movimiento y moneda.'; end if;
 if length(coalesce(v_description,'')) not between 1 and 500 then raise exception 'Escribe el concepto del movimiento.'; end if;
 v_amount:=private.accounting_number(p_input,'amount',100000000,2);
 if v_amount<=0 then raise exception 'El importe debe ser mayor que cero.'; end if;
 v_rate:=private.accounting_rate(p_input);
 v_cash:=case v_currency when 'USD' then '1110-002' else '1110-001' end;
 select * into a from public.ledger_accounts where code=p_input->>'counterpart' and active and postable;
 if not found or a.code in ('1110-001','1110-002') then raise exception 'Selecciona la cuenta de origen o destino del dinero.'; end if;
 if (v_type='expense' and a.bucket not in ('expense','cost','tax'))
  or (v_type='owner_withdrawal' and a.bucket<>'equity')
  or (v_type in ('deposit','bank_withdrawal') and a.code not like '1120-%') then raise exception 'La cuenta no corresponde al tipo de movimiento.'; end if;
 v_in:=v_type in ('income','bank_withdrawal');
 v_lines:=jsonb_build_array(jsonb_build_object('account',v_cash,'debit',case when v_in then v_amount else 0 end,'credit',case when v_in then 0 else v_amount end),
 jsonb_build_object('account',a.code,'debit',case when v_in then 0 else v_amount end,'credit',case when v_in then v_amount else 0 end));
 insert into private.cash_movement_requests(request_id,actor_id,transaction_id,payload) values(v_request,auth.uid(),txid_current(),p_input);
 v_id:=private.record_journal_entry(jsonb_build_object('requestId',v_request,'occurredOn',v_day,'kind','adjustment','currency',v_currency,'exchangeRate',v_rate,
 'description',v_description,'reference',coalesce(p_input->>'reference',''),'lines',v_lines,'cashMovementInput',p_input));
 v_old:=b.report;
 if b.closed_at is not null then
  v_report:=private.business_day_report(v_day)||jsonb_build_object('countedNio',v_old->'countedNio','countedUsd',v_old->'countedUsd','note',v_old->'note');
  v_report:=v_report||jsonb_build_object('differenceNio',(v_old->>'countedNio')::numeric-(v_report->>'expectedNio')::numeric,
  'differenceUsd',(v_old->>'countedUsd')::numeric-(v_report->>'expectedUsd')::numeric);
 end if;
 update public.business_days set report=v_report,revision=revision+1 where day=v_day returning * into b;
 insert into private.business_day_events(day,event,revision,actor_id,actor_name,reason,request_id,request_payload,report,opening_snapshot)
 values(v_day,'cash_movement',b.revision,auth.uid(),coalesce((select display_name from private.business_actors where id=auth.uid()),'Administrador'),
 v_description,v_request,p_input,v_report,jsonb_build_object('openingNio',b.opening_nio,'openingUsd',b.opening_usd,'openedAt',b.opened_at,'closedAt',b.closed_at,'journalId',v_id));
 return v_id;
end $$;
create function public.record_cash_movement(p_input jsonb) returns uuid language sql security invoker set search_path='' as $$select private.record_cash_movement(p_input);$$;
revoke all on function private.record_cash_movement(jsonb),public.record_cash_movement(jsonb) from public,anon;
grant execute on function private.record_cash_movement(jsonb),public.record_cash_movement(jsonb) to authenticated;

do $recovery$ declare s text; begin
 s:=pg_get_functiondef('private.operation_confirmation(text,uuid,boolean)'::regprocedure);
 s:=replace(s,'''ledger-account-change'') then','''ledger-account-change'',''business-day-correct_closing'') then');
 s:=replace(s,'when ''business-day-close'',''business-day-reopen'',''business-day-correct'' then','when ''business-day-close'',''business-day-reopen'',''business-day-correct'',''business-day-correct_closing'' then');
 s:=replace(s,'when ''business-day-correct'' then ''correct''','when ''business-day-correct'' then ''correct'' when ''business-day-correct_closing'' then ''closing_corrected''');
 if position('closing_corrected' in s)=0 then raise exception 'Revisar recuperación del cierre.'; end if;
 execute s;
 -- La etiqueta del evento es distinta del nombre de su operación recuperable.
 s:=pg_get_functiondef('private.prevent_retired_operation()'::regprocedure);
 s:=replace(s,'v_kind:=''business-day-''||(v_row->>''event'');','v_kind:=case v_row->>''event'' when ''closing_corrected'' then ''business-day-correct_closing'' when ''cash_movement'' then ''journal'' else ''business-day-''||(v_row->>''event'') end;');
 execute s;
end $recovery$;
notify pgrst,'reload schema';

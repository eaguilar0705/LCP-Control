-- Preparar efectivo no abre la jornada ni crea movimientos de dinero.
create table private.business_day_opening_preparations (
 id uuid primary key default gen_random_uuid(), day date not null,
 revision integer not null check(revision>0),
 opening_nio numeric(18,2) not null check(opening_nio between 0 and 100000000),
 opening_usd numeric(18,2) not null check(opening_usd between 0 and 100000000),
 previous_values jsonb, actor_id uuid not null references private.business_actors(id),
 actor_name text not null, created_at timestamptz not null default now(),
 request_id uuid not null unique, request_payload jsonb not null,
 unique(day,revision)
);
alter table private.business_day_opening_preparations enable row level security;
revoke all on private.business_day_opening_preparations from public,anon,authenticated;
create index business_day_opening_preparations_actor on private.business_day_opening_preparations(actor_id);
create trigger prevent_retired_operation before insert on private.business_day_opening_preparations
 for each row execute function private.prevent_retired_operation('business-day-prepare','actor_id','request_id');

create function private.business_day_opening_preparation(p_day date) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',id,'day',day,'revision',revision,'openingNio',opening_nio,
  'openingUsd',opening_usd,'actorName',actor_name,'createdAt',created_at)
 from private.business_day_opening_preparations
 where day=p_day and auth.uid() is not null and private.staff_role()='admin'
 order by revision desc limit 1;
$$;
revoke all on function private.business_day_opening_preparation(date) from public,anon,authenticated;

create function private.prepare_business_day(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_day date:=(p_input->>'day')::date; v_request uuid:=(p_input->>'requestId')::uuid;
 v_nio numeric; v_usd numeric; v_revision integer; previous private.business_day_opening_preparations%rowtype;
 saved private.business_day_opening_preparations%rowtype;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_request is null then raise exception 'Falta el identificador de preparación.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 select * into saved from private.business_day_opening_preparations where request_id=v_request;
 if found then
  if saved.actor_id<>auth.uid() or saved.request_payload<>p_input then raise exception 'La solicitud de preparación cambió.'; end if;
  return private.get_business_day(saved.day);
 end if;
 if v_day is distinct from (now() at time zone 'America/Managua')::date then raise exception 'Solo puedes preparar el efectivo de hoy.'; end if;
 if exists(select 1 from public.business_days where day=v_day) then raise exception 'La jornada ya está registrada. Usa Editar efectivo inicial para corregirla.'; end if;
 if exists(select 1 from public.business_days where opening_request=v_request)
  or exists(select 1 from private.business_day_events where request_id=v_request) then raise exception 'El identificador ya corresponde a otra operación de jornada.'; end if;
 select * into previous from private.business_day_opening_preparations where day=v_day order by revision desc limit 1;
 v_revision:=coalesce(previous.revision,0);
 if not(p_input ? 'expectedPreparationRevision') or (p_input->>'expectedPreparationRevision')::integer is distinct from v_revision then
  raise exception 'El efectivo preparado cambió. Actualiza sus datos antes de guardar.';
 end if;
 v_nio:=private.accounting_number(p_input,'openingNio',100000000,2);
 v_usd:=private.accounting_number(p_input,'openingUsd',100000000,2);
 if previous.id is not null and v_nio=previous.opening_nio and v_usd=previous.opening_usd then raise exception 'Los importes ya coinciden con el efectivo preparado.'; end if;
 perform private.limit_catalog_writes();
 insert into private.business_day_opening_preparations(day,revision,opening_nio,opening_usd,previous_values,actor_id,actor_name,request_id,request_payload)
 values(v_day,v_revision+1,v_nio,v_usd,case when previous.id is not null then jsonb_build_object('openingNio',previous.opening_nio,'openingUsd',previous.opening_usd) end,
  auth.uid(),coalesce((select display_name from private.business_actors where id=auth.uid()),'Administrador'),v_request,p_input);
 return private.get_business_day(v_day);
end $$;
create function public.prepare_business_day(p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.prepare_business_day(p_input);$$;
revoke all on function private.prepare_business_day(jsonb),public.prepare_business_day(jsonb) from public,anon;
grant execute on function private.prepare_business_day(jsonb),public.prepare_business_day(jsonb) to authenticated;

-- Los cierres originales quedan intactos; una corrección cerrada genera una
-- revisión adicional con el mismo conteo físico y una diferencia recalculada.
alter table private.business_day_events drop constraint business_day_events_check;
alter table private.business_day_events add constraint business_day_events_check
 check((event='close' and report is not null) or (event='reopen' and report is null) or event='correct');

do $correct$ declare s text; begin
 s:=pg_get_functiondef('private.correct_business_day(jsonb)'::regprocedure);
 if position('if b.closed_at is not null then' in s)=0 then raise exception 'Revisar la función de corrección de apertura.'; end if;
 s:=replace(s,'v_nio numeric; v_usd numeric; v_before jsonb;','v_nio numeric; v_usd numeric; v_before jsonb; v_report jsonb;');
 s:=replace(s,$old$if b.closed_at is not null then
  raise exception 'La jornada está cerrada. Si corresponde a hoy, reábrela antes de corregir el efectivo inicial.';
 end if;$old$,'');
 s:=replace(s,'Selecciona una jornada abierta.','Selecciona una jornada registrada.');
 s:=replace(s,'if exists(select 1 from public.business_days where opening_request=v_request) then',
  'if exists(select 1 from public.business_days where opening_request=v_request) or exists(select 1 from private.business_day_opening_preparations where request_id=v_request) then');
 s:=replace(s,'update public.business_days set opening_nio=v_nio,opening_usd=v_usd,revision=revision+1',
 $new$if b.closed_at is not null then
  if jsonb_typeof(b.report->'expectedNio') is distinct from 'number' or jsonb_typeof(b.report->'expectedUsd') is distinct from 'number'
   or jsonb_typeof(b.report->'countedNio') is distinct from 'number' or jsonb_typeof(b.report->'countedUsd') is distinct from 'number' then
   raise exception 'El cierre no tiene un conteo completo. Consulta a Administración antes de corregirlo.';
  end if;
  v_report:=b.report||jsonb_build_object(
   'expectedNio',(b.report->>'expectedNio')::numeric+v_nio-b.opening_nio,
   'expectedUsd',(b.report->>'expectedUsd')::numeric+v_usd-b.opening_usd,
   'differenceNio',(b.report->>'countedNio')::numeric-((b.report->>'expectedNio')::numeric+v_nio-b.opening_nio),
   'differenceUsd',(b.report->>'countedUsd')::numeric-((b.report->>'expectedUsd')::numeric+v_usd-b.opening_usd));
 end if;
 update public.business_days set report=v_report,opening_nio=v_nio,opening_usd=v_usd,revision=revision+1$new$);
 s:=replace(s,'request_payload,opening_snapshot)','request_payload,report,opening_snapshot)');
 s:=replace(s,'v_reason,v_request,p_input,jsonb_build_object(''before'',v_before,',
  'v_reason,v_request,p_input,v_report,jsonb_build_object(''openingNio'',v_nio,''openingUsd'',v_usd,''openedAt'',b.opened_at,''closedAt'',b.closed_at,''before'',v_before,');
 if position('reábrela antes' in s)>0 or position('report=v_report' in s)=0 then raise exception 'No se pudo extender la corrección cerrada.'; end if;
 execute s;
end $correct$;

do $read_open$ declare s text; marker text:='''openingSuggestion'''; begin
 s:=pg_get_functiondef('private.get_business_day(date)'::regprocedure);
 if position(marker in s)=0 then raise exception 'Revisar la consulta de jornadas.'; end if;
 s:=replace(s,marker,'''openingDraft'',case when v_admin and b.day is null then private.business_day_opening_preparation(v_day) end,'||marker);
 execute s;
 s:=pg_get_functiondef('private.open_business_day(jsonb)'::regprocedure);
 marker:='v_nio:=private.accounting_number(p_input,''openingNio'',100000000,2);';
 if position(marker in s)=0 then raise exception 'Revisar la apertura de jornadas.'; end if;
 s:=replace(s,marker,$guard$if p_input ? 'expectedOpeningDraftRevision' and (p_input->>'expectedOpeningDraftRevision')::integer is distinct from
  coalesce((select max(revision) from private.business_day_opening_preparations where day=v_day),0) then
  raise exception 'El efectivo preparado cambió. Actualiza los importes antes de abrir.';
 end if;
 if exists(select 1 from private.business_day_opening_preparations where request_id=v_request) then raise exception 'El identificador ya corresponde a una preparación.'; end if;
 $guard$||marker);
 execute s;
end $read_open$;

create or replace function private.get_business_day_history(p_day date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_day is null then raise exception 'Selecciona la fecha de la jornada.'; end if;
 select coalesce(jsonb_agg(item order by phase desc,revision desc),'[]'::jsonb) into v_result from (
  select 2 phase,revision,jsonb_build_object('id',id,'day',day,'event',event,'revision',revision,
   'createdAt',created_at,'actorId',actor_id,'actorName',actor_name,'reason',reason,'requestId',request_id,
   'report',case when report is not null then report||opening_snapshot end,
   'openingCorrection',case when event='correct' then opening_snapshot end) item
  from private.business_day_events where day=p_day
  union all
  select 1,revision,jsonb_build_object('id',id,'day',day,'event','prepare','revision',revision,
   'createdAt',created_at,'actorId',actor_id,'actorName',actor_name,'reason','Efectivo preparado antes de abrir','requestId',request_id,'report',null,
   'openingPreparation',jsonb_build_object('openingNio',opening_nio,'openingUsd',opening_usd),
   'openingCorrection',case when previous_values is not null then jsonb_build_object('before',previous_values,'after',jsonb_build_object('openingNio',opening_nio,'openingUsd',opening_usd)) end)
  from private.business_day_opening_preparations where day=p_day
 ) h;
 return v_result;
end $$;

do $recover$ declare s text; begin
 s:=pg_get_functiondef('private.operation_confirmation(text,uuid,boolean)'::regprocedure);
 if position('''business-day-correct'') then' in s)=0 then raise exception 'Revisar la recuperación de operaciones.'; end if;
 s:=replace(s,'''business-day-correct'') then','''business-day-correct'',''business-day-prepare'') then');
 s:=replace(s,'when ''business-day-open'' then','when ''business-day-prepare'' then v_table:=''private.business_day_opening_preparations'';v_actor:=''actor_id''; when ''business-day-open'' then');
 execute s;
end $recover$;
notify pgrst,'reload schema';

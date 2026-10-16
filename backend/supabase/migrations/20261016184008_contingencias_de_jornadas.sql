-- Las reaperturas corrigen un cierre accidental del día actual sin perder
-- aperturas, operaciones ni reportes de cierres anteriores.
alter table public.business_days
 add column revision integer not null default 0 check(revision>=0),
 add column reopen_count integer not null default 0 check(reopen_count>=0);

create table private.business_day_events (
 id uuid primary key default gen_random_uuid(),
 day date not null references public.business_days(day),
 event text not null check(event in ('close','reopen')),
 revision integer not null check(revision>0),
 created_at timestamptz not null default now(),
 actor_id uuid not null references private.business_actors(id),
 actor_name text not null,
 reason text not null,
 request_id uuid not null unique,
 request_payload jsonb not null,
 report jsonb,
 opening_snapshot jsonb not null,
 unique(day,revision),
 check((event='close')=(report is not null))
);
create index business_day_events_actor on private.business_day_events(actor_id);
alter table private.business_day_events enable row level security;
revoke all on private.business_day_events from public,anon,authenticated;

-- Se conserva el reporte ya emitido, sin volver a calcular cifras históricas.
update public.business_days set revision=1 where closed_at is not null;
insert into private.business_day_events(day,event,revision,created_at,actor_id,actor_name,reason,
 request_id,request_payload,report,opening_snapshot)
select b.day,'close',b.revision,b.closed_at,b.closed_by,coalesce(a.display_name,'Cuenta retirada'),
 coalesce(b.report->>'note',''),b.closing_request,b.closing_payload,b.report,
 jsonb_build_object('openingNio',b.opening_nio,'openingUsd',b.opening_usd,
 'openedAt',b.opened_at,'closedAt',b.closed_at)
from public.business_days b left join private.business_actors a on a.id=b.closed_by
where b.closed_at is not null;

create or replace function private.get_business_day(p_day date default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b public.business_days%rowtype;
 v_today date:=(now() at time zone 'America/Managua')::date;
 v_day date:=coalesce(p_day,v_today); v_admin boolean:=private.staff_role()='admin';
 v_report jsonb; v_state jsonb;
begin
 if auth.uid() is null or private.staff_role() is null then raise insufficient_privilege; end if;
 select * into b from public.business_days where day=v_day;
 if b.day is not null and v_admin then v_report:=coalesce(b.report,private.business_day_report(v_day)); end if;
 v_state:=jsonb_build_object('day',v_day,'revision',coalesce(b.revision,0),
  'openingNio',b.opening_nio,'openingUsd',b.opening_usd,'openedAt',extract(epoch from b.opened_at),
  'closedAt',extract(epoch from b.closed_at),'report',case when v_report is null then null else
   v_report||jsonb_build_object(
    'products',coalesce((select jsonb_agg(value order by value::text) from jsonb_array_elements(v_report->'products')),'[]'::jsonb),
    'payments',coalesce((select jsonb_agg(value order by value::text) from jsonb_array_elements(v_report->'payments')),'[]'::jsonb)) end);
 return jsonb_build_object('today',v_today,'day',v_day,
  'status',case when b.day is null then 'not_opened' when b.closed_at is null then 'open' else 'closed' end,
  'openDay',(select day from public.business_days where closed_at is null),
  'openedAt',b.opened_at,'closedAt',b.closed_at,
  'openingNio',case when v_admin then b.opening_nio end,'openingUsd',case when v_admin then b.opening_usd end,
  'report',case when v_admin then v_report end,'revision',coalesce(b.revision,0),
  'reopenCount',coalesce(b.reopen_count,0),'serverNow',now(),'stateToken',case when v_admin then md5(v_state::text) else '' end);
end $$;

create or replace function private.open_business_day(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_day date:=(now() at time zone 'America/Managua')::date; b public.business_days%rowtype;
 v_request uuid:=(p_input->>'requestId')::uuid; v_nio numeric; v_usd numeric;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_request is null then raise exception 'Falta el identificador de apertura.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 -- Un reintento después de medianoche sólo consulta la apertura ya procesada.
 select * into b from public.business_days where opening_request=v_request;
 if found then
  if b.opened_by<>auth.uid() or b.opening_payload<>p_input then raise exception 'La solicitud de apertura cambió.'; end if;
  return private.get_business_day(b.day);
 end if;
 if p_input ? 'expectedDay' and (p_input->>'expectedDay')::date is distinct from v_day then
  raise exception 'La fecha cambió. Actualiza la jornada antes de abrir la tienda.';
 end if;
 if exists(select 1 from public.business_days where closed_at is null) then raise exception 'Primero cierra la jornada pendiente.'; end if;
 if exists(select 1 from public.business_days where day=v_day) then raise exception 'Esta jornada ya fue cerrada. Si el cierre fue accidental, solicita su reapertura.'; end if;
 if exists(select 1 from private.business_day_events where request_id=v_request) then raise exception 'El identificador ya corresponde a otra operación de jornada.'; end if;
 v_nio:=private.accounting_number(p_input,'openingNio',100000000,2);
 v_usd:=private.accounting_number(p_input,'openingUsd',100000000,2);
 insert into public.business_days(day,opening_nio,opening_usd,opened_by,opening_request,opening_payload)
 values(v_day,v_nio,v_usd,auth.uid(),v_request,p_input);
 return private.get_business_day(v_day);
end $$;

create or replace function private.close_business_day(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.business_days%rowtype; e private.business_day_events%rowtype;
 v_day date:=(p_input->>'day')::date; v_today date:=(now() at time zone 'America/Managua')::date;
 v_report jsonb; v_request uuid:=(p_input->>'requestId')::uuid; v_nio numeric; v_usd numeric;
 v_note text:=btrim(coalesce(p_input->>'note','')); v_state jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_request is null then raise exception 'Falta el identificador del cierre.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 -- Es indispensable consultar el historial antes del estado vigente: repetir
 -- el primer cierre después de reabrir nunca debe volver a cerrar la tienda.
 select * into e from private.business_day_events where request_id=v_request;
 if found then
  if e.event<>'close' or e.actor_id<>auth.uid() or e.request_payload<>p_input then
   raise exception 'La solicitud de cierre cambió.';
  end if;
  return private.get_business_day(e.day);
 end if;
 select * into b from public.business_days where day=v_day for update;
 if not found then raise exception 'La jornada no está abierta.'; end if;
 if b.closed_at is not null then raise exception 'La jornada ya está cerrada.'; end if;
 if (p_input ? 'expectedRevision' and (p_input->>'expectedRevision')::integer is distinct from b.revision)
  or (b.reopen_count>0 and not(p_input ? 'expectedRevision')) then
  raise exception 'La jornada cambió. Actualiza sus datos antes de cerrar.';
 end if;
 v_state:=private.get_business_day(v_day);
 if (p_input ? 'expectedStateToken' and (p_input->>'expectedStateToken') is distinct from v_state->>'stateToken')
  or (b.reopen_count>0 and not(p_input ? 'expectedStateToken')) then
  raise exception 'Los movimientos de la jornada cambiaron. Actualiza el reporte y revisa el efectivo antes de cerrar.';
 end if;
 if v_day<v_today and length(v_note)<10 then raise exception 'Indica el motivo del cierre tardío (al menos 10 caracteres).'; end if;
 if v_day>v_today then raise exception 'No se puede cerrar una jornada futura.'; end if;
 v_nio:=private.accounting_number(p_input,'countedNio',100000000,2);
 v_usd:=private.accounting_number(p_input,'countedUsd',100000000,2);
 v_report:=v_state->'report';
 if length(v_note)>1000 then raise exception 'La observación admite hasta 1000 caracteres.'; end if;
 if (v_nio<>(v_report->>'expectedNio')::numeric or v_usd<>(v_report->>'expectedUsd')::numeric) and v_note='' then
  raise exception 'Indica el motivo de la diferencia de caja.';
 end if;
 if exists(select 1 from public.business_days where opening_request=v_request) then raise exception 'El identificador ya corresponde a una apertura.'; end if;
 v_report:=v_report||jsonb_build_object('countedNio',v_nio,'countedUsd',v_usd,
  'differenceNio',v_nio-(v_report->>'expectedNio')::numeric,
  'differenceUsd',v_usd-(v_report->>'expectedUsd')::numeric,'note',v_note);
 update public.business_days set closed_at=now(),closed_by=auth.uid(),closing_request=v_request,closing_payload=p_input,
  report=v_report,revision=revision+1 where day=v_day returning * into b;
 insert into private.business_day_events(day,event,revision,actor_id,actor_name,reason,request_id,request_payload,report,opening_snapshot)
 values(v_day,'close',b.revision,auth.uid(),coalesce((select display_name from private.business_actors where id=auth.uid()),'Administrador'),
  v_note,v_request,p_input,v_report,jsonb_build_object('openingNio',b.opening_nio,'openingUsd',b.opening_usd,
  'openedAt',b.opened_at,'closedAt',b.closed_at));
 return private.get_business_day(v_day);
end $$;

create function private.reopen_business_day(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.business_days%rowtype; e private.business_day_events%rowtype;
 v_day date:=(p_input->>'day')::date; v_today date:=(now() at time zone 'America/Managua')::date;
 v_request uuid:=(p_input->>'requestId')::uuid; v_reason text:=btrim(coalesce(p_input->>'reason',''));
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_request is null then raise exception 'Falta el identificador de reapertura.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 select * into e from private.business_day_events where request_id=v_request;
 if found then
  if e.event<>'reopen' or e.actor_id<>auth.uid() or e.request_payload<>p_input then
   raise exception 'La solicitud de reapertura cambió.';
  end if;
  return private.get_business_day(e.day);
 end if;
 if v_day is distinct from v_today then raise exception 'Sólo se puede reabrir la jornada de hoy. Los cierres de días anteriores se conservan.'; end if;
 if length(v_reason) not between 10 and 1000 then raise exception 'Indica el motivo de reapertura (entre 10 y 1000 caracteres).'; end if;
 select * into b from public.business_days where day=v_day for update;
 if not found or b.closed_at is null then raise exception 'La jornada no está cerrada.'; end if;
 if not(p_input ? 'expectedRevision') or (p_input->>'expectedRevision')::integer is distinct from b.revision then
  raise exception 'La jornada cambió. Actualiza sus datos antes de reabrir.';
 end if;
 if exists(select 1 from public.business_days where closed_at is null) then raise exception 'Primero cierra la jornada pendiente.'; end if;
 if exists(select 1 from public.business_days where opening_request=v_request) then raise exception 'El identificador ya corresponde a una apertura.'; end if;
 update public.business_days set closed_at=null,closed_by=null,closing_request=null,closing_payload=null,report=null,
  revision=revision+1,reopen_count=reopen_count+1 where day=v_day returning * into b;
 insert into private.business_day_events(day,event,revision,actor_id,actor_name,reason,request_id,request_payload,opening_snapshot)
 values(v_day,'reopen',b.revision,auth.uid(),coalesce((select display_name from private.business_actors where id=auth.uid()),'Administrador'),
  v_reason,v_request,p_input,jsonb_build_object('openingNio',b.opening_nio,'openingUsd',b.opening_usd,'openedAt',b.opened_at));
 return private.get_business_day(v_day);
end $$;

create function private.get_business_day_history(p_day date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_day is null then raise exception 'Selecciona la fecha de la jornada.'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'day',day,'event',event,'revision',revision,
  'createdAt',created_at,'actorId',actor_id,'actorName',actor_name,'reason',reason,'requestId',request_id,
  'report',case when report is not null then report||opening_snapshot end) order by revision desc),'[]'::jsonb)
 into v_result from private.business_day_events where day=p_day;
 return v_result;
end $$;

create function public.reopen_business_day(p_input jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select private.reopen_business_day(p_input); $$;
create function public.get_business_day_history(p_day date) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.get_business_day_history(p_day); $$;
revoke all on function private.reopen_business_day(jsonb),private.get_business_day_history(date),
 public.reopen_business_day(jsonb),public.get_business_day_history(date) from public,anon;
grant execute on function private.reopen_business_day(jsonb),private.get_business_day_history(date),
 public.reopen_business_day(jsonb),public.get_business_day_history(date) to authenticated;

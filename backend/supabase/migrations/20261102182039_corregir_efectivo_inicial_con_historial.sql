-- El efectivo de apertura es un conteo de caja, no un ingreso contable.
-- Se corrige únicamente una jornada abierta y se conserva cada cambio.
alter table private.business_day_events
 drop constraint business_day_events_event_check;
alter table private.business_day_events
 add constraint business_day_events_event_check check(event in ('close','reopen','correct'));

create function private.correct_business_day(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 v_day date:=(p_input->>'day')::date;
 v_request uuid:=(p_input->>'requestId')::uuid;
 v_reason text:=btrim(coalesce(p_input->>'reason',''));
 v_nio numeric; v_usd numeric; v_before jsonb;
 b public.business_days%rowtype; e private.business_day_events%rowtype;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if v_request is null then raise exception 'Falta el identificador de la corrección.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('lcp-business-day',0));
 select * into e from private.business_day_events where request_id=v_request;
 if found then
  if e.event<>'correct' or e.actor_id<>auth.uid() or e.request_payload<>p_input then
   raise exception 'La solicitud de corrección cambió.';
  end if;
  return private.get_business_day(e.day);
 end if;
 if v_day is null or v_day>(now() at time zone 'America/Managua')::date then
  raise exception 'Selecciona una jornada abierta.';
 end if;
 if length(v_reason) not between 10 and 1000 then
  raise exception 'Indica el motivo de la corrección (entre 10 y 1000 caracteres).';
 end if;
 select * into b from public.business_days where day=v_day for update;
 if not found then raise exception 'La jornada no está abierta. Abre la tienda desde Inicio.'; end if;
 if b.closed_at is not null then
  raise exception 'La jornada está cerrada. Si corresponde a hoy, reábrela antes de corregir el efectivo inicial.';
 end if;
 if not(p_input ? 'expectedRevision') or (p_input->>'expectedRevision')::integer is distinct from b.revision then
  raise exception 'La apertura cambió. Actualiza sus datos antes de corregirla.';
 end if;
 if exists(select 1 from public.business_days where opening_request=v_request) then
  raise exception 'El identificador ya corresponde a otra operación de jornada.';
 end if;
 v_nio:=private.accounting_number(p_input,'openingNio',100000000,2);
 v_usd:=private.accounting_number(p_input,'openingUsd',100000000,2);
 if v_nio=b.opening_nio and v_usd=b.opening_usd then
  raise exception 'Los importes ya coinciden con la apertura actual.';
 end if;
 perform private.limit_catalog_writes();
 v_before:=jsonb_build_object('openingNio',b.opening_nio,'openingUsd',b.opening_usd);
 update public.business_days set opening_nio=v_nio,opening_usd=v_usd,revision=revision+1
  where day=v_day returning * into b;
 insert into private.business_day_events(day,event,revision,actor_id,actor_name,reason,request_id,request_payload,opening_snapshot)
 values(v_day,'correct',b.revision,auth.uid(),
  coalesce((select display_name from private.business_actors where id=auth.uid()),'Administrador'),
  v_reason,v_request,p_input,jsonb_build_object('before',v_before,
   'after',jsonb_build_object('openingNio',v_nio,'openingUsd',v_usd)));
 return private.get_business_day(v_day);
end $$;
create function public.correct_business_day(p_input jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select private.correct_business_day(p_input); $$;
revoke all on function private.correct_business_day(jsonb),public.correct_business_day(jsonb) from public,anon;
grant execute on function private.correct_business_day(jsonb),public.correct_business_day(jsonb) to authenticated;

create or replace function private.get_business_day_history(p_day date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 if p_day is null then raise exception 'Selecciona la fecha de la jornada.'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'day',day,'event',event,'revision',revision,
  'createdAt',created_at,'actorId',actor_id,'actorName',actor_name,'reason',reason,'requestId',request_id,
  'report',case when report is not null then report||opening_snapshot end,
  'openingCorrection',case when event='correct' then opening_snapshot end) order by revision desc),'[]'::jsonb)
 into v_result from private.business_day_events where day=p_day;
 return v_result;
end $$;

-- La recuperación y el descarte de solicitudes siguen usando el identificador
-- original; el trigger existente impide ejecutar una solicitud ya descartada.
do $$ declare s text; begin
 s:=pg_get_functiondef('private.operation_confirmation(text,uuid,boolean)'::regprocedure);
 if position('''business-day-open'',''business-day-close'',''business-day-reopen'') then' in s)=0
  or position('when ''business-day-close'',''business-day-reopen'' then' in s)=0
  or position('case when p_kind=''business-day-close'' then ''close'' else ''reopen'' end' in s)=0 then
  raise exception 'Revisar la recuperación de jornadas antes de aplicar esta actualización.';
 end if;
 s:=replace(s,'''business-day-open'',''business-day-close'',''business-day-reopen'') then',
  '''business-day-open'',''business-day-close'',''business-day-reopen'',''business-day-correct'') then');
 s:=replace(s,'when ''business-day-close'',''business-day-reopen'' then',
  'when ''business-day-close'',''business-day-reopen'',''business-day-correct'' then');
 s:=replace(s,'case when p_kind=''business-day-close'' then ''close'' else ''reopen'' end',
  'case p_kind when ''business-day-close'' then ''close'' when ''business-day-correct'' then ''correct'' else ''reopen'' end');
 execute s;
end $$;

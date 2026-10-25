-- Se sugiere lo contado en el último cierre, sin abrir la tienda ni registrar
-- dinero. El administrador puede cambiar ambos importes antes de confirmar.
create function private.previous_cash_closing(p_day date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b public.business_days%rowtype; v_nio numeric; v_usd numeric;
begin
 if auth.uid() is null or private.staff_role() is distinct from 'admin' then raise insufficient_privilege; end if;
 select * into b from public.business_days where day<p_day and closed_at is not null order by day desc limit 1;
 if not found or jsonb_typeof(b.report->'countedNio') is distinct from 'number'
  or jsonb_typeof(b.report->'countedUsd') is distinct from 'number' then return null; end if;
 v_nio:=(b.report->>'countedNio')::numeric; v_usd:=(b.report->>'countedUsd')::numeric;
 if not (v_nio between 0 and 100000000 and v_usd between 0 and 100000000)
  or v_nio<>round(v_nio,2) or v_usd<>round(v_usd,2) then return null; end if;
 return jsonb_build_object('day',b.day,'countedNio',v_nio,'countedUsd',v_usd,'closedAt',b.closed_at,'revision',b.revision);
end $$;
revoke all on function private.previous_cash_closing(date) from public,anon,authenticated;

do $migration$
declare v_definition text; v_marker text:='''serverNow'',now(),''stateToken''';
begin
 v_definition:=pg_get_functiondef('private.get_business_day(date)'::regprocedure);
 if position(v_marker in v_definition)=0 then raise exception 'No se encontró la definición de jornada esperada.'; end if;
 v_definition:=replace(v_definition,v_marker,
  '''openingSuggestion'',case when v_admin and v_day=v_today and b.day is null then private.previous_cash_closing(v_day) end,'||v_marker);
 execute v_definition;
end $migration$;
notify pgrst,'reload schema';

-- Comprobar el rol real de la tabla de personal antes de cualquier anulación,
-- incluso ante reintentos o llamadas directas a las funciones públicas.
do $guards$
declare signature text; definition text; marker text;
begin
 foreach signature in array array[
  'public.delete_invoice(uuid,text)',
  'private.void_expense(uuid,text)',
  'private.void_finance_entry(uuid,text)',
  'private.void_journal_entry(uuid,text)',
  'private.void_cash_closing(uuid,text)',
  'private.correct_purchase(jsonb)'
 ] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  marker:=(regexp_match(definition,'(?i)\mbegin\M'))[1];
  if marker is null then raise exception 'No se pudo proteger %',signature; end if;
  definition:=regexp_replace(definition,'(?i)\mbegin\M',
   marker||E'\n if not private.is_superadmin() then raise exception ''Solo un SuperAdmin puede anular operaciones.'' using errcode=''42501''; end if;');
  execute definition;
 end loop;
end $guards$;

create function private.snapshot_price(p_prices jsonb,p_tier text,p_currency text)
returns numeric language sql immutable set search_path='' as $$
 select case jsonb_typeof(p_prices)
 when 'array' then (select (e->>'amount')::numeric from jsonb_array_elements(p_prices) e
   where e->>'tier_code'=p_tier and e->>'currency'=p_currency limit 1)
 when 'object' then (p_prices->p_tier->>p_currency)::numeric end;
$$;
revoke all on function private.snapshot_price(jsonb,text,text) from public,anon,authenticated;

-- Los respaldos de importación conservan arreglos; el editor guarda objetos.
-- Se leen ambos formatos sin modificar ni inventar eventos históricos.
do $history$
declare definition text;
begin
 definition:=pg_get_functiondef('private.price_history(uuid)'::regprocedure);
 definition:=regexp_replace(definition,
  '\(case when jsonb_typeof\(c.before_data->''prices''\)=''array'' then[\s\S]*?end\) as before_usd',
  'private.snapshot_price(c.before_data->''prices'',t.tier,''USD'') as before_usd');
 definition:=regexp_replace(definition,
  '\(case when jsonb_typeof\(c.before_data->''prices''\)=''array'' then[\s\S]*?end\) as before_nio',
  'private.snapshot_price(c.before_data->''prices'',t.tier,''NIO'') as before_nio');
 definition:=replace(definition,'(c.after_data->''prices''->t.tier->>''USD'')::numeric',
  'private.snapshot_price(c.after_data->''prices'',t.tier,''USD'')');
 definition:=replace(definition,'(c.after_data->''prices''->t.tier->>''NIO'')::numeric',
  'private.snapshot_price(c.after_data->''prices'',t.tier,''NIO'')');
 definition:=replace(definition,'''save'',''pricing'',''cost_pricing''',
  '''save'',''pricing'',''cost_pricing'',''catalog_completion'',''cost_import'',''source_correction''');
 definition:=replace(definition,'limit 200','limit 2000');
 execute definition;
end $history$;

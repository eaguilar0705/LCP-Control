-- La confirmación de una ubicación vacía no puede borrar un conteo que otra
-- persona registró mientras el cuadro estaba abierto. Las llamadas anteriores
-- siguen funcionando sin expectedQuantity y los reintentos conservan su id.
do $migration$
declare
 s text:=replace(pg_get_functiondef('private.record_inventory_movement(jsonb)'::regprocedure),chr(13),'');
 a text:='if v_request is null then raise exception ''Falta el identificador de operación.''; end if;';
 b text:='if v_existing.product_id<>v_product';
 c text:='if v_before is null and v_type<>''ADJUSTMENT'' then';
begin
 if position(a in s)=0 or position(b in s)=0 or position(c in s)=0 then
  raise exception 'No se encontró la función de movimientos esperada.';
 end if;
 s:=replace(s,a,a||$patch$
 if p_payload ? 'expectedQuantity' then
  if jsonb_typeof(p_payload->'expectedQuantity')='number' then
   if (p_payload->>'expectedQuantity')::numeric<0
    or (p_payload->>'expectedQuantity')::numeric>1000000
    or (p_payload->>'expectedQuantity')::numeric<>trunc((p_payload->>'expectedQuantity')::numeric) then
    raise exception 'El conteo esperado debe ser entero y válido.';
   end if;
  elsif jsonb_typeof(p_payload->'expectedQuantity') is distinct from 'null' then
   raise exception 'El conteo esperado debe ser entero o estar pendiente.';
  end if;
 end if;
$patch$);
 s:=replace(s,b,$patch$
  if p_payload ? 'expectedQuantity' and v_existing.before_quantity is distinct from (p_payload->>'expectedQuantity')::integer then
   raise exception 'La operación ya existe con otro conteo esperado.';
  end if;
  $patch$||b);
 s:=replace(s,c,$patch$
 if p_payload ? 'expectedQuantity' and v_before is distinct from (p_payload->>'expectedQuantity')::integer then
  raise exception 'Las existencias cambiaron. Actualiza el inventario antes de confirmar el conteo.';
 end if;
 $patch$||c);
 execute s;
end $migration$;
notify pgrst,'reload schema';

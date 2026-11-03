-- El conteo físico corrige existencias sin registrar una compra. Sólo un
-- SuperAdmin activo puede hacerlo; se conservan el historial antes/después,
-- el control expectedQuantity y los registros contables del movimiento.
-- Esta restricción vive en el RPC manual y no afecta devoluciones, anulaciones
-- ni otros procesos que generan movimientos de ajuste internamente.
do $migration$
declare
 s text:=replace(pg_get_functiondef('private.record_inventory_movement(jsonb)'::regprocedure),chr(13),'');
 marker text:='if v_role not in (''admin'',''warehouse'') and v_type in (''ENTRY'',''ADJUSTMENT'') then raise exception ''Solo un dueño puede registrar entradas y ajustes.''; end if;';
begin
 if position(marker in s)=0 then
  raise exception 'No se encontró el control de permisos de movimientos esperado.';
 end if;
 s:=replace(s,marker,$patch$
 if v_type='ADJUSTMENT' and not private.is_superadmin() then
  raise exception 'Solo un SuperAdmin puede ajustar las existencias.' using errcode='42501';
 end if;
 if v_role not in ('admin','warehouse') and v_type='ENTRY' then
  raise exception 'No tienes permiso para registrar entradas.' using errcode='42501';
 end if;
 $patch$);
 execute s;
end $migration$;
notify pgrst,'reload schema';

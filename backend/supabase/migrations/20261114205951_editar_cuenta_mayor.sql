-- Reutiliza el bloqueo, revisión y auditoría de la edición de cuentas.
do $migration$
declare
 definition text:=pg_get_functiondef('private.change_ledger_account(jsonb)'::regprocedure);
 marker text:='if v_name=a.name and v_display=coalesce(a.display_code,a.code) then';
 update_marker text:='set name=v_name,display_code=nullif(v_display,v_code) where code=v_code';
begin
 if position(marker in definition)=0 or position(update_marker in definition)=0 then
  raise exception 'Revisa la definición vigente de edición de cuentas.';
 end if;
 definition:=replace(definition,marker,$validation$
   if p_input ? 'parent' and p_input->>'parent' is distinct from a.parent then
    if a.parent is null then raise exception 'La cuenta principal conserva su nivel.'; end if;
    select * into p from public.ledger_accounts where code=p_input->>'parent' and active for update;
    if not found or p.bucket<>a.bucket or p.nature<>a.nature or left(p.code,1)<>left(a.code,1) then
     raise exception 'Selecciona una cuenta mayor activa del mismo tipo y naturaleza.';
    end if;
    if exists(
     with recursive ancestors(code,parent) as (
      select p.code,p.parent
      union
      select x.code,x.parent from public.ledger_accounts x join ancestors s on x.code=s.parent
     )
     select 1 from ancestors where code=a.code
    ) then raise exception 'Elige una cuenta mayor distinta de esta cuenta y sus subcuentas.'; end if;
   end if;
   if v_name=a.name and v_display=coalesce(a.display_code,a.code)
    and (not(p_input ? 'parent') or p_input->>'parent' is not distinct from a.parent) then$validation$);
 definition:=replace(definition,update_marker,
  'set name=v_name,display_code=nullif(v_display,v_code),parent=case when p_input ? ''parent'' then p_input->>''parent'' else a.parent end where code=v_code');
 execute definition;
end $migration$;

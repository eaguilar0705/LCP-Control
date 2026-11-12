-- Los aumentos por ajuste usan una cuenta de orden propia, sin pedir una
-- contrapartida en cada operación. Las deducciones conservan su selección y
-- los movimientos históricos conservan sus cuentas originales.
create table private.inventory_adjustment_defaults (
 singleton boolean primary key default true check(singleton),
 increase_account text not null references public.ledger_accounts(code)
);
alter table private.inventory_adjustment_defaults enable row level security;
revoke all on private.inventory_adjustment_defaults from public,anon,authenticated;

-- Asignar un código libre sin reutilizar ni modificar las cuentas del dueño.
do $account$
declare account_code text;
begin
 perform pg_advisory_xact_lock(hashtextextended('ledger-accounts',0));
 select '7000-'||lpad(n::text,3,'0') into account_code
 from generate_series(1,999)n
 where not exists(select 1 from public.ledger_accounts a where a.code='7000-'||lpad(n::text,3,'0'))
 order by n limit 1;
 if account_code is null then raise exception 'No hay un código libre bajo Cuentas de orden para Ajustes de inventario.'; end if;
 insert into public.ledger_accounts(code,name,parent,bucket,nature,postable,active)
 values(account_code,'Ajustes de inventario','7000','memorandum','debit',true,true);
 insert into private.inventory_adjustment_defaults(increase_account) values(account_code);
end $account$;

-- Resolver la cuenta antes de comprobar el requestId conserva la recuperación
-- de la misma operación. El cambio de cantidades, valoración y comprobante
-- sigue siendo una sola transacción con los mismos bloqueos y permisos.
do $movement$
declare definition text; marker text;
begin
 definition:=replace(pg_get_functiondef('private.record_inventory_movement(jsonb)'::regprocedure),E'\r\n',E'\n');
 marker:=' v_adjustment_kind text:=p_payload->>''adjustmentKind''; v_counter_account text:=p_payload->>''counterAccount'';';
 if position(marker in definition)=0 then raise exception 'Revisar las variables del ajuste de inventario.'; end if;
 definition:=replace(definition,marker,marker||E'\n'||
  ' v_automatic_counter_account boolean:=coalesce(v_adjustment_kind=''correction'' and not (p_payload ? ''counterAccount''),false);');
 marker:=' if p_payload ? ''adjustmentKind'' or p_payload ? ''counterAccount'' then';
 if position(marker in definition)=0 then raise exception 'Revisar la validación del ajuste de inventario.'; end if;
 definition:=replace(definition,marker,$default$
 if v_automatic_counter_account then
  select increase_account into v_counter_account from private.inventory_adjustment_defaults where singleton;
  if v_counter_account is null then raise exception 'Falta configurar la cuenta de orden de ajustes de inventario.'; end if;
 end if;
$default$||marker);
 marker:=' if v_adjustment_kind is not null then';
 if position(marker in definition)=0 then raise exception 'Revisar el conteo y la contrapartida del ajuste.'; end if;
 definition:=replace(definition,marker,$direction$
 if v_automatic_counter_account and (v_before is null or v_after<=v_before) then
  raise exception 'La cuenta de orden automática solo se utiliza al aumentar existencias. Para una deducción, selecciona la cuenta de contrapartida.';
 end if;
 if v_automatic_counter_account and not exists(select 1 from public.ledger_accounts
  where code=v_counter_account and active and postable and bucket='memorandum') then
  raise exception 'La cuenta de orden de ajustes de inventario debe estar activa y permitir movimientos. Revísala en Contabilidad → Catálogo de cuentas.';
 end if;
$direction$||marker);
 execute definition;
end $movement$;

notify pgrst,'reload schema';

-- Las cuentas de orden acumulan correcciones sin reconocer ingresos, costos
-- ni gastos. Solo se crea su cuenta mayor; el dueño crea sus propias cuentas
-- de movimiento desde Administrar cuentas. No se reclasifica ningún histórico.
alter table public.ledger_accounts drop constraint ledger_accounts_code_check;
alter table public.ledger_accounts add constraint ledger_accounts_code_check
 check(code ~ '^[1-7][0-9]{3}(-[0-9]{3}){0,3}$');
alter table public.ledger_accounts drop constraint ledger_accounts_bucket_check;
alter table public.ledger_accounts add constraint ledger_accounts_bucket_check
 check(bucket in ('asset','liability','equity','revenue','cost','expense','tax','memorandum'));

insert into public.ledger_accounts(code,name,parent,bucket,nature,postable)
 values('7000','Cuentas de orden',null,'memorandum','debit',false);

-- Conservar validaciones, permisos, revisiones, auditoría e idempotencia de
-- las cuentas existentes. El grupo 7 hereda tipo y naturaleza de su mayor.
do $account_codes$
declare definition text; signature text; marker text:='[1-6][0-9]{3}';
begin
 foreach signature in array array[
  'private.change_ledger_account(jsonb)',
  'private.import_business_excel(jsonb,boolean)'
 ] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if position(marker in definition)=0 then
   raise exception 'Revisar la validación de códigos de %.',signature;
  end if;
  execute replace(definition,marker,'[1-7][0-9]{3}');
 end loop;
end $account_codes$;

-- Se usa el mismo comprobante vinculado y el mismo costo congelado que en
-- las correcciones de balance. La pérdida real continúa siendo explícita y
-- utiliza 5150; la cuenta mayor 7000 no admite movimientos directamente.
do $adjustment_accounts$
declare definition text; marker text;
begin
 definition:=pg_get_functiondef('private.record_inventory_movement(jsonb)'::regprocedure);
 marker:='and active and postable and bucket in (''asset'',''liability'',''equity'') and code not in (''1130'',''5150'')';
 if position(marker in definition)=0 then
  raise exception 'Revisar las contrapartidas permitidas para correcciones de inventario.';
 end if;
 definition:=replace(definition,marker,
  'and active and postable and bucket in (''asset'',''liability'',''equity'',''memorandum'') and code not in (''1130'',''5150'')');
 definition:=replace(definition,
  'Selecciona una cuenta de contrapartida activa de activo, pasivo o capital, distinta de Inventario y Pérdidas de inventario.',
  'Selecciona una cuenta de contrapartida activa de activo, pasivo, capital o cuentas de orden, distinta de Inventario y Pérdidas de inventario.');
 execute definition;
end $adjustment_accounts$;

-- El mayor y la balanza incluyen todas las cuentas. Los estados se presentan
-- por clasificación: memorandum no pertenece a resultados ni a situación
-- financiera. Una diferencia de conciliación no se convierte en utilidad.
notify pgrst,'reload schema';

-- Los gastos del negocio se llevan en cinco cuentas: impuestos y tasas, pago de
-- préstamos, gastos financieros, gastos de ventas y gastos operativos. Aquí sólo
-- viven las categorías que alguien teclea; las dos de gastos operativos —compra
-- de mercadería y flete de importación— salen de los pedidos ya registrados y
-- por eso no aparecen en esta lista: registrarlas otra vez sería contarlas dos
-- veces. La cuenta a la que pertenece cada categoría se deduce en la aplicación,
-- no se guarda: así una fila nunca puede quedar en una cuenta que no le toca.
alter table public.expense_records drop constraint expense_records_category_check;
alter table public.expense_records add constraint expense_records_category_check check(
 category in (
  'impuestos_dgi','impuestos_alma',
  'prestamo_acreedor','prestamo_bancario',
  'interes_bancario','interes_acreedor',
  'renta','salario','papeleria','combustible','agua_luz','internet',
  'limpieza','mobiliario','viatico','marketing'
 )
);

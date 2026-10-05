# Contabilidad de La Casa del Perfume

Desarrollo del 3 de octubre de 2026, con Cierre diario actualizado el 4 de octubre. La contabilidad conecta el inventario, las facturas, los pedidos, los gastos y los abonos. Sólo Administrador y SuperAdmin pueden consultar o modificar este módulo.

## Instalación en Supabase

Las migraciones de contabilidad están **aplicadas en la base real** de **La Casa del Perfume**, proyecto `xkpujpoocsbkychstrne`, verificado el 3 de octubre de 2026. La base del libro de dinero ya estaba instalada; se aplicaron las otras cuatro migraciones en orden y se comprobaron los reportes con permisos de administración. La venta existente coincide con los ingresos, y los registros del negocio se conservaron. El [historial del proyecto](../reports/historial-del-proyecto.md) resume el trabajo realizado en contabilidad y su despliegue.

Las migraciones de este flujo, en orden de instalación, son:

1. `20261003120000_finance_ledger_without_tax.sql`: caja, banco y forma de pago de pedidos y gastos.
2. `20261003220645_linked_credit_payments.sql`: abonos vinculados, apertura explícita de cero y controles de saldo.
3. `20261003220730_cashflow_cash_closing.sql`: flujo agregado y arqueos guardados.
4. `20261003224314_cashflow_snapshot_product_identity.sql`: comprueba que cada importe de una factura pertenezca al mismo perfume antes de calcular el flujo y permitir un arqueo.
5. `20261003225145_prevent_deleted_invoice_replay.sql`: conserva la identidad de una factura eliminada y rechaza solicitudes tardías que intentarían volver a crearla.

No repetir una migración ya aplicada. Las RPC de lectura respetan el rol; las tablas no admiten escritura directa desde el navegador. Las funciones que escriben verifican permisos, guardan al responsable y reutilizan el identificador ante un reintento con los mismos datos.

Comprobación de instalación:

```sql
select to_regprocedure('public.credit_accounts(date)'),
       to_regprocedure('public.finance_cashflow(date,date)'),
       to_regprocedure('public.record_cash_closing(jsonb)'),
       to_regprocedure('public.list_cash_closings(date,date)');
```

Ejecutar `npm run check` y `npm run typecheck` para comprobar lint, compilación y tipos. En una base de desarrollo con datos sintéticos, revisar que ventas, costos, existencias, dinero y abonos coincidan en los reportes y que se respeten los permisos. El [historial del proyecto](../reports/historial-del-proyecto.md) resume las verificaciones anteriores.

## Empezar con saldos reales

En **Contabilidad → Caja y bancos → Registrar**, elegir **Saldo inicial** y registrar las cinco cuentas con **la misma fecha**:

- Caja: efectivo disponible.
- Banco: dinero en las cuentas del negocio, consolidado en una sola cuenta contable.
- Cuentas por cobrar: deudas de clientes que ya existían antes del arranque.
- Préstamos por pagar: capital pendiente, sin sumar intereses futuros.
- Cuentas por pagar a proveedores: compras pendientes anteriores al arranque.

Si una cuenta no tiene saldo, registrar **0** explícitamente. No se supone que una cuenta sin apertura esté en cero. Para corregir una apertura, anular su registro con motivo y volver a registrarla. Si hay abonos aplicados a una deuda inicial, primero se anulan esos abonos. Las operaciones anteriores al arranque no se vuelven a sumar a los saldos.

Contar los perfumes en tienda y bodega y registrar su costo inicial antes de vender permite conocer el margen de las ventas futuras. Un costo desconocido deja la utilidad pendiente; no equivale a cero.

## Trabajar con crédito y abonos

**Venta a crédito:** emitir la factura con pago **Pendiente**. La venta y el costo vendido se reconocen al emitir, y el saldo queda por cobrar. En **Cobros y pagos**, seleccionar su factura y registrar el abono en caja o banco. El sistema conserva el importe original, lo abonado y lo pendiente a la fecha de corte.

**Compra a crédito:** registrar el pedido con pago **Crédito del proveedor**. El pedido recibe existencias y actualiza el costo promedio con el envío. En **Cobros y pagos**, seleccionar el pedido y registrar su abono. La compra a crédito no sale de caja hasta pagarse.

Un abono debe corresponder a la factura, pedido o saldo inicial seleccionado. No puede ser anterior al documento ni superar el saldo disponible. Dos personas no pueden cobrar el mismo saldo simultáneamente por encima de la deuda. Un abono anulado reabre el saldo y conserva su motivo. Una factura que respalda abonos conserva ese historial y no se puede borrar completamente.

Las deudas anteriores al inicio permanecen como un **saldo inicial agregado**, sin inventar qué factura o pedido las originó. Los abonos antiguos que carecen de vínculo se advierten para conciliación; no se asignan automáticamente a una persona.

Los saldos están expresados en NIO usando la tasa de cada operación. Si una deuda en dólares se liquida a una tasa distinta, el saldo mostrado es el equivalente contable registrado; este módulo no calcula revaluación de deudas ni diferencia cambiaria separada. Revisar ese caso antes de liquidar la deuda.

## Revisar dinero y utilidad

**Resumen** muestra ventas y utilidad del período, caja y banco al corte, y saldos de clientes, proveedores y préstamos. También señala aperturas y costos faltantes.

**Flujo de efectivo** muestra cobros y pagos diarios, con caja y banco separados. Los abonos no crean nuevas ventas o compras. Las transferencias internas mueven dinero entre ambas cuentas y se compensan al sumarlas. Las aperturas y transferencias se muestran para conciliación, separadas de los cobros y pagos externos.

**Gastos** registra desde qué cuenta salió el dinero. El capital devuelto de préstamos disminuye la deuda; sólo los intereses son gasto. Aportes y retiros de los dueños se mantienen fuera del resultado comercial.

La compra de perfumes aumenta el inventario y su costo se reconoce al vender. No se registra nuevamente como gasto de mercadería: eso contaría el costo dos veces.

## Revisar el cierre diario

En **Contabilidad → Cierre diario**, elegir la fecha que se desea revisar. Al abrir la vista se propone **hoy según America/Managua**. La consulta muestra las ventas y los movimientos financieros registrados para ese día, sin ingresar cantidades de billetes.

El resumen de ventas distingue monedas y formas de pago. La lista de facturas se consulta por páginas. El detalle financiero reúne gastos, abonos de clientes y a proveedores, aportes, retiros, transferencias, préstamos y compras. Caja y banco muestran sus entradas, salidas y saldos esperados; cuando faltan aperturas o datos, se conservan las advertencias y valores pendientes.

Una venta con pago **Pendiente** forma parte de las ventas del día, pero no del dinero cobrado. Los abonos pueden corresponder a facturas de días anteriores y no se vuelven a contar como ventas. Una transferencia entre caja y banco mueve ambas cuentas y no constituye una entrada externa de dinero. Los saldos y movimientos contables utilizan la tasa conservada en cada operación.

Usar **Actualizar** después de registrar, anular o corregir operaciones desde sus pantallas correspondientes. Cierre diario es una consulta: no escribe registros, no crea un cierre físico ni bloquea la fecha. Ya no ofrece guardar o anular arqueos. Los conteos anteriores permanecen en la base y en la exportación contable; este cambio no requiere migraciones ni permisos nuevos.

## Estados y exportación

El estado de resultados utiliza costos e importes congelados de las ventas. El **balance general es provisional**: no se inventa el patrimonio inicial ni la utilidad acumulada para hacerlo cuadrar. El inventario consultado es el actual; cuando se selecciona otra fecha, su valor histórico y los totales dependientes quedan pendientes. Las razones financieras que necesitan ese valor tampoco se calculan con existencias actuales.

El libro Excel añade movimientos de dinero, cuentas por cobrar y pagar, flujo y arqueos históricos a los estados, gastos y costos. Conserva los valores pendientes y las advertencias de información incompleta. En `/demo/accounting` todos los datos son inventados y los botones de registro están deshabilitados.

No se calculan comprobantes fiscales ni obligaciones tributarias. Tampoco hay vencimientos configurados, cuentas bancarias contables individuales ni asientos manuales de activos fijos. Esos datos necesitan reglas del negocio antes de añadirse.

## Datos pendientes del negocio

- Fecha de inicio y saldos de las cinco cuentas.
- Detalle de clientes y proveedores que forman los saldos iniciales.
- Plazos de crédito y tratamiento acordado para abonos en dólares con tasas distintas.
- Patrimonio inicial, resultados acumulados y otros activos o deudas que deban incorporarse al balance.

El dueño confirmó que hay ventas y compras con crédito o abonos. Los demás datos no se han inventado. Las fuentes audiovisuales y sus límites de acceso están documentados en [contabilidad-videos.md](../research/contabilidad-videos.md).

# Edición de facturas

Solo SuperAdmin puede abrir **Facturación → Facturas emitidas → Editar factura**. La tienda debe estar abierta en la fecha actual. El formulario carga la versión más reciente.

Se pueden corregir cliente, teléfono, RUC, productos, cantidades, ubicación, lista, precios, descuentos por perfume y del total, moneda, tipo de cambio, envío, notas y pagos simples o divididos. Cambiar la lista no sustituye precios automáticamente: **Usar precios de la lista** lo hace explícitamente. El número, fecha de emisión, emisor y autor original se conservan.

**Guardar cambios** actualiza la factura, inventario y contabilidad en una sola transacción. Las unidades que permanecen conservan su costo histórico; las unidades adicionales toman el valor actual del inventario y las retiradas devuelven el costo correspondiente. Cambiar únicamente un pago o cliente no mueve existencias.

El historial conserva versión anterior y posterior, responsable y fecha; permite consultar y descargar cada versión. No se exige escribir un motivo. Si se corrige una factura de una jornada cerrada, se actualiza su reporte con una revisión identificada, conservando el cierre original y los conteos físicos. No se reabre la jornada.

## Cobros y límites

- Los abonos se conservan si la factura sigue por cobrar. El total no puede quedar por debajo de lo ya cobrado.
- Al cambiar a una forma de pago inmediata, los cobros vinculados de la misma fecha quedan anulados con trazabilidad y se incorporan al pago de la factura. El ingreso se cuenta una sola vez.
- Los abonos de otras fechas se conservan: para respetar sus fechas de recepción, la factura continúa por cobrar y la corrección bancaria se hace en **Cobros y pagos**.
- Una factura con notas de crédito conserva su detalle original; se corrige mediante devolución o nueva factura, sin cambiar unidades que ya respaldan una nota de crédito.
- Una pérdida de conexión permite **Verificar guardado** con la misma solicitud. No se vuelve a descontar inventario ni se crea otro número.
- Si otro SuperAdmin modificó la factura mientras estaba abierta, se exige cargar la última versión; no se sobrescribe silenciosamente.

## Validación

`npm run test:invoice-corrections` ejecuta los casos financieros y de permisos en PostgreSQL desechable. `npm run test:browser:invoice-corrections` prueba escritorio y móvil contra ese mismo motor aislado. Las pruebas no cambian operaciones reales ni envían correos.

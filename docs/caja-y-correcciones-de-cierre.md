# Caja y correcciones de cierre

Desde **Inicio**, Admin y SuperAdmin pueden usar **Registrar movimiento de caja** en una jornada abierta o cerrada. Se selecciona gasto/pago, retiro del propietario, depósito a banco, retiro de banco, otra entrada u otra salida; moneda, importe, cuenta de origen/destino y concepto. Los dólares requieren su tipo de cambio. Un pago de una deuda existente se registra contra la cuenta de esa deuda; no se vuelve a reconocer como gasto.

El movimiento genera un comprobante de ajuste numerado, actualiza el libro mayor y el efectivo esperado, y queda en el historial de la jornada. Si se registra después de cerrar, actualiza una nueva revisión del reporte, conservando el conteo físico y el cierre anterior. No reabre la tienda ni cambia facturas. Un depósito o retiro traslada dinero y no genera ventas ni gastos por sí mismo.

**Editar conteo del cierre** permite corregir un importe escrito por error, también de días anteriores, sin reabrir. Conserva fecha/hora y responsable del cierre original. Se recalcula la diferencia y se agrega una revisión al historial; el reporte anterior sigue descargable. Una corrección no cambia las aperturas de días posteriores que ya se guardaron.

El efectivo inicial y el conteo final son arqueos físicos. No sustituyen los saldos iniciales contables ni generan ingresos o gastos. Por eso cambiar únicamente un conteo no cambia la balanza. Para reflejar dinero gastado, retirado o depositado hay que registrar el movimiento y su contrapartida. **La balanza se expresa completamente en córdobas, incluida la cuenta Caja dólares**, convertida a la tasa de cada operación. No se interpreta el importe NIO como dólares físicos.

Las nuevas operaciones se serializan con cierre/facturación; rechazan versiones obsoletas, guardan responsable, fecha y solicitud, y usan reintentos idempotentes. La excepción que permite registrar un movimiento omitido en un día cerrado requiere un contexto privado de esa misma transacción. No habilita ventas, comprobantes genéricos ni acceso directo a modificar días cerrados.

Pruebas aisladas: `npm run test:cash-corrections` y `npm run test:browser:cash-corrections`. Nunca se corrigen saldos reales de forma automática durante la publicación.

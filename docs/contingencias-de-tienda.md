# Contingencias de operación de tienda

Revisión del 16 de octubre de 2026. Una jornada diaria para toda la tienda, con fechas calculadas por PostgreSQL en `America/Managua`. Admin y superadmin abren, cierran y reabren. No se ha definido un horario obligatorio.

## Casos cubiertos

| Situación                                            | Comportamiento                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Abrir temprano o cerrar tarde en el mismo día        | Se permite. Se registra la hora real; no se inventa un horario fijo.                                                                                                                                                                                |
| Cerrar antes de terminar por error                   | Se puede reabrir únicamente la jornada de hoy, con motivo de 10 a 1000 caracteres y revisión del estado actual. Se conservan la apertura y todas las operaciones.                                                                                   |
| Cerrar varias veces después de reaperturas           | Cada cierre conserva su reporte, fecha, responsable, motivo y PDF por revisión. Reabrir no borra los cierres anteriores.                                                                                                                            |
| Dejar abierta la jornada de ayer                     | Las nuevas facturas esperan el cierre pendiente y la apertura de hoy. El cierre tardío exige motivo y vuelve automáticamente a la fecha actual. No hay cierre automático sin arqueo.                                                                |
| Cambiar de día con el formulario de apertura abierto | La fecha esperada se comprueba contra el servidor. Se actualiza y revisa el formulario antes de abrir. Un reintento de una apertura ya registrada consulta la misma operación.                                                                      |
| Otro empleado vende durante el conteo                | El formulario detecta el cambio del reporte. Se deben actualizar los importes y revisar el efectivo. Se conservan las cantidades y el motivo escritos. PostgreSQL vuelve a comprobar el estado al cerrar.                                           |
| Dos administradores intentan abrir, cerrar o reabrir | Un bloqueo de transacción serializa las operaciones. Una revisión antigua no puede modificar una jornada reabierta. Los reintentos de una operación anterior no vuelven a cerrar ni a reabrir.                                                      |
| Venta y cierre casi al mismo tiempo                  | Una venta confirmada antes del cierre pertenece al reporte. Después del cierre se rechazan las facturas nuevas. Las proformas no requieren abrir tienda ni descuentan inventario.                                                                   |
| Efectivo contado distinto al esperado                | Se muestra la diferencia por moneda y se exige un motivo. El efectivo contado no reemplaza el cálculo del esperado.                                                                                                                                 |
| Respuesta perdida al abrir, cerrar o reabrir         | El reintento conserva el identificador y consulta la operación ya procesada, aunque luego cambie el estado.                                                                                                                                         |
| Factura guardada cuya respuesta no llegó             | Se conserva la misma operación para verificarla incluso después de un cierre. No se crea una segunda factura ni se descuenta dos veces el inventario.                                                                                               |
| Fechar un pago en un día anterior                    | Compra pagada, abono o movimiento de dinero pide confirmar cuándo se movió realmente el dinero, o cambiarlo a hoy. Una compra a crédito no representa una salida de efectivo. Las fechas contables históricas siguen permitidas cuando corresponde. |
| Consultar otra fecha mientras carga su historial     | Sólo se muestran los eventos correspondientes a la fecha seleccionada.                                                                                                                                                                              |

## Seguridad y conservación

Al usar Atrás/Adelante durante una emisión, la operación y el formulario se conservan en memoria por usuario. Un aviso permite recuperarlos; cerrar sesión permanece bloqueado mientras falte verificar la emisión.

Si falla la retirada del borrador después de emitir, la factura sigue confirmada. La emisión de un borrador guardado usa un identificador estable: volver a abrirlo recupera el documento original o rechaza datos diferentes, sin crear otra venta.

El historial se guarda en `private.business_day_events`, con RLS y sin lectura directa para `anon` ni `authenticated`. Las funciones verifican el rol antes de entregar importes o registrar operaciones. Los vendedores no reciben los saldos privados de caja ni los reportes de cierre.

La migración `20261016184008_contingencias_de_jornadas.sql` conserva el reporte del cierre existente sin recalcularlo. Al aplicarla se compararon antes y después los datos originales de jornadas, precios, existencias, documentos y comprobantes: permanecieron idénticos. No se abrió, cerró ni reabrió ninguna jornada real durante las pruebas. El análisis de seguridad no añadió advertencias respecto del estado previo.

## Validación

- `npm run test:database`: incluye 121 verificaciones específicas de contingencias, medianoche simulada en Nicaragua, roles, reintentos, revisiones y conservación del historial, además de los flujos existentes de contabilidad e inventario.
- `npm run test:contingencies`: navegador de escritorio y móvil, con peticiones contra PostgreSQL desechable; pérdidas de respuesta, conteos desactualizados, reapertura, cierre de ayer, confirmación de fechas de pago y recuperación de ventas. El grupo de pagos incluye 189 verificaciones y el cambio de día con ambos formularios ya completos, sin editar campos antes de guardar.
- `npm run test:store`: 30 jornadas, 1200 facturas, 120 proformas y 90 compras; 38 352 verificaciones de existencias, caja, auxiliares y mayor.
- Regresiones de navegador, 40 pruebas unitarias contables y 2 de reintentos, tipos, lint y compilación.
- PDF histórico en tamaño carta; cifras y márgenes revisados.

Las pruebas usan bases locales desechables. No envían correos ni generan ventas de prueba en producción.

## Límites operativos

Los importes iniciales y el arqueo requieren conteo físico. La aplicación no puede saber cuánto efectivo hay realmente en caja ni elegir el motivo de una diferencia. Una jornada de un día anterior no se reabre: su cierre queda conservado.

Las operaciones pendientes se mantienen en memoria mientras la pestaña permanece abierta. No se guardan datos financieros en el almacenamiento del navegador. Ante una recarga forzada, cierre del navegador o caída del dispositivo, se debe consultar el historial de facturas antes de intentar otra venta. El aviso de salida permite evitar esa pérdida de contexto; no convierte la aplicación en un sistema de ventas sin conexión.

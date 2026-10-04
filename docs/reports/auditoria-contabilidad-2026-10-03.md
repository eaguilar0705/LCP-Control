# Auditoría funcional y contable — 3 de octubre de 2026

La venta aparece en los ingresos del período y descuenta inventario. Una venta a crédito reconoce el ingreso y la cuenta por cobrar; los abonos cambian dinero y deuda sin duplicar el ingreso. Las operaciones auditadas quedaron consistentes entre los cálculos de PostgreSQL, las funciones usadas por la interfaz y el recorrido del navegador.

La revisión se ejecutó en el repositorio local. Las pruebas usan PostgreSQL desechable mediante PGlite, Supabase simulado y Chrome de prueba. No se consultaron ni se modificaron operaciones de una base desplegada. El harness aplica las migraciones del repositorio salvo la de permisos de plataforma, que depende del entorno de Supabase.

## Comandos ejecutados

| Comando                                            | Resultado observado                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                    | Exit 0; lint, 427 pruebas en 62 archivos y compilación. Se repitió con las dos migraciones correctivas.                                                             |
| `npm run test:db`                                  | Exit 0; 124 comprobaciones: catálogo 23, contabilidad 24, finanzas 10, flujo de efectivo 7, personal 7, contactos 6, facturas 14, precios 21 y precio de compra 12. |
| `npm run test:audit`                               | Exit 0; datos 110/110, venta → contabilidad 16 escenarios y 436 comprobaciones, pantallas 30/30, entradas inválidas 42/42, direcciones dañadas 24/24.               |
| Playwright completo, escritorio y móvil            | Exit 0; 103 pruebas pasadas y 9 omitidas por las condiciones de dispositivo de las pruebas existentes. Se usó un servidor externo en modo test.                     |
| `npm run test:e2e -- tests/e2e/accounting.spec.ts` | Exit 0; 2 pruebas pasadas con el nuevo ejecutor del repositorio; servidor cerrado al terminar.                                                                      |
| `npm run test:scripts`                             | Exit 0; 7 pruebas, incluida la regresión de fechas SQL del simulador.                                                                                               |
| `npm run test:credentials`                         | Exit 0; 25 comprobaciones sobre sesión, credenciales, almacenamiento del navegador y perfil en disco.                                                               |
| `npm run test:recovery`                            | Exit 0; solicitud de recuperación, espera entre reenvíos, callback, limpieza de tokens, actualización simulada de contraseña y enlace vencido.                      |

Las salidas de esta revisión están en `output/audit-final.log`, `output/audit-check-final.log`, `output/audit-db-final.log`, `output/audit-e2e-final.log` y `output/audit-scripts-final.log`. Son archivos generados, ignorados por Git. La parte de ventas se repite con `npm run test:audit:sales`.

## Evidencia de venta → ingresos

Se compraron 10 perfumes a C$70 más C$50 de flete: costo unitario C$75. El precio de venta es C$120, equivalente a US$4 con la tasa histórica de 30. Las aperturas de caja y banco son C$1,000 y C$250. Esta tabla muestra resultados acumulados de la prueba:

| Operación                                           | Ingreso C$ | Costo vendido C$ | Utilidad C$ | Unidades en tienda | Caja C$ | Banco C$ | Clientes por cobrar C$ |
| --------------------------------------------------- | ---------: | ---------------: | ----------: | -----------------: | ------: | -------: | ---------------------: |
| Compra y apertura                                   |          0 |                0 |           0 |                 10 |   1,000 |      250 |                      0 |
| Venta de contado de 2 perfumes                      |        240 |              150 |          90 |                  8 |   1,240 |      250 |                      0 |
| Tras otras ventas de contado y banco, NIO/USD       |        600 |              375 |         225 |                  5 |   1,360 |      490 |                      0 |
| Venta a crédito de 2 perfumes                       |        840 |              525 |         315 |                  3 |   1,360 |      490 |                    240 |
| Abono parcial de C$60                               |        840 |              525 |         315 |                  3 |   1,420 |      490 |                    180 |
| Abono final de C$180 a banco                        |        840 |              525 |         315 |                  3 |   1,420 |      670 |                      0 |
| Gasto de C$30, después de corregir un abono anulado |        840 |              525 |         285 |                  3 |   1,390 |      670 |                      0 |
| Eliminación de la primera factura                   |        600 |              375 |         195 |                  5 |   1,150 |      670 |                      0 |
| Reintento de la factura eliminada, rechazado        |        600 |              375 |         195 |                  5 |   1,150 |      670 |                      0 |

También se verificó que una proforma de 100 unidades no cambie inventario, ingresos ni dinero; que cambiar la tasa actual a 99 conserve los importes históricos; que una venta sin costo inicial conserve su ingreso pero deje pendiente la utilidad; y que los datos rechazados no alteren la huella de ninguna tabla.

El recorrido de pantalla compara **Contabilidad → Resumen → Ventas del período** con los importes contables de PostgreSQL antes y después de emitir y eliminar una factura. Luego registra una factura a crédito y un abono de C$100, comprueba el refresco de la tabla de deudas, confirma que el ingreso permanezca igual y anula el abono para restaurar la deuda.

## Hallazgos corregidos

**Reintento tras eliminar una factura.** La función de emisión buscaba la solicitud únicamente en las facturas activas. Tras una eliminación, la solicitud original podía volver a crear una venta y descontar stock al precio nuevo. La migración `20261003225145_prevent_deleted_invoice_replay.sql` conserva la identidad en la bitácora y rechaza el reintento mediante un trigger, usando el autor original y el identificador de solicitud. La operación mantiene sus bloqueos y revierte cualquier efecto previo sobre clientes o numeración. La regresión fallaba antes del cambio y pasa después, con ingresos, inventario, dinero y huellas de todas las tablas intactos. También cubre datos o tipo de documento alterados y la separación de solicitudes entre autores.

**Identidad del perfume en el flujo.** El flujo de efectivo aceptaba una foto contable que coincidía con el renglón y la factura pero podía identificar un perfume diferente. La unión de `private.cashflow_rows` ahora exige también que `document_item_costs.product_id` coincida con el producto del renglón. El cambio está en la migración nueva `20261003224314_cashflow_snapshot_product_identity.sql`. Las migraciones anteriores se conservan.

La regresión altera únicamente un fixture de la base desechable para simular esa inconsistencia. Verifica que el ingreso incorrecto se excluya, aumente la cuenta de ventas incompletas, el saldo esperado de caja permanezca pendiente y se impida cerrar la caja. También verifica que reparar el fixture devuelva un saldo calculable. Al omitir la nueva migración, la prueba falló donde debía: recibió una caja de C$ 2,200 en lugar de `null`. Con la corrección, pasó.

**Herramientas de prueba.** Se actualizaron expectativas antiguas de precios y selectores de formularios para comprobar las reglas actuales. El simulador convierte columnas SQL `DATE` a `yyyy-mm-dd`, igual que PostgREST; antes desplazaba fechas o excluía movimientos del día de corte. Su regresión distingue fechas de timestamps. Se limitó Vitest a dos procesos para evitar falsos tiempos de espera por saturación y se añadió un ejecutor de Playwright que cierra Vite en Windows. En el lector se restauró la indicación para solicitar ayuda del administrador cuando el usuario no puede dar de alta un código desconocido.

## Acceso e integridad revisados

Se revisaron los controles de rol en las funciones privadas, los permisos de ejecución y las políticas RLS. Las operaciones financieras exigen un administrador activo; los operadores y usuarios anónimos no pueden leer los registros confidenciales ni escribir mediante las funciones. Las escrituras directas sobre las tablas están revocadas. Las pruebas también verifican que eliminar las credenciales de un autor conserve la autoría financiera y que sus tokens antiguos dejen de tener acceso.

Los cobros identifican su factura, los pagos identifican su pedido y los abonos de apertura permanecen separados. Las pruebas verifican que los abonos parciales y totales no dupliquen la venta o compra, rechazan montos superiores al saldo pendiente, comprueban fechas y conservan las tasas históricas. Los reintentos con la misma solicitud devuelven el registro original; reutilizar la solicitud con otros datos falla. Las anulaciones conservan el motivo y la historia.

La corrección conserva `SECURITY INVOKER`, el `search_path` vacío y la revocación del acceso directo al helper. Referencias consultadas antes del cambio: [funciones de base de datos en Supabase](https://supabase.com/docs/guides/database/functions) y [CREATE FUNCTION de PostgreSQL](https://www.postgresql.org/docs/current/sql-createfunction.html).

## Alcance y pendientes

Los resultados validan los escenarios ejecutados; no prueban la ausencia absoluta de errores. Las migraciones correctivas están preparadas, sin aplicar en la base real. La [guía de contabilidad](../guides/contabilidad.md) enumera su orden de activación. No se conciliaron saldos reales con efectivo físico, estados bancarios, clientes o proveedores. El patrimonio y los valores históricos pendientes del balance conservan sus avisos; no se inventaron cifras para cuadrarlo.

Las pruebas extensivas `test:audit:buttons` y `test:audit:inputs` no se ejecutaron en esta revisión. Se cubrieron las operaciones completas, formularios críticos, rutas dañadas, contabilidad y pruebas de escritorio/móvil descritas arriba.

PGlite en estas pruebas utiliza una sola instancia y serializa sus consultas. Aunque el harness lanza dos abonos mediante `Promise.allSettled` y verifica que únicamente uno pueda consumir el saldo disponible, eso no demuestra el comportamiento de dos sesiones PostgreSQL independientes que compiten en paralelo.

Se inspeccionaron los bloqueos de idempotencia por actor y solicitud, el bloqueo compartido del libro de crédito, los bloqueos de la factura o pedido y las restricciones únicas. No se realizó una prueba de estrés con varias conexiones reales. La afirmación verificada es que la idempotencia, los límites de abono y los controles de acceso pasan en la base desechable; la concurrencia entre sesiones queda pendiente de una validación específica en un entorno de PostgreSQL de prueba.

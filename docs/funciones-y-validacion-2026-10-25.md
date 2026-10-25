# Funciones y validación — 25 de octubre de 2026

Continuación de la [auditoría del 24 de octubre](auditoria-empresa-2026-10-24.md). Esta revisión implementa las funciones que aquel informe dejó pendientes. Sus resultados anuales describen la versión anterior; no deben confundirse con las pruebas de esta actualización.

## Ventas y devoluciones

En Facturación puede elegirse un solo pago o dividir la factura entre dos y diez pagos. Cada uno conserva método, moneda, importe y tipo de cambio. Se valida el total antes de emitir y nuevamente dentro de la transacción. Caja recibe sólo el efectivo de cada moneda; los bancos y POS reciben sus propios importes.

Administración registra devoluciones desde el historial de facturas. Selecciona las unidades, indica el motivo y decide si el producto vuelve a existencias o queda dañado. La nota de crédito tiene número y fecha propios y conserva la factura original. Puede corresponder a una factura de una jornada ya cerrada: se registra en la jornada actual, sin reescribir el cierre anterior.

En una factura a crédito se reduce primero la deuda pendiente. Sólo se reembolsa el excedente ya pagado, desde la caja o cuenta elegida. Los abonos se conservan. No se puede devolver más de lo vendido ni registrar la misma solicitud dos veces. Una nota de crédito no se anula como un comprobante manual.

## Compras

El botón **Compras**, en Inventario, abre su historial y permite registrar, anular o reemplazar una compra. Las compras nuevas pagadas por banco exigen seleccionar BAC, LAFISE o Ficohsa en la moneda correspondiente.

Una corrección conserva el pedido original, su motivo y responsable. Revierte conjuntamente cantidades, valor de inventario, costo promedio y deuda; un reemplazo crea una compra vinculada en la misma transacción. Se distingue un error de registro de una devolución real del proveedor. Un reemplazo a crédito puede conservar y reasignar los abonos reales, sin repetirlos ni inventar un reintegro de dinero. No se representa una compra equivocada como merma.

La anulación automática se bloquea si existen movimientos posteriores que impiden recuperar el estado anterior con certeza. También se bloquea en compras antiguas que no tienen ese estado previo registrado y en errores de caja de jornadas anteriores que necesitan revisión contable. Esos casos requieren revisión de Administración; el programa no reconstruye costos ni devoluciones de dinero por suposición.

## Costos y valorización

El promedio unitario se conserva a seis decimales y el valor pendiente se lleva en centavos. Las ventas y mermas congelan su costo total. Al salir la última unidad se consume el saldo completo, evitando un residuo contable por redondear cada venta por separado. Una devolución recupera el costo histórico de las unidades devueltas. Los cálculos de valor actual y rotación consultan ese mismo saldo, sin volver a reconstruirlo desde el promedio redondeado.

En Contabilidad, **Valorización de inventario** compara el mayor 1130 con las existencias. Para una regularización de redondeo exige conteos y costos completos, saldo inicial, una vista previa vigente y motivo. Conserva historial y registra el asiento en la jornada abierta. No altera facturas ni costos históricos. Las diferencias mayores al límite calculado requieren revisar sus causas; no se convierten automáticamente en un ajuste para cuadrar.

## Interrupciones y errores de uso

- Una respuesta perdida conserva la solicitud original. Verificar el guardado no vuelve a emitir ni vuelve a mover existencias o dinero.
- Tras recargar o cerrar la pestaña se conservan únicamente el identificador, tipo de operación y ámbito del usuario. No se guardan formularios, importes ni credenciales para esta recuperación.
- Si no se encuentra la solicitud, debe revisarse el historial antes de descartarla. El servidor retira ese identificador y bloquea cualquier envío tardío con él; después puede registrarse una operación nueva.
- Atrás y Adelante del navegador respetan la edición pendiente de un perfume. Cancelar la salida conserva lo escrito.
- El rol Inventario conoce desde el inicio cuándo una entrada necesita que Administración registre una compra con costo.
- Antes del cierre se advierte un efectivo esperado negativo y se dirige a revisar fondos y pagos. No se admite un conteo físico negativo ni se agrega una venta ficticia.
- Los comprobantes tienen paginación completa, incluidos los automáticos VE/CV. Las sumas contables no dependen de la página visible.

## Aplicación en Supabase

Se aplicaron seis migraciones. Los importes, cantidades, costos, precios, documentos, pagos y permisos de las 31 tablas operativas comprobadas conservan su contenido anterior. La comparación excluye únicamente las columnas nuevas: costo total y banco, y nombre/SKU de líneas de compra. Estos últimos se completaron con la referencia actual del catálogo; no se reinterpretaron importes históricos. Los historiales nuevos quedaron vacíos: no se crearon ventas, compras, pagos, devoluciones ni ajustes reales para probar.

Una comprobación bajo el rol autenticado de Administración, dentro de una transacción de sólo lectura, consultó las funciones nuevas: 268 referencias de valor, 259 conteos incompletos, siete comprobantes en el período y 52 cuentas. No se regularizó ningún saldo de la tienda.

Los asesores no detectaron ERROR. Se cubrieron con índices las seis referencias nuevas señaladas. Persisten avisos anteriores de claves foráneas, una tabla retirada sin clave primaria y protección de contraseñas filtradas desactivada. Las 24 tablas privadas sin políticas mantienen sus permisos directos revocados; las 19 funciones públicas administrativas señaladas tienen controles de autenticación y rol. No se abrieron políticas para eliminar estos avisos.

## Evidencias

Las pruebas usan las migraciones reales en bases PostgreSQL desechables y Chrome a 1440, 390 y 320 píxeles. Sus operaciones no se envían a la tienda real.

| Prueba                                   | Resultado                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| Integridad de operaciones                | 1,083 comprobaciones y 13 escenarios                                                      |
| Recuperación y listado contable          | 2,289 comprobaciones; 1,332 comprobantes, incluidos 730 automáticos                       |
| Recuperación y navegación en Chrome      | 129 comprobaciones                                                                        |
| Compras y correcciones en Chrome         | 126 comprobaciones                                                                        |
| Devoluciones y pagos divididos en Chrome | 111 comprobaciones                                                                        |
| Valorización en Chrome                   | 39 comprobaciones                                                                         |
| Impresión                                | Cinco documentos de 100 productos; Carta, renglones y datos completos; incluye diez pagos |

La simulación nueva de **90 jornadas** aprobó **1,109,598 comprobaciones**: 5,400 facturas emitidas, 5,310 vigentes, 23,587 renglones vigentes, 540 proformas, 339 compras, 90 notas de crédito, 90 pagos divididos, 13 reaperturas y 39 rechazos atómicos. Se comprobaron cuatro períodos y 180 comprobantes automáticos. El mayor 1130 y el modelo independiente de valor pendiente coinciden exactamente en **C$5,529,653.71**. Esta corrida duró 513.43 segundos; no se presenta como una nueva simulación anual.

Pruebas dirigidas finales: 103 de valorización; 73 de devoluciones/pagos; 2,164 de compras, con 500 ciclos; 2,289 de recuperación/paginación; 105 unitarias; los 13 scripts de base; 858 comprobaciones de regresión de formularios y 17 rutas a tres anchos. Tipos, lint y compilación aprobaron. La aplicación se comprueba después de publicar comparando el archivo principal con la compilación local y ejecutando las cuatro suites nuevas sobre HTTPS con la API interceptada.

Reproducción:

```text
npm run test:financial-corrections
npm run test:browser:financial-corrections
npm run test:enterprise
npm run test:enterprise:pdf
npm run test:database
npm run test:accounting
npm run typecheck
npm run check
```

Para pruebas de navegador se usa `LCP_TEST_BASE_URL` con el servidor local. Las suites de las funciones nuevas también admiten el origen HTTPS oficial, interceptando la API para usar exclusivamente una base desechable.

Las evidencias quedan en `output/`, excluido de Git: `inventory-value`, `browser-inventory-valuation`, `purchase-corrections`, `sales-returns-split`, `functional-recovery-pagination`, `functional-recovery-browser` y `enterprise-pdf`.

## Datos para la entrega

Estas funciones no sustituyen el conteo físico ni los datos reales del negocio. Permanecen por completar las cantidades pendientes, la razón social y RUC, y las dos imágenes reales que indicó la auditoría anterior. Los productos DEMO relacionados con operaciones necesitan una depuración contable acordada; cambiarles el nombre o desactivarlos no revierte sus movimientos.

Las pruebas de correo, impresora y restauración de respaldo requieren comprobar esos servicios y dispositivos reales. La recuperación de solicitudes no permite vender sin conexión.

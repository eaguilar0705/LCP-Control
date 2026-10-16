# Revisión final de operación diaria

16 de octubre de 2026. Revisión iniciada en `main`, commit `3f3ba6b`, después de comprobar el repositorio remoto. Las ventas de prueba y los clientes ficticios se generaron únicamente en PostgreSQL desechable.

## Prueba de tres meses

La simulación recorre 90 jornadas, del 1 de septiembre al 29 de noviembre de 2026, con un reloj que sólo se modifica en la base de prueba. Un modelo independiente calcula las cantidades y los importes esperados.

| Recorrido                            | Resultado |
| ------------------------------------ | --------: |
| Jornadas abiertas y cerradas         |        90 |
| Facturas emitidas                    |     3,600 |
| Facturas vigentes                    |     3,510 |
| Renglones vigentes                   |    16,207 |
| Proformas                            |       360 |
| Compras                              |       328 |
| Devoluciones                         |        90 |
| Cambios de catálogo                  |       127 |
| Ediciones obsoletas rechazadas       |        90 |
| Reaperturas con historial conservado |        13 |
| Comprobantes automáticos conciliados |       180 |
| Verificaciones correctas             |   149,429 |

Cada día concilia existencias por ubicación, costo promedio, efectivo NIO/USD, seis cuentas bancarias, crédito de clientes, proveedores y mayor. Se cambia el catálogo durante la operación y se comprueba que las facturas y sus costos anteriores permanezcan intactos. Incluye reposiciones según demanda, liquidaciones de tarjetas, gastos, cobros, pagos, transferencias y rechazo de modificaciones de fechas cerradas.

También se ejecuta el modelo TypeScript que presenta Contabilidad: balanza, estado de resultados y situación financiera contienen importes completos, sin «Pendiente», en septiembre, octubre, noviembre y el acumulado. Activo equivale a pasivo más capital.

El test `scripts/tests/extended-store-flow.mjs` admite `LCP_SIMULATION_DAYS` entre 1 y 365; su valor predeterminado sigue siendo 30. La corrida de 90 jornadas y su JSON están en `output/revision-entrega-final/simulacion-90-jornadas/`.

## Errores encontrados y corregidos

- **Clientes y proveedores duplicados ante una respuesta perdida.** El formulario generaba otro UUID al reintentar un alta. Ahora conserva el identificador y verifica por ese ID si el servidor ya guardó exactamente los mismos datos. Las modificaciones concurrentes reales siguen mostrando conflicto.
- **Factura por un importe diferente al confirmado.** Si administración cambiaba un precio con el documento abierto, se emitía con el precio nuevo sin revisión del vendedor. Ahora la pantalla envía total y precios unitarios confirmados. PostgreSQL rechaza el cambio y revierte toda la transacción. «Actualizar precios» conserva el formulario, trae los precios vigentes y pide revisar el total. Recuperar una factura ya emitida mantiene su importe original.
- **Entrada de unidades que terminaba en un rechazo de costo.** Desde la edición de un perfume con costo conocido, «Agregar unidades» dirige a registrar la compra y conserva la ubicación elegida. Así se incluyen costo, pago y promedio ponderado. Salidas, conteos y daños conservan sus controles.
- **Carrito con más de 100 productos.** La pantalla impide agregar el producto 101 y avisa el límite antes de emitir. Una proforma de 100 productos conserva todas sus líneas y se descarga en carta.
- **Cero con signo negativo en importes.** El formato monetario normaliza `-0` para que se presente como cero.
- **Controles recortados dentro de la tarjeta en móvil.** A 320 px, algunos controles de cantidades sobresalían 31 px aunque la página ocultara el desbordamiento. Se corrigió el ancho mínimo de los campos y la distribución de los botones; la prueba mide cada control respecto de su tarjeta.

La validación de precios ocurre dentro de la transacción de emisión y antes del registro definitivo. Se probaron también cambios opuestos de dos precios que conservan el mismo total, monedas, datos inválidos y reintentos después de un cierre.

## Conciliación histórica confirmada

El propietario confirmó expresamente **C$1,900 por unidad** para las facturas FAC-000075 y FAC-000076 del 13 de octubre, producto LCP-0183. Se completaron únicamente sus dos costos históricos y se conservaron las imágenes anterior y posterior en `private.catalog_changes`.

La comprobación en Supabase devuelve `missingCosts=0` y `missingSales=0` para el libro iniciado el 13 de octubre y consultado hasta el 16. Debe y Haber coinciden. Se compararon antes y después productos, costos promedio actuales, precios, existencias, facturas, comprobantes manuales y jornadas: permanecieron idénticos.

La prueba de conciliación contiene 44 verificaciones. Una factura ausente, un costo ya modificado, cantidad o fecha distinta, jornada cerrada o responsable inactivo cancela toda la operación. Repetirla no duplica auditorías. No se sustituyeron los costos de registros anteriores al inicio del libro sin soporte del propietario.

## Comprobaciones adicionales

- Auditoría económica y de permisos: 57 verificaciones nuevas, junto con las regresiones existentes de base de datos.
- 205 comprobaciones nuevas de navegador en 1440, 390 y 320 px: edición, compras, inventario, lector manual, clientes y proveedores, facturación, proformas, comprobantes, teclado y reportes.
- Pérdida de respuesta en contactos, revisión concurrente, cambios de precios durante la venta, límite de productos y navegación entre registros.
- Pruebas de jornadas y emisiones pendientes; 189 verificaciones de fechas de pagos, incluidos formularios que permanecen abiertos al cambiar de día.
- Tipos, ESLint, Prettier y compilación de producción.

El transporte de prueba ahora respeta los conteos exactos y el orden por varias columnas de PostgREST; la paginación no se valida con una lista incompleta del servidor simulado.

El historial se verificó además con **1,205 facturas emitidas por la función real**, con fechas repetidas para comprobar el desempate por identificador. Sus páginas de 100 recuperan todos los documentos sin pérdidas ni duplicados; Hoy muestra 805 y ayer 400. La exportación obtiene 500 + 500 + 205 documentos. Al crecer a 2,001, adaptador y pantalla rechazan el PDF tras un único conteo y piden reducir el período. Son 24 verificaciones adicionales, sin errores de ejecución o API. La proforma de 100 productos se revisó como PDF de tres páginas carta, con texto dentro de la hoja.

Migraciones aplicadas y versionadas: `20261016191700_proteger_precios_confirmados_al_emitir.sql` y `20261016191704_conciliar_costos_historicos_confirmados.sql`. El análisis de seguridad conserva los avisos anteriores y no añade advertencias.

## Preparación de datos reales

Las pruebas verifican el programa con datos completos; la puesta en marcha todavía requiere el conteo físico de los 259 perfumes reales cuyas cantidades están pendientes, gestionar la jornada real del 13 de octubre aún abierta y revisar los datos de presentación anteriores. El sistema no inventa cantidades ni arqueos.

Los datos de identidad comercial deben completarse en Negocio antes de entregar documentos definitivos. El respaldo automático continúa pendiente por decisión del propietario. La recepción real de correos, la impresora, el lector físico, el menú nativo para compartir y la concurrencia entre conexiones PostgreSQL reales no quedan acreditados por una base WASM aislada.

Los límites explícitos de exportación y consulta continúan protegiendo el navegador. Contabilidad usa el mayor completo de PostgreSQL y el reporte principal usa agregación del servidor; no se ampliaron límites para entregar sumas parciales como definitivas.

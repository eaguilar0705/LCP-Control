# Tasas de precios de venta, costos de inventario y contabilidad

El audio del dueño del 11 de noviembre de 2026 a las 7:12 p. m. aclara que los **precios de venta se convierten a C$37 por US$1**. La tasa de **C$36.6243 por US$1 corresponde a los costos del inventario**. La contabilidad conserva su configuración independiente.

En **Negocio** hay tres controles, editables por administración:

| Control                                | Valor inicial | Uso                                                                                                                              |
| -------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Tipo de cambio de precios de venta     | 37            | Precios del catálogo y sus listas, conversiones comerciales y equivalencias de venta.                                            |
| Tipo de cambio de costos de inventario | 36.6243       | Tasa propuesta para nuevas compras, recepciones y costos iniciales del inventario en USD, y equivalencias de importes de compra. |
| Tipo de cambio contable                | 37            | Tasa propuesta para facturas, cobros y pagos en USD; conversión a USD de estados contables y su Excel.                           |

Una venta de US$24 se publica a **C$888**, y una de US$30 a **C$1110**. Un costo de US$10 se valora en **C$366.243**, conservando la precisión del costo y presentando C$366.24 donde se muestran dos decimales.

La ficha del perfume identifica expresamente la tasa de **precios de venta**. Cambiar esa tasa recalcula el catálogo, conservando las reglas de porcentajes y redondeo de los precios calculados al dólar entero superior. Cambiar la tasa de **costos de inventario** no recalcula los precios de venta ni revaloriza las existencias ya registradas.

Cada operación nueva permite indicar su tasa particular. Las compras y recepciones en USD conservan su tasa histórica al corregirlas; usar expresamente la tasa actual propone la de costos de inventario. Las configuraciones no reescriben compras, pagos, facturas, costos promedio ni movimientos anteriores. Los estados siguen leyendo los importes contables históricos en NIO, y su consulta USD usa la tasa contable.

## Activación

Aplicar todas las migraciones pendientes en orden, antes de publicar el frontend. La separación inicial requiere:

`backend/supabase/migrations/20261111210000_tasas_de_inventario_y_contabilidad.sql`

Después de las migraciones anteriores, aplicar la aclaración de costos y precios de venta:

`backend/supabase/migrations/20261112010000_separar_tasa_de_costos_y_precios_de_venta.sql`

Esta última crea la configuración de costos de inventario con 36.6243, fija la tasa de precios de venta en 37 y recalcula el catálogo. Conserva la tasa contable configurada y todas las operaciones históricas. Las tres tasas quedan editables por separado. Compilar o subir el código a GitHub no aplica la migración en Supabase.

## Comprobaciones aisladas

- `npm run test:cost-sale-rates`: actualización desde la base anterior, precios calculados y manuales, valor de compras, independencia de las tres tasas, conservación de datos históricos, validaciones y permisos.
- `npm run test:exchange-rates`: compatibilidad y comportamiento de la separación anterior de tasas.
- `npm run test:rounded-pricing`: precisión de precios calculados, listas y documentos históricos.
- `npm run test:browser:exchange-rates`: controles de Negocio, ficha del perfume, compras, recepciones, costos iniciales, facturación y consulta contable en Chrome a 1440, 390 y 320 px.
- `npm run test:browser:purchase-currency`: equivalencias de compra, tasa propuesta y conservación de la tasa de los documentos corregidos.

Las pruebas usan bases desechables con las migraciones y RPC reales; las solicitudes a Supabase están interceptadas y no modifican producción.

La revisión del 11 de noviembre pasó 36 comprobaciones nuevas de costos y precios, 43 de compatibilidad de tasas, 226 de redondeo y 206 de recepciones. En Chrome pasaron 108 comprobaciones de las tres tasas y 63 de compras, en 1440, 390 y 320 px. Lint, tipos y compilación también pasaron.

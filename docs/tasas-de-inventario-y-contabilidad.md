# Tasas de inventario y contabilidad

El audio del dueño del 11 de noviembre de 2026 solicita calcular los precios de inventario con una tasa distinta de la contable. El usuario confirmó **C$36.6243 por US$1 para inventario y precios** y **C$37 por US$1 para contabilidad**.

En **Negocio** hay dos controles independientes, editables por administración:

- **Tipo de cambio de inventario:** calcula los precios de los perfumes y sus listas. Mantiene el redondeo de los precios calculados al dólar entero superior. Por ejemplo, una compra de C$705 con 20 % de ganancia produce US$24 y C$878.98 con tasa 36.6243; con 37 producía US$23.
- **Tipo de cambio contable:** se propone para compras, recepciones, costos iniciales, cobros, pagos y facturas en USD. También convierte la balanza, el estado de resultado, el balance y su Excel a dólares. Cambiarla conserva los precios del catálogo.

La ficha del perfume muestra la tasa de inventario utilizada. Las operaciones nuevas permiten indicar su tasa particular. Las correcciones conservan la tasa histórica hasta que se elija expresamente otra. Cambiar estas configuraciones no revaloriza costos ni existencias, ni reescribe compras, pagos o facturas emitidas; los estados siguen leyendo los importes contables históricos en NIO y su consulta USD usa la tasa contable.

## Activación

Aplicar **antes de publicar el frontend**:

`backend/supabase/migrations/20261111210000_tasas_de_inventario_y_contabilidad.sql`

La migración crea la configuración contable con 37, fija la tasa comercial confirmada en 36.6243 y recalcula los precios del catálogo. Las tasas quedan editables por separado. Compilar el frontend no aplica esta migración en Supabase.

El final del audio menciona otro contenido que el dueño enviaría para editar; no describe ese cambio ni incluye ese material.

## Comprobaciones aisladas

`npm run test:exchange-rates` verifica la actualización desde la base anterior con una factura emitida, el caso US$23 → US$24, independencia de ambas tasas, conservación de datos históricos, validaciones y permisos.

`npm run test:browser:exchange-rates` recorre los controles de Negocio, los precios del perfume, la tasa propuesta al facturar y la consulta contable en Chrome a 1440, 390 y 320 px. Usa una base desechable con las migraciones y RPC reales; el transporte a Supabase está interceptado.

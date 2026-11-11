# Histórico de ventas por producto

El dueño solicitó en el audio del 10 de noviembre poder abrir un perfume desde Inventario y saber qué día se vendió, a qué cliente y a qué precio.

## Uso

1. En **Inventario**, abre la fotografía o el nombre del perfume para ver su ficha.
2. Consulta **Historial de ventas**. También está disponible en **Editar perfume**.
3. Revisa la fecha y hora de Managua, cliente, número de factura, ubicación, cantidad, precio unitario neto y total del renglón.
4. Usa **Anterior** y **Siguiente** para recorrer el historial, de veinte registros por página y del más reciente al más antiguo. **Actualizar** vuelve a consultar desde el comienzo.

El historial contiene únicamente ventas facturadas de ese perfume. Las proformas no representan una venta. La información comercial está disponible para **Admin** y **Superadmin** activos; los otros roles conservan su acceso habitual al catálogo sin recibir clientes ni precios históricos de venta.

## Cómo se leen los importes y estados

Los importes conservan la moneda original, **NIO** o **USD**, y el precio guardado en la factura. No se usa el precio actual del catálogo ni la tasa de cambio de hoy. El precio unitario neto incluye la parte del descuento general que corresponda al producto; el total del renglón conserva sus centavos exactos.

Cada factura aparece una sola vez para ese perfume. Una factura corregida muestra su versión vigente y su revisión, sin sumar de nuevo los movimientos internos de corrección. Las devoluciones muestran las unidades e importe devueltos por separado. Una factura anulada conserva su referencia histórica y se identifica como anulada. Si el producto fue retirado al corregir una factura, se conserva la última versión que lo incluía y se marca **Retirado al corregir**; no se presenta como una venta vigente.

Los nombres y precios se leen del mismo documento o versión conservada, sin mezclar un cliente nuevo con un precio de una versión anterior. No se muestran costos ni datos privados de solicitudes. La consulta no modifica ventas, inventario, clientes ni contabilidad.

La paginación conserva el corte de emisión y el número esperado de facturas. Si una corrección incorpora el perfume a una factura anterior y cambia ese número mientras se consulta otra página, el sistema pide **Actualizar ventas** antes de continuar, para evitar filas repetidas o desplazadas. Las correcciones y devoluciones muestran su estado vigente; el corte no representa una reconstrucción completa del estado del negocio en una fecha pasada.

Si no existen ventas, se indica expresamente. Un fallo de conexión o una actualización pendiente de la base muestra un error con opción de reintentar; no se presenta como un historial vacío. Cambiar de producto o de página descarta respuestas que pertenecen a la consulta anterior.

## Activación

Después de las migraciones anteriores, ejecutar en Supabase:

`backend/supabase/migrations/20261111010000_historico_ventas_por_producto.sql`

Después, publicar la compilación del frontend. El despliegue del código no ejecuta la migración. La actualización habilita consultas protegidas y sus índices; no vuelve a importar ni modifica registros históricos.

## Verificación local

```sh
npm run check
npm run typecheck
npm run test:product-sales-history
npm run test:browser:product-sales-history
```

Las pruebas usan PostgreSQL desechable y solicitudes del navegador interceptadas contra esa base; no generan ventas ni alteran datos del negocio real.

La entrega pasó 100 comprobaciones de base de datos y 249 de navegador en 1440, 390 y 320 px. La suite general pasó 156 pruebas; lint, compilación y tipos también pasaron. Se verifican los estados históricos, los permisos, las monedas y descuentos, las respuestas atrasadas y el cambio del total entre páginas.

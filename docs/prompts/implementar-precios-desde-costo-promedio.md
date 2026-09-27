# Prompt: calcular los precios desde el costo promedio del inventario

Implementa en el programa de este repositorio la funcionalidad solicitada por el cliente. Trabaja sobre el código actual, conserva los flujos existentes que no sean incompatibles con este requerimiento y entrega una explicación de los cambios y de las pruebas realizadas. Prepara las migraciones necesarias; no modifiques datos de producción como parte de la implementación local.

## Solicitud del cliente

El cliente compartió dos notas de voz del 26 de septiembre de 2026 y `Formulas.xlsx`. En la primera explica que separó tres fórmulas para ilustrar el proceso, pero que la **última fórmula**, cuyo ejemplo produce `20.351…`, representa el resultado que quiere utilizar: calcular primero el costo promedio y luego agregar el porcentaje de ganancia. En la segunda pide que el porcentaje se pueda cambiar **por perfume y por cada uno de sus tres precios**. El costo promedio debe considerar las unidades existentes y las que entran. Al consultar un perfume, sus precios deben basarse en ese promedio y los porcentajes configurados. El cliente acepta que el cálculo del inventario y la configuración de precios se presenten en apartados separados.

Las reglas matemáticas son:

```text
costo_promedio_nuevo =
  (unidades_existentes × costo_promedio_anterior
   + unidades_entrantes × costo_unitario_entrante)
  / (unidades_existentes + unidades_entrantes)

precio_venta_de_la_lista = costo_promedio_vigente × (1 + porcentaje_de_la_lista / 100)
```

En el Excel, el ejemplo usa 13 unidades a costo `15.675`, recibe 20 unidades a costo `16.675` y aplica `25 %`. El promedio es `16.281060606…`; el resultado final es `20.351325757…`, o `20.35` si el precio se publica con dos decimales. El cliente llama «margen» al porcentaje, pero **la fórmula es un recargo sobre el costo**. No sustituyas la operación por `costo / (1 - porcentaje)` ni redondees el costo promedio a dos decimales antes de aplicar el porcentaje. En `Formulas.xlsx`, `Hoja 1!F10` está almacenada como texto `15,675`; normaliza ese dato al usarlo como caso de prueba. La fórmula decisiva está en `Hoja 1!F16`.

## Estado actual que debes respetar y conectar

- `public.product_costs.average_cost_nio` ya guarda el costo promedio ponderado en córdobas. `private.record_shipment` lo actualiza con las existencias de tienda y bodega y con el costo unitario de entrada. El flujo actual incluye el envío prorrateado dentro del costo puesto en bodega. Reutiliza esta fuente contable; no crees otro promedio paralelo.
- `public.product_pricing` ya guarda porcentajes independientes para `emprendedor`, `vip` y `premium`, pero la regla activa toma como base `purchase_price`, introducido manualmente y separado del promedio contable. `private.markup_rules`, `private.markup_prices`, `private.write_product_pricing` y `private.reprice_catalog` dependen de esa base.
- `src/lib/pricing.ts` calcula la vista previa desde `PricingInput.purchasePrice`. La ficha del perfume consulta el promedio mediante `getProductCost`, pero lo usa sólo para informar la rentabilidad. `PricingFields`, `PricingPage`, `PricingDialog`, `ProductEditorPage` y la importación/exportación de precios presentan o editan el precio de compra independiente.
- Los precios publicados viven en `public.product_prices` y los consumen inventario, ventas, proformas y reportes. Hay precios manuales para listas sin porcentaje. Las facturas ya emitidas tienen importes históricos que no deben recalcularse.
- Una entrada manual de inventario sin costo actualmente invalida el promedio. La carga inicial de costo, los pedidos, la eliminación de facturas y otros caminos que cambian `product_costs` deben revisarse antes de añadir el recálculo automático.

## Implementación requerida

1. **Fuente única del costo.** Haz que las listas configuradas con porcentaje usen `product_costs.average_cost_nio` como base, en lugar de `product_pricing.purchase_price`. Mantén el promedio en NIO y su precisión contable de seis decimales; aplica el porcentaje y redondea sólo el precio final a dos decimales. Convierte el precio publicado a USD con la tasa vigente y conserva el comportamiento correcto cuando esa tasa cambie. Usa el costo puesto en bodega que ya calcula el sistema, incluido el envío prorrateado; documenta esta elección porque el Excel sólo dice «costo nuevo».
2. **Porcentajes por perfume y lista.** Conserva tres porcentajes editables e independientes, uno por cada lista existente: Emprendedor, VIP y Premium. Una lista sin porcentaje debe conservar su precio manual según la regla actual. Si todavía no se conoce el costo promedio, no inventes uno ni sustituyas silenciosamente el precio publicado; muestra un estado claro y permite completar el costo por el flujo autorizado.
3. **Actualización de precios.** Cuando una operación válida cambie el costo promedio, recalcula y persiste en `product_prices` las listas que tienen porcentaje, en la misma transacción que registra el cambio de costo. Revisa todos los caminos que pueden cambiar o invalidar el promedio, en especial pedidos, costo inicial, restauración de existencias al eliminar una factura y entradas manuales. No cambies el promedio por una simple salida de unidades ni por un ajuste de conteo que sólo corrige cantidades. Una entrada de mercadería que deba participar en el promedio necesita costo conocido: exige ese dato en un flujo autorizado o dirige al usuario al registro de compra; evita publicar un precio aparentemente calculado desde un promedio invalidado.
4. **Interfaz y contratos.** En la pantalla de Precios y la ficha del perfume, muestra el costo promedio vigente como valor calculado y de sólo lectura, seguido de los porcentajes y de la vista previa del precio de cada lista. Deja claro que el porcentaje es «ganancia sobre el costo». Actualiza los tipos, validaciones, servicios y adaptadores para que no persistan un segundo costo editable como base del precio. Ajusta la plantilla y el importador masivo: los porcentajes deben seguir siendo editables; si incluyes el promedio en el archivo, identifícalo como informativo y no lo importes como costo. Conserva las restricciones actuales de acceso a costos y porcentajes.
5. **Migración e historial.** Migra o deja inactivo de forma segura el uso de `purchase_price`, sin borrar los precios existentes de productos que aún no tienen costo promedio. Conserva los datos históricos necesarios para explicar precios anteriores. Registra de forma trazable los cambios automáticos de precio y su causa; no los presentes como si un usuario hubiese editado manualmente el perfume. Los nuevos precios se aplican a operaciones futuras: no reescribas facturas o proformas ya emitidas.
6. **Coherencia.** Haz que la vista previa del navegador y el cálculo de PostgreSQL produzcan el mismo precio, incluidos casos con costos de seis decimales y redondeos de medio centavo. Respeta el manejo actual de concurrencia, revisiones de producto y operaciones idempotentes; evita estados en los que el costo nuevo se guarde sin los precios derivados correspondientes.

## Criterios de aceptación

- El caso del Excel calcula `16.281060606…` de costo promedio y `20.35` como precio publicado con `25 %` de recargo.
- Dos perfumes pueden tener porcentajes diferentes, y un mismo perfume puede tener tres porcentajes diferentes. Cambiar uno no altera los otros.
- Registrar una compra con costo cambia el promedio y actualiza automáticamente sólo las listas calculadas del perfume afectado; la operación es atómica. Una lista manual mantiene su regla vigente.
- El cálculo considera la existencia total de tienda y bodega y funciona tanto con inventario inicial como con compras sucesivas, existencias en cero y entradas en distintas monedas.
- Una entrada sin costo, un promedio ausente o una tasa ausente no producen precios inventados ni resultados aparentemente válidos.
- Cambiar la tasa actualiza el equivalente en la otra moneda sin alterar el costo promedio ni el porcentaje configurado.
- Las facturas históricas conservan sus importes y el historial permite distinguir un cambio automático de uno manual.
- La pantalla, la carga masiva y los permisos reflejan el nuevo modelo. Las pruebas de base de datos, lógica de precios y flujos relevantes pasan junto con `npm run check`.

## Entrega

Al terminar, resume qué archivos y migraciones cambiaron, cómo quedó resuelto cada camino que modifica el costo promedio, el resultado de las pruebas y cualquier decisión de negocio que aún necesite validación. No declares completada la funcionalidad si el precio publicado puede quedarse desactualizado después de una entrada de mercadería.

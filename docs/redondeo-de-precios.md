# Redondeo de precios calculados

Para una lista con porcentaje y precio de compra:

1. Aplicar el porcentaje a la compra conservando la precisión del cálculo.
2. Expresar ese resultado en dólares y redondear hacia arriba al entero. Un importe ya entero se conserva. No redondear primero a centavos: US$30.000001 también debe terminar en US$31.
3. Obtener los córdobas desde ese dólar entero por la tasa vigente y redondear la conversión monetaria a dos decimales.
4. Multiplicar el precio unitario por la cantidad y sumar el documento. No volver a redondear el total.

Ejemplo a C$37: Mandaryn Sky con compra C$840 y 35 % resulta US$31/C$1,147. Club de Nuit Intense con compra C$940 y 35 % resulta US$35/C$1,295. Una unidad de cada uno suma US$66/C$2,442.

La vista previa del editor y PostgreSQL comparten la regla. Guardar el perfume o modificar el tipo de cambio no restaura el cálculo antiguo con centavos. El costo promedio contable y los porcentajes configurados se conservan. Las listas manuales, ofertas y descuentos explícitos mantienen sus importes; no se sustituyen por porcentajes ni se intercambian listas.

La migración actualiza exclusivamente los precios calculados existentes, sube la revisión del producto y guarda antes/después en el historial con causa **Redondeo al dólar superior**. No modifica documentos emitidos, existencias, costos, clientes ni borradores. Ejecutar nuevamente la normalización no duplica anotaciones.

Abrir un borrador conserva su cotización. Si cambió el catálogo, se solicita revisar **Actualizar precios** antes de emitir. Se muestra el precio anterior y actual por perfume y el total de productos. Cancelar conserva los valores guardados. Aplicar actualiza la vista; **Guardar borrador** persiste la nueva cotización. El servidor sigue rechazando una emisión basada en un precio que cambió después de revisarlo.

Validación: `npm run test:rounded-pricing` y `npm run test:browser:rounded-pricing`, contra PostgreSQL desechable. La prueba de navegador admite `LCP_TEST_BASE_URL=https://lcp-control.pages.dev`; sus llamadas a Supabase permanecen aisladas.

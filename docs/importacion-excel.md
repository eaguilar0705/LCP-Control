# Migración inicial desde Excel

En **Negocio → Importar desde Excel**, un administrador o superadministrador activo puede trasladar los datos iniciales al sistema. El botón se oculta para los demás roles y para la vista local; la base de datos comprueba el permiso de nuevo.

1. Descargar la plantilla desde el botón y copiar los datos del Excel actual en sus hojas. Conservar los nombres de las hojas y los encabezados; no es necesario llenar todas las hojas.
2. Guardar como **Libro de Excel (.xlsx)**, hasta 5 MB. Para un `.xls`, usar «Guardar como» en Excel. Pegar las fórmulas como valores. No usar celdas combinadas en las tablas.
3. Seleccionar el archivo y la fecha de los saldos iniciales, revisar la vista previa y pulsar **Validar en el sistema**. Los errores indican la hoja y la fila; la lista de errores de lectura se puede descargar.
4. Revisar el resultado y confirmar la importación. El lote completo se guarda en una transacción: un error revierte todas las filas. La validación previa ejecuta las mismas comprobaciones y revierte sus escrituras.

## Hojas

| Hoja          | Datos                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Productos     | SKU único del Excel, nombre, marca, código de fabricante opcional, tamaño, unidad, categoría, género, mínimo y precios de venta en USD para Emprendedor, VIP y Premium. |
| Existencias   | SKU del producto, conteo de bodega, conteo de tienda y costo unitario inicial en NIO. Puede referir productos nuevos o ya existentes por su SKU exacto.                 |
| Cuentas       | Código, nombre y cuenta mayor. Se conservan las cuentas estándar. Las nuevas cuentas de detalle se crean debajo de una cuenta mayor existente.                          |
| Saldos        | Código de cuenta, debe y haber en NIO. Deben cuadrar y corresponden a activo, pasivo y capital.                                                                         |
| Clientes      | Nombre, teléfono, correo, dirección, RUC y nivel de precio.                                                                                                             |
| Proveedores   | Nombre, teléfono, correo, dirección y RUC.                                                                                                                              |
| Negocio       | Una fila con nombre comercial, razón social, RUC, dirección, teléfono, correo, sucursal y datos adicionales de facturación.                                             |
| Instrucciones | Ayuda para completar cada columna. No se importa.                                                                                                                       |

Una celda vacía de existencia significa **pendiente de conteo**; escribir `0` significa que se contó y no hay unidades. Un costo vacío permanece pendiente; el costo admite hasta seis decimales. Para registrar un costo inicial se necesitan ambos conteos y existencias positivas, ya guardados o incluidos en el archivo. Los precios de venta se cargan en USD y se convierten a NIO con la tasa configurada en Negocio.

Los números guardados como texto usan punto decimal y no llevan separadores de miles. Las celdas numéricas reales de Excel se leen directamente. Teléfonos de clientes: solo dígitos, entre 8 y 15; conservar códigos y SKU como texto cuando tengan ceros iniciales.

## Apertura contable

La hoja Saldos crea el primer comprobante de apertura del libro; admite hasta 100 renglones y una fecha no futura ni bloqueada por un cierre. Completar los conteos y costos iniciales antes de registrar la apertura, o en el mismo archivo. Si el libro ya tiene apertura, la importación permite catálogos y contactos; las existencias y costos nuevos se registran mediante compras y movimientos del sistema. Los saldos se corrigen desde Comprobantes.

Cuando se incluyen saldos y existe inventario valorizado, incluir la cuenta **1130 — Inventario de perfumes** por el valor total de las existencias. Todos los productos deben tener sus conteos y, si hay unidades, su costo. El sistema exige que el inventario contable coincida con las existencias valorizadas. El costo inicial del inventario se registra también en el historial de costos, sin duplicar el valor del comprobante de apertura.

La importación de saldos usa NIO. Las cuentas que el catálogo reserva para movimientos en USD deben registrarse mediante el flujo contable en su moneda admitida. Los saldos de cuentas por cobrar y por pagar son saldos del mayor; el detalle y los cobros de cada deuda se gestionan en el módulo correspondiente. Las facturas históricas del Excel no se vuelven a emitir con esta carga; las ventas nuevas se facturan en el programa después de completar la migración.

## Registros existentes y reintentos

La carga conserva los conteos, costos y datos de catálogo ya registrados. Si el archivo intenta cambiarlos, muestra el conflicto y pide corregir el archivo o utilizar la edición o los ajustes del sistema. Los datos de identidad del negocio sí se guardan cuando se incluye explícitamente la hoja Negocio. No elimina registros que no estén en el Excel.

El sistema registra el archivo, su huella SHA-256, los datos importados, el administrador y la fecha. Repetir el mismo archivo recupera el resultado anterior sin duplicar existencias, contactos o saldos. Si se pierde la conexión al confirmar, reintentar con el mismo archivo y la misma fecha.

## Instalar la función

Antes de usar el botón con la base remota, aplicar la migración `backend/supabase/migrations/20261019234034_importar_negocio_desde_excel.sql` por el proceso habitual de despliegue de Supabase. Compilar la aplicación no aplica migraciones.

Comprobaciones locales:

```sh
npm run check
npm run typecheck
npm run test:business-import
npm run test:accounting
npm run test:database
# Con npm run dev activo:
npm run test:browser:business-import
```

Las pruebas usan datos ficticios en una base PostgreSQL desechable; no cargan datos en el negocio real.

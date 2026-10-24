# Revisión de tienda — 24 de octubre de 2026

## Entradas y compras

El aviso «ya tiene costo promedio» protegía el inventario de una entrada sin costo. La protección se conserva en PostgreSQL. Ahora Entrada continúa directamente a Registrar compra, conservando perfume, Tienda/Bodega, cantidad y motivo. Cancelar vuelve a esos datos. Agregar unidades desde la edición usa el mismo flujo.

Si existen unidades sin costo, se registra primero su costo inicial y luego se continúa con la compra. Si falta el conteo de alguna ubicación, se solicita completarlo. El rol Inventario solicita al administrador registrar la compra; conserva los ajustes y salidas que tiene autorizados.

El promedio se calcula con las unidades totales de Tienda y Bodega: `(5 × 1100 + 10 × 1000) / 15 = 1033.333333`. El costo promedio contable y los precios de venta conservan sus funciones separadas.

## Listas de precios

- Administración puede crear una lista con el nombre elegido desde Inventario.
- La tabla permite buscar por perfume, marca o código, escanear, editar varios importes y guardarlos juntos.
- Cada fila muestra imagen, código, nombre y presentación. Se muestran los importes definitivos en USD y NIO antes de guardar.
- El precio manual sigue cotizado en USD. Si se introduce NIO, se convierte a USD con dos decimales y luego se calcula NIO con la tasa; la vista previa muestra ese redondeo.
- Las tres listas originales conservan sus porcentajes. Las listas adicionales se fijan a mano; no se asignan nombres, importes ni márgenes supuestos.
- Se pueden asignar a clientes y usar en facturas, proformas, inventario y reportes. Los precios adicionales también se editan en la ficha del perfume.
- Un perfume sin importe muestra precio pendiente y no se vende con esa lista. Las valoraciones incompletas no se presentan como cero ni completas. Excel y PDF admiten listas parcialmente vacías.
- Crear una lista no modifica productos, costos, existencias ni documentos. El guardado por lote valida revisiones, es atómico y conserva el identificador para recuperar una respuesta perdida. Las facturas emitidas mantienen su precio original.

La plantilla de importación inicial sigue conteniendo las tres listas originales; las adicionales se completan desde Inventario. La lectura de productos y clientes pagina los resultados y avisa si alcanza su límite de lectura.

## Permisos y clientes

Caja factura y consulta sus propias facturas; no accede al directorio de clientes, inventario, movimientos, proformas, costos ni contabilidad. La selección de clientes activos y de productos permanece disponible dentro de facturación. PostgreSQL valida también las restricciones, incluidas las llamadas directas a las funciones privadas y las solicitudes antiguas.

Administración filtra clientes por estado y lista de precios. Las lecturas se probaron con 2,206 clientes y 2,206 productos. Los filtros de fecha se apilan en teléfonos pequeños para mostrar el año completo.

## Verificación

Las pruebas usan bases PostgreSQL desechables y correos de prueba interceptados; no crean ventas, compras ni clientes ficticios en producción.

| Prueba                          | Resultado                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Simulación de 90 jornadas       | 3,600 facturas, 360 proformas, 328 compras, 90 devoluciones y 149,430 verificaciones                                                           |
| Conciliación                    | Existencias, costos ponderados, caja NIO/USD, seis cuentas bancarias, deudas y mayor sin diferencias                                           |
| Compras en navegador            | 98 verificaciones a 1440, 390 y 320 px                                                                                                         |
| Caja y directorios en navegador | 78 verificaciones, incluida paginación con 2,206 registros                                                                                     |
| Listas en navegador             | 132 verificaciones, incluida exportación PDF/Excel sin precios completos                                                                       |
| Listas en PostgreSQL            | 54 verificaciones de permisos, reintentos, revisiones, rollback, facturación y contabilidad                                                    |
| Permisos en PostgreSQL          | 50 verificaciones                                                                                                                              |
| Recorrido general               | 17 rutas a 1440, 390 y 320 px; contactos, productos, compras, ventas, proformas, deudas, comprobantes, cierre diario, imágenes y exportaciones |

Se ejecutan también las suites contables, las migraciones completas, tipos, lint y compilación. Los comandos específicos están registrados en `package.json` como `test:price-lists` y `test:browser:store`.

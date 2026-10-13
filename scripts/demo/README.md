# Datos de presentación de Lcp Control

Lote **DEMO-LCP-20261013**, cargado en el proyecto Supabase **xkpujpoocsbkychstrne** el 13 de octubre de 2026. Los productos y contactos ficticios llevan `[DEMO]`. Las notas y referencias identifican el lote. Los datos anteriores se conservaron.

## Qué mostrar

1. Recargar el programa. En Inicio, la jornada del **13/10/2026** está abierta, con 72 facturas y 208 unidades vendidas.
2. En Inventario, buscar **DEMO**: hay 8 perfumes con precios para Emprendedor, VIP y Premium, existencias en tienda y bodega, costo promedio e historial. Las 24 compras recibieron 700 unidades. Hay 75 entradas por renglón de compra, 11 salidas de muestras, 11 daños y dos ajustes de conteo adicionales a los conteos iniciales.
3. En compras/costo de inventario, consultar **DEMO-LCP-20261013-COMPRA-1** a **COMPRA-24**: compras en dólares y córdobas, desde caja, banco y crédito, con envío repartido y costos ponderados.
4. En Ventas, mostrar **FAC-000003** a **FAC-000074**: efectivo, tarjetas, BAC, LAFISE, Ficohsa y crédito. Las facturas **FAC-000007** y **FAC-000010** tienen abonos parciales, además de 10 nuevas facturas a crédito abonadas; **FAC-000014** queda pendiente completa.
5. En Proformas, mostrar **PRO-000001** a **PRO-000012**, vigentes hasta el **20/10/2026**. No descuentan inventario.
6. En Clientes y Proveedores, buscar **DEMO**: 5 clientes y 2 proveedores ficticios, sin teléfonos reales ni correos de personas reales.
7. En Contabilidad/Informes, seleccionar el **13/10/2026**: apertura contable, compras, ventas, pérdidas y sobrantes de inventario, 13 gastos, 12 cobros, 2 aportes ficticios y 1 abono de C$ 5,000 al proveedor. Hay crédito pendiente por cobrar y pagar, y tarjetas pendientes de acreditar. La balanza está equilibrada y no faltan costos del lote.

La caja esperada actual se conserva en `verificacion_20261013.json`, en `day.report.expectedNio` y `day.report.expectedUsd`. Sirve para mostrar el cierre de jornada con diferencia cero. Si se registran operaciones adicionales, los valores cambian. El lote corresponde a una sola fecha; una presentación posterior debe consultar ese período y gestionar la jornada según las reglas normales de la aplicación.

La ampliación añadió **132 operaciones**: 60 facturas, 20 compras, 20 salidas/daños, 10 proformas, 10 gastos, 10 cobros y 2 aportes. Las compras y ventas también generan sus propios renglones de inventario y costo; estos registros derivados no se cuentan como operaciones adicionales para alcanzar la cifra solicitada.

## Limpieza después de presentar

**No ejecutar todavía.** Abrir `limpiar_demo_20261013.sql` en el editor SQL del proyecto indicado y ejecutarlo como administrador cuando se termine la presentación. El script está limitado a los identificadores del lote y se ejecuta en una transacción. Puede limpiar su jornada aunque se haya cerrado durante la presentación. Conserva los 260 productos originales, sus precios y existencias, las cuentas, los usuarios y los registros anteriores.

La limpieza aborta sin borrar nada si encuentra operaciones adicionales que dependan de los registros DEMO o actividad ajena al lote desde la apertura contable. En ese caso se debe revisar y ampliar la limpieza con los identificadores concretos de esas operaciones. No elimina automáticamente datos anteriores: la base ya tenía 2 facturas, 11 movimientos y 1 gasto antes de esta carga. Una limpieza completa de esos registros requiere identificarlos y decidir su alcance por separado.

`cargar_demo_20261013.sql` conserva la carga exacta y evita duplicar un lote presente. Las operaciones se registraron mediante las funciones de negocio existentes; no se modificó el esquema ni se desactivaron controles. Los productos y contactos se insertaron con identificadores propios para aislarlos. La autoría del lote corresponde al administrador Diego.

`ampliar_demo_20261013.sql` registra compras, salidas, gastos y aportes adicionales. Después ejecutar `ampliar_documentos_bloque_20261013.sql` con `block_no` igual a 1, 2, 3 y 4, en minutos diferentes, para respetar el límite de 20 documentos por minuto. La ampliación es idempotente: cada operación conserva su identificador y solicitud, y no se duplica si se reejecuta con los mismos datos.

## Evidencia

- `estado_previo_20261013.json`: cantidades y huellas de contenido de 27 tablas, excluyendo el lote. Se confirmó que permanecieron iguales después de cargarlo.
- `verificacion_20261013.json`: existencias, facturas, compras, crédito, caja y balanza después de la carga.
- Se ejecutó una limpieza de prueba terminada en **ROLLBACK**. Las 27 huellas coincidieron con el estado previo, y los datos DEMO permanecen cargados para presentar. Los saltos de la secuencia de comprobantes no se reinician; no afectan los saldos.

No borrar tablas completas ni ejecutar `TRUNCATE` o `supabase db reset` para retirar estos datos.

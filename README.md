# La Casa del Perfume

Código fuente de la aplicación de inventario, facturación, proformas y contabilidad, con React, TypeScript, Vite y Supabase.

En **Negocio** se configuran por separado las tasas de **inventario y precios** (36.6243) y **contabilidad** (37). La primera recalcula el catálogo; la segunda se propone en operaciones nuevas y convierte los estados a USD. Ver [uso, activación y comprobaciones](docs/tasas-de-inventario-y-contabilidad.md).

En **Inventario**, al abrir la ficha de un perfume, Administración puede consultar su **Historial de ventas**: fecha y hora, cliente, factura, unidades, precio unitario neto y total en la moneda de la venta. También está disponible en **Editar perfume**. Las devoluciones, facturas anuladas y productos retirados al corregir una factura se identifican expresamente. Requiere `20261111010000_historico_ventas_por_producto.sql`; ver [uso y activación](docs/historico-ventas-por-producto.md).

Las compras pendientes se completan en **Contabilidad → Comprobantes → Clasificar compra**: la primera cuenta queda fija en **Inventario de perfumes**, por el total recibido; se editan las contrapartidas de pago. La cuenta Compras por clasificar se retira del flujo y del catálogo. Aplicar la migración correspondiente antes de publicar la interfaz; ver [recepciones y correcciones contables](docs/recepciones-y-correcciones-contables.md).

Las correcciones de recepción consolidan los importes por cuenta para que un cargo y un abono que se compensan en Inventario no inflen Debe/Haber. El registro original sigue disponible en el detalle. Requiere `20261107220000_consolidar_correcciones_de_recepcion.sql`; ver la misma guía de recepciones.

Contabilidad presenta comprobantes, cobros y pagos, catálogo de cuentas, balanza de comprobación, estado de resultado y estado de situación financiera. El libro integra operaciones automáticas y comprobantes manuales de partida doble. La descarga de Excel contiene las cuatro hojas de estados y catálogo. «Pendiente» indica que falta información para confirmar el importe; no equivale a cero. Los saldos iniciales y ajustes se registran desde Comprobantes; los cobros y pagos se vinculan a su deuda. Los precios se editan en cada perfume.

La balanza separa la apertura contable de los movimientos: la apertura aparece en **Saldo inicial**, incluso cuando su fecha está dentro del rango consultado; **Debe** y **Haber** muestran las operaciones del período. Para períodos posteriores se arrastra el saldo previo. Esta separación requiere aplicar `20261107190000_separar_saldos_iniciales_en_balanza.sql` en Supabase; no modifica los comprobantes ni sus saldos finales. Verificación local aislada: `npm run test:trial-opening`.

**Agregar unidades** permite escribir solo la diferencia: con dos unidades existentes, agregar una deja tres. Los aumentos por ajuste, también por conteo físico, utilizan automáticamente la cuenta de orden **Ajustes de inventario**, sin pedir tratamiento ni contrapartida. Una unidad de C$500 carga C$500 a Inventario y abona C$500 a esa cuenta de orden, sin reconocer ingresos ni pérdidas. Las deducciones conservan la elección de cuenta. Requiere `20261111230000_orden_automatica_para_aumentos_de_inventario.sql`, que crea la cuenta con un código libre sin modificar cuentas existentes. Ver [cantidades y valoración](docs/ajustes-de-inventario.md).

Las correcciones pueden usar una **cuenta de orden**, visible en la balanza y fuera del estado de resultados. En **Contabilidad → Catálogo → Administrar cuentas**, el dueño crea su cuenta bajo **7000 · Cuentas de orden**; no se crea una cuenta de movimiento automáticamente. **Descontar unidades** y **Salida**, para Superadmin, también permiten elegir esa contrapartida sin reconocer una pérdida. Requiere aplicar `20261111000000_cuentas_de_orden_para_ajustes.sql` antes de publicar la interfaz. Ver [ajustes de inventario](docs/ajustes-de-inventario.md).

Al disminuir un conteo existente se elige **Corrección de cantidad (sin pérdida)** o **Pérdida real**. La corrección exige una cuenta de contrapartida de balance o de orden en córdobas y conserva un comprobante vinculado; la pérdida utiliza **Pérdidas de inventario**. Aplicar `20261107200000_ajustes_de_inventario_con_contrapartida.sql` antes de publicar la interfaz. Ver [ajustes de inventario](docs/ajustes-de-inventario.md).

**Pérdidas de inventario** se puede elegir directamente en **Cuenta de contrapartida** para una baja real, sin asignarla automáticamente a las correcciones. En **Movimientos**, Superadmin dispone de **Anular ajuste** para revertir un ajuste manual equivocado conservando su historial y costo. Requiere `20261108000000_anular_ajustes_de_inventario.sql`.

En **Negocio → Importar desde Excel**, los administradores pueden descargar la plantilla y cargar productos, precios, existencias de bodega y tienda, cuentas y saldos iniciales, clientes, proveedores y datos del negocio. Incluye vista previa, validación completa y protección contra cargas duplicadas. Ver [formato y puesta en marcha](docs/importacion-excel.md); la función requiere aplicar la migración de importación en Supabase antes de utilizarla con la base remota.

En **Inventario → Listas de precios**, administración puede crear listas con su propio nombre y editar varios perfumes a la vez. Las listas adicionales empiezan sin precios y también se pueden completar desde la edición del perfume. Un perfume sin precio en la lista elegida no puede facturarse con ella. La plantilla inicial de Excel conserva las columnas de Emprendedor, VIP y Premium; las listas adicionales se completan desde Inventario.

**Entrada** y **Recibir mercadería** permiten guardar una recepción pendiente de revisión contable. Sus unidades no están disponibles para vender ni afectan el mayor hasta que administración revise los costos y confirme caja, banco o crédito del proveedor. La confirmación incorpora existencias y registra la compra una sola vez. Ver [recepciones y activación](docs/recepciones-de-mercaderia.md). **Ajustar existencias**, disponible para **Superadmin** desde Inventario y al editar cada perfume, permite guardar el total contado en Tienda o Bodega, hacia arriba, hacia abajo o en cero, con motivo e historial. Al editar un perfume, Superadmin puede agregar las unidades adicionales o guardar el conteo total; las compras se eligen por separado. Ver [uso y activación de ajustes](docs/ajustes-de-inventario.md). El rol **Caja** tiene facturación e historial propio; las proformas, la edición de clientes y los movimientos de inventario requieren otro rol autorizado.

En Registrar compra, el campo Proveedor sugiere los proveedores activos guardados al buscar por nombre, teléfono o RUC. Se puede elegir con el ratón o con las flechas y Enter; también admite un nombre escrito libremente sin crear otro contacto.

En Facturación y Proformas se puede indicar envío por Moto, CargoTrans o Buses y cuánto se cobra al cliente. El envío aparece desglosado y se suma al total cobrado; Contabilidad lo reconoce separado de la venta de perfumes. El pago posterior al transportista se registra desde **Comprobantes → Pago de envío**. Ver [uso y activación de envíos](docs/envios-a-clientes.md).

## Instalar y ejecutar

Requiere Node.js 22.12 o superior y npm. Ejecutar desde la raíz:

```sh
npm ci
npm run dev
```

Abrir http://127.0.0.1:5173/login e ingresar con una cuenta activa del personal autorizada en Supabase.

## Conexión a Supabase

Esta entrega incluye `.env.local` con la URL y la clave publicable del proyecto **La Casa del Perfume**. El navegador usa esa clave; los permisos y las operaciones definitivas se comprueban en Supabase.

Si se obtiene el código mediante Git, crear `.env.local` copiando `.env.example`, que conserva la misma configuración pública. Para usar otro proyecto, cambiar `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY`. No colocar contraseñas, claves secretas ni `service_role` en variables `VITE_*`.

El backend utiliza la base remota existente. Los archivos de `backend/supabase/migrations/` conservan el SQL del proyecto; instalar dependencias o compilar no aplica migraciones. Configurar en Supabase las URL de retorno de autenticación del dominio donde se publique la aplicación.

## Estructura

- `frontend/`: pantallas, servicios del navegador, estilos y recursos visuales.
- `backend/supabase/migrations/`: tablas, funciones de negocio y políticas de acceso.
- `shared/contracts/`: tipos compartidos independientes de la interfaz.
- `scripts/dev/clean.mjs`: limpieza de salidas y cachés locales.

Los manifiestos `package.json`, el lockfile y las configuraciones de TypeScript, Vite, ESLint y Prettier forman parte del proyecto y permiten instalarlo, compilarlo y mantenerlo.

## Verificar y publicar

```sh
npm run check
npm run typecheck
npm run test:accounting
npm run test:database
npm run test:store
npm run test:price-lists
npm run preview
```

`check` valida lint y compila la aplicación en `output/dist/`. Publicar esa carpeta en un hosting HTTPS con fallback de rutas a `index.html`. `preview` permite revisar la compilación localmente y mantiene el servidor limitado a este equipo.

Con el servidor local activo, `npm run test:browser:accounting` verifica el módulo en Chrome a 1440, 390 y 320 px; `npm run test:browser` recorre también inventario, ventas y reportes. Las pruebas interceptan Supabase y usan datos aislados. `LCP_TEST_BASE_URL` permite elegir un servidor local distinto del puerto 5173. La auditoría y sus correcciones se documentan en [el informe contable](docs/auditoria-contabilidad-2026-10-13.md).

`npm run test:browser:store` verifica las entradas con costo, las listas adicionales, Caja y los filtros de clientes. La [revisión del 24 de octubre](docs/revision-tienda-2026-10-24.md) resume los cambios y sus comprobaciones.

`test:store` simula 30 jornadas con 1,200 facturas y concilia inventario, caja, bancos y contabilidad en una base desechable. La [revisión de entrega del 16 de octubre](docs/revision-entrega-2026-10-16.md) documenta las comprobaciones, los comprobantes automáticos y la carga de costos.

La entrega no incluye dependencias instaladas, compilaciones, cachés, informes ni respaldos. `npm ci` instala las dependencias y `npm run build` genera la compilación. Para limpiar las salidas después de detener dev/preview:

```sh
npm run clean
```

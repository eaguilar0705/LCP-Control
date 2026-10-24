# La Casa del Perfume

Código fuente de la aplicación de inventario, facturación, proformas y contabilidad, con React, TypeScript, Vite y Supabase.

Contabilidad presenta comprobantes, cobros y pagos, catálogo de cuentas, balanza de comprobación, estado de resultado y estado de situación financiera. El libro integra operaciones automáticas y comprobantes manuales de partida doble. La descarga de Excel contiene las cuatro hojas de estados y catálogo. «Pendiente» indica que falta información para confirmar el importe; no equivale a cero. Los saldos iniciales y ajustes se registran desde Comprobantes; los cobros y pagos se vinculan a su deuda. Los precios se editan en cada perfume.

En **Negocio → Importar desde Excel**, los administradores pueden descargar la plantilla y cargar productos, precios, existencias de bodega y tienda, cuentas y saldos iniciales, clientes, proveedores y datos del negocio. Incluye vista previa, validación completa y protección contra cargas duplicadas. Ver [formato y puesta en marcha](docs/importacion-excel.md); la función requiere aplicar la migración de importación en Supabase antes de utilizarla con la base remota.

En **Inventario → Listas de precios**, administración puede crear listas con su propio nombre y editar varios perfumes a la vez. Las listas adicionales empiezan sin precios y también se pueden completar desde la edición del perfume. Un perfume sin precio en la lista elegida no puede facturarse con ella. La plantilla inicial de Excel conserva las columnas de Emprendedor, VIP y Premium; las listas adicionales se completan desde Inventario.

**Entrada** y **Agregar unidades** conducen a Registrar compra con el producto, la ubicación y la cantidad elegidos. La compra conserva su costo y actualiza el promedio ponderado; **Ajuste** se utiliza para registrar o corregir conteos. El rol **Caja** tiene facturación e historial propio; las proformas, la edición de clientes y los movimientos de inventario requieren otro rol autorizado.

En Registrar compra, el campo Proveedor sugiere los proveedores activos guardados al buscar por nombre, teléfono o RUC. Se puede elegir con el ratón o con las flechas y Enter; también admite un nombre escrito libremente sin crear otro contacto.

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

# La Casa del Perfume

Aplicación de inventario, facturación y proformas con React, TypeScript, Vite y Supabase.

Esta copia conserva la aplicación y sus herramientas de operación; no incluye suites de pruebas automatizadas.

El proyecto activo ya tiene catálogo, precios, fotos privadas y persistencia de clientes, proveedores, documentos y permisos. El estado de la base y los pasos pendientes de activación están en [docs/guides/database.md](docs/guides/database.md); edición e impresión carta, en [docs/guides/catalog-and-printing.md](docs/guides/catalog-and-printing.md). Guardar código en Git no aplica migraciones automáticamente en otros proyectos.

## Abrir la aplicación

Requiere Node 22.12 o superior y npm. Desde la carpeta del proyecto:

```sh
npm ci
npm run dev
```

Abrir **http://127.0.0.1:5173/login**. Para trabajar con datos reales, configurar `.env.local` según `.env.example` y disponer de una cuenta activa en `staff_members`. Las instrucciones de la base están en [docs/guides/database.md](docs/guides/database.md).

**http://127.0.0.1:5173/demo** permite explorar 30 productos inventados, con códigos `DEMO-0001` a `DEMO-0030`. Esta vista existe únicamente en desarrollo. Siempre usa datos sintéticos, incluso si `.env.local` configura una base real. Permite preparar borradores; no emite documentos ni modifica existencias.

Mantener el servidor encendido mientras se utiliza la aplicación. Usar siempre el mismo origen: `localhost` y `127.0.0.1` tienen sesiones y almacenamiento local independientes. Los servidores de desarrollo y preview escuchan solamente en este equipo.

## Flujos disponibles

- **Catálogo e inventario:** búsqueda y filtros, precios por lista y moneda, fotos y etiquetas CODE128. El código interno procede de `products.sku`; el EAN/UPC del fabricante, si existe, se conserva por separado. Ambos sirven para buscar productos activos.
- **Movimientos reales:** Entrada y Ajuste para administradores y personal de inventario; Salida y Dañado también para ventas. Ajuste establece el saldo total de una ubicación y admite cero. Un producto sin contar requiere primero un ajuste. La confirmación llama a la función transaccional de la base y actualiza la vista.
- **Escáner:** búsqueda manual y cámara, con acciones de inventario sobre el producto encontrado. Requiere localhost o HTTPS y permiso de cámara. La cámara se libera al detenerla o salir.
- **Facturación:** emite `FAC-…` con cliente, teléfono, forma de pago y ubicación; descuenta inventario al confirmarse en la base. No es un comprobante fiscal y no calcula impuestos.
- **Proformas:** emite `PRO-…` con vigencia; no cobra ni modifica inventario. Tiene borradores separados de las facturas.
- **Documentos emitidos:** muestran los renglones e importes confirmados por la base, quedan bloqueados para edición y pueden imprimirse o compartirse. Para preparar otro documento se usa Nueva factura/Nueva proforma. El RUC del cliente se conserva al emitir. El historial filtra por período (Hoy, Últimos 7 días, Este mes, Mes pasado o fechas a mano), carga de 100 en 100 y permite reabrir y reimprimir cada documento. «Exportar PDF del período» descarga un solo PDF con el listado del período (totales por moneda y por forma de pago) seguido de cada documento completo; admite hasta 2,000 documentos por archivo y, si el período tiene más, pide un rango más corto en lugar de recortarlo. Las facturas ya no se exportan a Excel.
- **WhatsApp y PDF:** comparten un borrador identificado como tal o el documento emitido. WhatsApp abre el mensaje para revisión y envío manual. El PDF usa el menú de compartir cuando el navegador lo permite; en computadora se descarga.
- **Inventario unificado:** vistas de tarjetas y tabla, alta, edición, cambio de foto, tres listas de precios (Emprendedor, VIP y Premium) en dólares y córdobas según la tasa del negocio, y retiro/reactivación para administradores. Desde la edición se pueden sumar o descontar cantidades por ubicación, con motivo e historial. Los datos del perfume y los movimientos tienen botones de guardado independientes.
- **Precios desde el precio de compra:** el administrador escribe en cada perfume su **precio de compra** (en US$ o C$) y un **porcentaje de ganancia** por lista (Emprendedor, VIP y Premium): `precio de venta = precio de compra × (1 + % ÷ 100)`, al centavo, en la moneda de la compra; la otra moneda sale de la tasa del negocio. Se edita en la ficha del perfume, en la pantalla **Precios** o cargando un Excel/CSV con las columnas Precio de compra, Moneda de compra y los porcentajes. Una lista sin porcentaje conserva su precio a mano; una con porcentaje y sin precio de compra queda «Falta precio de compra» con su precio publicado. El costo promedio del inventario (compras y costo inicial) sigue sirviendo para márgenes y contabilidad, pero ya no cambia precios. Sólo Administrador y SuperAdmin ven el precio de compra y los porcentajes. Migración `20261002120000_purchase_price_pricing.sql`.
- **Mi cuenta:** nombre visible, correo y contraseña de la propia cuenta.
- **Clientes:** alta, edición, archivo, contacto, RUC y lista de precios; selección directa al facturar/cotizar.
- **Usuarios:** autorización previa de correos, cinco roles y desactivación conservando el historial. Cada persona activa su acceso en `/activate`. El envío SMTP a usuarios fuera del equipo de Supabase está pendiente.
- **Negocio:** nombre comercial, dirección y teléfono editables, y el tipo de cambio vigente del dólar. La tasa se propone al facturar en dólares y al registrar compras y gastos; cada operación conserva la que se usó, así que cambiarla no altera nada ya emitido.
- **Proveedores:** contactos, condiciones, notas y estado compartidos en Supabase, con revisión de cambios concurrentes.
- **Reportes:** ingresos, ticket, unidades y proformas con su variación contra el periodo anterior; cobertura de existencias, capital detenido, concentración de ventas, clientes que no volvieron, frecuencia de compra, ventas por día de la semana y mermas. Se descargan en PDF y en Excel (el libro ya no lista las facturas una por una: eso se exporta en PDF desde el historial). Las cifras las calcula la base de datos con `public.report_digest`, así que un año de ventas llega ya sumado en lugar de descargar cada factura; la migración ya está aplicada en el proyecto de Supabase; en una base sin ella, se calculan en el navegador como antes y la pantalla lo avisa.
- **Contabilidad:** resumen de utilidad y dinero, pedidos y costo promedio ponderado, gastos, cuentas por cobrar y pagar con abonos vinculados a cada factura o pedido, caja y banco, flujo de efectivo y arqueo físico por denominación con diferencias e historial. El estado de resultados utiliza costos congelados; el balance identifica el patrimonio por conciliar y los valores históricos pendientes. El Excel incluye movimientos, deudas, flujo y arqueos. Sólo Administrador y SuperAdmin. Las migraciones están aplicadas en Supabase y verificadas el 3 de octubre de 2026; ver [la guía de contabilidad](docs/guides/contabilidad.md) para registrar los saldos iniciales reales y el [historial del proyecto](docs/reports/historial-del-proyecto.md) para el resumen de lo trabajado por módulo.

Los reintentos de emisión y movimientos con los mismos datos conservan el identificador de operación mientras el formulario sigue abierto. Los clics simultáneos comparten una sola solicitud. Si se pierde una respuesta, reintentar desde ese formulario. Cerrar, recargar o empezar otra operación crea una nueva solicitud: ante una emisión dudosa, comprobar el registro en la base antes de repetirla.

## Almacenamiento y datos

Los registros reales viven en Supabase; los precios y existencias se validan allí. Las políticas de acceso exigen una cuenta activa del personal. La aplicación obtiene el rol de `staff_members`, no de metadatos editables del navegador.

**Sesión sólo en memoria.** La sesión (tokens de acceso y de renovación) vive únicamente en la memoria de la pestaña: no se escribe en localStorage, sessionStorage, IndexedDB ni cookies. Las peticiones del SDK y las fotos privadas usan `no-store`; catálogo y editor muestran objetos temporales que se revocan al salir de la vista. Las firmas de fotos en memoria se invalidan al cerrar sesión o cambiar de cuenta. Recargar la página, abrir otra pestaña o cerrar el navegador pide la contraseña otra vez. Al arrancar se borran las claves de sesión heredadas conocidas de localStorage y sessionStorage del origen actual. No elimina entradas HTTP históricas de otras versiones ni datos del gestor de contraseñas del navegador.

Borradores de facturas y proformas se guardan por cuenta en Supabase y se sincronizan entre equipos con detección de conflictos. Clientes y proveedores también viven en la base. Solo la demostración mantiene registros locales; las preferencias y frases se conservan en el navegador. Los datos locales antiguos no se importan automáticamente.

El catálogo real no se incluye en `src/data/catalog.json` ni en la compilación. El importador genera un archivo privado:

```sh
python scripts/catalog/import_catalog.py RUTA_A_LA_CARPETA_CON_LOS_EXCEL
```

La salida es `private-data/catalog.json`, ignorada por Git. Este script no carga los datos a Supabase por sí solo. El análisis de origen está en [docs/discovery/catalog-import.md](docs/discovery/catalog-import.md). Las fotos se sirven desde Storage privado después de importarlas. Las pendientes muestran una alternativa y conservan el enlace original para abrirlo manualmente.

## Estructura del proyecto

```text
LCP-Control/
├── index.html              Punto de entrada de Vite
├── package.json            Dependencias y comandos npm
├── *.config.ts / .js       Vite, ESLint, TypeScript, Prettier
├── public/
│   └── brand/              Logotipos (imágenes servidas tal cual)
├── src/                    Código de la aplicación (sin pruebas)
│   ├── main.tsx            Arranque: monta la app y carga los estilos
│   ├── app/                Enrutado, layout, contexto de acceso y ErrorBoundary
│   ├── components/         Componentes reutilizables
│   ├── features/           Una carpeta por módulo (sales, inventory, reports…)
│   ├── lib/                Utilidades y reglas de dominio
│   ├── services/           Acceso a datos y adaptadores (Supabase, demo, local)
│   ├── styles/             Todas las hojas CSS
│   └── types/              Declaraciones de tipos
├── supabase/
│   └── migrations/         Migraciones SQL en orden cronológico
├── scripts/                Herramientas de línea de comandos
│   ├── catalog/            Importación de catálogo e imágenes
│   ├── openbeautyfacts/    Auditoría de códigos EAN/UPC
│   └── dev/                Limpieza y PDF de ejemplo
├── docs/
│   ├── guides/             Guías de operación y referencia
│   ├── discovery/          Análisis de origen del negocio y del catálogo
│   └── reports/            Historial del trabajo por módulo
├── output/                 Generado, ignorado por Git: se borra con npm run clean
│   ├── dist/               Compilación de producción
│   ├── cache/              Cachés de TypeScript y Vite
│   └── pdf/                PDF de ejemplo (npm run clean no los borra)
└── private-data/           Datos privados del negocio, ignorados por Git
```

El alias `@/` apunta a `src/` (configurado en `vite.config.ts` y `tsconfig.json`).

## Comprobación y mantenimiento

```sh
npm run check
npm run typecheck
```

`check` ejecuta `npm run lint && npm run build`. `typecheck` comprueba los tipos de la aplicación y de la configuración sin generar archivos JavaScript.

Antes de publicar, revisar manualmente las pantallas afectadas, los permisos de cada rol, la impresión/PDF y la cámara de un teléfono. `/demo` permite recorrer los flujos con datos sintéticos; las operaciones que escriben en Supabase requieren una base de desarrollo preparada para esa comprobación.

Para limpiar salidas generadas, detener antes el servidor de desarrollo y el de preview:

```sh
npm run clean
```

Elimina `output/dist` y `output/cache`, además de salidas de pruebas heredadas de versiones anteriores (también si quedaron en la raíz). Conserva dependencias, fuentes, configuración, migraciones, datos y los PDF de ejemplo de `output/pdf`.

Para reconstruir y revisar la versión compilada:

```sh
npm run build
npm run preview
```

Abrir la dirección indicada por preview. La compilación no incluye `/demo`; necesita configuración y una cuenta autorizada. Mantener `output/dist` mientras se use preview o se sirva esa carpeta. Para instalar en otra máquina, conservar `package-lock.json` y ejecutar `npm ci`.

La publicación requiere un hosting HTTPS con fallback SPA a `index.html`. Las comprobaciones de lint, tipos y compilación no sustituyen la aceptación con cuentas reales, conteos físicos ni cámaras de teléfonos.

## Códigos de barras externos

El [auditor de Open Beauty Facts](docs/guides/open-beauty-facts.md) consulta marcas y alias, compara los perfumes y genera un informe privado de EAN/UPC candidatos. Respeta los límites de la API, conserva caché y atribución y no asigna códigos automáticamente. Ejecutar `node scripts/openbeautyfacts/audit_openbeautyfacts.mjs`; los resultados quedan en `private-data/openbeautyfacts/`.

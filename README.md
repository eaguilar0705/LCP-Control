# La Casa del Perfume

Aplicación de inventario, facturación y proformas con React, TypeScript, Vite y Supabase.

El proyecto activo ya tiene catálogo, precios, fotos privadas y persistencia de clientes, proveedores, documentos y permisos. El estado de la base y los pasos pendientes de activación están en [docs/database.md](docs/database.md); edición e impresión carta, en [docs/catalog-and-printing.md](docs/catalog-and-printing.md). Guardar código en Git no aplica migraciones automáticamente en otros proyectos.

## Abrir la aplicación

Requiere Node 22.12 o superior y npm. Desde la carpeta del proyecto:

```sh
npm ci
npm run dev
```

Abrir **http://127.0.0.1:5173/login**. Para trabajar con datos reales, configurar `.env.local` según `.env.example` y disponer de una cuenta activa en `staff_members`. Las instrucciones de la base están en [docs/database.md](docs/database.md).

**http://127.0.0.1:5173/demo** permite explorar 30 productos inventados, con códigos `DEMO-0001` a `DEMO-0030`. Esta vista existe únicamente en desarrollo y pruebas. Siempre usa datos sintéticos, incluso si `.env.local` configura una base real. Permite preparar borradores; no emite documentos ni modifica existencias.

Mantener el servidor encendido mientras se utiliza la aplicación. Usar siempre el mismo origen: `localhost` y `127.0.0.1` tienen sesiones y almacenamiento local independientes. Los servidores de desarrollo y preview escuchan solamente en este equipo.

## Flujos disponibles

- **Catálogo e inventario:** búsqueda y filtros, precios por lista y moneda, fotos y etiquetas CODE128. El código interno procede de `products.sku`; el EAN/UPC del fabricante, si existe, se conserva por separado. Ambos sirven para buscar productos activos.
- **Movimientos reales:** Entrada y Ajuste para administradores y personal de inventario; Salida y Dañado también para ventas. Ajuste establece el saldo total de una ubicación y admite cero. Un producto sin contar requiere primero un ajuste. La confirmación llama a la función transaccional de la base y actualiza la vista.
- **Escáner:** búsqueda manual y cámara, con acciones de inventario sobre el producto encontrado. Requiere localhost o HTTPS y permiso de cámara. La cámara se libera al detenerla o salir.
- **Facturación:** emite `FAC-…` con cliente, teléfono, forma de pago y ubicación; descuenta inventario al confirmarse en la base. No es un comprobante fiscal y no calcula impuestos.
- **Proformas:** emite `PRO-…` con vigencia; no cobra ni modifica inventario. Tiene borradores separados de las facturas.
- **Documentos emitidos:** muestran los renglones e importes confirmados por la base, quedan bloqueados para edición y pueden imprimirse o compartirse. Para preparar otro documento se usa Nueva factura/Nueva proforma. El RUC del cliente se conserva al emitir. El historial permite reabrir los últimos 200 documentos autorizados y reimprimirlos.
- **WhatsApp y PDF:** comparten un borrador identificado como tal o el documento emitido. WhatsApp abre el mensaje para revisión y envío manual. El PDF usa el menú de compartir cuando el navegador lo permite; en computadora se descarga.
- **Inventario unificado:** vistas de tarjetas y tabla, alta, edición, cambio de foto, tres precios en dólares y sus equivalentes en córdobas según la tasa del negocio, y retiro/reactivación para administradores. Desde la edición se pueden sumar o descontar cantidades por ubicación, con motivo e historial. Los datos del perfume y los movimientos tienen botones de guardado independientes.
- **Mi cuenta:** nombre visible, correo y contraseña de la propia cuenta.
- **Clientes:** alta, edición, archivo, contacto, RUC y lista de precios; selección directa al facturar/cotizar.
- **Usuarios:** autorización previa de correos, cinco roles y desactivación conservando el historial. Cada persona activa su acceso en `/activate`. El envío SMTP a usuarios fuera del equipo de Supabase está pendiente.
- **Negocio:** nombre comercial, dirección y teléfono editables, y el tipo de cambio vigente del dólar. La tasa se propone al facturar en dólares y al registrar compras y gastos; cada operación conserva la que se usó, así que cambiarla no altera nada ya emitido.
- **Proveedores:** contactos, condiciones, notas y estado compartidos en Supabase, con revisión de cambios concurrentes.
- **Reportes:** ingresos, ticket, unidades y proformas con su variación contra el periodo anterior; cobertura de existencias, capital detenido, concentración de ventas, clientes que no volvieron, frecuencia de compra, ventas por día de la semana y mermas. Se descargan en PDF y en Excel.
- **Contabilidad:** pedidos de importación —precio del proveedor por perfume y envío cobrado por la agencia según el peso, repartido por igual entre las unidades de la caja—, costo promedio ponderado, gastos en las cinco cuentas del negocio —el pago de préstamos se informa sin restar de la utilidad, porque devuelve capital— y estado de resultados del periodo. Muestra el margen de cada producto y de cada lista de precios, las ventas por debajo del costo, el inventario valorado a costo y la rotación. Sólo para Administrador y SuperAdmin; el personal de ventas nunca ve costos.

Los reintentos de emisión y movimientos con los mismos datos conservan el identificador de operación mientras el formulario sigue abierto. Los clics simultáneos comparten una sola solicitud. Si se pierde una respuesta, reintentar desde ese formulario. Cerrar, recargar o empezar otra operación crea una nueva solicitud: ante una emisión dudosa, comprobar el registro en la base antes de repetirla.

## Almacenamiento y datos

Los registros reales viven en Supabase; los precios y existencias se validan allí. Las políticas de acceso exigen una cuenta activa del personal. La aplicación obtiene el rol de `staff_members`, no de metadatos editables del navegador.

Borradores de facturas y proformas se guardan por cuenta en Supabase y se sincronizan entre equipos con detección de conflictos. Clientes y proveedores también viven en la base. Solo la demostración mantiene registros locales; las preferencias y frases se conservan en el navegador. Los datos locales antiguos no se importan automáticamente.

El catálogo real no se incluye en `src/data/catalog.json` ni en la compilación. El importador genera un archivo privado:

```sh
python scripts/import_catalog.py RUTA_A_LA_CARPETA_CON_LOS_EXCEL
```

La salida es `private-data/catalog.json`, ignorada por Git. Este script no carga los datos a Supabase por sí solo. El análisis de origen está en [docs/discovery/catalog-import.md](docs/discovery/catalog-import.md). Las fotos se sirven desde Storage privado después de importarlas. Las pendientes muestran una alternativa y conservan el enlace original para abrirlo manualmente.

## Comprobación y mantenimiento

```sh
npm run check
npm run test:db
npm run test:e2e
```

`check` ejecuta lint, pruebas unitarias/integración y compilación. `test:db` ejecuta las suites de catálogo y contabilidad en PostgreSQL desechable, incluidas las migraciones de precios en dólares. Playwright utiliza Chrome instalado y prueba escritorio y móvil con un servidor propio en el puerto 5174 y credenciales vacías. El puerto debe estar libre. Las pruebas de interfaz no realizan operaciones contra la base real.

Para limpiar salidas generadas, detener antes las pruebas y el servidor de preview:

```sh
npm run clean
```

Elimina únicamente `dist`, `test-results`, `playwright-report`, `coverage` y la antigua caché `tsconfig.tsbuildinfo`. Conserva dependencias, fuentes, configuración, migraciones y datos. La caché actual de TypeScript está en `node_modules/.cache`.

Para reconstruir y revisar la versión compilada:

```sh
npm run build
npm run preview
```

Abrir la dirección indicada por preview. La compilación no incluye `/demo`; necesita configuración y una cuenta autorizada. Mantener `dist` mientras se use preview o se sirva esa carpeta. Para instalar en otra máquina, conservar `package-lock.json` y ejecutar `npm ci`.

La publicación requiere un hosting HTTPS con fallback SPA a `index.html`. Las pruebas locales no sustituyen la aceptación con cuentas reales, conteos físicos ni cámaras de teléfonos. No se han emitido documentos ni alterado inventario real durante esta revisión.

## Códigos de barras externos

El [auditor de Open Beauty Facts](docs/open-beauty-facts.md) consulta marcas y alias, compara los perfumes y genera un informe privado de EAN/UPC candidatos. Respeta los límites de la API, conserva caché y atribución y no asigna códigos automáticamente. Ejecutar `node scripts/audit_openbeautyfacts.mjs`; los resultados quedan en `private-data/openbeautyfacts/`.

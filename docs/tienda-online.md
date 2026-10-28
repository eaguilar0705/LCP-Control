# Tienda online integrada

Los administradores y superadministradores gestionan la web pública desde **Tienda online** (`/storefront`), usando la sesión habitual de Control. La web pública sigue siendo un proyecto estático independiente; ambos usan el mismo Supabase.

## Comportamiento

- **Catálogos para compartir** contiene cuatro enlaces independientes: Emprendedor, VIP, Premium y Menudeo. Cada enlace entrega solo su precio en USD desde la lista del inventario. La web pública no incluye un selector ni recibe los otros enlaces. Los enlaces son capacidades compartibles: quien reciba otro enlace podrá abrirlo; no sustituyen un acceso individual con contraseña.
- La raíz del catálogo conserva Menudeo. Los precios faltantes se muestran como «Consultar precio», sin sustituirlos por otra lista. Las fotografías, publicaciones y disponibilidad se administran una sola vez; un borrador nunca se publica por editar un precio.
- En Inventario se muestran las cuatro listas juntas y se agrupan los perfumes por marca antes de paginar, en tarjetas, tabla y ficha. La moneda sigue siendo seleccionable. El botón de administración de listas permanece para editar los precios.
- **Elegir del inventario** abre un selector con búsqueda por nombre, marca o código y lleva a la ficha elegida.
- **Cambiar destacado**, en la pantalla principal, reemplaza el único perfume de portada. Solo usa fichas visibles con fotografía; no publica otras ediciones pendientes. La base serializa los cambios y limita a uno los destacados, también al publicar desde un editor anterior. La portada puede mostrar un perfume sin disponibilidad; su ficha conserva el estado real y no permite añadirlo si no está disponible.
- Altas y cambios de nombre, presentación, marca o fotografía crean una revisión pendiente. La descripción editorial se conserva; cada catálogo lee el precio correspondiente del inventario. Se puede usar el origen o rechazar sus cambios.
- Guardar un borrador no publica. Revisar publicación permite ver el resultado antes de aprobarlo.
- La disponibilidad automática considera Tienda y Bodega. Cualquier existencia positiva confirmada permite anunciar Disponible; sin existencias confirmadas se muestra No disponible. Los conteos ausentes o nulos se distinguen de cero en el administrador.
- El público no recibe cantidades, costos ni datos de origen. Solo recibe la publicación aprobada y su disponibilidad.
- **Ocultar cuando no esté disponible** se configura por perfume y se aplica al publicar. La reposición vuelve a mostrarlo. Ocultar o archivar manualmente lo mantiene oculto.
- Desactivar o eliminar el origen genera una **baja pendiente**. Su ficha pasa a No disponible. **Aceptar baja** archiva y oculta; **Conservar ficha** conserva la publicación anterior sin recuperar el producto de Control.
- Un producto independiente se administra manualmente. No crea inventario ni ventas.
- El indicador del menú consulta revisiones al cambiar de pantalla, al enfocar la aplicación y cada minuto mientras la pestaña esté visible. La bandeja se actualiza con su botón Actualizar y después de cada acción.

## Datos y seguridad

`storefront_drafts` guarda borradores y opciones pendientes. `storefront_publications` conserva la versión aprobada, las opciones de disponibilidad publicadas y la intención editorial de visibilidad (`listed`). La disponibilidad nunca incrementa la revisión editorial ni reemplaza nombres o precios pendientes.

Las operaciones pasan por `storefront_action`, con comprobación de rol y revisión en la base. Las políticas RLS limitan la lectura; los visitantes solo leen columnas públicas de publicaciones visibles. Las fotos de origen se copian al publicar, y solo las fotos aprobadas son descargables sin sesión.

Las imágenes iniciales se incluyen en `frontend/public/storefront/images/productos/` para que Control no dependa del dominio de la landing. Las fotografías nuevas se almacenan en Supabase Storage.

Migraciones aplicadas al proyecto actual:

- `20261025125859_storefront_revision_publicacion.sql`
- `20261026053624_catalogo_integrado_disponibilidad.sql`
- `20261027224831_destacar_un_solo_perfume.sql`
- `20261028181345_catalogos_independientes_por_lista.sql`

No repetir la importación inicial ni ejecutar migraciones desde el build de Cloudflare.

## Verificación

### Revisión de compra, publicación y venta del 26 de octubre de 2026

La revisión adicional se preparó en `codex/revisar-tienda-online`, basada en `codex/catalogo-publicacion` e incluyendo el `main` anterior. La entrega integra el módulo en `main` y actualiza también `codex/catalogo-publicacion`, la rama de producción configurada actualmente en Cloudflare Pages. El alias `main.lcp-control.pages.dev` es una vista previa mientras se conserve esa configuración.

- `npm run test:storefront`: **101 comprobaciones** en PostgreSQL desechable. Las 21 nuevas usan las funciones reales de compra, emisión de factura y devolución: compra sin publicación automática, borrador privado, publicación aprobada, venta parcial, factura idempotente, venta de la última unidad, sobreventa rechazada, devolución, reposición y agotamiento entre Tienda y Bodega. También comprueban que las ventas respetan el precio público, los borradores pendientes y la ocultación manual.
- Prueba de navegador contra esa base aislada: guardar un borrador no lo publica; aprobar muestra USD 37.50; una factura de dos unidades desde Facturación agota el perfume; el catálogo abierto cambia a **No disponible**, deshabilita Añadir y elimina el artículo de la selección sin recargar. La reposición recupera la disponibilidad.
- Se aclaró el acceso **Elegir del inventario**. **Crear ficha independiente** conserva la opción manual y deja claro que no queda vinculada a existencias. Se alinearon fotos, precios y controles, y se revisaron el listado y el editor a 390 px y el catálogo a 320 px, sin desbordamiento horizontal.
- Control pasa ESLint, TypeScript y compilación. El catálogo pasa sus comprobaciones de sintaxis, límites de publicación, compilación y la prueba del temporizador de actualización.

El catálogo tenía una demora: una página que permanecía abierta no consultaba cambios hasta volver a la pestaña o recargar. La corrección del repositorio independiente consulta publicaciones cada 15 segundos mientras la página está visible y al enfocar o recuperar conexión. Usa peticiones sin caché y evita reconstruir tarjetas cuando no hubo cambios. La copia de trabajo está en `output/catalogo-review`; también se conserva el parche de revisión en `output/storefront-review/catalogo-actualizacion.patch`.

Para reproducir la prueba visual, clonar `LCP-CONTROL-CATALOGO` en `output/catalogo-review` y ejecutar `node scripts/tests/storefront-browser-server.mjs`. Control se sirve en `http://127.0.0.1:5175`, el catálogo en `http://127.0.0.1:4180` y los controles de compra/venta de prueba en `/__qa`. El acceso de este servidor usa `qa@example.test` y cualquier contraseña ficticia. Su transporte sustituye Supabase exclusivamente dentro del servidor de prueba y nunca envía operaciones a producción. `/__qa/frame?width=390` permite revisar el diseño móvil. Cerrar el proceso descarta la base completa.

Las capturas y los resultados están en `output/storefront-review`. La consulta de producción fue únicamente de lectura pública: ambos proyectos usan el mismo Supabase y devolvieron 272 publicaciones. No se alteraron inventario, ventas, publicaciones ni cuentas reales.

### Verificación anterior

`npm run test:storefront` ejecuta 80 comprobaciones aisladas de publicación, permisos, archivos, concurrencia editorial, disponibilidad, bajas y protección de cantidades. También se ejecutaron las pruebas de acceso al catálogo, jornada y traslados; TypeScript, ESLint de los archivos modificados y build de producción.

La prueba de navegador aislada verificó guardar, publicar, copiar la foto del origen, conservar una baja, crear una referencia independiente y añadir una segunda fotografía después de guardar. El editor se revisó en escritorio y a 390 px de ancho. El 26 de octubre de 2026 se completó también la prueba autenticada con la cuenta real: reactivar LCP-0261 en Control, guardar borrador sin exponerlo, aprobar su publicación con USD 37.50, desactivarlo, comprobar la baja pendiente y aceptar su archivo. La referencia quedó nuevamente inactiva y archivada; la web volvió a 272 publicaciones visibles. No se modificaron cantidades, costos ni ventas. Se corrigió la demora del indicador del menú para actualizarlo también al cambiar de pantalla.

## Publicación

La producción actual de Control se publica desde `codex/catalogo-publicacion`, sincronizada con `main` en esta entrega. Comando `npm run build`, salida `output/dist`, Node 22, raíz del repositorio. Cambiar la producción a `main` exige ajustar primero la rama en Cloudflare; subir solo a `main` crea una vista previa. El catálogo usa `main` de su repositorio independiente, comando `npm run check && npm run build` y salida `dist`. La publicación de código no ejecuta migraciones ni vuelve a importar referencias.

La guía completa está en `DESPLIEGUE-CLOUDFLARE.md` del repositorio privado `eaguilar0705/LCP-CONTROL-CATALOGO`. El administrador integrado no necesita un tercer proyecto de hosting.

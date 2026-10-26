# Tienda online integrada

Los administradores y superadministradores gestionan la web pública desde **Tienda online** (`/storefront`), usando la sesión habitual de Control. La web pública sigue siendo un proyecto estático independiente; ambos usan el mismo Supabase.

## Comportamiento

- Altas y cambios de nombre, presentación, marca o fotografía crean una revisión pendiente. El precio público y la descripción editorial se conservan. Se puede usar el origen o rechazar sus cambios.
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

No repetir la importación inicial ni ejecutar migraciones desde el build de Cloudflare.

## Verificación

`npm run test:storefront` ejecuta 80 comprobaciones aisladas de publicación, permisos, archivos, concurrencia editorial, disponibilidad, bajas y protección de cantidades. También se ejecutaron las pruebas de acceso al catálogo, jornada y traslados; TypeScript, ESLint de los archivos modificados y build de producción.

La prueba de navegador aislada verificó guardar, publicar, copiar la foto del origen, conservar una baja, crear una referencia independiente y añadir una segunda fotografía después de guardar. El editor se revisó en escritorio y a 390 px de ancho. El 26 de octubre de 2026 se completó también la prueba autenticada con la cuenta real: reactivar LCP-0261 en Control, guardar borrador sin exponerlo, aprobar su publicación con USD 37.50, desactivarlo, comprobar la baja pendiente y aceptar su archivo. La referencia quedó nuevamente inactiva y archivada; la web volvió a 272 publicaciones visibles. No se modificaron cantidades, costos ni ventas. Se corrigió la demora del indicador del menú para actualizarlo también al cambiar de pantalla.

## Publicación

Esta entrega está en `codex/catalogo-publicacion`. Para el nuevo Cloudflare Pages, seleccionar esa rama o integrarla primero en `main`. Comando `npm run build`, salida `output/dist`, Node 22, raíz del repositorio. El catálogo usa su repositorio independiente, comando `npm run check && npm run build` y salida `dist`.

La guía completa está en `DESPLIEGUE-CLOUDFLARE.md` del repositorio privado `eaguilar0705/LCP-CONTROL-CATALOGO`. El administrador integrado no necesita un tercer proyecto de hosting.

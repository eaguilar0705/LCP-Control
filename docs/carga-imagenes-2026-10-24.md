# Carga de imágenes — 24 de octubre de 2026

Al desmontar una ficha se revocaba su imagen y se repetía la descarga al regresar. El elemento `img` también aparecía sin `src` mientras esperaba, mostrando el icono de imagen rota y su texto alternativo.

## Cambios

- Las fotos descargadas y las solicitudes en curso se comparten entre pantallas durante la sesión.
- La caché vive únicamente en memoria: hasta 256 referencias o 24 MiB de archivos comprimidos. Se eliminan primero las fotos menos usadas; una foto visible no se revoca para cumplir el límite hasta que deje de estar en uso.
- Cerrar o cambiar sesión aborta las descargas pendientes y revoca también las fotos que sigan montadas. Una respuesta tardía no puede repoblar la caché.
- Se mantiene `cache: no-store` y el bucket privado. Las firmas no se asignan al `img`, ni se guardan en localStorage, sessionStorage, IndexedDB o Cache Storage.
- Antes de cargar aparece un recuadro del mismo tamaño. Los errores reales muestran el estado de foto no disponible. Los fallos temporales de red, 408, 429 y 5xx tienen como máximo un reintento; los 404 no se repiten automáticamente.
- Cambiar la fotografía sigue creando una ruta distinta y muestra la nueva imagen.

La primera descarga sigue dependiendo de la conexión. No se precarga todo el catálogo, no se cambian las imágenes originales y no se modifican tablas ni permisos.

## Verificación

`scripts/tests/private-image-downloads.test.mjs` comprueba descargas compartidas, límites de memoria, referencias activas, invalidación, reintentos, cambios de usuario y respuestas posteriores al cierre de sesión.

`npm run test:browser:images` usa PostgreSQL y Storage simulados localmente con archivos PNG reales, respuestas demoradas y contadores de red. Comprueba inventario, facturación, proformas, paginación, sustitución de fotos, errores, renovación de firma y cierre de sesión en escritorio y móvil. No envía solicitudes a Storage de producción.

# Recuperación de pantallas después de una actualización

El error «Failed to fetch dynamically imported module» aparece cuando una pestaña
intenta descargar un módulo que ya no está disponible, por ejemplo después de
publicar una nueva compilación. El 12 de noviembre de 2026, la petición del archivo
`ReportsPage` de la captura devolvía HTML de la aplicación en lugar de JavaScript.
La pantalla predeterminada de React Router ocultaba el panel completo.

La ruta principal ahora tiene una pantalla de error propia. Ante un fallo de
descarga de módulos o CSS, y con conexión, recarga la dirección actual una sola
vez por versión y pestaña. La URL compilada identifica la versión; un marcador
en `sessionStorage` evita recargas repetidas. Si el navegador no permite ese
almacenamiento, no se intenta recargar automáticamente.

Cuando el fallo persiste, hay un mensaje en español y botones para recargar o
ir al inicio. Los errores normales de renderizado muestran esa misma pantalla,
sin recarga automática. La sesión de esta aplicación vive sólo en memoria:
recargar requiere iniciar sesión de nuevo. Después del acceso se vuelve a la
dirección original, incluidos los parámetros y el fragmento. El límite no
impide un nuevo intento manual.

`frontend/public/_headers` configura `Cache-Control: no-cache` en Cloudflare Pages,
incluidas las rutas que sirven `index.html`. El navegador puede conservar los
archivos, pero debe revalidarlos antes de reutilizarlos.

## Comprobación y publicación

```sh
npm run check
npm run test:chunk-recovery
npm run test:browser:chunk-recovery
```

La prueba de navegador crea una compilación de producción con configuración
ficticia en `output/chunk-recovery/dist/` y usa PostgreSQL desechable.
Comprueba edición y guardado de perfumes a 1440, 390 y 320 px; una respuesta HTML
en lugar del módulo; recuperación de la dirección después de iniciar sesión; fallo
persistente sin bucle; reintento manual; y errores de renderizado. Los resultados
y capturas se guardan en `output/chunk-recovery/`.

Publicar `output/dist/` en el proyecto existente de Cloudflare Pages. No requiere
migraciones. Las pestañas que ya estaban abiertas con una versión anterior a esta
corrección necesitan una recarga manual inicial para recibirla.

Referencias: [manejo de errores de carga en Vite](https://vite.dev/guide/build.html#load-error-handling)
y [cabeceras en Cloudflare Pages](https://developers.cloudflare.com/pages/configuration/headers/).

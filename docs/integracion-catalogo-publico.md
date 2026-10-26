# Integración con el catálogo público

El catálogo se mantiene en el repositorio independiente [LCP-CONTROL-CATALOGO](https://github.com/eaguilar0705/LCP-CONTROL-CATALOGO). Control y el catálogo usan el mismo proyecto Supabase, con permisos y datos públicos separados de inventario, costos y ventas.

## Base de datos

`backend/supabase/migrations/20261025125859_storefront_revision_publicacion.sql` crea los borradores, publicaciones, bitácora, políticas de acceso, almacenamiento de fotografías y operaciones de revisión. La migración ya fue aplicada al proyecto actual el 25 de octubre de 2026. No debe ejecutarse de nuevo al cambiar el hosting ni formar parte del comando de compilación de Cloudflare.

Un alta o cambio relevante de producto genera una revisión pendiente. La última publicación aprobada sigue visible hasta que un administrador aprueba la siguiente. Los precios internos no reemplazan el precio público.

La ampliación `20261026053624_catalogo_integrado_disponibilidad.sql`, también aplicada, conecta la disponibilidad al inventario y reemplaza la retirada automática por una baja pendiente de aprobación. La administración está integrada en Control → Tienda online. El comportamiento y las pruebas actuales se describen en [tienda-online.md](tienda-online.md).

La carga editorial inicial es independiente de esta migración y ya se realizó. No se deben reimportar los perfumes al desplegar otra URL. Las cuentas administrativas siguen siendo las cuentas activas de Control.

## Verificación realizada

- `node scripts/tests/storefront.mjs`: 45 comprobaciones de revisión, publicación, medios, permisos, precios, retirada y conflictos.
- `node scripts/tests/catalog-access.mjs`: 46 comprobaciones de acceso al catálogo interno.
- Compilación de TypeScript y Vite completada.
- Prueba real de la primera versión en navegador con la sesión del propietario: alta con fotografía en Control, recepción pendiente, borrador privado, publicación con precio público USD 37.50, modificación del origen, segunda aprobación y retirada al desactivar. La ampliación actual cambia esa retirada por una baja con aprobación.
- La referencia temporal LCP-0261 quedó inactiva en Control y archivada en el catálogo. No se registraron existencias, ventas ni movimientos. Se restableció el total de 272 publicaciones visibles.
- La web pública rechazó las cuatro operaciones administrativas anónimas probadas y no expuso fotos privadas del origen.

El entorno PGlite de pruebas simula la función de Storage `allow_only_operation` para comprobar la restricción de descarga frente a listado y enlaces firmados. No es un cambio en los permisos de Storage de producción.

## Despliegue

La [guía de Cloudflare](https://github.com/eaguilar0705/LCP-CONTROL-CATALOGO/blob/main/DESPLIEGUE-CLOUDFLARE.md) contiene los pasos y variables. Se crean dos proyectos Pages: Control con salida `output/dist` y catálogo con salida `dist`. Toda la administración está en `/storefront` de Control. La antigua pantalla `/admin/` del catálogo se retiró; esas rutas responden 404.

Cambiar Cloudflare o sus direcciones no mueve la base de datos. Solo hay que configurar las nuevas direcciones de retorno de Auth y las variables públicas del frontend. El despliegue de código no requiere volver a importar publicaciones.

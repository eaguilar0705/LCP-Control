# La Casa del Perfume

Código fuente de la aplicación de inventario, facturación, proformas y contabilidad, con React, TypeScript, Vite y Supabase.

Contabilidad presenta cuatro vistas: catálogo de cuentas, balanza de comprobación, estado de resultado y estado de situación financiera. La descarga de Excel contiene esas mismas cuatro hojas, vinculadas a las operaciones de la perfumería. Los importes sin información suficiente permanecen pendientes. Los movimientos y gastos se registran desde la balanza; los precios se editan en cada perfume.

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
npm run preview
```

`check` valida lint y compila la aplicación en `output/dist/`. Publicar esa carpeta en un hosting HTTPS con fallback de rutas a `index.html`. `preview` permite revisar la compilación localmente y mantiene el servidor limitado a este equipo.

La entrega no incluye dependencias instaladas, compilaciones, cachés, informes ni respaldos. `npm ci` instala las dependencias y `npm run build` genera la compilación. Para limpiar las salidas después de detener dev/preview:

```sh
npm run clean
```

# Auditoría 26 de septiembre de 2026 — funcionamiento, validaciones y seguridad

Revisión de la versión `f28a064` (la copia local sólo difería en los finales de línea). Las correcciones están en la copia local, sin commit. En Supabase sólo se hizo una escritura, autorizada: cerrar todas las sesiones abiertas (sección 5). No se emitieron documentos ni se tocaron datos del negocio.

## 1. Cómo se probó

- **Batería automática** antes y después: lint, `tsc -b`, pruebas unitarias, compilación, PostgreSQL desechable (`test:db`), scripts, Playwright (escritorio y móvil) y `npm audit`.
- **Todos los botones.** Un recorrido automático abrió cada pantalla y pulsó cada botón visible, recargando la pantalla antes de cada clic. Registró errores de consola, excepciones y botones sin efecto. Se hizo en tres entornos: la vista local (escritorio 1440 px y teléfono 390 px), el modo Supabase contra un servidor simulado con clientes, proveedores, documentos, movimientos y usuarios, y la versión compilada con una política de seguridad de contenido (CSP) estricta.
- **51 escenarios de flujo y validación** en modo Supabase simulado: clientes, proveedores, usuarios, negocio y tasa, movimientos, factura, proforma, eliminación de factura, perfume, mi cuenta, acceso y código HTML malicioso.
- **Credenciales.** Se inició sesión en un Chrome real con perfil en disco. Después se revisaron localStorage, sessionStorage, IndexedDB, Cache Storage, cookies y service workers, y se buscaron la contraseña y los tokens dentro de los archivos del perfil. Se repitió al recargar, al cerrar y reabrir el navegador y al cerrar sesión.
- **Código y repositorio:** búsqueda de secretos en los 22 commits del historial, en la carpeta local y en los archivos comprimidos de `output/`. También se revisaron XSS, enlaces externos, la exportación a Excel y el manejo de errores.
- **Supabase en lectura:** asesores de seguridad, RLS, permisos de `anon`, funciones `SECURITY DEFINER`, bucket y sesiones abiertas.

## 2. Resultado general

| Comprobación | Antes | Después |
| --- | --- | --- |
| Lint y `tsc -b` | Sin errores | Sin errores |
| Pruebas unitarias | 273 en 41 archivos | **279 en 42 archivos** |
| Compilación | Correcta | Correcta |
| PostgreSQL (`test:db`) | 65 | 65 |
| Scripts | 6 | 6 |
| Playwright | 85 aprobadas, 7 omitidas | **93 aprobadas**, 7 omitidas a propósito |
| `npm run test:credentials` (nuevo) | 4 fallos: tokens en localStorage, sesión que sobrevive a F5 | **25 de 25** |
| `npm audit` | 0 vulnerabilidades | 0 vulnerabilidades |
| Botones pulsados (vista local escritorio / teléfono / modo Supabase) | 126 / 162 / 103 | Todos con efecto o deshabilitados con motivo; 0 errores de consola |
| Reportes → «Último año» | **La pestaña se cerraba** | 0,5 s y 340 MB |
| Violaciones de CSP en la versión compilada | 1 por carga (Zod) | 0 |

Los botones deshabilitados lo están con motivo: el documento está vacío, la vista local es de sólo lectura, no se puede eliminar la propia cuenta, no hay página anterior o la tasa no cambió. Las 7 pruebas omitidas lo están por diseño: el PDF sólo se prueba en escritorio y el menú desplegable sólo en el teléfono.

## 3. Hallazgos corregidos

| # | Gravedad | Dónde | Hallazgo (cómo se reprodujo) | Corrección |
| --- | --- | --- | --- | --- |
| 1 | **Alta** | Sesión | Al iniciar sesión, supabase-js guardaba en `localStorage` (`sb-xkpujpoocsbkychstrne-auth-token`) el token de acceso, el **token de renovación** y el correo. Quedaban escritos en el perfil del navegador (`Local Storage/leveldb`). Si alguien cerraba el navegador sin cerrar sesión, al reabrirlo el panel se abría sin contraseña. La contraseña nunca se guardaba. | La sesión vive **sólo en memoria** (`persistSession: false`). Al arrancar se borra cualquier `sb-*-auth-token` que haya dejado la versión anterior. Todas las peticiones a Supabase usan `cache: 'no-store'`. Recargar, abrir otra pestaña o cerrar el navegador pide la contraseña. La renovación del token sigue funcionando en memoria (comprobado). |
| 2 | **Alta** | Reportes | Con «Último año», la memoria de la pestaña crecía unos 570 MB/s hasta que Chrome la cerraba. «Últimos 90 días» tardaba 3,3 s y llegaba a 1,5 GB. Causa: `localDay()` creaba un `Intl.DateTimeFormat` por fecha, miles de veces por mes del periodo, y la memoria nativa no se liberaba a tiempo. Hoy pasa con los datos de muestra; con un año de ventas reales pasaría igual. | Un formateador por módulo en `localDay`, `isoDate`, `formatDate` y `formatCurrency`. «Último año»: 0,5 s y 340 MB. «90 días»: 0,2 s. Prueba unitaria y prueba e2e. |
| 3 | Media | Supabase Auth | 11 sesiones abiertas sin caducidad en 3 cuentas (la más antigua, del 13-09). Sus tokens de renovación estaban en los navegadores donde se inició sesión. | Se cerraron todas, con autorización (sección 5). |
| 4 | Media-baja | Facturación → «Ver ejemplo en carta» | Abre otra pestaña. Con la sesión en memoria, esa pestaña pedía iniciar sesión. | `/documents/example/:kind` ya no exige sesión: sólo muestra datos de muestra, sin nada del negocio. Las pantallas privadas siguen redirigiendo al acceso (prueba e2e). |
| 5 | Baja | Clientes / Proveedores | Un nombre de sólo espacios pasaba el `required` del navegador. La base lo rechazaba con «Revisa el nombre y el estado del cliente». | Aviso en el formulario («Escribe el nombre del cliente/proveedor») y no se envía. Prueba unitaria. |
| 6 | Baja | Versión compilada con CSP | Zod comprueba si puede usar `new Function`. Con una CSP estricta, esa comprobación se reportaba como violación en cada carga, aunque no rompía nada. | `public/zod-jitless.js` desactiva el modo JIT antes de cargar los módulos. Con la CSP de la sección 6: 0 violaciones en 103 botones y 23 flujos. |

### Lo que se comprobó y funciona bien

- **Contraseña:** no aparece en el almacenamiento del navegador ni en ningún archivo del perfil, ni con la sesión abierta ni después.
- **Cookies, IndexedDB, Cache Storage y service workers:** el programa no usa ninguno.
- **Cerrar sesión** revoca la sesión en Supabase (`POST /auth/v1/logout`) y la borra del navegador.
- **El enlace del correo** (`/auth/callback`) limpia los tokens de la barra de direcciones antes de canjearlos.
- **XSS:** un nombre con `<img onerror>` y `<script>` se muestra como texto en la lista, en la factura y al imprimir, y no se ejecuta. El código no usa `dangerouslySetInnerHTML`, `innerHTML` ni `eval`. Excel escribe celdas de texto (`inlineStr`), sin riesgo de fórmulas. El mensaje de WhatsApp va codificado. Los enlaces externos llevan `noreferrer`.
- **Secretos:** no hay ninguno en el historial, en la carpeta local ni en los `.tgz` de `output/`. `.env.test` va vacío. La compilación se detiene si detecta una clave secreta. Los servidores de pruebas sólo escuchan en 127.0.0.1.
- **Errores:** nunca muestran mensajes internos. Supabase sólo pasa los avisos en español escritos para el personal.
- **Validaciones (modo Supabase simulado):**
  - Cliente: nombre vacío o de sólo espacios, correo `ana@`, teléfono con letras, 160 caracteres como máximo.
  - Proveedor: nombre vacío.
  - Usuario: correo `ventas@`, nombre vacío; para eliminar hay que escribir el correo.
  - Negocio: tasa 0, −5 o texto bloqueada; 3,66 pide confirmación con el aviso de más del 10 %.
  - Movimientos: sin producto, cantidad 0 o 1,5, motivo en blanco, salida mayor que lo contado («Solo hay 5 unidades en Tienda»).
  - Factura: sin cliente, WhatsApp `123`, impuesto 150 %, cantidad mayor que las existencias.
  - Perfume: vacío, precio −1, EAN de 3 dígitos, 3 decimales.
  - Mi cuenta: nombre de espacios, contraseña de 6 caracteres, contraseñas distintas, correo `yo@`.
  - Acceso: correo `a@b`, contraseña vacía.
- **Flujos completos:** con datos válidos llaman a la función correcta y muestran el aviso de éxito:
  - Guardar, editar y eliminar clientes y proveedores.
  - Autorizar y eliminar usuarios.
  - Entrada de inventario.
  - Borrador, imprimir, WhatsApp y PDF.
  - Emitir factura y proforma.
  - Eliminar factura.
  - Guardar perfume.
  - Cambiar la contraseña.

## 4. Supabase (lectura)

- **Tablas:** RLS en las 21 tablas públicas. `anon` no tiene permisos sobre ninguna tabla.
- **Fotos:** el bucket `product-images` es privado.
- **Funciones:** las 14 funciones `SECURITY DEFINER` tienen `search_path=''` y comprueban la identidad. Ni `anon` ni `public` pueden ejecutarlas. Los avisos del asesor sobre ellas y sobre las 11 tablas privadas sin políticas son intencionales, igual que en la auditoría del 23-09.
- **Pendiente:** la protección contra contraseñas filtradas sigue desactivada.

## 5. Sesiones cerradas en Supabase

Con autorización del 26-09, se borraron las 11 filas de `auth.sessions`, lo que borra en cascada sus tokens de renovación. Las 3 cuentas tienen que volver a iniciar sesión. Un token de acceso ya emitido sigue siendo válido hasta que vence (1 hora como máximo), pero no se puede renovar. Aparte de estas sesiones, no se tocó ningún dato.

## 6. Cabeceras recomendadas para el hosting (probadas)

Cuando el programa se publique, conviene servirlo con estas cabeceras. Se probaron con la versión compilada: 103 botones y 23 flujos en modo Supabase simulado, sin ninguna violación. Hay que cambiar el dominio de Supabase si es otro.

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://xkpujpoocsbkychstrne.supabase.co; connect-src 'self' https://xkpujpoocsbkychstrne.supabase.co; font-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(self), microphone=(), geolocation=()
X-Frame-Options: DENY
Strict-Transport-Security: max-age=31536000
X-Robots-Tag: noindex, nofollow
```

## 7. Efectos de la sesión en memoria

- **F5, otra pestaña o cerrar el navegador** piden la contraseña otra vez. Los borradores de facturas y proformas no se pierden: se guardan en la cuenta, en Supabase.
- **Un documento sin guardar como borrador** se pierde al recargar, igual que antes.
- **«Reintentar»** en la pantalla de error recarga la aplicación, así que ahora también pide la contraseña.
- **El enlace del correo** (activación o cambio de correo) abre una pestaña nueva, que queda con la sesión iniciada.
- **Sesiones en Supabase.** Si alguien cierra la pestaña sin pulsar «Cerrar sesión», el token desaparece del equipo, pero su sesión sigue registrada en Supabase y se acumula. Se puede limpiar de vez en cuando o poner caducidad en Auth (ver 8.3).

## 8. Pendiente de decisión o del panel de Supabase

1. **Auth → Password security:** activar la protección contra contraseñas filtradas y fijar la **longitud mínima en 12**. La pantalla exige 12, pero Supabase acepta 6 por defecto, y la API se puede llamar sin pasar por la pantalla. Desde SQL no se puede comprobar.
2. **Gestor de contraseñas del navegador.** El programa no guarda la contraseña, pero Chrome ofrece «¿Guardar contraseña?». En una computadora compartida hay que elegir «Nunca» o desactivarlo en la configuración de Chrome.
3. **Caducidad de sesiones.** Supabase Auth → Sessions: «Time-box user sessions» e «Inactivity timeout» (plan Pro). Otra opción es borrar de vez en cuando las sesiones sin actividad.
4. **Repositorio público.** Hoy se clonó sin credenciales y `docs/reports/evaluacion-2026-09-15.md` sigue con los correos del personal.
5. Siguen sin resolverse varios pendientes del 23-09:
   - Pedir confirmación antes de emitir una factura; hoy se emite con un clic.
   - Las 3 cuentas son SuperAdmin.
   - Versionar las 2 migraciones que sólo están en la base.
   - Carga de conteos, mínimos y costos.
6. **Fotos.** Las URL firmadas de las fotos duran 24 h. No son credenciales, pero un enlace compartido abre esa foto durante ese tiempo.

## 9. Archivos

Nuevos: `public/zod-jitless.js`, `tests/security/credentials.mjs` (`npm run test:credentials`), `tests/e2e/security.spec.ts`, `tests/unit/lib/credentialStorage.test.ts`, este informe.

Modificados: `src/lib/supabase.ts`, `src/app/App.tsx`, `src/features/reports/model.ts`, `src/features/sales/document.ts`, `src/lib/format.ts`, `src/features/contacts/ContactsPage.tsx`, `index.html`, `package.json`, `eslint.config.js`, `README.md` y las pruebas `tests/e2e/reports.spec.ts`, `tests/unit/features/reports/model.test.ts` y `tests/unit/features/contacts/ContactsPage.test.tsx`.

Sin migraciones. Para deshacer un archivo: `git checkout -- <archivo>`.

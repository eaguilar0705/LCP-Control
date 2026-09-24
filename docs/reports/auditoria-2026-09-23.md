# Auditoría 23 de septiembre de 2026 — campos, validaciones, interfaz y funcionamiento

Auditoría de la versión `4d64aa6` (la copia local sólo difería en los finales de línea). Se corrigieron en la copia local, sin commit, los errores claros y de bajo riesgo; lo que requiere una decisión del negocio queda en la sección 5. La base real de Supabase se revisó **sólo en lectura**: no se emitió, modificó ni borró ningún dato.

## 1. Cómo se probó

- **Batería automática** antes y después de las correcciones: lint, `tsc -b`, pruebas unitarias, compilación, PostgreSQL desechable (`npm run test:db`), scripts y Playwright (escritorio y móvil).
- **Recorrido en el navegador** de las 24 rutas (demostración, acceso, activación, enlaces de correo, 404) en tres anchos (1440, 390 y 320 px): errores de consola, desbordes horizontales, objetivos táctiles y accesibilidad con axe-core (WCAG 2.1 A/AA).
- **14 escenarios de formularios** con valores válidos, vacíos, negativos, decimales, límites y fechas: factura, proforma, inventario, movimientos, proveedores, escáner, acceso, activación, mi cuenta, reportes y alertas.
- **Lectura del código**: esquemas zod, formularios, adaptadores y funciones SQL, comparando los límites de cada campo en pantalla con los de la base.
- **Supabase en lectura**: asesores de seguridad y rendimiento, permisos de `anon`, RLS y consultas de consistencia de catálogo, inventario, cuentas y borradores.

## 2. Resultado general

| Comprobación | Antes | Después |
| --- | --- | --- |
| Lint y `tsc -b` | Sin errores | Sin errores |
| Pruebas unitarias | 243 en 34 archivos | **273 en 41 archivos** (30 nuevas) |
| Compilación | Correcta | Correcta |
| PostgreSQL (`test:db`) | 65 | 65 |
| Scripts | 6 | 6 |
| Playwright | 74 aprobadas, 6 omitidas | **85 aprobadas**, 7 omitidas a propósito (11 nuevas) |
| axe WCAG 2.1 AA | 3 tipos de fallo (≈160 elementos) | **0** |
| Errores de consola | 0 | 0 |
| Desborde horizontal a 320/390/1440 px | 0 | 0 |

Las 7 pruebas omitidas lo están por diseño: el PDF sólo se prueba en escritorio y el menú desplegable sólo en el teléfono.

## 3. Hallazgos corregidos

| # | Gravedad | Pantalla | Hallazgo (cómo se reprodujo) | Corrección |
| --- | --- | --- | --- | --- |
| 1 | **Alta** | Menú del teléfono | El velo oscuro era una sombra: el toque lo atravesaba y pulsaba el botón oculto. Reproducido: con el menú abierto, tocar fuera abrió «Dañado de inventario». En Facturación el mismo toque puede caer sobre «Emitir factura». Escape no cerraba y el teclado salía del menú hacia la página tapada. | Velo real que cierra el menú; Escape lo cierra; el foco entra en el menú y vuelve al botón que lo abrió; la página queda `inert` mientras está abierto; `aria-expanded`; se cierra solo si la ventana pasa a tamaño escritorio. |
| 2 | **Alta** | Negocio · tipo de cambio | Un clic cambiaba la tasa y repreciaba en córdobas los 260 perfumes, sin confirmación. Escribir 3.66 en lugar de 36.6 bajaba todos los precios un 90 %. | Diálogo de confirmación con la tasa anterior, la nueva y el porcentaje; aviso destacado si el cambio supera el 10 %. El error, si lo hay, queda en el diálogo. |
| 3 | Media | Factura / proforma | Un WhatsApp mal escrito («123») se descartaba en silencio al emitir: el documento y el cliente nuevo quedaban sin teléfono. | Aviso junto al campo («8 dígitos, o completo con el código del país») y no deja emitir hasta corregirlo. |
| 4 | Media | Factura / proforma | El campo Cliente aceptaba 200 caracteres y la base 160: de 161 a 200 la base respondía «Ingresa el nombre del cliente». El nombre vacío sólo se descubría al emitir. | Límite de 160 en el campo y aviso junto a él en cuanto el documento tiene productos. Los borradores pueden seguir incompletos. |
| 5 | Media | Proforma | «Válida hasta» se podía borrar o dejar vencida (p. ej. al reabrir un borrador de días atrás). Vacía, la base fallaba al convertir `''` en fecha y mostraba «No pudimos completar la operación». | Aviso en el campo («Elige hasta qué fecha…» / «no puede ser anterior a hoy») y bloqueo de «Emitir». El adaptador envía `null` en lugar de `''`. |
| 6 | Media | Factura / proforma | No había forma de eliminar un borrador: sólo salían al emitirse. Se acumulan hasta el tope de 1 MB por cuenta, y entonces ya no se puede guardar ninguno. | Botón «Eliminar borrador» (con confirmación) para el borrador abierto. |
| 7 | Media | Iniciar sesión | La base tiene un bloqueo por intentos fallidos (gancho `hook_password_verification_attempt`, HTTP 429 con los minutos de espera). La pantalla lo convertía en «Revisa tu conexión». | Se muestra el aviso del bloqueo; el límite general de Supabase (en inglés) se traduce. |
| 8 | Media | Barra inferior del teléfono | Mostraba siempre Facturación y Proformas, aunque la cuenta (Inventario, Solo consulta) no tuviera permiso: llevaban a «No tienes permiso». | Aplica los mismos permisos que el menú lateral. |
| 9 | Media | Búsquedas | «jazmin» daba 0 de 30 y «Jazmín» 6 de 30; lo mismo con «Nacar». Afectaba a Inventario, Clientes, Proveedores y Facturas/Proformas emitidas (el buscador al facturar sí ignoraba las tildes). | Búsqueda sin tildes ni mayúsculas. Se mantiene la frase completa: «Cedro 01» sigue dando un solo perfume. |
| 10 | Media | Reportes | Al elegir una fecha a mano quedaba marcado «Últimos 30 días». Un «Desde» posterior al «Hasta» (tecleado) mostraba el periodo entero en cero, sin aviso. | Ningún botón queda marcado con fechas a mano y el rango nunca queda invertido: el otro extremo se ajusta. |
| 11 | Media-baja | Facturas emitidas | «Ver documento» dibujaba el documento debajo de hasta 200 tarjetas, sin moverse: parecía que no hacía nada. | Lleva la vista y el foco a las acciones del documento. El contador indica «N de M» al buscar. |
| 12 | Media-baja | Usuarios · Negocio | El formulario de permisos aparece arriba de la lista: al editar a alguien de más abajo quedaba fuera de la pantalla. Los errores al guardar salían arriba, con el mismo aspecto que «Acceso guardado». | Se desplaza al formulario y enfoca el primer campo; el error queda dentro del formulario y se anuncia como error. En Negocio, el error también se muestra como error. |
| 13 | Media-baja | Mi cuenta · Activar | Los avisos salían al final de la página (fuera de la vista en el teléfono); un nombre de sólo espacios llegaba a la base; nada limitaba la contraseña a los 72 caracteres de Supabase. En Activar, «Configura Supabase…» se convertía en un error genérico. | Cada aviso aparece en su tarjeta; se valida el nombre; límite de 72 en las contraseñas; mensajes de configuración conservados. |
| 14 | Baja | Alertas | Decía siempre «Conteos pendientes», aunque todo estuviera contado. Con los mínimos en cero (como hoy) ninguna alerta puede aparecer y no se avisaba. | Distingue conteos pendientes, mínimos sin configurar y «Sin alertas». |
| 15 | Baja | Movimientos | «Dañado registrada», «Ajuste registrada» y el título «Dañado de inventario». | «Producto dañado registrado», «Ajuste registrado», «Producto dañado». |
| 16 | Baja | Accesibilidad | Cabeceras de tabla con contraste 3:1 y celdas/estados con 4,37:1 (mínimo 4,5:1; 155 elementos en Reportes). La página 404 no tenía `h1`. La hoja de ejemplo, desplazable en el teléfono, no se alcanzaba con el teclado. | Colores con contraste AA (mismo tono), `h1` en la 404, hoja enfocable como región. axe queda en 0. |
| 17 | Baja | Ficha del producto | Sin nota de disponibilidad quedaba un «·» colgando. | Se omite el separador. |

### Lo que se comprobó y funciona bien

- Cantidades de factura: 0, −1, 1,5, 10 000 y vacío se rechazan con el aviso correcto; más que las existencias de la ubicación («Solo hay 3 en Tienda») y ubicación sin conteo bloquean la emisión.
- Impuesto (−1, 101, vacío) y tipo de cambio en dólares (vacío, 0, negativo) se marcan y bloquean guardar o emitir.
- Editor de perfumes: nombre, marca, tamaño, EAN (8, 12, 13 o 14 dígitos), mínimo y precios con dos decimales; coinciden con los límites de `save_catalog_product`.
- Movimientos: producto obligatorio, cantidad entera, motivo sin espacios vacíos, salida mayor que lo contado bloqueada antes de llegar a la base.
- Acceso: correo inválido (`a@b`), contraseñas que no coinciden, cuentas sin confirmar.
- Ejemplo de factura con 40 productos en una hoja y descarga de PDF.
- Límites del servidor iguales a los de pantalla en clientes (160/254/80/600/1500), proveedores, negocio, notas y motivos.

## 4. Supabase (sólo lectura)

**Seguridad.** Todas las tablas públicas tienen RLS; `anon` no tiene permisos sobre ninguna tabla ni puede ejecutar funciones; el bucket de fotos es privado (5 MB, JPG/PNG/WebP). Los 14 avisos de funciones `SECURITY DEFINER` ejecutables por `authenticated` son intencionales: cada función comprueba el rol y `test:db` lo prueba. Las 11 tablas privadas con RLS sin políticas también (no tienen acceso desde la API). **Pendiente:** la protección contra contraseñas filtradas (HaveIBeenPwned) está desactivada; se activa en la configuración de contraseñas de Auth ([guía de Supabase](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)).

**Rendimiento.** Dos claves foráneas sin índice en `private.staff_deletions` y cinco índices sin uso: irrelevante con el volumen actual.

**Datos para empezar a operar.**

| Dato | Estado | Consecuencia |
| --- | --- | --- |
| Perfumes | 260, todos activos, 6 precios cada uno, ninguno ≤ 0, córdobas = dólares × 36,6 en todos | Correcto |
| Existencias | 520 de 520 saldos **sin conteo** | No se puede facturar ni registrar salidas hasta contar Tienda y Bodega |
| Mínimo de inventario | 0 en los 260 | Las alertas nunca aparecerán |
| Costo promedio | Sin costo en los 260 | Margen y resultado quedarán «Pendiente» |
| Atributos | 260 sin género, 113 sin categoría, 4 sin tamaño, 2 sin foto, 0 códigos EAN | Filtros incompletos; el escáner sólo reconoce el código interno |
| Documentos | 0 facturas, 0 proformas, 0 movimientos | Sistema aún sin operación real |
| Cuentas | 3 activas, **las 3 SuperAdmin** | Ver 5.2 |
| Borradores | 1 de factura (18 renglones) | Compatible con el esquema actual |

**Historial de migraciones.** `login_attempt_limits` (el bloqueo por intentos fallidos) y `promote_initial_superadmins` existen en la base pero no en el repositorio, y las dos migraciones de hoy no figuran en el historial. Una base creada desde el repositorio no tendría el bloqueo, y las pruebas de PostgreSQL no lo cubren.

## 5. Pendiente de decisión (sin cambios)

1. **Confirmar antes de emitir una factura.** Hoy un clic descuenta inventario y sólo Administración puede deshacerlo eliminándola. Un paso «¿Emitir FAC por NIO …?» evitaría emisiones por error.
2. **Roles.** Las tres cuentas son SuperAdmin: ven costos, cambian la tasa y administran usuarios. Quien sólo factura puede ser Ventas; quien cuenta, Inventario.
3. **Repositorio público.** `eaguilar0705/LCP-Control` es público en GitHub (se clonó sin credenciales) y `docs/reports/evaluacion-2026-09-15.md` contiene los correos del personal. No hay claves en el repositorio.
4. **Versionar las dos migraciones que sólo están en la base.** La de SuperAdmin contiene un correo: conviene hacerlo con el repositorio ya privado.
5. **Auth:** activar la protección contra contraseñas filtradas y confirmar en los *Auth Hooks* del panel de Supabase que el gancho de verificación de contraseña (`hook_password_verification_attempt`) esté activo: la función existe en la base, pero su activación no se puede comprobar desde SQL.
6. **Carga de datos:** conteo físico de Tienda y Bodega, mínimos, costos iniciales y atributos (sección 4).
7. **Borradores:** si un borrador guardado deja de cumplir el esquema (por un cambio futuro del código), la lista entera deja de cargarse y se bloquea guardar (`useWorkspaceDrafts` valida todo junto). Hoy no ocurre.
8. **Escáner manual:** un código de sólo espacios responde «Lectura inválida» y «Reintentar» enciende la cámara.
9. **Cliente por teléfono:** al facturar sin elegir un cliente, si el teléfono ya pertenece a otro, la base usa ese cliente y su nombre, sin avisar.
10. **Pruebas e2e:** con 4 procesos en una máquina de 2 núcleos, 4 pruebas fallaron por tiempo en la primera carga de Reportes; con los 2 procesos configurados pasan todas.
11. El camino `opening` de `AccountingAction` sigue sin punto de entrada (código sin uso).

## 6. Archivos

Nuevos: `src/lib/search.ts`, `tests/e2e/audit-fixes.spec.ts`, `tests/unit/app/AppShell.test.tsx`, `tests/unit/lib/search.test.ts`, `tests/unit/services/signInError.test.ts`, `tests/unit/features/alerts/AlertsPage.test.tsx`, `tests/unit/features/administration/BusinessPage.test.tsx`, `tests/unit/features/auth/AccountPage.test.tsx`, `tests/unit/features/auth/ActivatePage.test.tsx`, este informe.

Modificados: `src/app/{App,AppShell}.tsx`, `src/components/ui.tsx` (`Button` acepta `ref`), `src/features/administration/AdministrationPage.tsx`, `src/features/alerts/AlertsPage.tsx`, `src/features/auth/{AccountPage,ActivatePage}.tsx`, `src/features/contacts/ContactsPage.tsx`, `src/features/inventory/{InventoryMovements,InventoryPage,MovementDrafts}.tsx`, `src/features/inventory/model.ts`, `src/features/reports/{ReportsPage.tsx,model.ts}`, `src/features/sales/{DocumentExamplePage,DocumentHistory,DocumentWorkspace}.tsx`, `src/features/suppliers/SuppliersPage.tsx`, `src/services/{auth,index}.ts`, `src/services/adapters/supabase.ts`, `src/styles/styles.css` y las pruebas de administración, historial, factura, inventario y reportes.

Sin migraciones nuevas. Para deshacer un archivo: `git checkout -- <archivo>`.

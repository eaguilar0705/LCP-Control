# Usuarios y lector integrado

La migración `20260922120000_staff_account_deletion.sql` se aplicó al proyecto
`xkpujpoocsbkychstrne` el 22 de septiembre de 2026 con el nombre
`staff_account_deletion`. Se probó la eliminación de una cuenta sintética en una
transacción revertida: no quedó ninguna cuenta de prueba ni se eliminó una real.

## Eliminación de cuentas

`delete_staff_account` exige un administrador activo y comprueba nuevamente en
el servidor la identidad y el rol de la cuenta que aparece en la confirmación.
Un Admin no puede borrar a un SuperAdmin. Nadie puede borrarse a sí mismo y debe
quedar un SuperAdmin activo. El bloqueo de administración también serializa la
activación de las autorizaciones pendientes.

La operación elimina la autorización pendiente o la cuenta de `auth.users`,
incluidos personal, sesiones y borradores por sus relaciones en cascada. Las
políticas consultan `staff_members`, por lo que un token anterior no conserva
acceso a los datos del negocio después del borrado.

Las referencias históricas apuntan a `private.business_actors`, con UUID y nombre,
sin contraseña ni correo. `private.staff_deletions` registra quién eliminó la
cuenta. Ninguna de estas tablas tiene acceso directo para clientes. Facturas,
movimientos, gastos, costos y autoría del historial de precios se conservan.

Las fotografías del bucket `product-images` cambian de propietario al
administrador que realiza la operación; sus rutas, contenido y asociaciones no
cambian. Si hay archivos en otros buckets, el borrado se rechaza y se revierte
completo. Esta precaución sigue la [restricción de propiedad de Supabase Storage](https://supabase.com/docs/guides/auth/managing-user-data#deleting-users).

La revisión de Supabase señala los RPC `SECURITY DEFINER` como revisables: es
intencional que el cliente invoque estas operaciones; cada función restringe el
rol dentro del servidor y fija `search_path`. La nueva eliminación no otorga
permisos de escritura directa sobre Auth. Ver [aviso del linter](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).
Las tablas privadas sin políticas están cerradas intencionalmente. Sigue
pendiente la configuración anterior de [protección de contraseñas filtradas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

En la comprobación posterior seguían las 3 cuentas reales, 260 productos y 256
archivos de fotografías; no había documentos ni movimientos. El historial remoto
también incluye `login_attempt_limits` y `promote_initial_superadmins` del 19 de
septiembre, que preceden este cambio y no se modificaron.

## Escáner

`ScanButton` abre un diálogo dentro de inventario, el selector compartido por
facturas/proformas y el editor del perfume. La cámara se inicia a petición y se
detiene al leer, cancelar o desmontar. El código también puede introducirse con
teclado o lector USB. La captura no guarda el perfume ni emite el documento.

Inventario limpia los filtros incompatibles y busca por SKU o EAN/UPC. El
selector de documentos mantiene las líneas ya agregadas. El editor conserva los
ceros iniciales y exige el formato numérico de un código del fabricante; el
registro definitivo sigue pasando por las validaciones y restricciones de
unicidad del catálogo. `/scanner` conserva compatibilidad con enlaces anteriores,
pero se retiró de la navegación principal.

## Verificación

`npm run check`, `npm run test:db` y las pruebas Playwright de
`context-scanner`, `scanner-decode`, `unified-inventory` y `reports` cubren el
flujo de confirmación, permisos, borrado real, conservación contable, códigos
internos y de fabricante, captura con cámara y navegación en escritorio/móvil.

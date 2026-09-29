# Acceso y recuperación de contraseña

En la pantalla de acceso, **Olvidé mi contraseña** solicita un correo mediante
Supabase Auth. La respuesta no confirma si una cuenta existe. Se espera un
minuto antes de permitir otro envío; Supabase aplica además sus propios límites.

El enlace de un solo uso pasa por `/auth/callback`, limpia las credenciales de
la dirección y abre `/reset-password`. La nueva contraseña requiere entre 12 y
72 caracteres y confirmación. Un enlace vencido ofrece solicitar otro.
La activación de nuevos usuarios sigue siendo independiente y exige que un
administrador haya autorizado su correo.

Configuración de Authentication → URL Configuration en el proyecto:

- Site URL: `https://lcp-control.pages.dev/`
- Redirect URLs: `https://lcp-control.pages.dev/auth/callback`
- Redirect URLs: `https://lcp-control.pages.dev/auth/callback?type=recovery`

Estas direcciones se verificaron guardadas el 28 de septiembre de 2026.
Los correos enviados antes del cambio pueden conservar enlaces al equipo de
desarrollo: hay que solicitar uno nuevo. Si se cambia el dominio, actualizar
estas direcciones y, si se utiliza, `VITE_AUTH_REDIRECT_URL`, y volver a compilar.
La aplicación publicada ignora una configuración accidental que apunte a localhost.

La entrega del correo depende de la configuración de correo/SMTP y los límites
del proyecto Supabase. `npm run test:recovery` comprueba la interfaz y el intercambio
con Supabase simulado: no envía correos ni cambia contraseñas reales.

Las sesiones continúan sólo en memoria: recargar o cerrar la pestaña requiere
iniciar sesión de nuevo. No se guarda la contraseña ni el enlace de recuperación.

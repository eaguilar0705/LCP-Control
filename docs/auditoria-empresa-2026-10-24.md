# Auditoría del flujo de la empresa — 24 de octubre de 2026

## Alcance y criterio de aprobación

La revisión parte de `main`, commit `0bb1ded`, y usa las migraciones reales del repositorio en bases PostgreSQL desechables (PGlite). Chrome recorre los formularios reales contra esas bases. Las cuentas, documentos, productos y fechas simuladas no se envían a la tienda alojada en Supabase.

No basta con que aparezca una confirmación: se comprueban cabecera, renglones, precio y costo históricos, existencias, numeración, cobros, deudas, caja, bancos, comprobantes y estados contables. Los cálculos esperados se llevan por separado del resultado del servidor. El informe distingue errores corregidos, funciones que todavía faltan y datos reales que debe completar la tienda.

## Errores corregidos en esta revisión

1. **Venta nueva sin costo conocido.** Se podía facturar un perfume con precio y existencias, pero sin costo de inventario; su costo de venta quedaba desconocido y el resultado contable podía quedar pendiente. PostgreSQL ahora rechaza esa emisión completa, indica el perfume y dónde completar el costo, y no consume unidades ni numeración. El carrito se conserva; después de registrar el costo puede emitirse una sola vez. También se protegen salidas, mermas y diferencias de conteo posteriores al conteo inicial. Un costo registrado de cero sigue siendo válido; las proformas y los documentos históricos conservan su comportamiento.
2. **Liquidación POS en dólares bloqueada por redondeo.** US$6, cambio 36.6, comisión 4.5% y retención 1.5% producen neto US$5.64. Convertir los tres débitos por separado daba C$219.59 frente al crédito de C$219.60. En liquidaciones calculadas y validadas por el servidor se distribuye únicamente la diferencia de conversión, hasta C$0.02, al banco receptor. El banco queda en US$5.64/C$206.43; comisión C$9.88; retención C$3.29. No se cambian los importes originales en dólares ni se permite descuadrar un comprobante manual. El formulario muestra el ajuste.
3. **Comprobante manual sin indicación para continuar.** El botón quedaba deshabilitado al no cuadrar el asiento. Ahora permite intentar guardar y explica qué revisar; corregir Debe/Haber conserva concepto, cuentas y demás datos.
4. **Edición de perfume perdida al salir.** Los enlaces de navegación y la recarga ahora avisan si hay cambios. Cancelar la salida conserva la edición. El guardado correcto puede continuar normalmente.
5. **Perfume guardado con respuesta perdida.** Una alta o edición podía haberse guardado, pero el reintento quedaba atrapado en un conflicto de revisión. Se consulta el UUID y se comprueban datos, listas y porcentajes antes de reconocer el guardado. Un conflicto real con otro cambio sigue rechazándose.
6. **Razón social del cliente recortada al imprimir.** El PDF limitaba el nombre a dos líneas. Ahora conserva el nombre completo y ajusta la altura del recuadro. Se revisaron cuatro documentos de 100 productos, 16 páginas Carta, incluidos nombre largo y notas extensas, sin productos omitidos o duplicados.
7. **Segundo comprobante tras una confirmación perdida.** Cambiar el formulario después de un guardado cuya respuesta se perdió podía generar otro UUID y otro comprobante. Ahora se conserva la solicitud original por usuario, se bloquea su edición y se verifica el mismo guardado. La navegación de la pestaña conserva la solicitud y ofrece recuperarla desde el aviso; no permite cerrar sesión antes de verificarla. Los errores de red, permisos o límite de uso durante la verificación no autorizan otra operación. El diálogo no puede cerrarse con Escape mientras hay una confirmación pendiente.
8. **Medios centavos en comisiones y conversiones.** US$53 × 4.5% debe producir US$2.39, pero la aritmética binaria mostraba US$2.38 y podía generar renglones distintos de los aceptados por la base. Los porcentajes y las conversiones del comprobante ahora usan enteros y el mismo redondeo decimal que PostgreSQL; no se relajan las validaciones.
9. **Cambio de datos tras una respuesta perdida en compras, abonos y movimientos.** Se reprodujo una compra de dos unidades cuyo reintento modificado agregaba otras tres, y un abono que se repetía sólo por editar su descripción. La protección compartida conserva la operación original por usuario y rechaza otra solicitud distinta mientras siga sin confirmar. Los campos y cierres del formulario quedan protegidos; se verifica el mismo guardado. Si se navega a otra pantalla, el aviso superior permite confirmar la solicitud original, sin duplicarla. Cerrar sesión permanece bloqueado hasta verificar. Se comprobó también en salidas, daños y cambios de cantidades desde la edición.
10. **Dos listas de precios tras una respuesta perdida.** Se confirmó que cambiar el nombre y reintentar una alta ya guardada creaba otra lista. Ahora se conserva el nombre y el UUID originales, se bloquean edición y cierre hasta verificar y se permite recuperar la operación desde el aviso superior después de navegar. Tras confirmarla se pueden crear otras listas legítimas.
11. **Una ficha antigua restauraba permisos de usuario.** Si otro administrador bajaba a Solo consulta y deshabilitaba una cuenta, guardar únicamente su nombre desde una ficha anterior la restauraba a Admin/activa. La comparación y el guardado ahora ocurren bajo el mismo bloqueo en PostgreSQL. El conflicto conserva lo escrito y ofrece cargar los datos actuales con confirmación. También se impide recrear una cuenta eliminada o ignorar su activación desde una ficha obsoleta. Las versiones antiguas no pueden eludir la protección.
12. **Negocio sobrescribía cambios de otra sesión.** Guardar una dirección desde un formulario antiguo podía deshacer un teléfono actualizado por otro administrador. Se compara la instantánea completa bajo bloqueo de fila antes de escribir. Un conflicto exige revisar los datos actuales y conserva la edición hasta que se acepte recargar. La importación sigue funcionando y un reintento exacto reconoce el guardado anterior sin sobrescribir cambios posteriores.

## Traslados solicitados durante la revisión

Se agregó **Inventario → Traslados**, disponible para Administración e Inventario. Una sola operación descuenta del origen y suma al destino; exige conteos conocidos en ambas ubicaciones, comprueba el stock y no altera el promedio, los precios ni la contabilidad. Caja y Solo consulta no pueden trasladar; Solo consulta puede leer el historial.

El historial guarda perfume y SKU originales, motivo, responsable, fecha de Managua y cantidades anteriores y posteriores en ambas ubicaciones. Se conserva aunque luego se renombre el perfume o se elimine la cuenta del empleado. Una equivocación se corrige con un traslado inverso autorizado y trazable, siempre que todavía haya unidades en su origen; no se borra el primero.

La respuesta perdida se verifica con el mismo UUID, incluso después de cerrar la jornada. Se probaron 500 traslados alternos, fallos inducidos entre historial y cantidades y una venta posterior desde el destino: 6,297 comprobaciones de base y 93 de navegador. No se representan los traslados como entradas de compra o salidas por pérdida.

Las cuatro migraciones de esta revisión modifican funciones y permisos y crean el historial vacío de traslados; no asignan costos, cantidades, precios ni documentos a la tienda.

Se aplicaron las cuatro migraciones a Supabase y se compararon conteos y huellas del contenido de 31 tablas de operación antes y después: idénticos. El historial nuevo de traslados quedó con cero registros. Las operaciones de prueba no se enviaron a esa base. Se revisaron además las funciones actualizadas, permisos y asesores.

## Errores humanos y cómo continuar

| Situación                                                                          | Resultado y recuperación                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Falta un campo obligatorio o se introduce una cantidad no válida para la operación | Se rechaza la operación. Se corrige en el mismo formulario sin dejar una venta o movimiento parcial. El conteo total sí admite cero.                                     |
| Falta el conteo, el precio de la lista elegida o el costo                          | No se inventan valores ni se sustituyen por cero. Administración completa el dato; Caja conserva la venta para reintentar. Caja no recibe el importe de los costos.      |
| Se agrega mercadería a un perfume con costo promedio                               | Se continúa a Registrar compra conservando perfume, ubicación, cantidad y motivo. La entrada sin costo no debe usarse como compra.                                       |
| Se compra mercadería a otro costo                                                  | Se promedia con las unidades existentes de Tienda y Bodega. Las ventas anteriores conservan su costo histórico. Costo de inventario y precio de venta siguen separados.  |
| Se necesita trasladar de Bodega a Tienda o viceversa                               | Se usa Traslados; se exige stock suficiente y conteo en ambos lugares. Un fallo revierte las dos ubicaciones. El promedio y el total general se conservan.               |
| Cambia el precio mientras se prepara una factura                                   | El servidor comprueba el precio confirmado dentro de la transacción. Se actualiza y revisa el precio antes de emitir; el intento rechazado no descuenta unidades.        |
| Se pierde la respuesta después de guardar                                          | Se reutiliza el identificador de la operación y se recupera el resultado; no se debe crear una segunda venta, compra, abono o liquidación.                               |
| Falla un renglón avanzado de una factura de 100 productos                          | Se revierte la transacción completa: cabecera, detalle, costo, existencias y consecutivo. Se probó un fallo técnico inyectado en el renglón 99.                          |
| Se cambia después el nombre/precio del perfume, el cliente o los datos del negocio | El documento emitido conserva sus datos históricos. No se reconstruye una factura antigua con los valores actuales del catálogo.                                         |
| Se cierra por error durante el mismo día                                           | Admin/superadmin puede reabrir con motivo. Se conserva cada cierre y su responsable; una revisión antigua no puede volver a cerrar el estado nuevo.                      |
| Queda abierta la jornada anterior o cambia el día durante un formulario            | Se solicita cerrar la pendiente y abrir la fecha actual de Managua. No se factura a una jornada anterior ni se cierra automáticamente sin arqueo.                        |
| Cambia el reporte mientras se cuenta caja                                          | Hay que actualizar los importes y revisar el arqueo. Se conservan el conteo escrito y el motivo; el servidor vuelve a comprobar el estado al confirmar.                  |
| Hay diferencia entre efectivo esperado y contado                                   | Se conserva la diferencia por moneda y se exige motivo. El conteo físico no sustituye las ventas o gastos guardados.                                                     |
| Abono o comprobante equivocado                                                     | Existe anulación con motivo y conservación del registro, sujeta a permisos y fecha de la jornada. El saldo vuelve a calcularse.                                          |
| Se intenta entrar a un módulo sin permiso                                          | Se deniega también desde PostgreSQL/RLS. Ocultar una pestaña no es la única protección.                                                                                  |
| Dos administradores editan el mismo usuario o Negocio                              | Se rechaza el formulario obsoleto y se ofrece cargar los datos actuales, pidiendo confirmación antes de descartar lo escrito. No se restauran permisos o datos antiguos. |

## Funciones que todavía necesitan una solución

Estas limitaciones no se consideran aprobadas por el hecho de que las pruebas del flujo habitual pasen.

| Prioridad | Falta                                                           | Consecuencia y trabajo necesario                                                                                                                                                                                                                                                                                  |
| --------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alta      | Corrección o anulación de compras                               | Registrar 100 unidades en lugar de 10, o un costo erróneo, afecta promedio, existencias y deuda. Falta un flujo autorizado, con motivo e historial, que revierta o rectifique todo y compruebe si ya hubo ventas posteriores. No se resuelve únicamente con un ajuste de inventario.                              |
| Alta      | Devolución parcial / nota de crédito                            | No hay un flujo específico para devolver parte de una factura, o corregir una venta de una jornada ya cerrada. Debe conservar el documento original y registrar devolución, dinero, crédito, existencias y costo en la fecha que corresponda.                                                                     |
| Alta      | Corregir factura a crédito con historial de abonos              | Incluso si se anula un abono, su vínculo se conserva y puede impedir eliminar la factura. Esto protege el historial, pero falta la rectificación comercial correspondiente. No se debe borrar el vínculo para eludir el bloqueo.                                                                                  |
| Alta      | Elegir el banco pagador en una compra                           | El pago directo con Banco utiliza `1120-000`, banco genérico, sin elegir BAC/LAFISE/Ficohsa ni la cuenta de su moneda. Falta guardar esa selección para conciliar cada banco. Mientras tanto puede registrarse la compra a crédito y después pagar al proveedor desde la cuenta bancaria específica.              |
| Media     | Residuo de costo al agotar existencias en ventas separadas      | Con 15 unidades a C$1,033.333333, la apertura suma C$15,500. Quince ventas de una unidad suman costo C$15,499.95 y dejan C$0.05 en Inventario 1130 con existencias cero. Una venta de 15 consume C$15,500. La partida doble cuadra, pero falta distribuir o regularizar explícitamente ese redondeo por producto. |
| Media     | Pago dividido                                                   | Una factura admite un método de pago. Falta repartir la misma venta entre efectivo, tarjeta y/o transferencia con su conciliación.                                                                                                                                                                                |
| Media     | Atrás del navegador durante edición de un perfume               | El nuevo aviso protege enlaces y recarga, pero no intercepta todavía Atrás/Adelante del navegador. No equivale al mecanismo de recuperación existente durante una emisión. Se necesita protección o recuperación de borrador de producto.                                                                         |
| Media     | Recuperar confirmaciones tras cerrar el navegador               | La solicitud pendiente se conserva durante la navegación de la pestaña y se avisa antes de recargar. Un cierre forzado o la pérdida del dispositivo elimina esa memoria: hay que consultar el historial antes de repetir. Conviene recuperar el identificador de forma segura después de reiniciar.               |
| Media     | Más de 500 comprobantes en un período                           | La interfaz avisa que muestra 500 y pide reducir el período. Las sumas contables se consultan completas, pero conviene paginar el listado para acceder a todos sin cambiar fechas.                                                                                                                                |
| Media     | Restricciones del rol Inventario antes de completar una entrada | Cuando la operación exige costo autorizado, necesita administración. Conviene explicarlo antes de llenar los datos, conservando la protección del servidor.                                                                                                                                                       |
| Media     | Avisar antes de cerrar si el efectivo esperado es negativo      | Conviene advertirlo antes del arqueo y dirigir a revisar pagos y fondos. No debe aceptarse un conteo físico negativo ni inventarse una venta para cuadrarlo; se debe registrar el origen real del dinero.                                                                                                         |

## Estado real de la tienda consultado sin escrituras

Consulta del 24/10/2026: 268 productos activos; 258 con imagen; 9 con algún conteo registrado y 259 sin conteo registrado; los 268 tienen costo registrado. Esto no sustituye una verificación física de cantidades en ambas ubicaciones.

Se encontraron 77 facturas, 12 proformas, 9 clientes y 2 proveedores. Las comprobaciones de integridad consultadas no encontraron facturas con suma de renglones distinta de su total, renglones de factura sin snapshot de costo ni comprobantes manuales descuadrados. Desde la apertura contable del 13/10/2026 no se detectaron costos desconocidos; existen dos movimientos históricos anteriores a esa apertura. No había jornadas abiertas al realizar la consulta.

Hay ocho productos con SKU `DEMO-20261013-01` a `DEMO-20261013-08`. Tienen documentos, compras y movimientos relacionados; quitarlos de la contabilidad exige una depuración planificada. Desactivarlos o quitarles el nombre DEMO no revierte esas operaciones. Esta revisión no los elimina ni altera sus registros.

Faltan imágenes en esos ocho productos DEMO y en dos referencias reales: `LCP-0209`, PACO RABANNE PHANTOM PARFUM 3.4 MEN + 5.0 DEO; y `LCP-0210`, PACO ONE MILLION 3.4 EDT MEN + 3.4 S/G. Se deben completar desde Inventario con fotos de esas presentaciones.

En Negocio están presentes teléfono y dirección. Faltan razón social, RUC, correo y sucursal. Deben completarse desde Negocio y revisarse en una factura antes de entregar el programa.

La comparación de cuerpos de funciones, normalizando saltos de línea, encontró 121 de 122 rutinas de aplicación iguales entre repositorio y producción antes de esta corrección. La restante es `is_superadmin`, con una consulta de rol equivalente y optimizada en producción. No se interpretaron diferencias de nombre de migración como pérdida de funciones.

Los asesores no señalaron errores de nivel ERROR. El resultado final mantiene 17 tablas privadas con RLS sin políticas, 16 funciones administrativas `SECURITY DEFINER` ejecutables por usuarios autenticados y la protección de contraseñas filtradas desactivada. La categoría de funciones pasó de 15 a 16 con los guardados protegidos; sus controles de rol y conflictos se probaron, no se interpreta el aviso como permiso abierto a Caja. No deben eliminarse permisos de las funciones de aplicación sin comprobar sus validaciones: [criterio del asesor](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), [protección de contraseñas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). Los avisos de RLS sin políticas se revisaron junto al acceso restringido por funciones; no justifican abrir lectura directa de tablas privadas. Rendimiento mantiene tres claves foráneas sin índice y una tabla retirada sin clave primaria; los dos índices nuevos de traslados aún no tienen uso porque su historial está vacío.

## Recorrido diario utilizado en las pruebas

1. Administración abre la jornada con el efectivo físico en córdobas y dólares.
2. Se registra mercadería con proveedor, fecha, referencia, unidades, costo y pago; se comprueba el promedio ponderado y su contrapartida. Si cambia de ubicación dentro de la empresa, se registra un traslado.
3. Caja busca productos, selecciona cliente y lista, revisa cantidades, moneda y pago y emite. Se vuelve a consultar la factura para comprobar todos sus datos guardados.
4. Se contrastan existencias, ventas, costo de ventas, ingresos por método de pago y auxiliares. Una proforma se guarda por separado sin descontar inventario.
5. Se registran abonos, pagos, gastos, transferencias y liquidaciones de tarjeta. Los abonos no vuelven a contabilizar una venta; los traslados de dinero no se convierten en ingresos.
6. Se incluyen errores corregibles, pérdidas de respuesta después de guardar, precios cambiados, mermas, devoluciones completas permitidas y cierre accidental con reapertura autorizada.
7. Administración revisa el reporte, cuenta el efectivo real y cierra con motivo de cualquier diferencia. El día siguiente comienza respetando el cierre previo.

En cada jornada se verifica partida doble y se contrasta el balance con activos, pasivos, capital y resultado; no se agrega una diferencia ficticia para hacerlo cuadrar.

## Resultados y reproducción

**La simulación anual terminó aprobada:** 365 jornadas sobre 260 perfumes, 21,900 facturas emitidas (21,535 vigentes y 365 anulaciones completas permitidas), 2,190 proformas, 1,439 compras y 95,362 renglones de factura vigentes. Se registraron 39,617 operaciones RPC y 137,751 unidades vendidas netas.

Se hicieron **4,538,809 comprobaciones** contra un modelo independiente: 24,090 documentos únicos, 47,815 comprobaciones acumuladas de cabeceras y 243,825 de renglones. La relectura final cubrió íntegros los 23,725 documentos supervivientes y sus costos. Los 12 meses y el año completo aprobaron balanza, balance y resultados, sin costos pendientes; se comprobaron los 730 comprobantes automáticos de ventas y costo, consultando meses disjuntos para respetar el límite de respuesta.

También se comprobaron 365 escrituras obsoletas rechazadas, 159 casos inválidos sin escrituras parciales, 53 reaperturas con historial, 512 cambios de catálogo y la conservación de datos históricos. Los 365 casos de liquidación se contrastaron con las matemáticas del frontend: 2,190 comprobaciones adicionales. Después de cerrar el código de la aplicación, una corrida nueva de siete jornadas aprobó 420 facturas, 42 proformas, 21 compras y 76,175 comprobaciones.

**Diferencia de valorización documentada:** al final del año el mayor 1130 conserva C$38,214,596.82; unidades × promedio a seis decimales suma C$38,214,599.79, una diferencia de C$2.97. Redondear cada producto antes de sumar da una diferencia de C$2.88. Se reconstruyó el mayor por los 260 productos y no se insertó ningún ajuste para ocultar la diferencia. Es el residuo de redondeo explicado en los pendientes, distinto de una factura perdida o de un costo desconocido.

La prueba conserva puntos de control completos de PostgreSQL y del modelo esperado. Se corrigió el redondeo del modelo usando enteros y decimales exactos; se registraron retiros banco → caja cuando la operación simulada necesitó fondos. Para la relectura final se ejecutó `ANALYZE` únicamente en PGlite, guardando el plan y las estadísticas: no cambia datos, reglas ni aserciones. La lectura de los comprobantes automáticos se dividió por meses para no confundir el límite explícito de 500 con el total existente. No se consideraron aprobadas las corridas interrumpidas; los diagnósticos resueltos se conservan separados del resultado aprobado.

| Verificación terminada          | Resultado                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------- |
| Año completo y estados          | 365 jornadas; 21,900 facturas; 4,538,809 comprobaciones; 13 períodos; 730 VE/CV |
| Integridad dirigida             | 1,077 comprobaciones, 13 escenarios y factura de 100 productos                  |
| Primer uso y errores humanos    | 486 comprobaciones, cinco roles, 1440/390/320 px                                |
| Comprobantes y redondeo POS     | 420 comprobaciones, 1440/390/320 px                                             |
| Confirmación de movimientos     | 354 comprobaciones, incluidas salidas, daños y cantidades desde edición         |
| Confirmación de compras/abonos  | 180 comprobaciones, navegación y recuperación sin duplicados                    |
| Confirmación de listas          | 150 comprobaciones, más las 132 del recorrido de listas existente               |
| Usuarios y Negocio concurrentes | 174 comprobaciones en 1440/390/320 px                                           |
| Traslados                       | 6,297 comprobaciones de base; 500 traslados y 93 de navegador                   |
| Modelos unitarios               | 101 pruebas aprobadas                                                           |
| Base de datos                   | Los 13 scripts de `test:database` aprobados con las cuatro nuevas migraciones   |
| Compras, listas y Caja          | 98 + 132 + 78 comprobaciones; directorios de 2,206 registros                    |
| Uso cotidiano e inventario      | 1,008 comprobaciones a seis anchos y 207 del flujo de inventario                |
| Imágenes y proveedores          | 120 y 74 comprobaciones                                                         |
| Recorrido de entrega            | 205 comprobaciones y recorrido general de 17 rutas a tres anchos                |
| Fechas e historial              | 189 comprobaciones; otras 24 para 1,205 facturas y exportación 500 + 500 + 205  |
| Contabilidad en navegador       | Estados, comprobantes automáticos VE/CV y PDF en 1440/390/320 px                |
| Compilación                     | Lint, tipos y build aprobados                                                   |

- `npm run test:enterprise`: integridad dirigida y simulación anual. `LCP_SIMULATION_DAYS` permite una corrida corta; el valor predeterminado de la nueva prueba es 365.
- `npm run test:browser:enterprise`: siete suites de primer uso, comprobantes, confirmación de movimientos/compras/abonos/listas, concurrencia de usuarios/Negocio y traslados en 1440, 390 y 320 px.
- Los grupos nuevos de confirmación verificaron 354 casos de movimientos y 180 de compras y abonos. Incluyen pérdida de respuesta después de guardar, intentos de cambiar datos, navegación Atrás, recuperación desde el aviso y bloqueo de un segundo formulario.
- `npm run test:enterprise:pdf`: cuatro documentos, 16 páginas Carta y 100 productos por documento, con revisión de contenido y márgenes. Requiere Python con `pdfplumber`; se puede indicar el ejecutable mediante `LCP_PYTHON`.
- `npm run test:database`, `npm run test:accounting`, `npm run check` y `npm run typecheck`.
- Suites de compras, Caja, listas, usabilidad, imágenes, proveedores, contabilidad, cierres, fechas de pagos e historial voluminoso.
- Para un servidor local distinto de 5173: `LCP_TEST_BASE_URL=http://127.0.0.1:5174`.

Las evidencias locales quedan en `output/enterprise-integrity/`, `output/enterprise-year-final/`, `output/enterprise-year-postrelease-smoke/`, `output/first-use-audit/`, `output/journal-contingencies/`, `output/movement-confirmation/`, `output/enterprise-operation-confirmation/`, `output/price-tier-confirmation/`, `output/enterprise-master-data/`, `output/inventory-transfers/`, `output/inventory-transfers-browser/` y `output/enterprise-production-readonly.json`. Las suites nuevas también pueden ejecutarse individualmente desde `scripts/tests/`. `output/` no se publica en Git.

## Publicación

Las correcciones iniciales se publicaron en `df9f6b1`; los traslados y protecciones de usuarios, Negocio y listas están en `1c04cd3`. Cloudflare sirve `/assets/index-BpwvkRG1.js`, coincidente con la compilación local. El acceso HTTPS pasó en 1440/390/320 px y Contabilidad redirige a iniciar sesión si no hay usuario autorizado. La comprobación de formularios sobre el frontend publicado intercepta la API y usa bases desechables; no representa ventas creadas en la tienda real.

Las siete suites críticas sobre ese frontend HTTPS aprobaron **1,857 comprobaciones**: primer uso 486; comprobantes 420; movimientos 354; compras y abonos 180; listas 150; usuarios y Negocio 174; traslados 93. Sus resultados están en `output/enterprise-published-final/` y, para la corrida definitiva de usuarios y Negocio, `output/enterprise-published-cas-retry/resultados.json`. La comparación final con el contenido anterior a las cuatro migraciones volvió a confirmar las 31 tablas sin cambios. Evidencia: `output/enterprise-final-verification.json`.

## Límites de lo comprobado

PGlite ejecuta las funciones y transacciones reales, pero no certifica carga simultánea de varias conexiones ni reproduce todos los servicios de Supabase. La simulación no demuestra cuántos empleados concurrentes soporta un plan de alojamiento. Los correos están interceptados; falta comprobar recepción y enlaces reales. PDF y navegador no prueban una impresora, un escáner ni una cámara físicos. Falta también un ensayo de restauración de respaldo en otra base; esta revisión no crea el respaldo automático que el usuario dejó para más adelante.

La aplicación requiere conexión para registrar operaciones; una respuesta perdida recuperable no convierte el sistema en una aplicación de ventas sin conexión. Una recarga forzada o pérdida del dispositivo obliga a consultar el historial antes de repetir una operación que pudo haberse guardado.

El funcionamiento contable comprobado no sustituye completar saldos y conteos reales, ni la revisión de datos tributarios de la empresa por su responsable. La entrega debe distinguir esas tareas de los errores de software corregidos.

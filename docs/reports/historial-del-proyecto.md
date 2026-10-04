# Historial de trabajo de LCP Control

Actualizado el **4 de octubre de 2026**, zona **America/Managua**.

Este documento consolida las revisiones del 14, 15, 22, 23 y 26 de septiembre y las auditorías, regresión y despliegue del 3 de octubre de 2026. Resume el trabajo realizado por módulo y conserva los resultados relevantes sin repetir los informes anteriores. Las guías operativas aportan los cambios posteriores de acceso y precios.

Los resultados de pruebas y consultas que aparecen aquí son **evidencia histórica**, realizada en las fechas indicadas. Consolidar esta documentación y retirar archivos de pruebas no constituye una nueva ejecución funcional ni una consulta actual de la base del negocio.

## Evolución del programa

| Fecha | Trabajo documentado |
| --- | --- |
| 14–15 de septiembre | Correcciones de borradores y precios, resumen diario en horario de Managua, conservación de costos históricos, carga diferida de pantallas y mejoras de tablas en teléfono. |
| 22–23 de septiembre | Corrección de activación y enlaces de correo, edición y eliminación de contactos, totales por ubicación, impresión compacta, validaciones de formularios, permisos de navegación y accesibilidad. |
| 26 de septiembre | Sesiones sólo en memoria, limpieza de tokens antiguos, mejora del consumo de memoria de reportes, compatibilidad con una política CSP estricta y cierre autorizado de sesiones antiguas. |
| 27–28 de septiembre | Evolución de los precios calculados desde el costo promedio y verificación de las redirecciones de acceso al dominio publicado, según las guías conservadas. |
| 2 de octubre | Los precios calculados pasan a depender del precio de compra y del porcentaje de cada lista. El costo promedio conserva su función contable. |
| 3 de octubre | Ampliación de contabilidad, abonos vinculados, flujo de dinero y arqueos; correcciones de integridad, de descarga y caché de fotos privadas; regresión funcional y aplicación de migraciones contables en Supabase. |
| 4 de octubre | Limpieza solicitada por el dueño: retirada de las suites y herramientas exclusivamente de pruebas y consolidación de los informes en este archivo. Se conserva el código funcional, las migraciones y la documentación operativa. |

## Ventas: facturas, proformas y borradores

Se corrigió la reapertura de borradores para utilizar los precios vigentes y avisar cuando cambia el total, sin sobrescribir automáticamente el borrador ni modificar documentos emitidos. Los productos retirados o sin precios bloquean la emisión. Se añadieron validaciones visibles de cliente, teléfono, cantidades, impuestos, tasa y vencimiento de proformas, junto con eliminación confirmada de borradores y estados de carga que evitan envíos repetidos.

La impresión HTML y los PDF usan densidades adaptativas: se comprobó históricamente que documentos de hasta 40 productos caben en una hoja carta o A4 en los escenarios previstos, y que listas mayores continúan con encabezados. El historial permite consultar, reabrir y reimprimir documentos; se mejoró el desplazamiento y foco al abrirlos. Los documentos confirmados conservan sus importes y costos de emisión.

La revisión contable comprobó que una factura reconoce ingresos y descuenta existencias, que una proforma no altera inventario ni dinero y que los reintentos con la misma solicitud no duplican la operación. La corrección del 3 de octubre conserva también la identidad de una factura eliminada: una solicitud tardía no puede volver a crearla ni descontar inventario otra vez.

## Inventario, productos, fotografías y escáner

Se incorporaron totales de Tienda, Bodega y consolidado, filtro por ubicación y presentación de existencias en tarjetas, tablas y ficha. Se revisaron cantidades enteras, motivos, salidas superiores a lo contado y bloqueos cuando falta el conteo. Las alertas distinguen conteos pendientes, mínimos sin configurar y ausencia de alertas; las búsquedas ignoran mayúsculas y tildes.

La edición de productos conserva controles de revisión para detectar cambios simultáneos. El catálogo incluye códigos internos y EAN, listas de precios, atributos, fotos privadas y retiro o reactivación según permisos y trazabilidad. El lector admite búsqueda manual y cámara; se corrigió la recuperación del estado al detenerla y se mantiene la indicación de pedir ayuda administrativa para un código desconocido cuando el usuario no puede registrarlo.

Las fotos se almacenan en un bucket privado, con formatos y tamaño restringidos. Se revisó la descarga y la caché de imágenes privadas el 3 de octubre. La aplicación utiliza descarga sin caché persistente y estado de firmas en memoria, que se limpia al terminar o cambiar la sesión; una petición pendiente no debe repoblar la caché de una sesión finalizada.

Los registros históricos de septiembre describían el arranque con 260 productos, 520 saldos por ubicación sin contar y costos iniciales pendientes. Son observaciones de esas fechas: no deben interpretarse como un conteo actual del negocio. El despliegue del 3 de octubre ya registraba movimientos y una factura real existente.

## Precios y costos

Se separaron dos conceptos: **precio de venta** y **costo de inventario**. Las compras incorporan el envío al costo unitario y actualizan el promedio ponderado; las ventas conservan una copia de su costo en el momento de emisión. Un costo desconocido se presenta como pendiente y no se reemplaza por cero, por el precio de venta ni por el promedio actual.

La base de los precios calculados cambió durante el desarrollo. La regla vigente documentada desde el 2 de octubre es `venta = round(precio de compra × (100 + porcentaje) / 100, 2)` para cada lista, en la moneda de compra; la otra moneda utiliza la tasa vigente. Una lista sin porcentaje conserva su precio a mano. El costo promedio sigue sirviendo para márgenes y contabilidad y no recalcula estos precios de venta. Las notas de septiembre sobre precios fijados sólo en dólares o calculados desde el costo promedio corresponden a etapas anteriores.

El cambio de tasa requiere confirmación, muestra la variación y destaca cambios superiores al 10 %. Se conservaron la trazabilidad de cambios de precio y los importes históricos de documentos. El arranque exige contar existencias y cargar costos conocidos antes de vender para poder determinar el margen; el sistema no reconstruye retrospectivamente un costo que la venta no tenía.

## Contactos, cuentas de usuario y acceso

Clientes y proveedores pasaron a edición en modal, con errores dentro del formulario, validación de nombres y eliminación confirmada. El cliente con documentos se archiva para conservar las referencias; los cambios y eliminaciones comprueban la revisión y mantienen una bitácora privada.

Se corrigieron los enlaces de activación y cambio de correo con `/auth/callback`, canje explícito del enlace y limpieza de tokens en la URL. Se añadieron mensajes para cuentas ya confirmadas, reenvío con espera de un minuto, bloqueo por intentos de acceso y campos de contraseña con mostrar u ocultar. La recuperación abre `/reset-password`, exige confirmación y una contraseña de 12 a 72 caracteres, y ofrece solicitar otro enlace si venció.

La guía de acceso registra las redirecciones de `https://lcp-control.pages.dev/` verificadas el 28 de septiembre. Las afirmaciones anteriores de que aún no existía dominio son antecedentes; esta síntesis no comprueba la disponibilidad actual del sitio ni el envío real de correo. Los permisos de menús, barra móvil y operaciones se ajustaron al rol; eliminar credenciales de un empleado conserva la autoría financiera mediante actores permanentes.

## Seguridad y navegación

La sesión de Supabase se conserva sólo en memoria, con `persistSession: false`; recargar, abrir otra pestaña o cerrar el navegador exige volver a iniciar sesión. Se limpia el almacenamiento antiguo de tokens y las peticiones usan `cache: 'no-store'`. El 26 de septiembre se cerraron once sesiones antiguas con autorización, sin modificar registros comerciales.

Las revisiones comprobaron RLS, restricciones a usuarios anónimos, controles de rol en funciones y revocación de escrituras directas desde el navegador. Costos y registros financieros se reservan a administración. La compilación incorpora detección de secretos y los servidores de desarrollo escuchan en loopback. Se comprobó el tratamiento de texto malicioso en pantallas, impresión y Excel, y se añadió el arranque de Zod sin JIT para evitar violaciones bajo una CSP estricta.

El menú móvil recibió una capa que intercepta toques, cierre con Escape, manejo del foco y contenido de fondo inactivo. Se corrigieron contraste de tablas, encabezado de la página 404 y navegación por teclado. Los informes antiguos describían un repositorio público; el dueño confirma que está **privado** al solicitar la limpieza del 4 de octubre.

## Reportes y rendimiento

El resumen diario utiliza límites explícitos del día de Managua, recorre las páginas de ventas y advierte si una consulta no puede ofrecer un total completo. Se corrigieron selección de fechas y rangos invertidos, etiquetas de moneda y alineación de tablas. Los formatos de fecha y moneda se reutilizan para evitar crear miles de instancias y agotar memoria al consultar períodos largos.

Reportes y Administración pasaron a carga diferida. En la medición del 15 de septiembre el JavaScript inicial comprimido pasó de 222 a 114 kB; ese dato pertenece a aquella versión, no a la compilación actual. La revisión del 26 de septiembre comprobó que el reporte anual dejó de cerrar la pestaña en su escenario de muestra. Exportaciones e indicadores mantienen las advertencias sobre información incompleta.

## Contabilidad, créditos, dinero y arqueos

El módulo conecta ventas, compras, inventario, gastos y deudas. Una venta a crédito reconoce ingresos y cuenta por cobrar al emitir; un abono reduce la deuda y mueve caja o banco sin crear otro ingreso. Los pagos identifican su pedido y las deudas iniciales permanecen separadas. Se validan fecha, saldo disponible, identidad de la operación, permisos e idempotencia. Las anulaciones conservan motivo e historial.

El flujo separa caja y banco, cobros, pagos, transferencias y aperturas. Los arqueos guardan el conteo por denominación, la expectativa y la diferencia; no corrigen dinero automáticamente. Una operación retroactiva hace que el arqueo requiera revisión. Se corrigió la unión contable para exigir que el costo congelado pertenezca al mismo producto de la factura: una inconsistencia deja el saldo pendiente e impide guardar un cierre incorrecto.

El estado de resultados conserva ventas, costos y tasas históricas. El balance sigue siendo provisional cuando faltan patrimonio, resultados acumulados o valor histórico del inventario; no se inventan cifras para cuadrarlo. Excel incluye movimientos, deudas, flujo y arqueos, además de estados y advertencias.

### Instalación documentada en Supabase el 3 de octubre

La migración base del libro financiero ya figuraba instalada. Se aplicaron cuatro ampliaciones y correcciones; Supabase asignó versiones UTC que comienzan el 4 de octubre aunque en Managua aún era el día 3:

| Migración local | Versión remota documentada |
| --- | --- |
| `20261003120000_finance_ledger_without_tax.sql` | `20261003214821` |
| `20261003220645_linked_credit_payments.sql` | `20261004032617` |
| `20261003220730_cashflow_cash_closing.sql` | `20261004032627` |
| `20261003224314_cashflow_snapshot_product_identity.sql` | `20261004032636` |
| `20261003225145_prevent_deleted_invoice_replay.sql` | `20261004032647` |

El registro terminó con 30 migraciones. Se verificaron ocho RPC contables, RLS y permisos; las envolturas públicas comprobadas eran `SECURITY INVOKER`, con `search_path` vacío y sin ejecución para `anon`. Una transacción de sólo lectura con identidad administrativa confirmó que la factura existente coincidía con ingresos y cuentas contables. Se compararon cantidades y huellas de doce tablas, que conservaron los registros previos. No se crearon ventas, gastos, abonos ni arqueos ficticios en producción. Ese despliegue actualizó la base; no publicó el frontend.

## Validaciones históricas y sus límites

Las revisiones de septiembre ampliaron progresivamente las pruebas unitarias, de navegador, formularios, permisos y PostgreSQL desechable. El 3 de octubre se documentaron estos resultados sobre el código revisado:

- 439 pruebas unitarias en 64 archivos, lint, TypeScript y compilación aprobados en la validación previa a la regresión final; 124 comprobaciones de base y 25 de credenciales, más cinco casos de caché de imágenes.
- 103 pruebas de navegador aprobadas y nueve omitidas por condiciones explícitas de dispositivo.
- Cinco grupos de auditoría con 642 comprobaciones: datos, ventas y contabilidad, pantallas, formularios inválidos y direcciones inválidas.
- Un recorrido de botones con 1,283 acciones visibles y 86 controles deshabilitados; otro con 1,197 intentos de entradas adversas, sin observaciones registradas en sus escenarios.
- Siete pruebas de scripts y recuperación de contraseña contra un servicio simulado.

Los entornos utilizaron datos sintéticos, PGlite, respuestas de Supabase simuladas y cámara simulada. La auditoría extensa de entradas se ejecutó en escritorio. No se probaron envío real de correos, cámara física ni competencia entre conexiones PostgreSQL independientes; PGlite serializa consultas de una misma instancia. El harness omitía una migración de permisos de plataforma que depende de Supabase. Las consultas de instalación en la base real fueron una comprobación separada y de sólo lectura.

Las suites y sus comandos `test:*` se retiraron durante la limpieza del **4 de octubre de 2026**, por solicitud del dueño. Estos resultados conservan lo observado entonces; no representan una garantía de comportamiento después de cambios futuros. Las comprobaciones de lint, tipos y compilación se conservan para validar el proyecto.

## Comprobación de la limpieza del 4 de octubre

Se eliminaron los 108 archivos de `tests/`, la configuración de Playwright, el entorno de pruebas, su ejecutor y las salidas generadas de auditoría. Se retiraron diez dependencias directas exclusivas de pruebas y 117 entradas del archivo de dependencias bloqueadas, sin cambiar las versiones de los paquetes conservados. Los ocho informes anteriores se sustituyeron por este historial.

Se ajustaron npm, TypeScript, Vite, ESLint y la integración continua para trabajar sin las suites eliminadas. `npm run check` aprobó lint, la comprobación de tipos incluida en la compilación y el build de producción. Se verificó que los enlaces locales de los 13 Markdown restantes existieran. El generador de PDF de ejemplo sigue funcionando sin cargar archivos de entorno. No se modificaron los archivos funcionales de `src/`, los recursos de `public/` ni las migraciones SQL; esta limpieza no escribió datos del negocio.

## Pendientes documentados y límites operativos

- **Conciliar el historial remoto de migraciones antes de un futuro `supabase db push`.** Los objetos de `purchase_price_pricing` ya existían el 3 de octubre, pero su nombre no figuraba en el registro; repetirla podría retirar precios existentes.
- **Registrar y conciliar aperturas reales.** Al terminar el despliegue había cero aperturas y cero arqueos. Caja, banco, clientes, préstamos y proveedores necesitan una fecha de inicio común y saldo explícito, incluido cero. Esa observación no es una consulta actual de los saldos.
- **Completar datos operativos con evidencia del negocio:** conteos, costos faltantes, mínimos y atributos, según lo que efectivamente siga pendiente. Un costo inicial de producto ya registrado no dispone de una corrección libre; revisar la lista antes de cargarla.
- **Verificar la configuración real de Auth y correo.** La protección contra contraseñas filtradas seguía desactivada en la consulta del 3 de octubre; la entrega SMTP, longitud mínima del servidor y ganchos de autenticación requieren comprobación en el panel. La recuperación simulada no confirma entregabilidad.
- **Realizar validación con dispositivos y concurrencia reales:** cámara de teléfono, enlaces de correo y operaciones simultáneas desde conexiones independientes. No se conciliaron los saldos con efectivo físico, estados bancarios, clientes o proveedores.
- **Respetar límites contables:** sin revaluación separada de deudas en dólares, vencimientos configurados, cuentas bancarias individuales, comprobantes fiscales ni asientos manuales de activos fijos. Los arqueos no bloquean períodos y el balance no reconstruye inventario histórico.
- **Revisar capacidad al crecer:** el historial de documentos pagina de 100 en 100 y el PDF de período admite hasta 2,000 documentos; contactos y movimientos tienen límites de consulta documentados. Un volumen mayor requiere ampliar la consulta, no asumir que las listas recortadas representan todo el negocio.

Las observaciones antiguas sobre número de cuentas, rol de cada persona, disponibilidad del sitio y existencias no se trasladan automáticamente como pendientes actuales. Deben verificarse cuando se retome esa operación.

## Documentación operativa conservada

Este archivo reúne el historial; las instrucciones de operación siguen en las guías:

- [Base de datos y migraciones](../guides/database.md).
- [Contabilidad, créditos y apertura de cuentas](../guides/contabilidad.md).
- [Acceso y recuperación de contraseña](../guides/acceso-y-recuperacion.md).
- [Catálogo, fotos e impresión](../guides/catalog-and-printing.md).
- [Personal y escáner](../guides/staff-and-scanning.md).
- [Puesta en marcha](../guides/puesta-en-marcha.md).
- [Enriquecimiento de catálogo con Open Beauty Facts](../guides/open-beauty-facts.md).

Los materiales de descubrimiento e investigación se conservan como contexto del negocio. Cuando una nota antigua de arranque difiera de la regla posterior de precios o acceso, utilizar la guía específica y el código vigente. Guardar código en Git no instala migraciones ni acredita el estado operativo de Supabase.

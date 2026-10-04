# Regresión funcional después de la corrección de seguridad

Fecha: 3 de octubre de 2026, hora de Nicaragua.

No se detectaron regresiones en los escenarios ejecutados. Las pruebas principales y los recorridos adicionales de botones y entradas terminaron sin fallos observados. No fue necesario modificar la implementación.

## Pruebas ejecutadas en esta revisión

| Comando / grupo                             | Resultado                                                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:e2e`                          | 103 aprobadas; 9 omitidas por condiciones explícitas de dispositivo; código 0.                                             |
| `npm run test:audit`: datos                 | 110/110.                                                                                                                   |
| `npm run test:audit`: ventas y contabilidad | 16 escenarios; 436 comprobaciones aprobadas.                                                                               |
| `npm run test:audit`: pantallas             | 30/30.                                                                                                                     |
| `npm run test:audit`: formularios inválidos | 42/42, sin modificaciones inesperadas en la base.                                                                          |
| `npm run test:audit`: direcciones inválidas | 24/24.                                                                                                                     |
| `npm run test:scripts`                      | 7/7.                                                                                                                       |
| `npm run test:recovery`                     | Solicitud, espera entre reenvíos, callback, limpieza de tokens, cambio de contraseña y enlace vencido aprobados; código 0. |

Los cinco grupos de `test:audit` suman 642 comprobaciones. Los comandos terminaron sin reintentos manuales ni cambios en la implementación.

`npm run test:audit:buttons` también terminó con código 0: 1,283 acciones con efecto visible y 86 controles deshabilitados, en 76 visitas por ruta, rol y dispositivo. El JSON terminal contiene 1,369 registros, cero observaciones, cero rutas de API desconocidas y cero fallos de API. No hubo aborto del recorrido ni fallos al localizar o pulsar controles. El barrido usa su lista definida de pantallas; contabilidad se verifica con las pruebas dedicadas descritas arriba.

| Rol            | Acciones en escritorio | Deshabilitados en escritorio | Acciones en móvil | Deshabilitados en móvil |
| -------------- | ---------------------: | ---------------------------: | ----------------: | ----------------------: |
| Administración |                    339 |                           21 |               358 |                      21 |
| Ventas         |                    161 |                           19 |               171 |                      19 |
| Bodega         |                    111 |                            3 |               117 |                       3 |
| Sin sesión     |                     13 |                            0 |                13 |                       0 |

`npm run test:audit:inputs` terminó con código 0 y sin aborto del recorrido: 1,197 intentos con valores adversos, 2,373 campos rellenados, 29 contextos con campos y 14 clases de datos. Se visitaron las 21 rutas previstas en escritorio: 1,113 intentos de administración y 84 sin sesión. El JSON final registra cero observaciones, cero rutas de API desconocidas y cero fallos de API. No se detectaron pantallas caídas, mensajes internos expuestos, ejecución del código inyectado, excepciones ni valores NaN/Infinity guardados. Este recorrido no se ejecutó en móvil.

El registro clasifica 900 intentos mediante botón, 164 botones deshabilitados y 133 intentos mediante Enter. Esa clasificación no presupone que los 900 intentos llegaran al servidor ni que todo texto de la lista adversa deba rechazarse en cualquier campo. Se inspeccionaron tanto los resultados JSON como el cierre de los recorridos en stdout; el código de salida por sí solo no determina estos resultados.

## Funciones comprobadas

Se recorrieron inventario, búsqueda, variantes, precios, códigos de barras, cambio y eliminación de fotos; facturas, proformas, borradores, clientes, proveedores y personal; moneda y bancos; contabilidad, créditos, abonos, flujo de efectivo y cierre de caja; informes, exportación PDF/Excel e impresión; rutas protegidas, acceso de demostración y navegación en escritorio y móvil. La recuperación de contraseña usa un servicio simulado.

La revisión de ventas compara los cálculos de la base desechable con el resumen presentado por la interfaz. Una venta de contado de dos perfumes a C$120 produce C$240 de ingresos y actualiza existencias, costo y caja. Las ventas a crédito reconocen ingreso y cuenta por cobrar; sus abonos reducen la deuda sin registrar otro ingreso. Los reintentos no duplican la factura ni el movimiento. Las anulaciones restauran los saldos esperados, y las proformas no alteran ingresos ni inventario.

Las nueve omisiones de Playwright son condiciones previstas en las pruebas: un menú exclusivo de móvil se omite en escritorio; en móvil se omiten seis casos de densidad de impresión, uno de identidad en papel fijo y uno de barrido explícito de tamaños. Estos últimos se ejecutan en el proyecto de escritorio, incluido el barrido de tamaños de teléfono y tableta.

## Verificaciones anteriores sobre el mismo código

Antes de esta petición, después de corregir la descarga y caché de las fotos privadas, aprobaron `npm run check` —lint, 439 pruebas unitarias en 64 archivos, TypeScript y compilación—, `npm run typecheck`, `npm run test:db` —124 comprobaciones— y `npm run test:credentials` —25 comprobaciones de autenticación y cinco casos de caché de imágenes—. Se conservan como evidencia de esa validación; no se contabilizan como una ejecución nueva en esta revisión.

Se volvió a comprobar por SHA-256 que los 271 archivos de código, migraciones y pruebas coinciden entre el repositorio y la copia utilizada para esta revisión. También coinciden los 16 archivos modificados por la corrección de seguridad, incluidos `package.json` y `README.md`.

## Entorno y límites

Las pruebas usan una copia temporal del repositorio, PGlite, credenciales sintéticas, respuestas de Supabase simuladas y servidores locales. No escriben en Supabase real ni modifican ventas, perfumes o saldos del negocio. Los resultados validan los escenarios ejecutados; no sustituyen una conciliación de los saldos reales ni una prueba del programa publicado.

El harness omite la migración de permisos de plataforma `harden_platform_function_grants`, que depende del entorno de Supabase. La cámara se simula, el envío real de correos no se prueba y PGlite no verifica competencia entre sesiones PostgreSQL independientes.

Se conservaron estas evidencias en `output/regression-2026-10-03/`, una carpeta local ignorada por Git:

- [Informe de Playwright](../../output/regression-2026-10-03/playwright-report.html) y [estado final](../../output/regression-2026-10-03/last-run.json).
- [Resultados de botones](../../output/regression-2026-10-03/buttons.json).
- [Resultados de entradas extensas](../../output/regression-2026-10-03/inputs.json).
- [Resultados de formularios críticos](../../output/regression-2026-10-03/forms.json).

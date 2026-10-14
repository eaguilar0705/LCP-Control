# Informe de auditoría funcional y contable

**Proyecto:** LCP-Control — La Casa del Perfume  
**Fecha del informe:** 13 de octubre de 2026, Managua  
**Versión examinada:** rama `main`, revisión inicial `2eb19d6`, más las correcciones locales descritas aquí.

## Resultado

Se comprobaron errores en conciliación de caja y bancos, seguimiento de deudas, operaciones con fechas anteriores, utilidad bruta, presentación de signos y validación de comprobantes. Los errores reproducidos se corrigieron en el código y en una nueva migración SQL. También se aclaró el significado de «Pendiente» en pantalla y Excel.

La validación incluye **40 pruebas de cálculo/presentación**, **70 comprobaciones nuevas de base de datos en ocho escenarios**, las pruebas existentes de jornada y operaciones, y recorridos de Chrome en escritorio y móvil. Los resultados detallados están al final del informe.

**La migración se aplicó a Supabase tras la autorización del usuario, el 13 de octubre de 2026 a las 21:52:25 de Managua.** Quedó registrada como `20261014035225_reconcile_accounting_subledgers` en el proyecto «La Casa del Perfume». Se verificaron sus dependencias, controles de deuda/POS, funciones privadas y triggers. Las huellas de contenido de las 16 tablas comparadas coinciden antes y después. El frontend corregido permanece en el proyecto local y requiere publicación. Las pruebas funcionales usan datos ficticios aislados; las comprobaciones remotas se limitan a instalación, consistencia y conservación de datos, sin emitir una opinión sobre estados financieros reales.

## 1. Cómo funciona el módulo

La pantalla actual usa `AccountingPage → ledger_report → journalModel`. El libro mayor suma los comprobantes manuales y las contrapartidas automáticas de ventas, compras, gastos y movimientos. Las funciones alternativas `buildAccountingModel`, `balanceSheet` y `financialRatios` permanecen en el proyecto, pero no generan las pantallas actuales; sus hallazgos se identifican por separado.

| Sección              | Qué hace                                                                                                                                            | Uso del contador                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Comprobantes         | Registra apertura, ingresos, egresos, ajustes, minutas, transferencias y liquidaciones POS; permite ver detalle, descargar PDF y anular con motivo. | Registrar hechos que no provienen de una operación automática y corregir mediante ajustes documentados. |
| Cobros y pagos       | Presenta facturas a crédito, compras a crédito y saldo inicial con sus ajustes; vincula abonos a la deuda.                                          | Cobrar o pagar desde el documento correspondiente para que el mayor y el auxiliar concilien.            |
| Catálogo             | Agrupa activos, pasivos, capital, ingresos, costos, gastos e IR; distingue grupos y cuentas que admiten movimientos.                                | Seleccionar la cuenta apropiada y mantener su descripción.                                              |
| Balanza              | Muestra saldo inicial, Debe, Haber y saldo final de cada cuenta en NIO.                                                                             | Comprobar movimientos, saldos contrarios a su naturaleza y diferencias entre deudores y acreedores.     |
| Estado de resultado  | Presenta ingresos, costo de venta, utilidad bruta, gastos, IR y resultado neto, para el período y acumulado.                                        | Distinguir margen comercial, otros ingresos, gastos y utilidad neta.                                    |
| Situación financiera | Muestra activos, pasivos, capital registrado y resultado acumulado al corte.                                                                        | Comprobar activo = pasivo + capital, incluyendo el resultado.                                           |

La exportación Excel contiene catálogo, balanza, resultado y situación financiera. Utiliza el mismo modelo que la pantalla, conserva números como números y escribe «Pendiente» cuando un importe es desconocido.

### Apertura y período

La apertura contable recoge los saldos **reales al comienzo de su fecha** en activo, pasivo y capital. Las operaciones de esa fecha en adelante se agregan al libro. Una cuenta omitida en una apertura válida queda en cero; por eso el contador debe comprobar que la apertura esté completa. No se inventa capital para cuadrar una diferencia.

La apertura diaria de la tienda es un conteo físico de efectivo, separado de la apertura del libro. No constituye una venta ni un ingreso. Los cierres de jornada bloquean modificaciones de las operaciones de fechas cerradas.

En la balanza:

| Columna       | Interpretación                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Saldo inicial | Acumulado de asientos anteriores a «Desde». No siempre coincide con el primer comprobante de apertura. |
| Debe          | Débitos brutos dentro del período seleccionado, incluidos los comprobantes que caigan en él.           |
| Haber         | Créditos brutos dentro del mismo período.                                                              |
| Saldo final   | Acumulado hasta «Hasta», expresado según la naturaleza de la cuenta.                                   |

Para una cuenta deudora: **final = inicial + Debe − Haber**. Para una acreedora: **final = inicial − Debe + Haber**. Los totales de saldos son la diferencia entre deudores y acreedores; un total cero puede indicar que la balanza cuadra, aunque existan activos y deudas importantes.

El resultado del período usa solamente los movimientos entre «Desde» y «Hasta». **El acumulado comienza en la apertura del libro**, incluso si esta pertenece a otro año; no es automáticamente el acumulado del año calendario.

### Operaciones automáticas y criterio contable

| Operación                  | Contrapartidas principales                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Venta de contado           | Débito a caja o banco y crédito a ventas; además débito a costo de venta y crédito a inventario.                                  |
| Venta a crédito            | Débito a cuentas por cobrar y crédito a ventas; el cobro posterior reduce la deuda sin registrar otra venta.                      |
| Venta POS                  | Débito a `1142`, tarjetas pendientes de acreditar. El banco aumenta al liquidar.                                                  |
| Liquidación POS            | Débito al banco por el neto, comisión como gasto financiero, retención como activo acreditable y crédito a tarjetas por el bruto. |
| Compra de perfumes         | Débito a inventario y crédito a caja, banco o proveedores. El flete se incorpora al costo de la compra.                           |
| Pago de préstamo           | Reduce el principal del pasivo; el interés se reconoce por separado como gasto financiero.                                        |
| Compra de mobiliario       | El libro vigente la clasifica en activo fijo `1210`. La depreciación se registra mediante ajustes.                                |
| Merma / sobrante de conteo | Reduce / aumenta inventario y reconoce pérdida / otros ingresos, cuando existe costo histórico.                                   |

El inventario usa promedio ponderado y las ventas conservan el costo histórico de su emisión. El precio de compra usado para calcular listas de venta es independiente del costo contable. El reconocimiento del inventario como gasto al vender y el uso del promedio ponderado son coherentes con los criterios descritos en [IAS 2 — Inventarios](https://www.ifrs.org/issued-standards/list-of-standards/ias-2-inventories/). La clasificación de bienes usados durante varios períodos como activos se apoya en [IAS 16 — Propiedades, planta y equipo](https://www.ifrs.org/issued-standards/list-of-standards/ias-16-property-plant-and-equipment/); la vida útil y depreciación deben definirse con datos reales.

## 2. Cuándo devuelve «Pendiente»

**«Pendiente» significa que falta información suficiente para confirmar el importe. No equivale a cero ni significa necesariamente que un cliente deba dinero.** Se representa como `null` en el modelo; un cero conocido se muestra numéricamente.

| Condición del libro vigente                                                                    | Balanza                                                                                                                                                | Resultado                                                                                                                | Situación financiera                                                                                                       | Cómo resolver                                                                                      |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| No existe comprobante de apertura.                                                             | Todas las cifras y totales pendientes.                                                                                                                 | Importes pendientes.                                                                                                     | Saldos y totales pendientes.                                                                                               | Registrar apertura balanceada, con saldos reales y fecha correcta.                                 |
| «Hasta» es anterior a la apertura.                                                             | Importes pendientes.                                                                                                                                   | Importes pendientes.                                                                                                     | Importes pendientes.                                                                                                       | Elegir un corte dentro de la vigencia del libro.                                                   |
| Hay facturas sin detalle contable completo desde apertura hasta el corte (`missingSales > 0`). | Todas las cifras pendientes por prudencia.                                                                                                             | Importes pendientes.                                                                                                     | Saldos pendientes.                                                                                                         | Conciliar el detalle e importes históricos de las facturas afectadas.                              |
| Hay movimientos sin costo histórico (`missingCosts > 0`).                                      | Las cuatro columnas de `1130`, `5120`, `5150` y `4190` quedan pendientes; los totales también. Caja, bancos y otras cuentas conocidas siguen visibles. | Costo, pérdidas y otros ingresos afectados, utilidad bruta y neta pendientes. Ventas y gastos conocidos siguen visibles. | Inventario, resultado acumulado, total activo, capital y pasivo más capital pendientes. Pasivos conocidos siguen visibles. | Reconstruir el costo de las operaciones afectadas con soporte histórico.                           |
| «Desde» es anterior a la apertura, pero «Hasta» la alcanza o supera.                           | Se advierte que el libro comienza en la fecha de apertura; esta condición por sí sola no bloquea las cifras.                                           | Igual criterio.                                                                                                          | Igual criterio.                                                                                                            | Interpretar el alcance mostrado; las operaciones anteriores a apertura no pertenecen a este libro. |

El conteo de costos faltantes se calcula **desde la apertura hasta «Hasta»**, no solamente dentro del período. No discrimina la cuenta y columna exacta del faltante. Por ello, una venta sin costo de un mes anterior puede mantener pendientes las cuatro columnas de esas cuentas y el resultado del mes consultado. Es una decisión conservadora del modelo actual; no prueba que los cuatro importes estén individualmente ausentes.

Ejemplo: dos movimientos sin costo no justifican ocultar una caja conocida de C$900 o ventas registradas de C$2,000. Esas cifras permanecen visibles; inventario y utilidades dependientes continúan pendientes.

En **Cobros y pagos**, «Pendiente C$» es también el nombre de una columna: un valor numérico positivo indica deuda pendiente de liquidar. El texto «Pendiente» dentro de una celda significa importe contable desconocido. La ausencia del servicio de créditos ahora se distingue de «sin cuentas».

Un resultado nulo o incompleto recibido del servidor produce un error de consulta explícito en lugar de fabricar ventas cero. Una diferencia de arqueo ausente se muestra como pendiente y no como cero.

**Asignar hoy un costo promedio a un producto no demuestra el costo de una venta antigua.** Para resolver un faltante histórico deben conciliarse sus registros a la fecha correspondiente; no se rellenaron costos ni saldos reales por suposición.

## 3. Errores comprobados y corregidos

P1 indica riesgo de saldos o conciliaciones incorrectos; P2 indica cálculo, validación o presentación que puede inducir a una interpretación incorrecta.

| ID  | Prioridad | Antes / reproducción                                                                                                                                                                       | Corrección                                                                                                                                                      |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | P1        | Apertura contable con caja C$1,000: el flujo devolvía caja desconocida al buscar solamente aperturas financieras antiguas.                                                                 | El flujo adopta apertura y movimientos del libro vigente; mantiene respaldo legado sin duplicar aperturas.                                                      |
| A02 | P1        | Una venta POS incrementaba bancos en el flujo antes de acreditarse.                                                                                                                        | POS permanece en tarjetas pendientes; bancos aumentan al registrar la liquidación.                                                                              |
| A03 | P1        | Un egreso manual reducía caja en el mayor, pero no en el flujo.                                                                                                                            | Se incluyen comprobantes manuales de caja/bancos y sus anulaciones. Las transferencias internas se excluyen del flujo externo.                                  |
| A04 | P1        | Un ajuste en `1140` o `2111` cambiaba el mayor sin actualizar el saldo inicial del auxiliar.                                                                                               | Los ajustes forman parte del saldo inicial y ajustes de deuda. Facturas y pedidos mantienen sus propios abonos vinculados.                                      |
| A05 | P1        | Reducir o anular un ajuste de deuda ya utilizado por abonos podía dejar un saldo negativo. Un cobro con fecha anterior también podía consumir un saldo necesario para un ajuste posterior. | Se valida la serie diaria completa de cambios y abonos; la operación inválida se rechaza íntegramente.                                                          |
| A06 | P1        | Una liquidación POS con fecha anterior podía dejar negativas las tarjetas después de una liquidación posterior.                                                                            | Se comprueba el saldo histórico por fecha, no sólo el saldo del día solicitado.                                                                                 |
| A07 | P1        | Eliminar una venta POS que respaldaba una liquidación antigua podía crear saldo histórico negativo aunque el saldo actual siguiera positivo.                                               | La eliminación vuelve a comprobar la serie POS y se rechaza cuando deja liquidaciones sin respaldo.                                                             |
| A08 | P1        | Adoptar una apertura contable de fecha/importe diferente podía esconder deudas o abonos del módulo financiero anterior.                                                                    | La adopción conserva fecha y saldos anteriores; las correcciones se hacen mediante ajustes posteriores.                                                         |
| A09 | P1        | Podían registrarse caja inicial negativa y movimientos en moneda incompatible con bancos estándar.                                                                                         | PostgreSQL rechaza caja inicial negativa y moneda incompatible; la interfaz filtra cajas/bancos estándar por moneda.                                            |
| A10 | P2        | Ventas C$1,000, otros ingresos C$100 y costo C$600 daban utilidad bruta C$500.                                                                                                             | Utilidad bruta C$400; los otros ingresos siguen formando parte de la utilidad neta de C$500.                                                                    |
| A11 | P2        | Una reversión de gasto de C$50 se presentaba como negativa en pantalla, mientras Excel mostraba efecto positivo.                                                                           | Ambos presentan la reversión como incremento del resultado.                                                                                                     |
| A12 | P2        | El formulario aceptaba negativos en el lado contrario y comprobantes que cuadraban en USD pero no después del redondeo por renglón en NIO.                                                 | Se valida positividad, centavos, ambas sumas y conversión individual. USD 0.01 + 0.01 contra USD 0.02 a TC 36.5 produce C$0.74 contra C$0.73 y se bloquea.      |
| A13 | P2        | Respuestas contables ausentes/incompletas se podían interpretar como ventas cero o confirmación de éxito. Métodos de pago desconocidos se clasificaban como banco.                         | Respuesta incompleta produce error; métodos o importes inválidos se identifican como información incompleta.                                                    |
| A14 | P2        | Filtros tecleados podían invertir el rango o consultar fechas futuras; los avisos no explicaban las columnas.                                                                              | Rango coherente limitado al día actual y explicación de «Pendiente» y de la fórmula de la balanza en pantalla/Excel.                                            |
| A15 | P2        | La apertura ofrecía ingresos/gastos que PostgreSQL rechaza; créditos sin servicio aparecían como ausencia de deudas; diferencias de jornada desconocidas se mostraban como cero.           | Apertura limitada a activo/pasivo/capital, estado de créditos incompleto explícito, avisos sobre abonos antiguos sin vínculo y arqueos desconocidos pendientes. |

### Hallazgos en funciones alternativas, sin atribuirlos a la pantalla actual

Se corrigieron gastos desconocidos fuera del período que invalidaban otro período, omisión de impuestos sobre ventas por conciliar en pasivos y ratios basados en patrimonio supuesto `activo − pasivo`. Los ratios dependientes ahora quedan pendientes si el patrimonio o ingresos no están confirmados.

También se protegieron los cálculos auxiliares de actividad diaria: entradas/neto incompletos no se presentan como definitivos y un conteo sin dólares no multiplica cero por una tasa inválida. Estas funciones auxiliares no sustituyen la lógica vigente del cierre de tienda.

## 4. Pruebas y evidencia

| Validación                        | Resultado                                                                                                                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:accounting`         | 40/40 pruebas aprobadas; 24 existentes y 16 nuevas. Incluye renderizado real de tablas y comprobación de Excel.                                                                                                              |
| `npm run test:database`           | Cuatro recorridos aprobados: jornada, operaciones completas (71 comprobaciones), catálogo/permisos (46) y auditoría contable nueva (70, ocho escenarios).                                                                    |
| `npm run test:browser:accounting` | Chrome a 1440, 390 y 320 px: apertura/cierre diario, PDF, estados con costos faltantes, sin apertura, facturas incompletas, filtros, cálculo y guardado de liquidación.                                                      |
| `npm run test:browser`            | 17 rutas a los tres anchos; contactos, inventario, compras, facturas, proformas, créditos, comprobantes, cierres, PDF/Excel y catálogo de 260 productos ficticios; sin errores de ejecución/API ni desbordamiento de página. |
| `npm run check`                   | ESLint, comprobación de tipos y compilación de producción aprobados.                                                                                                                                                         |

Las pruebas de base de datos usan PostgreSQL en memoria mediante PGlite, aplican las migraciones y ejecutan las funciones de negocio. Las pruebas de Chrome interceptan Supabase y usan datos de prueba. No escriben ventas, gastos, saldos o clientes reales.

La revisión independiente reprodujo y verificó los dos errores cronológicos A05/A07. Se comprobó que las funciones auxiliares nuevas están en esquema privado con permisos directos revocados y que se conservan los controles de administrador y las políticas de acceso.

Las pruebas nuevas quedan en `scripts/tests/accounting-audit.test.mjs`, `finance-audit.test.mjs`, `journal-audit.test.mjs` y `database-accounting-audit.mjs`. Se corrigió además una fecha errónea del escenario antiguo de gasto desconocido: el gasto de apertura debe caer antes del período; sus expectativas se conservaron.

Los registros de esta ejecución quedan bajo `output/accounting-audit/`; las capturas y descargas de navegador, en `output/accounting-review/` y `output/system-review/`. Esas salidas están excluidas de Git. El modo `node scripts/tests/database-accounting-audit.mjs --baseline` restaura en la base aislada las funciones originales del flujo y **falla deliberadamente** al reproducir A01.

## 5. Qué necesita completar el contador

1. Conciliar la apertura con arqueo, estados bancarios, inventario físico valorizado, clientes, proveedores, préstamos y capital real. El saldo `1130` no se coteja automáticamente con un conteo físico histórico.
2. Revisar los avisos de costos/detalle faltantes y reconstruirlos con soportes de cada fecha. No confundir precio de venta o costo de compra actual con costo histórico.
3. Registrar cobros y pagos desde su documento; un ajuste global de deuda no equivale a pagar una factura específica. Los saldos iniciales y abonos antiguos sin vínculo requieren desglose documental.
4. Conciliar `1142` con los lotes POS y los depósitos bancarios; separar comisión y retención con las tasas y bases reales del contrato.
5. Revisar depreciaciones, provisiones, deterioro de inventario, impuestos y cierre anual mediante ajustes. El módulo no ejecuta automáticamente esas políticas ni cambia el acumulado a enero.

Cada comprobante trabaja con una moneda. Las restricciones monetarias cubren las cajas y seis cuentas bancarias estándar; las cuentas nuevas y la cuenta bancaria genérica carecen de metadatos de moneda. El flete se distribuye por unidades: si los productos consumen transportes muy diferentes, el responsable debe evaluar esa política de distribución. No se cambiaron tasas tributarias, vidas útiles ni saldos por criterio supuesto.

No se comprobó concurrencia con varias conexiones de un servidor PostgreSQL real ni se certificó la integridad de datos actuales. Las migraciones de pruebas omiten los archivos de endurecimiento de funciones de plataforma que el simulador no puede representar; los permisos de los endpoints contables sí se probaron.

## 6. Entrega y puesta en uso

La migración aplicada es `backend/supabase/migrations/20261014035225_reconcile_accounting_subledgers.sql`. El archivo se renombró para coincidir con la versión registrada por Supabase; su contenido y SHA-256 se conservaron. El nombre refleja la fecha UTC de aplicación; el informe usa la fecha local de Managua. No reemplaza los archivos de migraciones previos ni rellena datos de negocio.

La migración anterior `audit_accounting_workflows` ya estaba instalada; sólo se aplicó la corrección nueva. El proyecto comprobado es `xkpujpoocsbkychstrne`, «La Casa del Perfume», configurado en la aplicación. La revisión previa encontró una apertura contable vigente, sin aperturas financieras antiguas, sin días con deuda/POS negativo, sin caja inicial negativa y sin monedas incompatibles en las cuentas estándar.

Después de aplicar se ejecutaron `private.check_credit_pool()`, `private.check_pos_balance()` y la lectura del saldo del flujo sin errores. Los tres triggers nuevos están activos y las seis funciones auxiliares nuevas carecen de permisos de ejecución directos para `PUBLIC`, `anon` y `authenticated`. Se compararon cantidad y huellas de productos, precios, inventario, documentos, costos, compras, gastos, movimientos financieros, comprobantes, clientes y jornadas en 16 tablas: todas coincidieron.

El asesor de seguridad conserva los avisos anteriores: 15 funciones públicas con `SECURITY DEFINER` ejecutables por usuarios autenticados y [protección de contraseñas filtradas desactivada](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). Los detalles de funciones y su revisión se consultan en [el asesor de funciones privilegiadas](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable). La migración no añadió avisos.

La revisión automática rechazó la comprobación de las RPC públicas mediante simulación de una identidad administradora, por considerarla un método de acceso no autorizado. Esa prueba no se ejecutó; la verificación de instalación se completó con estructura, permisos, controles internos y huellas de datos, sin simular identidades. El registro local de aplicación y resultados queda en `output/accounting-audit/supabase-deployment.json`.

Para mostrar las mejoras de formularios, textos y cálculos en la aplicación publicada todavía se necesita publicar la nueva compilación del frontend. Los controles nuevos de base de datos ya están instalados; los datos faltantes que produzcan «Pendiente» requieren conciliación con información real.

La evaluación del código corregido es favorable para los escenarios ejecutados. La confiabilidad de los estados reales depende de una apertura completa, costos históricos confirmados y conciliación documental. «Pendiente» debe mantenerse mientras esos requisitos no estén satisfechos.

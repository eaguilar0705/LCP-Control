# Contabilidad y jornada de tienda

## Referencias y alcance

Revisión del 11 de octubre de 2026 sobre `main` (`fe7db69`): notas del negocio, 13 fotografías, catálogo de cuentas, balanza de comprobación, estado de resultados y estado de situación financiera enviados por el cliente. Se usó la estructura de esos documentos, sin importar nombres, cuentas bancarias ni saldos de la otra empresa.

## Operación diaria

- Una jornada por fecha de Managua y una sola jornada abierta a la vez.
- Admin y superadmin abren y cierran desde Inicio. Ventas puede emitir únicamente durante la jornada del día. Una jornada anterior pendiente debe cerrarse antes de abrir la nueva.
- La apertura guarda el efectivo físico en C$ y US$. Se puede reutilizar el conteo del último cierre o rellenar ambos importes con cero; los campos siguen siendo editables y siempre se confirma la apertura. No crea ingresos ni duplica el comprobante contable de apertura.
- El cierre conserva ventas por pago y moneda, productos/unidades vendidos, efectivo esperado, conteo, diferencias, motivo y responsables. Admin y superadmin pueden reabrir la jornada del mismo día con motivo obligatorio; se conservan todos los cierres y reaperturas con su reporte original.
- El historial corresponde a la fecha seleccionada en «Consultar jornada» y permanece desplegado al cambiarla. «Actualizar jornada» vuelve a consultar el estado, los importes y el historial, también después de un fallo de conexión.
- La base serializa las operaciones con el cierre y bloquea escrituras en facturas, movimientos de inventario, compras, gastos y comprobantes de fechas cerradas. Las proformas no requieren apertura.
- El efectivo esperado incluye ventas de contado, cobros, pagos, compras, gastos, transferencias y comprobantes que afecten la caja principal. Los comprobantes de apertura contable no se suman otra vez al efectivo del día.

## Libro contable

- Catálogo persistente con grupos y cuentas: activo 1, pasivo 2, capital 3, ingresos 4, costos/gastos 5 e IR 6. Bancos BAC, LAFISE y Ficohsa por moneda; capital de Miguel; DGI y alcaldía.
- Permite agregar cuentas de detalle bajo una cuenta mayor y renombrar las existentes. No se copian números bancarios de las referencias.
- Comprobantes de saldos iniciales, ingreso, egreso, ajuste, minuta, transferencia bancaria y liquidación de tarjetas. Número propio, referencia, detalle consultable y PDF. Anulaciones con motivo y conservación del registro.
- Debe y haber deben cuadrar tanto en moneda original como en córdobas. La validación, los permisos y la idempotencia se ejecutan en PostgreSQL.
- El contador registra un comprobante de apertura balanceado con los saldos **reales al comienzo de su fecha**. Las operaciones de esa fecha en adelante se incorporan automáticamente. No se utiliza una diferencia ficticia como capital para cuadrar el balance.
- Las ventas, su costo histórico, compras, gastos, mermas y movimientos financieros anteriores continúan registrados. Las aperturas del módulo financiero anterior no se suman al nuevo comprobante de apertura.
- La balanza usa saldos iniciales y movimientos brutos. El balance agrega activo, pasivo, capital y resultado acumulado. El resultado distingue ventas, costo, utilidad bruta, gastos y utilidad/pérdida neta. Los importes dependientes de costos o apertura desconocidos quedan pendientes.
- Una compra de mobiliario registrada como tal se clasifica en activo fijo. Las amortizaciones/depreciaciones se registran mediante comprobante de ajuste.
- El inventario se valora por costo promedio ponderado; las ventas conservan el costo de su fecha. El precio de compra usado para calcular listas de venta es independiente del costo contable del inventario.
- Las facturas nuevas ya tenían impuesto separado en cero; se verificó que sigue siendo así. Se preserva el impuesto histórico de las facturas anteriores.

## Tarjetas y bancos

La venta por POS se registra pendiente de acreditar. La liquidación mueve el neto al banco elegido, la comisión a gasto financiero y la retención a IR acreditable. Las tasas y la base de retención (venta bruta o venta menos comisión) son explícitas y quedan guardadas con cada comprobante; no se impusieron las tasas de ejemplo como tasas de la empresa. Las líneas de la liquidación se verifican nuevamente en el servidor.

Las transferencias y minutas no se consideran ingresos ni gastos. Los comprobantes se expresan en una moneda con una tasa guardada. Operaciones de cambio de moneda que requieran diferencias cambiarias deben desglosarse con el contador mediante comprobantes de ajuste.

## Datos que debe completar el negocio

- Saldos iniciales de caja, bancos, inventario, créditos, deudas y capital; no se inventaron.
- Costos iniciales reales de los perfumes. La consulta del proyecto el 11/10/2026 encontró 260 productos con costo promedio sin registrar. Un costo desconocido no se convierte en cero.
- Catálogo adicional y tasas contractuales reales de cada liquidación.
- Nombres y valores de las dos listas adicionales. El cliente confirmó que aún no los tiene: continúan Emprendedor, VIP y Premium.

## Validación reproducible

1. `npm ci`
2. `npm run check` (lint, contratos, tipos y compilación).
3. `npm run test:accounting` (modelos financieros, Excel y nuevo libro).
4. `npm run test:database` (migraciones en PostgreSQL desechable/PGlite, permisos, RLS, reintentos, diario, comprobantes, costos, compras y ventas sin IVA). No contacta producción. Omite dos migraciones de endurecimiento de funciones internas exclusivas de la plataforma Supabase.
5. `npm run dev -- --port 5173`, luego `npm run test:browser` (Chrome instalado; formularios contra PostgreSQL desechable, Auth simulado, sin escrituras a Supabase; 1440/390/320 px). Capturas en `output/system-review/`. La revisión ampliada y sus resultados están en [revisión integral del 13 de octubre](revision-integral-2026-10-13.md).

Las pruebas no certifican obligaciones tributarias de la empresa. La configuración de cuentas, saldos y tasas corresponde a sus datos y criterio contable. Referencia técnica para el costo de inventarios: [IAS 2, IFRS Foundation](https://www.ifrs.org/issued-standards/list-of-standards/ias-2-inventories/).

## Revisión del proyecto alojado

Las dos migraciones de esta entrega se aplicaron a Supabase. Se consultaron jornada y libro con un usuario administrador real en una transacción revertida; no se crearon jornadas, comprobantes ni importes de prueba en producción. Las ocho funciones públicas nuevas son `SECURITY INVOKER`, sin ejecución anónima, con comprobación de permisos en las funciones privadas.

El asesor mantiene avisos anteriores: 15 funciones públicas de administración usan `SECURITY DEFINER` ([criterio del asesor](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)) y la [protección de contraseñas filtradas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) está desactivada. Esta entrega no cambia sus permisos ni el plan de Auth. `business_days` aparece como RLS sin políticas porque el acceso directo está revocado y se consulta exclusivamente mediante las funciones autorizadas ([criterio del asesor](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)). Los índices nuevos sin uso todavía son esperables en tablas sin operaciones.

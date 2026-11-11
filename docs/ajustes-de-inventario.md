# Ajustes por conteo físico

El dueño necesita corregir las cantidades que encuentra al contar los perfumes, sin registrar esas diferencias como una compra. El ajuste manual se reserva a usuarios activos con rol **Superadmin**.

## Uso

1. En **Inventario**, pulsa **Ajustar existencias**, o usa el enlace del perfume para abrir directamente sus cantidades. También está disponible arriba de **Editar perfume**.
2. Elige **Tienda** o **Bodega**.
3. Escribe el **total físico** de esa ubicación. Por ejemplo, si el sistema muestra 10 y contaste 13, escribe 13; si contaste 8, escribe 8. Puedes guardar 0.
4. Si ya había un conteo, selecciona la **Cuenta de contrapartida**. Para acumular las correcciones fuera del estado de resultados, elige tu cuenta de orden. También se puede elegir la cuenta de activo, pasivo o capital que corresponda; no se asigna una cuenta automáticamente. **5150 · Pérdidas de inventario** también aparece en ese selector y se elige expresamente para pérdidas reales, como un perfume abierto de muestra o tester. Solo está disponible al disminuir existencias. El campo **Tratamiento del ajuste** queda sincronizado con la cuenta elegida. Las contrapartidas se expresan en córdobas.
5. Revisa las cantidades antes y después y pulsa **Guardar ajuste**. El motivo ya trae **Conteo físico**; se puede cambiar cuando haga falta una aclaración.

El cambio conserva fecha, usuario, motivo, tratamiento, cuenta elegida y cantidades anteriores y finales en el historial de movimientos. La corrección mantiene el costo promedio y registra su valor contra la cuenta elegida mediante un comprobante vinculado, sin reconocer ingresos ni gastos. Por ejemplo, corregir de 20 a 15 unidades mal digitadas disminuye el inventario contra esa cuenta; no registra una pérdida de cinco unidades. Una pérdida real sí conserva su costo en la cuenta de pérdidas. El comprobante de una corrección no se edita ni anula por separado del movimiento.

El conteo inicial no requiere este selector y puede conservar el costo pendiente; para modificar un conteo ya registrado se necesita el costo del perfume. Si falta, el sistema indica completarlo desde **Costo de inventario** y conserva las cantidades anteriores. Los movimientos históricos conservan su clasificación; volver a contar no reclasifica una pérdida anterior. Las recepciones y devoluciones conservan su propio tratamiento.

**Registrar compra** sigue disponible para unidades compradas, con su costo y pago. Los administradores y el personal de inventario conservan sus otros permisos; el ajuste manual y la confirmación de ubicaciones vacías requieren Superadmin.

Si las existencias cambiaron mientras revisabas el formulario, el sistema rechaza el conteo anterior. Actualiza las existencias y revisa el total antes de intentar otra vez. Si se pierde la respuesta al guardar, **Verificar guardado** consulta la misma operación para evitar duplicados.

## Cuenta de orden y descuentos sin pérdida

El audio del dueño del 10 de noviembre precisa que los ajustes deben acumularse en una cuenta de orden y mostrarse en la balanza, sin reconocer ingresos, costos ni gastos.

En **Contabilidad → Catálogo → Administrar cuentas → Agregar cuenta**, crea tu cuenta con **7000 · Cuentas de orden** como cuenta mayor; por ejemplo, código **7000-001** y el nombre que corresponda al negocio. La actualización solo crea la cuenta mayor, sin elegir ni crear una cuenta de movimiento por el dueño.

En **Descontar unidades**, al editar un perfume, o en **Inventario → Salida**, Superadmin escribe las unidades a retirar, mantiene **Corrección de cantidad (sin pérdida)** y selecciona su cuenta de orden. Se muestra la cantidad final antes de guardar. La operación conserva el conteo esperado, su comprobante y el historial, y se puede anular como los otros ajustes. Por ejemplo, retirar una unidad que cuesta C$300 abona C$300 a Inventario y carga C$300 a la cuenta de orden; no aumenta **Pérdidas de inventario** ni cambia la utilidad. Un aumento por conteo invierte las dos partidas.

Para una pérdida real se debe elegir expresamente **Pérdida real** o **5150 · Pérdidas de inventario**. Los roles sin permiso de ajustes conservan sus salidas como pérdida y reciben esa explicación antes de confirmar. Las compras y productos dañados conservan su tratamiento propio. Los movimientos históricos no se reclasifican.

Las cuentas de orden se incluyen en el catálogo, la balanza y su Excel, y se excluyen de resultados y situación financiera. Por ello, un abono al inventario contra una cuenta fuera de situación puede dejar una diferencia entre activo y pasivo más capital. Se conserva el aviso de conciliación de ese estado; no se oculta la diferencia ni se convierte en gasto o utilidad. La balanza conserva la partida doble.

## Anular un ajuste equivocado

En **Movimientos**, Superadmin puede abrir **Anular ajuste** en un ajuste manual existente. La vista previa muestra las cantidades actuales, las unidades que se van a devolver o retirar y el valor de la reversión. Se debe indicar el motivo antes de confirmar.

La anulación conserva el movimiento original, lo marca como anulado y registra una reversión vinculada con su costo histórico. Por ejemplo, anular una reducción de cinco unidades devuelve esas cinco a las existencias actuales y revierte su pérdida o contrapartida; no restablece a ciegas el conteo anterior ni borra ventas posteriores. Los reportes reconocen la reversión en la jornada actual, conservando el movimiento de la fecha original. Se necesita abrir la jornada actual y revisar nuevamente si las existencias o el valor cambiaron.

Los movimientos de facturas, recepciones, devoluciones y compras regularizadas se corrigen desde su operación de origen. No se pueden anular sus movimientos internos de forma independiente. Tampoco se permite una reversión que dejaría unidades o valor negativos. El historial conserva el responsable, el motivo y el vínculo entre el ajuste original, su reversión y el comprobante correspondiente.

## Activación

Aplicar en Supabase, después de las migraciones anteriores:

`backend/supabase/migrations/20261103010000_ajustes_de_inventario_solo_superadmin.sql`

Para separar correcciones y pérdidas y habilitar la elección de contrapartida, aplicar también, después de todas las migraciones anteriores:

`backend/supabase/migrations/20261107200000_ajustes_de_inventario_con_contrapartida.sql`

Para habilitar la anulación auditada y sus reportes, aplicar después de las anteriores:

`backend/supabase/migrations/20261108000000_anular_ajustes_de_inventario.sql`

Para habilitar las cuentas de orden y su uso como contrapartida, aplicar después de las anteriores:

`backend/supabase/migrations/20261111000000_cuentas_de_orden_para_ajustes.sql`

Después, publicar la compilación del frontend. Compilar localmente no aplica la migración ni cambia roles de usuarios existentes. El dueño debe tener asignado el rol Superadmin en Personal.

## Verificación local

```sh
npm run check
npm run test:inventory-adjustments
npm run test:inventory-adjustment-accounting
npm run test:inventory-adjustment-voids
npm run test:inventory-order-accounts
npm run test:browser:inventory-order-accounts
npm run test:browser:inventory-adjustments
```

Las pruebas de ajustes usan una base desechable. Comprueban cantidades mayores, menores, cero y conteos iniciales; restricciones por rol, historial, contabilidad, cambios concurrentes y reintentos sin duplicados. El recorrido del navegador cubre computadora y celular.

En la revisión del 8 de noviembre pasaron 166 comprobaciones de anulación, 124 del tratamiento contable de ajustes y 139 pruebas generales de lógica. El navegador pasó 237 comprobaciones en anchos de 1440, 390 y 320 px: elección directa de 5150, correcciones, anulación con vista previa, historial y recuperación sin duplicar movimientos ni comprobantes. La compilación y lint también pasaron. Todas estas comprobaciones usan datos aislados.

La actualización de cuentas de orden del 10 de noviembre pasó 80 comprobaciones nuevas de base de datos, 124 del tratamiento contable existente, 142 pruebas generales y 72 comprobaciones nuevas de navegador. También pasaron las 237 comprobaciones del recorrido existente de ajustes y las 60 de controles de inventario, en anchos de 1440, 390 y 320 px. Además, pasaron 354 comprobaciones de confirmación de movimientos y 486 de primer uso en los tres anchos. Lint, tipos y compilación también pasaron.

En la revisión anterior, la suite general `test:database` se detenía en la preparación de `business-day.mjs` porque su base de prueba no define `storage.allow_only_operation`, requerida por una migración anterior. `extended-store-flow.mjs` se detenía antes de probar los ajustes porque una compra de su primer día omite la cuenta bancaria. Estos fallos requieren actualizar esas pruebas; no se modificaron los flujos de negocio para evitarlos.

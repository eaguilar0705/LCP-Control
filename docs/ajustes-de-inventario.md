# Ajustes por conteo físico

El dueño necesita corregir las cantidades que encuentra al contar los perfumes, sin registrar esas diferencias como una compra. El ajuste manual se reserva a usuarios activos con rol **Superadmin**.

## Uso

1. En **Inventario**, pulsa **Ajustar existencias**, o usa el enlace del perfume para abrir directamente sus cantidades. También está disponible arriba de **Editar perfume**.
2. Elige **Tienda** o **Bodega**.
3. Escribe el **total físico** de esa ubicación. Por ejemplo, si el sistema muestra 10 y contaste 13, escribe 13; si contaste 8, escribe 8. Puedes guardar 0.
4. Si el nuevo conteo aumenta las existencias, el sistema utiliza automáticamente la cuenta de orden **Ajustes de inventario**, sin pedir tratamiento ni contrapartida. Si disminuye las existencias, selecciona la **Cuenta de contrapartida** de orden, activo, pasivo o capital que corresponda. **5150 · Pérdidas de inventario** también aparece en ese selector y se elige expresamente para pérdidas reales, como un perfume abierto de muestra o tester. Solo está disponible al disminuir existencias. El campo **Tratamiento del ajuste** queda sincronizado con la cuenta elegida. Las contrapartidas se expresan en córdobas.
5. Revisa las cantidades antes y después y pulsa **Guardar ajuste**. El motivo ya trae **Conteo físico**; se puede cambiar cuando haga falta una aclaración.

El cambio conserva fecha, usuario, motivo, tratamiento, contrapartida y cantidades anteriores y finales en el historial de movimientos. La corrección mantiene el costo promedio y registra su valor contra la cuenta automática o elegida mediante un comprobante vinculado, sin reconocer ingresos ni gastos. Por ejemplo, corregir de 20 a 15 unidades mal digitadas disminuye el inventario contra la cuenta elegida; no registra una pérdida de cinco unidades. Una pérdida real sí conserva su costo en la cuenta de pérdidas. El comprobante de una corrección no se edita ni anula por separado del movimiento.

El conteo inicial no requiere este selector y puede conservar el costo pendiente; para modificar un conteo ya registrado se necesita el costo del perfume. Si falta, el sistema indica completarlo desde **Costo de inventario** y conserva las cantidades anteriores. Los movimientos históricos conservan su clasificación; volver a contar no reclasifica una pérdida anterior. Las recepciones y devoluciones conservan su propio tratamiento.

**Registrar compra** sigue disponible para unidades compradas, con su costo y pago. Los administradores y el personal de inventario conservan sus otros permisos; el ajuste manual y la confirmación de ubicaciones vacías requieren Superadmin.

Si las existencias cambiaron mientras revisabas el formulario, el sistema rechaza el conteo anterior. Actualiza las existencias y revisa el total antes de intentar otra vez. Si se pierde la respuesta al guardar, **Verificar guardado** consulta la misma operación para evitar duplicados.

## Agregar únicamente las unidades adicionales

Al abrir **Editar perfume** de la forma habitual, Superadmin empieza en **Agregar unidades**. También puede usar el botón **Agregar unidades** de Inventario. Se escribe solo lo adicional: si hay dos unidades y se agrega una, se escribe **1** y la vista previa muestra **2 → 3**. Para mercadería comprada se conserva **Registrar compra** o **Recibir mercadería**, con su revisión y costos propios.

La opción **Ajustar existencias (conteo físico)** sigue disponible para escribir el total físico. Los accesos específicos a conteos abren esa opción. Cambiar entre cantidad adicional y conteo borra el número introducido para no reinterpretarlo accidentalmente. Una ubicación sin contar requiere registrar primero su conteo inicial.

**Cuenta de inventario (automática)** muestra Inventario de perfumes, con su código visible. Esta cuenta aumenta al agregar unidades y disminuye al descontarlas. Para los aumentos, la contrapartida se asigna automáticamente a **Ajustes de inventario**; **Cuenta de contrapartida** se mantiene para las deducciones. Inventario no se selecciona como su propia contrapartida, porque ese asiento compensaría su valor en la misma cuenta.

El cambio solicitado el 11 de noviembre crea **Ajustes de inventario** bajo **7000 · Cuentas de orden**, con el primer código libre entre `7000-001` y `7000-999`. No reutiliza ni modifica las cuentas existentes, aunque ya tengan alguno de esos códigos. La cuenta creada debe mantenerse activa, como cuenta de orden que admite movimientos; si se desactiva o reclasifica, el sistema rechaza nuevas adiciones y pide revisarla en Contabilidad. Las operaciones ya guardadas se pueden recuperar aunque luego se desactive la cuenta.

Con costo de C$500 y dos unidades existentes, agregar una unidad registra un aumento de **C$500** en Inventario, no C$1500. La estimación muestra solo la diferencia de unidades y el costo actual; el importe definitivo lo calcula la base al guardar. El costo pendiente se indica expresamente y no se sustituye por cero. El cambio conserva la revisión del conteo esperado, el costo histórico, la contrapartida y la recuperación del mismo guardado, sin sumar la unidad dos veces si se pierde la respuesta.

## Cuenta de orden y descuentos sin pérdida

El audio del dueño del 10 de noviembre precisa que los ajustes deben acumularse en una cuenta de orden y mostrarse en la balanza, sin reconocer ingresos, costos ni gastos.

La actualización del 11 de noviembre crea **Ajustes de inventario** para los aumentos automáticos. Para usar otras cuentas en las deducciones, en **Contabilidad → Catálogo → Administrar cuentas → Agregar cuenta**, crea tu cuenta con **7000 · Cuentas de orden** como cuenta mayor y un código disponible.

En **Descontar unidades**, al editar un perfume, o en **Inventario → Salida**, Superadmin escribe las unidades a retirar, mantiene **Corrección de cantidad (sin pérdida)** y selecciona su cuenta de orden. Se muestra la cantidad final antes de guardar. La operación conserva el conteo esperado, su comprobante y el historial, y se puede anular como los otros ajustes. Por ejemplo, retirar una unidad que cuesta C$300 abona C$300 a Inventario y carga C$300 a la cuenta elegida; no aumenta **Pérdidas de inventario** ni cambia la utilidad. Un aumento por conteo carga Inventario y abona automáticamente **Ajustes de inventario**.

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

Para crear y asignar la cuenta de orden automática de los aumentos, aplicar después de todas las anteriores:

`backend/supabase/migrations/20261111230000_orden_automatica_para_aumentos_de_inventario.sql`

Después, publicar la compilación del frontend. Compilar localmente no aplica la migración ni cambia roles de usuarios existentes. El dueño debe tener asignado el rol Superadmin en Personal.

## Verificación local

```sh
npm run check
npm run test:inventory-adjustments
npm run test:inventory-adjustment-accounting
npm run test:inventory-adjustment-voids
npm run test:inventory-order-accounts
npm run test:automatic-inventory-increases
npm run test:browser:add-inventory-units
npm run test:browser:inventory-order-accounts
npm run test:browser:inventory-adjustments
```

Las pruebas de ajustes usan una base desechable. Comprueban cantidades mayores, menores, cero y conteos iniciales; restricciones por rol, historial, contabilidad, cambios concurrentes y reintentos sin duplicados. El recorrido del navegador cubre computadora y celular.

En la revisión del 8 de noviembre pasaron 166 comprobaciones de anulación, 124 del tratamiento contable de ajustes y 139 pruebas generales de lógica. El navegador pasó 237 comprobaciones en anchos de 1440, 390 y 320 px: elección directa de 5150, correcciones, anulación con vista previa, historial y recuperación sin duplicar movimientos ni comprobantes. La compilación y lint también pasaron. Todas estas comprobaciones usan datos aislados.

La actualización de cuentas de orden del 10 de noviembre pasó 80 comprobaciones nuevas de base de datos, 124 del tratamiento contable existente, 142 pruebas generales y 72 comprobaciones nuevas de navegador. También pasaron las 237 comprobaciones del recorrido existente de ajustes y las 60 de controles de inventario, en anchos de 1440, 390 y 320 px. Además, pasaron 354 comprobaciones de confirmación de movimientos y 486 de primer uso en los tres anchos. Lint, tipos y compilación también pasaron.

En la revisión anterior, la suite general `test:database` se detenía en la preparación de `business-day.mjs` porque su base de prueba no define `storage.allow_only_operation`, requerida por una migración anterior. `extended-store-flow.mjs` se detenía antes de probar los ajustes porque una compra de su primer día omite la cuenta bancaria. Estos fallos requieren actualizar esas pruebas; no se modificaron los flujos de negocio para evitarlos.

Las adiciones por unidades del 10 de noviembre pasaron 93 comprobaciones de navegador en 1440, 390 y 320 px y seis pruebas de cálculo de valor. El ejemplo de dos unidades más una de C$500 termina en tres unidades, incrementa el valor en C$500 y registra la contrapartida una sola vez, incluso con respuesta perdida. También volvieron a pasar las 237 comprobaciones de ajustes y las 60 de controles existentes.

La cuenta automática del 11 de noviembre pasó 32 comprobaciones nuevas de migración, códigos ocupados, conservación del histórico, cuentas inactivas, permisos, valoración, partida doble y recuperación sin duplicados. Pasaron además 76 comprobaciones de conteos, 124 del tratamiento contable y seis pruebas de reportes, 166 de anulaciones y 80 de cuentas de orden. En navegador pasaron 129 comprobaciones de adiciones automáticas, 252 de ajustes y anulaciones, 72 de deducciones contra cuentas de orden y 60 de controles de inventario, en 1440, 390 y 320 px. Lint, tipos y compilación pasaron. Estas verificaciones usan bases desechables; no aplican la migración ni publican la interfaz en producción.

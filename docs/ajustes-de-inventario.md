# Ajustes por conteo físico

El dueño necesita corregir las cantidades que encuentra al contar los perfumes, sin registrar esas diferencias como una compra. El ajuste manual se reserva a usuarios activos con rol **Superadmin**.

## Uso

1. En **Inventario**, pulsa **Ajustar existencias**, o usa el enlace del perfume para abrir directamente sus cantidades. También está disponible arriba de **Editar perfume**.
2. Elige **Tienda** o **Bodega**.
3. Escribe el **total físico** de esa ubicación. Por ejemplo, si el sistema muestra 10 y contaste 13, escribe 13; si contaste 8, escribe 8. Puedes guardar 0.
4. Si ya había un conteo, elige **Ajuste (corrección de cantidad)** o **Pérdida real**. Para corregir un dato mal digitado, selecciona la cuenta de contrapartida de activo, pasivo o capital; no se asigna una cuenta automáticamente. Las contrapartidas se expresan en córdobas. **Pérdida real** solo permite disminuir existencias y utiliza **Pérdidas de inventario**.
5. Revisa las cantidades antes y después y pulsa **Guardar ajuste**. El motivo ya trae **Conteo físico**; se puede cambiar cuando haga falta una aclaración.

El cambio conserva fecha, usuario, motivo, tratamiento, cuenta elegida y cantidades anteriores y finales en el historial de movimientos. La corrección mantiene el costo promedio y registra su valor contra la cuenta elegida mediante un comprobante vinculado, sin reconocer ingresos ni gastos. Por ejemplo, corregir de 20 a 15 unidades mal digitadas disminuye el inventario contra esa cuenta; no registra una pérdida de cinco unidades. Una pérdida real sí conserva su costo en la cuenta de pérdidas. El comprobante de una corrección no se edita ni anula por separado del movimiento.

El conteo inicial no requiere este selector y puede conservar el costo pendiente; para modificar un conteo ya registrado se necesita el costo del perfume. Si falta, el sistema indica completarlo desde **Costo de inventario** y conserva las cantidades anteriores. Los movimientos históricos conservan su clasificación; volver a contar no reclasifica una pérdida anterior. Las recepciones y devoluciones conservan su propio tratamiento.

**Registrar compra** sigue disponible para unidades compradas, con su costo y pago. Los administradores y el personal de inventario conservan sus otros permisos; el ajuste manual y la confirmación de ubicaciones vacías requieren Superadmin.

Si las existencias cambiaron mientras revisabas el formulario, el sistema rechaza el conteo anterior. Actualiza las existencias y revisa el total antes de intentar otra vez. Si se pierde la respuesta al guardar, **Verificar guardado** consulta la misma operación para evitar duplicados.

## Activación

Aplicar en Supabase, después de las migraciones anteriores:

`backend/supabase/migrations/20261103010000_ajustes_de_inventario_solo_superadmin.sql`

Para separar correcciones y pérdidas y habilitar la elección de contrapartida, aplicar también, después de todas las migraciones anteriores:

`backend/supabase/migrations/20261107200000_ajustes_de_inventario_con_contrapartida.sql`

Después, publicar la compilación del frontend. Compilar localmente no aplica la migración ni cambia roles de usuarios existentes. El dueño debe tener asignado el rol Superadmin en Personal.

## Verificación local

```sh
npm run check
npm run test:inventory-adjustments
npm run test:inventory-adjustment-accounting
npm run test:browser:inventory-adjustments
```

Las pruebas de ajustes usan una base desechable. Comprueban cantidades mayores, menores, cero y conteos iniciales; restricciones por rol, historial, contabilidad, cambios concurrentes y reintentos sin duplicados. El recorrido del navegador cubre computadora y celular.

En esta entrega pasaron las 51 comprobaciones de ajustes, las 25 de conteos esperados, las 121 pruebas de lógica y una simulación completa de siete jornadas con 420 facturas, 42 proformas y 21 compras conciliadas. El navegador pasó 93 comprobaciones de ajustes y 60 de controles de inventario en anchos de 1440, 390 y 320 px. La compilación y lint también pasaron.

La suite general `test:database` se detiene en la preparación de `business-day.mjs` porque su base de prueba no define `storage.allow_only_operation`, requerida por una migración anterior. `extended-store-flow.mjs` se detiene antes de probar los ajustes porque una compra de su primer día omite la cuenta bancaria. Estos fallos requieren actualizar esas pruebas; no se modificaron los flujos de negocio para evitarlos.

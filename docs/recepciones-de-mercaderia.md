# Recepción de mercadería y revisión contable

El audio del dueño del 6 de noviembre de 2026 describe dos tareas: bodega registra la mercadería recibida con sus unidades y costo; contabilidad revisa el costo total, incluida la importación, y elige la contrapartida en caja, banco o proveedores. El usuario confirmó que las unidades **solo pueden venderse después de la revisión contable**.

## Flujo

1. En **Inventario**, usar **Recibir mercadería**, o **Entrada** para un perfume. Indicar productos, ubicación, cantidades, costos y respaldo de la recepción. No se elige una cuenta de pago en esta etapa.
2. La recepción queda **Pendiente de revisión**. Las unidades están registradas en la recepción, separadas de las existencias disponibles. No alimentan ventas, costo promedio, caja, bancos, proveedores ni el mayor. Bodega puede recibir aunque la jornada esté cerrada.
3. Administración revisa la recepción desde Inventario o **Contabilidad → Recepciones pendientes**. Verifica los costos, envío, moneda, tasa y fecha contable; selecciona explícitamente caja, el banco pagador o crédito del proveedor. Los productos, cantidades y ubicaciones recibidos se conservan. Para corregir estos últimos se cancela la recepción y se registra una nueva.
4. **Contabilizar recepción** registra la compra, las existencias disponibles, el costo y la contrapartida conjuntamente. La compra queda enlazada a la recepción. Repetir una confirmación no suma unidades ni registra otra compra.
5. Una recepción pendiente puede cancelarse con motivo. Se conserva el historial y no se generan movimientos de dinero o inventario.

El asiento «incompleto» mencionado en el audio se representa como una recepción pendiente persistente. Se completa antes de ingresar al mayor; los comprobantes definitivos conservan la exigencia de Debe = Haber.

| Estado        | Unidades de la recepción disponibles para vender | Registro contable                |
| ------------- | ------------------------------------------------ | -------------------------------- |
| Pendiente     | Ninguna                                          | Pendiente fuera del mayor        |
| Contabilizada | Se incorporan a las existencias de su ubicación  | Compra con contrapartida elegida |
| Cancelada     | Ninguna                                          | Sin compra nueva                 |

## Permisos y revisión

Inventario/Bodega, Administrador y SuperAdmin pueden recibir y consultar recepciones. Administrador y SuperAdmin pueden contabilizarlas. Bodega puede cancelar únicamente sus recepciones pendientes; administración puede cancelar cualquiera que siga pendiente. Caja y Solo consulta no acceden a los costos de estas recepciones.

La recepción conserva sus datos originales, autor y fecha. La compra enlazada conserva los costos y el pago definitivos. Las revisiones impiden confirmar o cancelar una versión que otra persona ya modificó. Las solicitudes de guardado conservan su identificador para verificar una respuesta perdida, también después de recargar la página.

La confirmación respeta las reglas existentes de jornada y fecha de compra. No reabre una jornada cerrada ni registra un pago en un cierre antiguo. La fecha de recepción permanece en el historial aunque la contabilización se haga después.

Para un perfume nuevo, antes de contabilizar deben confirmarse las existencias previas de Tienda y Bodega. Ese conteo excluye las unidades de la recepción pendiente. Si ya hay existencias sin costo, debe completarse su costo inicial antes de incorporar la nueva compra. Un conteo desconocido no se interpreta como cero.

## Diferencia con los controles anteriores

**Registrar compra** sigue permitiendo a administración recibir y contabilizar conjuntamente una operación que ya tiene toda la información revisada.

**Ajustar existencias** corresponde a un conteo físico, no a mercadería comprada. Un sobrante posterior al conteo inicial reconoce inventario contra Otros ingresos; un faltante tiene su tratamiento propio. Usar un ajuste para registrar una compra puede explicar el efecto descrito en el audio, pero el audio no identifica qué botón se utilizó. Los movimientos históricos requieren revisar su respaldo antes de corregirlos.

## Activación y verificación

### Integración con la clasificación contable

La actualización contable incorporada del remoto agrega **Compras por clasificar** y edición de recepciones ya contabilizadas. **Pendiente de revisión**, en la recepción de Bodega, conserva las unidades fuera de las existencias vendibles. Su confirmación sigue exigiendo caja, banco o proveedores.

La opción **Pendiente de clasificar**, disponible en las compras directas de administración, corresponde a otra etapa: la mercadería ya fue recibida y su valor reconocido contra la cuenta temporal 2190; todavía falta distribuir la contrapartida definitiva. No sustituye la recepción pendiente de Bodega. El historial de recepción conserva los importes originales; los costos y pagos vigentes, con sus revisiones, se consultan desde **Inventario → Compras**.

La prueba de integración cubre ambos recorridos y una corrección posterior, conservando el bloqueo inicial y sin duplicar unidades ni asientos.

Aplicar después de las migraciones anteriores:

`backend/supabase/migrations/20261106210000_recepciones_pendientes_de_contabilizar.sql`

Después publicar la compilación del frontend. Compilar localmente no aplica la migración en Supabase.

```sh
npm run check
npm run typecheck
npm run test:inventory-receipts
npm run test:browser:inventory-receipts
```

Las pruebas usan bases PostgreSQL desechables e interceptan las llamadas del navegador. No registran recepciones ni compras en la tienda real.

Verificación de esta entrega: 177 comprobaciones de recepción en PostgreSQL y 128 en Chrome a 1440, 390 y 320 px. Pasaron además las 122 pruebas de lógica, las regresiones de corrección de compras, ajustes de inventario, costos y conteos, proveedores y recuperación de operaciones. El recorrido de compras anterior se adaptó a la recepción pendiente y aprobó 180 comprobaciones.

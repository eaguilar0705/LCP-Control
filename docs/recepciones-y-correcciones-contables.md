# Recepciones y correcciones contables

La recepción de mercancía y la clasificación de su pago son operaciones vinculadas. El cargo de la compra corresponde a **1130 · Inventario de perfumes**; la contrapartida de pago se completa en Contabilidad.

## Trabajo diario

1. En Inventario, registrar la compra con sus perfumes, unidades, costos, proveedor, fecha y referencia. La opción inicial es **Pendiente de clasificar**.
2. La recepción actualiza cantidades, costo promedio y valor de inventario. Prepara el total como cargo a Inventario de perfumes, sin descontar caja ni bancos. Hasta completar la contrapartida, el asiento queda fuera del mayor y los estados indican que hay compras pendientes; no se crea una deuda ficticia.
3. En **Contabilidad → Comprobantes → Recepciones de inventario**, abrir **Clasificar compra**. La **cuenta 1** queda fija en Inventario de perfumes, con el total de mercadería y envío en NIO. No se puede cambiar, eliminar ni alterar su importe. Completar únicamente las contrapartidas de caja, bancos y/o proveedores; se pueden distribuir pagos o agregar diferencias cambiarias expresamente.
4. Para pagos existentes, usar **Vincular pagos ya registrados**. El renglón de Proveedores debe cubrir esos abonos, pues ya descontaron el dinero. No volver a acreditar el banco por el mismo pago. Las fechas deben conservar la secuencia de la recepción, clasificación y abonos; los anticipos se registran con su cuenta contable correspondiente.
5. Revisar y confirmar. Se conserva el vínculo con la recepción y no se vuelve a ingresar mercancía. Los nuevos abonos se registran desde **Cobros y pagos** y respetan el crédito efectivamente clasificado.

## Compras ingresadas por error como conteo

En **Inventario → Movimientos**, elegir la fecha del ingreso y **Revisar ingreso como compra**. Esta opción es del SuperAdmin y corresponde únicamente a compras nuevas que se guardaron por error como un aumento de conteo.

La regularización conserva las unidades, la valorización y los costos ya registrados. Archiva la clasificación anterior de sobrante, conserva el movimiento original y prepara una compra con cargo fijo a Inventario de perfumes, sin ingresar mercancía otra vez ni efectuar pagos. Los importes conservados requieren revisión: la opción no inventa el costo real de una factura de proveedor.

La compra aparece en **Inventario → Compras → Ver compra → Editar recepción completa** y en **Contabilidad → Comprobantes → Recepciones de inventario**. Allí se corrigen los costos y se clasifica su pago. Reabrir el ingreso desde Movimientos lleva a su compra existente; no crea otra. Las correcciones posteriores mantienen su historial.

Los conteos que realmente representan sobrantes mantienen su tratamiento original. No se convierten automáticamente en compras.

## Monedas y borradores

Las compras y recepciones muestran el total en su moneda original y su equivalente. Para compras en córdobas, el equivalente USD se calcula con el tipo de cambio configurado en Negocio, sin fijar una tasa en el código. Las compras nuevas toman esa tasa por defecto; la tasa contable de un importe NIO continúa siendo 1.

El equivalente USD se muestra con dos decimales y nunca se usa para recalcular el importe original. El costo de compra no se redondea al dólar entero, como sí ocurre con ciertos precios de venta. Una compra USD ya registrada conserva su tasa histórica; **Usar tipo de cambio actual** permite elegir expresamente la vigente al corregirla.

En **Contabilidad → Balanza de comprobación / Estado de resultado / Estado de situación financiera**, **Moneda del reporte** permite consultar los mismos saldos en NIO o su equivalente USD con la tasa vigente de Negocio. El encabezado y el Excel indican la moneda y la tasa utilizada. La exportación conserva los valores numéricos sin redondeo intermedio; su presentación usa dos decimales.

La consulta USD no revaloriza existencias ni sustituye costos históricos de ventas. Por ejemplo, C$59,063.46 equivalen a US$1,596.31 con tasa 37. Si una cuenta externa usa otro costo de origen, cambiar la moneda del reporte no corrige esa diferencia: se debe conciliar el detalle y registrar la corrección correspondiente. Sin una tasa válida se mantiene disponible el reporte NIO y se indica que falta configurar el cambio.

En un comprobante manual, **Usar córdobas y dólares en el comprobante** permite usar una moneda y tasa por renglón. Las cajas y bancos estándar conservan su moneda. El cuadre usa los equivalentes NIO, sin sumar dólares y córdobas como si fueran iguales.

La tasa del comprobante no modifica la tasa comercial ni los precios del catálogo. Una diferencia cambiaria requiere una clasificación explícita del contador; no se crea una ganancia automática comparando con la tasa de ventas.

**Guardar borrador** admite renglones incompletos sin afectar saldos. Se retoma desde **Borradores contables**. Al contabilizarlo se retira del listado en la misma transacción. La revisión evita que dos pestañas contabilicen el mismo borrador.

## Correcciones del SuperAdmin

- **Editar clasificación / Editar comprobante:** conserva identificador, número, autor original y versiones anteriores. Permite corregir fecha, concepto, referencia y contrapartidas, incluso en una jornada cerrada. En la clasificación de compras el cargo a Inventario se mantiene fijo y toma el total vigente de la recepción. No permite dejar un asiento descuadrado ni quitar el crédito que respalda abonos reales.
- **Dejar pendiente de clasificar:** conserva el comprobante anulado y permite volver a clasificar. Con abonos existentes, se debe corregir la clasificación o resolver antes sus vinculaciones.
- **Editar recepción completa / Editar recepción:** modifica proveedor, referencia, fecha, productos, cantidades, ubicaciones, costos y envío mediante una revisión vinculada. La compra original no desaparece. Solo se aplica la diferencia de unidades a las existencias actuales.
- En una recepción con operaciones posteriores, el contador revisa el **valor final del inventario** de cada perfume. La diferencia del costo de compra se distribuye entre inventario restante y la cuenta de costo/gasto elegida. No se recalculan a ciegas los costos congelados de facturas anteriores. La corrección se registra en la jornada actual; requiere abrirla. Si cambia el importe de una compra pendiente/clasificada, vuelve a requerir revisión de su contrapartida. Los estados muestran esa revisión pendiente hasta completar el asiento por el nuevo total.
- **Editar abono**, en Cobros y pagos, conserva el registro y permite corregir fecha, tipo de abono, documento vinculado, moneda, tasa, cuenta, importe y referencia. Se valida el reemplazo excluyendo el abono anterior en una sola transacción. Los abonos vinculados desde una clasificación se desvinculan allí antes de reasignarlos.

La edición de un asiento generado por una corrección de recepción lleva a la recepción de origen: así se corrigen conjuntamente el libro contable y el valor del inventario. La edición no modifica automáticamente los precios de venta ni las facturas emitidas. Toda corrección conserva actor, revisión y fecha.

### Cargos y abonos que se compensan en Inventario

Una recepción pendiente puede corregir su costo antes de clasificar el pago. Esa revisión no es una segunda compra: el total definitivo se carga una sola vez al clasificarla. Las correcciones nuevas consolidan los importes por cuenta; cuando el resultado es cero, conservan su revisión sin generar otro comprobante.

Los comprobantes anteriores que cargaban y abonaban el mismo importe a Inventario conservan sus renglones y su historial original. La balanza, el detalle y el PDF presentan su efecto neto para no inflar Debe y Haber. El detalle indica **Sin efecto contable** cuando corresponde y permite **Ver registro original de la corrección**. Por ejemplo, un cargo y un abono de C$2,129.15 en Inventario no representan otra entrada ni salida de mercancía. Los costos consumidos y las contrapartidas que sí cambian conservan su efecto real.

Aplicar `backend/supabase/migrations/20261107220000_consolidar_correcciones_de_recepcion.sql` después de las migraciones anteriores. Esta migración cambia funciones y lecturas; no reescribe comprobantes, pagos, cantidades ni costos históricos. Verificación aislada: `npm run test:receipt-correction-netting` y `npm run test:browser:receipt-correction-netting`.

## Actualización del flujo

La cuenta **Compras por clasificar (2190)** se retira del catálogo y de nuevos comprobantes. La migración convierte las clasificaciones existentes al cargo directo a Inventario, conserva sus versiones anteriores y evita que la recepción y su clasificación sumen el inventario dos veces. Los abonos, cantidades, costos, facturas y solicitudes originales se conservan. Las compras sin contrapartida necesitan completarse desde Clasificar compra.

Aplicar en Supabase `backend/supabase/migrations/20261107010000_compras_con_inventario_fijo.sql` antes de publicar esta interfaz. Compilar no actualiza la base remota. **Recepciones pendientes** de Bodega mantiene su revisión previa a liberar las unidades; es un flujo distinto.

## Validación

`npm run test:purchase-accounting` prueba recepciones, clasificación, créditos parciales, pagos, ambas monedas, correcciones posteriores, informes, borradores, permisos, revisiones, recuperación e idempotencia en PostgreSQL desechable.

Incluye una actualización desde la base anterior con compras clasificadas, abonos, consumo, correcciones y borradores existentes. Verifica que se conserve ese estado al retirar la cuenta temporal y que el servidor rechace alterar el cargo fijo.

`npm run test:browser:purchase-accounting` usa las migraciones y RPC reales en esa base desechable con transporte interceptado, en escritorio, tableta y móvil. Incluye pérdida de respuesta de guardado, revisión del PDF y control de desbordamiento. No crea pruebas en producción.

Comprueba además el cargo fijo al clasificar, retomar borradores y editar desde la tabla de comprobantes; verifica que una factura nueva siga emitiéndose y descontando las unidades correctas.

`node --test scripts/tests/statement-currency.test.mjs` y `node scripts/tests/browser-statement-currency.mjs` verifican la conversión de los tres estados y del Excel, cambios de tasa, ausencia de tasa y conservación de los asientos, en escritorio y móvil con datos aislados.

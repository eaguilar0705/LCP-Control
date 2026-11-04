# Envíos a clientes

En Facturación y Proformas, la sección **Envío** aparece junto al total, sin desplegar los datos del cliente. **Tipo de envío** permite elegir **Moto**, **CargoTrans** o **Buses**. El campo **Cobro por envío** indica lo que paga el cliente, en la moneda del documento. No aplica una tarifa automática. También se puede indicar un envío gratuito, con importe cero, o elegir **Sin envío**. Se pide solamente tipo e importe; no una dirección de entrega.

El envío se suma después de los descuentos de los productos. La factura, la vista previa, el PDF y el mensaje para WhatsApp muestran el tipo, el importe y el total. El borrador conserva esos datos; cambiar de moneda reinicia el importe para que una cantidad en córdobas no se interprete como dólares.

Un envío cobrado en dólares requiere indicar el tipo de cambio, también al emitir una proforma.

Al emitir una factura, el total de productos más envío entra a la caja, banco o cuenta de cobro seleccionada. Un pago dividido debe completar ese mismo total; una factura pendiente conserva el envío dentro de su saldo por cobrar. La proforma solo cotiza.

Contabilidad reconoce la venta de perfumes en **4110** y el importe del envío en **2117 · Envíos por pagar**, dentro del pasivo circulante. El dinero recibido incluye ambos conceptos, pero el envío no es ingreso ni aumenta la utilidad. Esta acumulación al facturar es la única operación automática de este flujo.

**4120 · Cobros por envío** se retira del catálogo disponible para nuevos movimientos. Su registro interno se conserva para los comprobantes históricos. **5130-011 · Envíos a clientes** se mantiene como gasto. Se agrega **4190-001 · Gestión de envíos**, debajo de **4190 · Otros ingresos**, para los ingresos que Miguel registre manualmente.

## Pagar al transportista

Miguel registra el pago real en **Contabilidad → Comprobantes → Comprobante de egreso**, seleccionando las cuentas y los importes:

1. Escribir el concepto y, si corresponde, el número de factura en la referencia.
2. Debitar **2117 · Envíos por pagar** por el importe entregado al transportista.
3. Acreditar la caja o el banco del que sale ese mismo dinero.
4. Guardar el comprobante. El pago reduce la deuda y no genera un gasto adicional.

El pago tiene su propia fecha, moneda y tipo de cambio. Puede ser diferente del cobro al cliente y queda visible en el historial de comprobantes. Emitir la factura, cerrar la jornada o cambiar de mes no crea un egreso ni reconoce ganancias por gestión automáticamente. Se retira el botón rápido **Pago de envío**, que preparaba un gasto.

## Diferencia por gestión y envíos asumidos por la tienda

Al final del período, Miguel puede registrar un **Comprobante de ajuste** con débito en **2117** y crédito en **4190-001** por la diferencia que corresponda reconocer como ingreso. No se calcula ni se traslada automáticamente.

Si la tienda regala o asume un envío con su propio dinero, el comprobante manual debita **5130-011 · Envíos a clientes** y acredita la caja o el banco del que sale el dinero. Ese caso sí es un gasto de la tienda.

Ejemplo: una factura cobra C$80 de envío; el pasivo aumenta C$80. Un pago manual de C$60 al transportista deja C$20 pendientes de aplicación. Solo cuando Miguel registra el ajuste manual de esos C$20 a **4190-001** aparece la ganancia por gestión.

Las devoluciones de productos conservan el cargo por envío original y devuelven únicamente el importe neto de los productos seleccionados. Si se necesita reembolsar un envío, se registra por separado con su comprobante. La anulación completa de una factura retira también su cobro por envío y conserva el respaldo de la operación.

## Activación

Aplicar en Supabase la migración de envíos como pasivo posterior a `20261102190000_envios_en_facturas_y_contabilidad.sql`. Compilar la aplicación no aplica la migración remota. Los documentos, sus números, importes y comprobantes manuales no se borran ni se reescriben.

Las pruebas utilizan una base desechable y no modifican el negocio real:

```sh
npm run test:shipping
npm run test:browser:shipping
```

La prueba de navegador inicia su propio servidor local; `LCP_TEST_BASE_URL` permite usar otro servidor o el despliegue público con toda la API sustituida por una base aislada.

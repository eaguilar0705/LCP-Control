# Envíos a clientes

En Facturación y Proformas, **Tipo de envío** permite elegir **Moto**, **CargoTrans** o **Buses**. El campo **Cobro por envío** indica lo que paga el cliente, en la moneda del documento. No aplica una tarifa automática. También se puede indicar un envío gratuito, con importe cero, o elegir **Sin envío**.

El envío se suma después de los descuentos de los productos. La factura, la vista previa, el PDF y el mensaje para WhatsApp muestran el tipo, el importe y el total. El borrador conserva esos datos; cambiar de moneda reinicia el importe para que una cantidad en córdobas no se interprete como dólares.

Un envío cobrado en dólares requiere indicar el tipo de cambio, también al emitir una proforma.

Al emitir una factura, el total de productos más envío entra a la caja, banco o cuenta de cobro seleccionada. Un pago dividido debe completar ese mismo total; una factura pendiente conserva el envío dentro de su saldo por cobrar. La proforma solo cotiza.

Contabilidad reconoce la venta de perfumes en **4110** y los cobros por envío en **4120 · Cobros por envío**. El margen de cada perfume conserva sus ingresos y costos propios. Los cobros por envío forman parte del resultado del negocio como ingreso separado.

## Pagar al transportista

En **Contabilidad → Comprobantes → Pago de envío**, registrar el pago real a la moto, CargoTrans o buses:

1. Escribir el concepto y, si corresponde, el número de factura en la referencia.
2. Elegir en **Pagado desde** la caja o el banco del que sale el dinero.
3. Indicar el importe pagado. El sistema prepara el gasto en **5130-011 · Envíos a clientes** y su salida de dinero.
4. Guardar el comprobante de egreso.

El pago tiene su propia fecha, moneda y tipo de cambio. Puede ser diferente del cobro al cliente y queda visible en el historial de comprobantes. Se registra cuando se paga al transportista; emitir la factura no genera ese egreso automáticamente. Cada pago se registra una sola vez, aunque agrupe varios envíos.

Las devoluciones de productos conservan el cargo por envío original y devuelven únicamente el importe neto de los productos seleccionados. Si se necesita reembolsar un envío, se registra por separado con su comprobante. La anulación completa de una factura retira también su cobro por envío y conserva el respaldo de la operación.

## Activación

Aplicar en Supabase la migración `backend/supabase/migrations/20261102190000_envios_en_facturas_y_contabilidad.sql` antes de utilizar el cobro por envío. Compilar la aplicación no aplica la migración remota. Las facturas anteriores conservan su total y se leen con envío cero.

Las pruebas utilizan una base desechable y no modifican el negocio real:

```sh
npm run test:shipping
npm run test:browser:shipping
```

La prueba de navegador inicia su propio servidor local; `LCP_TEST_BASE_URL` permite usar otro servidor local existente.

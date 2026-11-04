# Administración de cuentas

En **Contabilidad → Catálogo de cuentas → Administrar cuentas**, Admin y SuperAdmin pueden:

- Agregar una cuenta indicando código, nombre y cuenta mayor. Hereda el tipo y naturaleza de su cuenta mayor.
- Renombrar una cuenta. Su código y clasificación se conservan.
- Desactivar una cuenta para retirarla de los selectores de nuevos comprobantes.
- Consultar cuentas inactivas y reactivarlas.

No se borran registros físicos: los saldos y comprobantes se conservan, incluso si la cuenta se desactiva teniendo movimientos. En el catálogo habitual solo aparecen cuentas activas; los estados mantienen las cuentas con importes históricos. Se pueden anular comprobantes previos sin borrar su cuenta.

Las cuentas utilizadas por ventas, inventario, pagos, importaciones y gastos automáticos, junto con sus cuentas mayores, no se pueden desactivar. La pantalla muestra el motivo. La cuenta retirada 4120 no se puede reactivar por error.

Para desactivar una cuenta mayor personalizada, primero se desactivan sus subcuentas. Para reactivar una subcuenta, su cuenta mayor debe estar activa.

La administración de cuentas funciona con la tienda abierta o cerrada. No cambia importes de comprobantes ni crea movimientos de dinero. Cada modificación guarda responsable, fecha y valores anteriores y posteriores, sin pedir un motivo. Los reintentos usan la misma solicitud y las ediciones simultáneas exigen actualizar la lista.

Las pruebas se ejecutan contra PostgreSQL desechable:

```sh
npm run test:ledger-accounts
npm run test:browser:ledger-accounts
```

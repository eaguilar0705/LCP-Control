# Administración de cuentas

En **Contabilidad → Catálogo de cuentas → Administrar cuentas**, Admin y SuperAdmin pueden:

- Agregar una cuenta indicando código, nombre y cuenta mayor. Hereda el tipo y naturaleza de su cuenta mayor.
- Editar el nombre y la numeración visible de una cuenta. Se conserva su clasificación y el primer dígito del tipo (1 activo, 2 pasivo, etc.). No se admiten números duplicados.
- Desactivar una cuenta para retirarla de los selectores de nuevos comprobantes.
- Consultar cuentas inactivas y reactivarlas.

No se borran registros físicos: los saldos y comprobantes se conservan, incluso si la cuenta se desactiva teniendo movimientos. En el catálogo habitual solo aparecen cuentas activas; los estados mantienen las cuentas con importes históricos. Se pueden anular comprobantes previos sin borrar su cuenta.

Las cuentas utilizadas por ventas, inventario, pagos, importaciones y gastos automáticos, junto con sus cuentas mayores, no se pueden desactivar. La pantalla muestra el motivo. La cuenta retirada 4120 no se puede reactivar por error.

Para desactivar una cuenta mayor personalizada, primero se desactivan sus subcuentas. Para reactivar una subcuenta, su cuenta mayor debe estar activa.

La administración de cuentas funciona con la tienda abierta o cerrada. No cambia importes de comprobantes ni crea movimientos de dinero. Cada modificación guarda responsable, fecha y valores anteriores y posteriores, sin pedir un motivo. Los reintentos usan la misma solicitud y las ediciones simultáneas exigen actualizar la lista.

La identidad interna de la cuenta permanece estable aunque cambie su número visible. Así se conservan las relaciones de comprobantes e importaciones y las operaciones automáticas siguen usando la misma cuenta. Catálogo, selectores, comprobantes, PDF y estados/Excel muestran el número editado. No hay que modificar las funciones de ventas al renumerar «Envíos por pagar» o una caja.

Las pruebas se ejecutan contra PostgreSQL desechable:

```sh
npm run test:ledger-accounts
npm run test:browser:ledger-accounts
```

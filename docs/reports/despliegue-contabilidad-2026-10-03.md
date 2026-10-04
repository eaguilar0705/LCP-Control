# Despliegue de contabilidad en Supabase

Fecha del negocio: **3 de octubre de 2026**, zona **America/Managua**. Proyecto: **La Casa del Perfume**, `xkpujpoocsbkychstrne`. Se aplicaron las cuatro migraciones pendientes a petición del dueño, después de la [auditoría funcional](auditoria-contabilidad-2026-10-03.md).

## Migraciones aplicadas

| Archivo local                                           | Nombre remoto                        | Versión remota   |
| ------------------------------------------------------- | ------------------------------------ | ---------------- |
| `20261003220645_linked_credit_payments.sql`             | `linked_credit_payments`             | `20261004032617` |
| `20261003220730_cashflow_cash_closing.sql`              | `cashflow_cash_closing`              | `20261004032627` |
| `20261003224314_cashflow_snapshot_product_identity.sql` | `cashflow_snapshot_product_identity` | `20261004032636` |
| `20261003225145_prevent_deleted_invoice_replay.sql`     | `prevent_deleted_invoice_replay`     | `20261004032647` |

Las cuatro operaciones devolvieron éxito y aparecen en `supabase_migrations.schema_migrations`. Las versiones remotas las asigna Supabase con fecha UTC; por eso empiezan por 4 de octubre aunque en Managua era 3 de octubre. El registro terminó con **30 migraciones**.

La migración base `finance_ledger_without_tax` ya figuraba como aplicada, versión `20261003214821`, y se conservó. Se comprobaron sus tablas y funciones, los actores permanentes y el historial de eliminación antes de desplegar.

La actualización habilita abonos vinculados a facturas y pedidos, flujo de dinero y arqueos persistentes. Las correcciones comprueban la identidad del perfume en los importes congelados y rechazan reintentos tardíos de facturas eliminadas.

## Verificación en la base real

Las ocho RPC contables están instaladas: `record_finance_entry`, `void_finance_entry`, `finance_sales`, `credit_accounts`, `finance_cashflow`, `record_cash_closing`, `void_cash_closing` y `list_cash_closings`. Sus funciones públicas son `SECURITY INVOKER`, tienen búsqueda de esquema vacía, permiten ejecución a `authenticated` y la deniegan a `anon`.

`finance_entries` y `cash_closings` tienen RLS habilitado. El navegador autenticado puede consultar según las políticas, pero carece de permisos de inserción, modificación y eliminación directas. Sus referencias de autoría apuntan a `private.business_actors`. Los cinco disparadores de forma de pago, conservación de facturas con abonos y protección de reintentos están habilitados; existe el índice del historial de solicitudes eliminadas.

Se ejecutó una transacción **READ ONLY**, bajo el rol `authenticated` y con la identidad de un administrador activo mediante claims locales. Terminó con `ROLLBACK`. Las comprobaciones pasaron:

- La factura existente tiene importes completos y coincide con los ingresos de `finance_sales`.
- Los ingresos netos y unidades del estado de resultados coinciden con los importes congelados de esa venta.
- Las cuentas por cobrar corresponden a las facturas a crédito.
- El flujo reconoce las ventas cobradas y los gastos existentes.
- El historial de arqueos puede consultarse y está vacío.
- Sin aperturas, los saldos finales de caja y banco permanecen pendientes.

No se registraron ventas, abonos, gastos ni arqueos ficticios en producción. Esta comprobación verifica SQL y permisos en la base real; las operaciones de escritura y los recorridos de interfaz se probaron previamente en entornos desechables, como detalla la auditoría. No se hizo una prueba concurrente entre sesiones reales.

## Conservación de registros

Se compararon cantidades y huellas MD5 de las filas completas antes y después. En `finance_entries` se excluyeron únicamente las tres columnas nuevas para comparar su contenido previo. **Las 12 tablas conservaron sus cantidades y huellas**:

| Tabla                     | Filas antes y después |
| ------------------------- | --------------------: |
| `products`                |                   260 |
| `product_prices`          |                 1,560 |
| `product_costs`           |                   260 |
| `inventory_balances`      |                   520 |
| `inventory_movements`     |                     9 |
| `documents`               |                     1 |
| `document_items`          |                     1 |
| `document_item_costs`     |                     1 |
| `expense_records`         |                     1 |
| `purchase_shipments`      |                     0 |
| `purchase_shipment_lines` |                     0 |
| `finance_entries`         |                     0 |

Las [evidencias de instalación y comparación](../../output/audit/contabilidad-supabase-2026-10-03.json) y la [consulta de comprobación](../../output/audit/contabilidad-supabase-2026-10-03.sql) se guardaron localmente en `output/audit`, directorio ignorado por Git. No contienen credenciales ni identidades de usuarios.

## Avisos existentes y alcance

Los asesores de seguridad devolvieron exactamente los mismos hallazgos antes y después, excluyendo sus marcas de observación. **No aparecieron avisos nuevos**:

- 12 tablas privadas con RLS sin políticas, usadas como almacenamiento interno: [explicación del asesor](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).
- 15 funciones públicas anteriores con `SECURITY DEFINER` ejecutables por personal autenticado: [criterios de revisión](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable). Las ocho RPC contables comprobadas son `SECURITY INVOKER`.
- La protección de contraseñas filtradas de Auth está desactivada: [configuración de Supabase](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

No se modificaron esas configuraciones durante este despliegue. Tampoco se reparó el historial previo de migraciones. Los objetos de `purchase_price_pricing` ya existen aunque su nombre no figura en el registro; volver a ejecutar esa migración podría retirar precios existentes. Debe conciliarse el historial antes de un futuro `supabase db push`.

Quedan **cero aperturas registradas** y **cero arqueos**. Para calcular saldos completos, registrar las cinco cuentas iniciales reales con la misma fecha en **Contabilidad → Caja y bancos → Registrar → Saldo inicial**. Una cuenta sin saldo requiere un cero explícito. La [guía de contabilidad](../guides/contabilidad.md) explica este arranque y los límites del balance provisional.

Este despliegue actualizó la base de Supabase. La publicación del frontend queda fuera de su alcance.

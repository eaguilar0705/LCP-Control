# Base de datos del negocio

Proyecto activo: **LCP-Control**, `xkpujpoocsbkychstrne`, el que configura `.env.local`. Es el que usa la aplicación; el identificador `vqicpwbwuatlyfdzpfne` que aparecía aquí antes no correspondía a este proyecto. **Las dieciséis migraciones de `supabase/migrations` están aplicadas**, verificado el 14 de septiembre de 2026, incluidas contabilidad, pedidos con envío, cuentas de gasto y precios del catálogo en dólares. Las de endurecimiento toleran que un proyecto nuevo no tenga la función histórica `rls_auto_enable`.

Antes de dar por buena una actualización del código, comprobar que la base va a la par. Ya pasó dos veces que no lo estaba: primero cuatro migraciones aplicadas a otro proyecto, y después un primer intento de costos escrito directamente en la base y nunca guardado como archivo. La comprobación rápida:

```sql
select version, name from supabase_migrations.schema_migrations order by version;
```

Debe listar las dieciséis migraciones de `supabase/migrations`. En este proyecto los identificadores remotos difieren de los nombres locales porque las migraciones se aplicaron mediante MCP: se corresponden por nombre; la última figura como `catalog_priced_in_usd`.

## El intento de costos que se retiró

El proyecto llegó a tener una primera versión de costos aplicada a mano: una tabla `product_costs` con promedio por moneda y `units_costed`, columnas `unit_cost` y `cost_currency` en `document_items` e `inventory_movements`, y `create_document` y `record_inventory_movement` reescritas para llenarlas. Nunca se usó desde la aplicación —el cliente no envía `unitCost` en un movimiento— y las tres tablas estaban vacías. Su registro además se había reescrito a mano: cuatro filas borradas y una fila inventada, `20260914120000 product_costs`, sin sentencias y ordenada después de todo lo demás.

`20260914051000_reset_abandoned_cost_draft.sql` devuelve las dos funciones a la versión del repositorio y retira la tabla y las columnas; `20260914070000_retire_abandoned_cost_ledger_rows.sql` quita las dos filas huérfanas del registro. Ninguna de las dos toca datos: todo lo retirado estaba vacío y el catálogo, los precios y los saldos quedaron intactos.

## Datos cargados y trazabilidad

- 260 productos, 38 marcas, 3 listas y 1,560 precios NIO/USD. El precio base se fija en dólares y su equivalente en córdobas se recalcula al cambiar la tasa del negocio. Verificación del 14 de septiembre: tasa de 37 y cero precios inconsistentes.
- 780 filas de origen, sus tres archivos, hojas y hashes SHA-256 en `private.import_sources/import_rows`. La identidad de unión es marca + nombre + presentación.
- 520 saldos por Bodega/Tienda sin contar (`NULL`); no se deducen existencias de las listas de precios.
- Fotos: **258 productos tienen `image_path` registrado**, verificado el 14 de septiembre de 2026. Esto confirma la asociación en el catálogo; no sustituye comprobar la carga de cada archivo con una sesión autorizada. Para importar originales locales se usa `scripts/catalog/import_product_images.mjs`. Comprobación: `select count(*) from public.products where image_path is not null;`
- Sin imagen de origen: LCP-0209 (Phantom Parfum con desodorante) y LCP-0210 (One Million EDT con gel). Se pueden añadir desde el editor.
- Clientes, proveedores, documentos y movimientos comienzan vacíos, por decisión del usuario. No se trasladaron operaciones del proyecto anterior.

Para preparar una importación revisable, sin ejecutar escrituras remotas:

```sh
python scripts/catalog/prepare_database_catalog.py CARPETA_CON_LOS_TRES_EXCEL
```

La salida en `private-data/database-import` está excluida de Git. No incorporar los Excel, precios privados, fotos originales ni credenciales al repositorio. Los SKU LCP son internos; `products.barcode` sigue reservado para EAN/UPC comprobados.

## Persistencia del programa

| Registro           | Ubicación y comportamiento                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catálogo           | `products`, `brands`, `product_prices`; alta, edición, seis precios, imagen, archivo/reactivación y revisiones concurrentes.                                         |
| Imágenes           | Bucket privado `product-images`, máximo 5 MB por archivo, JPEG/PNG/WebP. La aplicación optimiza nuevas fotos y usa enlaces firmados. No solicita miniaturas a Drive. |
| Existencias        | `inventory_balances` y `inventory_movements`; escrituras transaccionales mediante `record_inventory_movement`.                                                       |
| Clientes           | `customers`; nombre, teléfono, correo, RUC, dirección, notas, estado y lista de precios. Edición mediante `save_customer`.                                           |
| Proveedores        | `suppliers`; contacto, teléfono, correo, RUC, dirección, marcas, condiciones y notas. Edición mediante `save_supplier`.                                              |
| Facturas/proformas | `documents` y `document_items`; numeraciones FAC/PRO separadas, datos y precios congelados, RUC del cliente incluido.                                                |
| Borradores         | `user_drafts`; facturas/proformas separadas por usuario, sincronizadas entre equipos y protegidas contra sobreescrituras concurrentes.                               |
| Negocio            | `business_settings`; nombre, dirección y teléfono editables; cambios solo afectan documentos nuevos.                                                                 |
| Costos de compra   | `product_costs` (promedio ponderado vigente), `purchase_shipments` con sus `purchase_shipment_lines`, y `opening_cost_records`. Tabla aparte del catálogo para que la política de acceso deje fuera a Ventas. |
| Costos congelados  | `document_item_costs` guarda costo, tipo de cambio, tasa de impuesto y venta neta de cada renglón al emitir; `inventory_movement_costs` hace lo mismo con mermas, salidas y ajustes negativos. |
| Gastos             | `expense_records`; categoría, comprobante e importe, repartidos en cinco cuentas. No se borran: se anulan con motivo y quedan en el historial.                                                 |
| Tipo de cambio     | `exchange_rates`, una sola fila con la tasa vigente en córdobas por dólar y quién la cambió. Se edita en **Negocio** con `set_exchange_rate`; sólo propone un valor, nunca reescribe operaciones pasadas. |
| Acceso             | Supabase Auth guarda las credenciales. `staff_members` es la única fuente de permisos. `private.pending_staff` reserva correos y roles antes de activar cuentas.     |

La demostración de desarrollo conserva sus datos sintéticos y borradores/proveedores locales. Preferencias de interfaz y rotación de frases siguen en el navegador; no son registros del negocio.

## Permisos y activación

| Rol           | Acceso                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SuperAdmin    | Administración completa y gestión de otros SuperAdmin.                                                                                                 |
| Administrador | Catálogo, imágenes, clientes, proveedores, documentos, inventario, negocio y personal; no puede conceder ni modificar SuperAdmin.                      |
| Ventas        | Catálogo, existencias, clientes, facturación/proformas, salidas y daños. Solo ve sus documentos y movimientos; no cambia tarifas asignadas a clientes. |
| Inventario    | Catálogo, existencias, proveedores en consulta, entradas, salidas, daños y ajustes; solo ve sus movimientos. Sin clientes, documentos comerciales ni costos.   |
| Solo consulta | Catálogo, fotos y existencias; sin escrituras comerciales.                                                                                             |

Estado verificado en este proyecto: dos cuentas activas, ambas con rol **Administrador**, y ninguna autorización pendiente en `private.pending_staff`. No hay ningún SuperAdmin. Conviene saberlo porque `save_staff_account` sólo deja conceder o retirar ese rol a quien ya lo tiene: mientras nadie lo sea, la pantalla de Usuarios no puede crear el primero. Se asigna una sola vez desde la base:

```sql
update public.staff_members set role = 'superadmin'
where user_id = (select id from auth.users where email = 'CORREO@ejemplo.com');
```

A partir de ahí, las altas y los cambios de rol se hacen desde **Usuarios**. No se asignaron contraseñas compartidas ni se enviaron invitaciones.

1. Un administrador autoriza un correo y su rol en **Usuarios**.
2. La persona abre `/activate`, elige su propia contraseña y confirma su correo. El enlace del correo vuelve a `/auth/callback`, que canjea el enlace, abre la sesión y entra al panel (ver «Enlaces de correo» más abajo).
3. El disparador de Auth crea la fila en `staff_members` y consume la autorización pendiente. Un correo no autorizado no puede registrarse.
4. Para retirar acceso, deshabilitarlo desde Usuarios. Se conserva el historial. No se permite quitarse los propios permisos ni eliminar al último SuperAdmin activo.

**Pendiente de puesta en marcha:** el proyecto usa el SMTP de prueba de Supabase. Solo permite confirmaciones a miembros del equipo de Supabase, no a cualquier correo autorizado dentro de la aplicación. Para usuarios ajenos al equipo, configurar un proveedor SMTP en Authentication → Emails → SMTP Settings. No desactivar la confirmación de correo ni dar acceso al panel administrativo a empleados para sortear este límite. [Documentación oficial de SMTP](https://supabase.com/docs/guides/auth/auth-smtp).

### Enlaces de correo (activación, cambio de correo)

Corregido el 22 de septiembre de 2026. Antes, `signUp` no enviaba `emailRedirectTo`, así que Supabase devolvía a la **Site URL** (`http://127.0.0.1:5173/login`), que no existe en el teléfono ni en otra computadora; y el cliente se crea con `detectSessionInUrl: false`, así que aunque la dirección fuera correcta nadie leía el `#access_token` del enlace. Ahora:

- `signUp`, `resend` y el cambio de correo envían `emailRedirectTo = <origen>/auth/callback` (o `VITE_AUTH_REDIRECT_URL`).
- `/auth/callback` canjea explícitamente los tres formatos: `#access_token` (flujo implícito, el configurado), `?token_hash&type` (plantilla propia) y `?code` (PKCE); muestra un mensaje claro si el enlace venció (`otp_expired`) y borra los tokens de la barra de direcciones.
- Si el correo ya estaba confirmado, `/activate` lo dice en lugar de pedir que se revise el correo, y permite reenviar la confirmación con espera de 60 s.

**Configuración pendiente en el panel de Supabase** (Authentication → URL Configuration):

1. **Site URL**: el dominio HTTPS definitivo (por ejemplo `https://control.lacasadelperfume.com`).
2. **Redirect URLs**: agregar `https://<dominio>/auth/callback` y, para desarrollo, `http://127.0.0.1:5173/auth/callback`. Si falta, Supabase ignora `emailRedirectTo` y vuelve a la Site URL.
3. El servidor que publique la aplicación debe responder `index.html` para `/auth/callback` (regla SPA habitual).
4. Opcional y recomendado si el correo corporativo usa «enlaces seguros» (Outlook/Defender) que abren el enlace antes que la persona: en Authentication → Emails → *Confirm signup*, enlazar directo a la aplicación con `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email`. La aplicación ya entiende ese formato.

## Contabilidad de costos

El costo se registra donde ocurre la compra, no como un campo de la ficha del perfume que alguien deba recordar actualizar. Todo el módulo vive en **Reportes → Costos, margen y gastos**, visible sólo para Administrador y SuperAdmin (`product.edit_cost` y la política `owner_accounting_read`). Los precios del catálogo son precios de venta y nunca se usan como costo.

- **Estado:** aplicado. Las 260 filas de `product_costs` existen con el promedio en blanco; cada perfume adquiere su costo al registrar su costo inicial o su primera compra.
- **Método:** promedio ponderado. Cada renglón recibido recalcula `nuevo promedio = (existencias previas × promedio previo + costo puesto en bodega del renglón) ÷ unidades totales`, dentro de la misma transacción que suma las existencias.
- **Cómo llega la mercadería:** por agencia de envíos. Se pide una caja con varios perfumes y la agencia cobra el peso del paquete, nada más. Por eso la unidad de registro es el **pedido**: una cabecera con el proveedor, la agencia y el envío cobrado, y un renglón por perfume con su precio original —ya con el descuento por cantidad, si lo hubo—.
- **Costo puesto en bodega:** precio del proveedor + la parte del envío que le toca a la unidad. El envío se reparte **por igual entre todas las unidades del pedido**, que es lo que más se acerca a un cobro por peso sin pedirle a nadie que pese cada frasco. No hay impuestos de compra que separar.
- **Monedas:** cada pedido y cada gasto guardan su propio tipo de cambio; la contabilidad se consolida en córdobas con esa tasa histórica, no con una tasa del día. La tasa vigente se configura en **Negocio** y se propone al facturar en dólares y al registrar pedidos y gastos; el campo sigue siendo editable en cada operación. Vive en `exchange_rates` y no en `business_settings` porque `create_document` congela esa fila entera como emisor del documento.
- **Congelado al vender:** `create_document` deja copiado en cada renglón el costo vigente, la tasa y el impuesto de la venta. Un margen de enero no cambia porque en marzo se compre más caro.
- **Nunca se inventa un costo:** una unidad sin costo conocido se muestra como pendiente, jamás como cero. Mientras haya pendientes, la utilidad del período queda en blanco y las cifras conocidas se muestran por separado.
- **Carga inicial:** los 260 perfumes empiezan sin costo. En **Costos y precios → Cargar costos desde lista** se pega la columna de códigos y la de costos desde Excel; cada fila se valida contra el catálogo antes de escribir nada y las que no se pueden registrar se explican una por una. Un producto que ya tiene promedio no se sobrescribe: se actualiza registrando el pedido.
- **Las cinco cuentas de gasto:** impuestos y tasas (DGI, ALMA), pago de préstamos (acreedores, bancarios), gastos financieros (intereses bancarios y de acreedor), gastos de ventas (renta, salario, papelería, combustible, agua y luz, internet, limpieza, muebles y equipos, viático, marketing) y gastos operativos (compra de mercadería, flete de importación). La cuenta se deduce de la categoría en la aplicación y no se guarda, para que una fila no pueda quedar en una cuenta que no le toca.
- **Sólo tres cuentas bajan la utilidad.** El **pago de préstamos** devuelve capital: la cuota no empobrece al negocio, sólo mueve el dinero; lo que cuesta el préstamo es su interés, y ése ya está en gastos financieros. Los **gastos operativos** no se teclean: son los pedidos del período y pesan en el resultado cuando se vende cada perfume, como costo de lo vendido. Registrarlos otra vez a mano sería contarlos dos veces, así que la base rechaza esas categorías.
- **Qué se obtiene:** utilidad bruta y resultado operativo del período, cuánto costó la mercadería y cuánto el envío, margen por producto y por lista de precios, ventas por debajo del costo, inventario valorado a costo, rotación anual y días de inventario, gastos por cuenta y por categoría, y evolución mes a mes. Todo sale también en el PDF y en el libro de Excel.

Las funciones `record_shipment`, `set_opening_cost`, `record_expense` y `void_expense` exigen rol `admin`, reciben un requestId idempotente y bloquean producto y saldos antes de tocar el promedio. `record_shipment` valida el pedido completo —renglones, cantidades y envío— antes de tocar una sola existencia, y rechaza un mismo perfume repetido en dos renglones del mismo pedido. Un movimiento de entrada registrado por la vía genérica de inventario invalida el promedio del producto a propósito: sólo un pedido con su costo puede volver a establecerlo.

La vista local (`/demo`) trae un libro contable inventado —costos, pedidos, gastos y márgenes— para poder recorrer el módulo antes de aplicar la migración. No permite registrar nada.

## Reportes calculados en la base

`public.report_digest(p_from date, p_to date)` (migración `20260926120000_report_digest.sql`) devuelve en un solo objeto todo lo que muestran Reportes y la portada: ventas por moneda del periodo y del anterior, serie diaria, días de la semana, formas de pago, listas, productos, clientes (nuevos, recurrentes, principales, los que no volvieron y su frecuencia), conversión de proformas, movimientos de inventario y, sólo para administración, el libro contable (venta neta, impuesto, costo congelado, faltantes, mermas a costo, margen por producto y por lista, meses y ventas bajo costo).

- **Por qué:** antes el navegador descargaba cada factura del periodo y del anterior, con sus renglones, sus costos y los movimientos, y la lectura se cortaba en 20,000 filas. Ahora viaja el resultado: su tamaño depende de cuántos productos y clientes distintos hay (las listas de clientes llegan a 200 por moneda), no de cuántas facturas.
- **Permisos:** `SECURITY INVOKER`, así que RLS decide qué suma cada rol, igual que al leer las tablas. Ventas sólo ve sus documentos; el libro contable sólo lo recibe administración. Sin fila activa en `staff_members` responde «Tu cuenta no tiene permiso».
- **Fechas:** días de Managua (UTC−6 fijo). Un periodo no puede pasar de diez años.
- **Índices:** agrega `documents(created_at)` e `inventory_movements(created_at)`.
- **Misma cuenta que la aplicación:** `src/features/reports/digest.ts` hace el mismo cálculo con las filas crudas (lo usan la vista local y el respaldo). `tests/unit/database/reportDigest.test.ts` carga todas las migraciones en PGlite, emite facturas, proformas y movimientos al azar (semilla fija) y compara ambas versiones en siete periodos, para administración y para ventas.
- **Medición (PGlite, más lento que Supabase):** con 40,000 facturas, 120,000 renglones y 120,000 movimientos, 30 días tardan 0.24 s, 90 días 0.57 s y un año 2.2 s; la respuesta pesa unos 260 KB.
- **Respaldo:** si la función no existe (`PGRST202`), la aplicación lee las filas como antes y muestra en Reportes que se están calculando en el equipo.

Para aplicarla: en Supabase, **SQL Editor → New query**, pegar el contenido completo de `supabase/migrations/20260926120000_report_digest.sql` y ejecutar (o `supabase db push` con la CLI). Comprobación: `select to_regprocedure('public.report_digest(date,date)');` debe devolver el nombre de la función. En la aplicación, el aviso «Estos reportes se están calculando en este equipo…» deja de aparecer.

## Operación y comprobaciones

Las escrituras del negocio pasan por funciones con comprobaciones de rol, validaciones y límites de uso. Las tablas no conceden escritura directa a usuarios del navegador. Las lecturas aplican RLS, y el almacenamiento sigue siendo privado. Deshabilitar una cuenta corta el acceso en la base aunque su token no haya expirado.

`create_document` y `record_inventory_movement` reciben un requestId idempotente. Facturar bloquea y descuenta saldos; proformar no toca inventario. Una factura requiere conteo inicial mediante **Inventario → Ajuste**. Ninguna cantidad se inventó durante la carga.

El historial de documentos consulta las facturas o proformas de un período (índice `documents(kind, created_at desc)`), de 100 en 100, y las reimprime en carta/PDF; el PDF del período junta hasta 2,000 documentos. Movimientos muestra los últimos 200 registros autorizados. Clientes/proveedores muestran hasta 2,000 registros por pantalla. Para volúmenes mayores, añadir paginación de servidor.

`npm run test:db` incluye las 23 comprobaciones históricas de catálogo y las 21 de contabilidad y precios actuales. Comprueba permisos, revisiones, persistencia, instantáneas, costos, gastos y conversión de precios en PostgreSQL desechable. La revisión del 14 de septiembre consultó la base real sin escribir operaciones: 260 productos, 1,560 precios, cero precios inconsistentes, cero saldos negativos y 520 saldos todavía sin contar.

El asesor de seguridad informa seis tablas privadas con RLS sin políticas: es intencional, no se consultan directamente desde la API. También advierte sobre diez RPC SECURITY DEFINER accesibles a authenticated —la décima es `set_exchange_rate`—; son las escrituras y consultas autorizadas del programa, con controles internos de rol y search_path vacío. Las cuatro RPC de contabilidad no aparecen en el aviso porque su envoltura pública es SECURITY INVOKER. [Detalle del aviso](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable). No se amplió el acceso público para ocultar estas advertencias.

## Configuración local

```env
VITE_SUPABASE_URL=https://xkpujpoocsbkychstrne.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
VITE_DATA_MODE=supabase
```

Usar `.env.local`, ignorado por Git. Nunca usar claves secretas o service_role en el navegador. La publicación en HTTPS, el correo SMTP, el conteo físico, las dos fotos faltantes y los datos fiscales definitivos requieren completar la puesta en marcha.

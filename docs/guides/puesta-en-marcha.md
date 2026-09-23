# Puesta en marcha — La Casa del Perfume

Guía para el día de la entrega. Los precios de los 260 perfumes ya están cargados; lo que sigue es contar las existencias y empezar a trabajar. **El orden de estos pasos importa**: hacerlos al revés cuesta información que después no se recupera.

---

## Lo primero: el orden

```
1. CONTAR todo          →  2. CARGAR LOS COSTOS      →  3. FACTURAR Y PEDIR
   (Inventario)            (sólo el dueño)              (todos)
```

**No se puede cargar el costo de un perfume antes de contarlo.** El programa lo pide así a propósito: el costo inicial se aplica a las unidades que hay, y para eso tiene que saber cuántas hay.

**No conviene facturar antes de cargar los costos.** Una venta guarda el costo que el perfume tenía *en ese momento*. Si todavía no había costo, esa factura queda **sin margen para siempre**: no se arregla después. Las ventas se registran igual y el inventario se descuenta bien; lo único que se pierde es saber cuánto se ganó en ellas.

Si la tienda no puede parar de vender mientras cuentan, cuenten y costeen **primero los perfumes que más rotan**, y el resto después. El costo entra perfume por perfume, no hay que terminar los 260 para empezar.

---

## Paso 1 · Contar las existencias

**Quién:** el rol Inventario o el Administrador.
**Dónde:** Inventario → abrir el perfume → **Ajuste**.

Se cuenta **dos veces cada perfume**: una en Tienda y otra en Bodega. Hasta que las dos estén contadas, el programa no deja cargar su costo ni recibir un pedido de ese perfume.

Un perfume que no hay en existencia **se cuenta en cero igual**. No es lo mismo «cero» que «sin contar»: el cero es una respuesta, y deja el perfume listo para su primer pedido.

Si se equivocaron al contar, se vuelve a entrar y se pone el número correcto. Corregir un conteo ya **no borra el costo** del perfume; antes sí lo hacía.

---

## Paso 2 · Cargar los costos

**Quién:** sólo el Administrador (el personal de ventas nunca ve costos).
**Dónde:** Reportes → Costos y precios → **Cargar costos desde lista**.

Se pega desde Excel: código del perfume y costo por unidad. El costo es **lo que costó traer cada frasco**: lo que se le pagó al proveedor más la parte del envío que le tocó.

Tres cosas que conviene saber antes de pegar la lista:

- **Sólo entran los perfumes con existencias contadas mayores que cero.** Los que quedaron en cero no llevan costo inicial, y está bien: su primer pedido de importación se lo pone solo.
- **Un costo mal tecleado no se puede corregir.** Una vez cargado, la única forma de moverlo es recibir pedidos hasta que el promedio lo diluya. **Revisen el Excel con calma antes de pegarlo.**
- **El costo no es el precio de venta.** El programa nunca usa uno como el otro, pero vale decirlo: si se pega la columna equivocada, todos los márgenes salen mal y nadie se entera hasta que el reporte se ve raro.

---

## Paso 3 · Ya se puede trabajar

Desde aquí funciona todo: facturar, proformas, pedidos de importación, gastos y reportes.

---

## Dos reglas del día a día

### Mercadería que llega: **Pedido de importación**, nunca «Entrada»

Cuando llega una caja del proveedor, se registra en **Reportes → Pedidos → Registrar pedido**, con el precio de cada perfume y lo que cobró la agencia por el peso.

En Inventario existe también un botón de **Entrada**. Sirve para sumar unidades que aparecieron sin compra de por medio —una devolución, un frasco que estaba traspapelado—. **Usarlo para mercadería comprada borra el costo promedio de ese perfume**, porque el programa entiende que llegaron unidades que nadie costeó. Vale la pena decírselo a quien maneja bodega.

### El tipo de cambio mueve todos los precios

Los precios se fijan en **dólares**; el de córdobas sale de la tasa. Cambiar la tasa en **Negocio** recalcula de una vez los precios en córdobas de los 260 perfumes. No cambia los dólares, ni toca ninguna factura ya emitida.

O sea: si sube el dólar, **no hay que tocar precios**, sólo la tasa. Si sube un perfume, se cambia su precio en dólares en la ficha del perfume.

---

## Quién puede hacer qué

| | SuperAdmin / Administrador | Ventas | Inventario | Solo consulta |
| --- | :---: | :---: | :---: | :---: |
| Facturar y hacer proformas | ✓ | ✓ | | |
| Ver y editar clientes | ✓ | ✓ | | |
| Contar existencias (Ajuste) | ✓ | | ✓ | |
| Registrar salidas y daños | ✓ | ✓ | ✓ | |
| Ver el catálogo y las existencias | ✓ | ✓ | ✓ | ✓ |
| Crear y editar perfumes y precios | ✓ | | | |
| **Ver costos, márgenes y ganancia** | ✓ | | | |
| Registrar pedidos y gastos | ✓ | | | |
| Cambiar el tipo de cambio | ✓ | | | |
| Dar de alta y de baja al personal | ✓ | | | |

El personal de ventas **nunca ve un costo**, ni en pantalla ni en los reportes. Eso está puesto en la base de datos, no sólo en la pantalla: aunque alguien se las arreglara para pedirlos, no los recibe.

---

## Avisos que van a ver, y qué significan

| El programa dice | Qué pasó | Qué hacer |
| --- | --- | --- |
| «Carga primero el costo inicial de *X*: ya tiene *N* unidades contadas y todavía no tiene costo» | Llegó un pedido de un perfume contado al que nunca se le cargó el costo | Cargar su costo inicial y volver a registrar el pedido |
| «Registra primero el conteo de tienda y bodega» | Se quiere costear o recibir un perfume sin contar | Contarlo en las dos ubicaciones |
| «El costo inicial requiere existencias contadas» | Se quiere cargar el costo de un perfume que está en cero | No hace falta: su primer pedido le pondrá el costo |
| «Este producto ya tiene costo promedio» | Se quiere volver a cargar un costo inicial | El costo ya existe; se mueve recibiendo pedidos |
| «Existencias insuficientes para *X*» | La factura pide más unidades de las contadas | Revisar la cantidad o contar de nuevo |
| «Sin conteo en Tienda. Registra el inventario antes de facturar» | Se quiere vender un perfume nunca contado | Contarlo primero |
| «Otro usuario cambió este perfume» | Dos personas editaron la misma ficha | Cerrar y volver a abrir el perfume antes de guardar |
| «Registra el tipo de cambio del dólar en Negocio» | No hay tasa registrada | Registrarla en Negocio |

---

## Antes de entregar: tres cosas que faltan

Estas no dependen del programa sino de la puesta en marcha, y **sin las dos primeras el personal no puede entrar**.

1. **Dónde se abre el programa.** Todavía no está publicado en ninguna dirección de internet. Hace falta un hosting con HTTPS que devuelva `index.html` en cualquier ruta. Mientras no exista, el programa sólo corre en la computadora donde se desarrolla.
2. **Los correos de acceso.** Cada persona crea su contraseña en `/activate`, y para eso recibe un correo de confirmación. Hoy el proyecto usa el correo de prueba de Supabase, que **sólo envía a los dueños del proyecto** y muy pocos mensajes por hora. Hay que configurar un correo propio (SMTP) antes de dar de alta al personal, o nadie va a poder activar su cuenta.
3. **La protección de contraseñas filtradas** está apagada en Supabase. Es un interruptor: al encenderlo, el programa rechaza contraseñas que ya aparecieron en filtraciones conocidas. Con personal nuevo eligiendo contraseñas, conviene tenerlo encendido desde el primer día.

También vale confirmar dos cosas de las cuentas actuales: hay **dos Administradores**, y el Administrador ve costos, márgenes y la ganancia del negocio, y puede dar de alta y de baja al personal. Si alguna de las dos cuentas sólo necesita facturar, el rol **Ventas** le alcanza y no le enseña los costos.

---

## Para comprobar que todo sigue bien

En la computadora donde está el proyecto:

```
npm run check                            lint, 192 pruebas y compilación
node tests/database/puesta-en-marcha.mjs recorre estos pasos en una base de prueba
```

El segundo hace exactamente lo que dice esta guía —contar, costear, pedir, corregir un conteo— contra una base de datos real y desechable, y enseña qué pasa en cada camino. No toca la base del negocio.

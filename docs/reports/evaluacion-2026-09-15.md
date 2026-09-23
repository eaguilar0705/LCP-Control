# Evaluación general — LCP-Control

15 de septiembre de 2026. Revisión de rendimiento, funcionamiento, interfaz, seguridad y del módulo contable. Se levantó la aplicación de verdad, se recorrieron las nueve pantallas en escritorio, tableta y teléfono, y se auditó la base de datos desplegada (`xkpujpoocsbkychstrne`).

**Cuatro archivos corregidos y devueltos a la carpeta del proyecto.** `npm run check` en verde: lint, **191 pruebas** y build. Las **54 pruebas de navegador** (escritorio y móvil) y las **44 comprobaciones en PostgreSQL real** también pasan.

---

## Resumen

| Área | Estado |
| --- | --- |
| Pruebas y compilación | 191 unitarias + 54 de navegador + 44 de base de datos, todas en verde |
| Seguridad de la base | **Muy sólida.** Una cuenta anónima no puede leer ni escribir absolutamente nada |
| Seguridad del repositorio | **El repositorio de GitHub es público.** Decisión a tomar |
| Rendimiento | Se corrigió: **la carga inicial bajó a la mitad** |
| Interfaz | Se corrigieron tres defectos, uno de ellos **rompía el módulo en el teléfono** |
| Cuadre contable | **Cuadra al centavo** en todas las vistas comprobadas |
| Dependencias | 0 vulnerabilidades (`npm audit`) |

---

## 1. Rendimiento: la carga inicial pesaba el doble de lo necesario

`App.tsx` cargaba de golpe las pantallas de Reportes y de Administración, aunque sólo el Administrador puede abrirlas: la ruta `/reports` está detrás de `finance.read` y el personal de Ventas ni siquiera la ve en el menú. Aun así, **cada vendedor descargaba el panel contable completo** —las cuatro pestañas, las exportaciones a PDF y Excel, el diálogo de pedidos— antes de poder facturar.

Se pasaron a carga diferida, igual que ya estaban el escáner y la facturación:

| | Antes | Después |
| --- | --- | --- |
| JavaScript de arranque | 796 kB · **222 kB comprimido** | 389 kB · **114 kB comprimido** |
| CSS de arranque | 75 kB · 16.2 kB comprimido | 66 kB · 14.6 kB comprimido |

**La mitad del JavaScript de arranque, 108 kB comprimidos menos.** En el teléfono del mostrador, con datos móviles, eso es la diferencia entre abrir la caja rápido o esperar. El panel contable se descarga sólo cuando el Administrador entra a Reportes, y como es su propio archivo, cambiarlo ya no invalida la caché del resto del programa.

El resto del peso está bien repartido: `jspdf` (399 kB), `html2canvas` (199 kB) y el lector de códigos (368 kB) ya se descargaban aparte y sólo cuando hacen falta.

Tiempos medidos: compilación **2.1 s**, pruebas unitarias **45 s**, pruebas de navegador **3.6 min**.

## 2. Interfaz y presentación

### El módulo contable se deslizaba de lado en el teléfono

El más serio de los tres. En un teléfono, las pestañas **«Costos y precios»** y **«Gastos»** dejaban que la página entera se desplazara horizontalmente: al deslizar el dedo de lado —el gesto más natural del mundo sobre una tabla— el contenido se iba y quedaba **la pantalla en blanco**, con sólo la barra inferior visible. Había que adivinar que se volvía deslizando al revés.

La tabla tiene su propio desplazamiento interno, que es lo correcto, pero el ancho llegaba hasta la ventana y arrastraba la página con él. `overflow-x` por sí solo no lo impide; `contain: paint` sí. Comprobado ahora en las nueve pantallas y en las cuatro pestañas del panel, a 390, 768 y 1440 px: **ninguna se desplaza de lado.**

Esto ya estaba en «Costos y precios» antes de esta revisión; la revisión del 14 de septiembre no lo detectó porque sólo miró el código, sin abrir la aplicación.

### Las cinco cuentas de gasto no se alineaban entre sí

Las cinco cuentas —Impuestos, Préstamos, Financieros, Ventas, Operativos— se dibujan una debajo de otra con las mismas seis columnas, y el ojo las lee como un solo libro. Pero cada tabla se medía por su propio contenido, así que las columnas bailaban hasta **18 px** de una cuenta a la siguiente: «Importe original» terminaba en 910, 922, 904 y 910 según la cuenta. Ahora las cuatro comparten la misma rejilla, verificado al píxel.

### La separación entre córdobas y dólares era más débil que los títulos que separa

Reportes dibuja el mismo bloque de ocho secciones dos veces, una por moneda: «Ingresos por día», «Productos más vendidos», «Clientes»… con títulos **idénticos**. Lo único que los distinguía era una etiqueta de 10 px en café claro, más pequeña y de menos peso que los títulos que gobierna. Al bajar por la página, la segunda tanda se leía como repetida. Ahora la etiqueta va en vino, más grande, con una línea que cruza el ancho de la página.

### Lo que sí estaba bien

- **Ninguna desalineación entre encabezado y celda** en ninguna tabla de las nueve pantallas: el trabajo del 14 de septiembre se sostiene.
- **Cero errores de consola** en todo el recorrido, en escritorio y en móvil.
- Ningún archivo de código fuente huérfano: los 115 archivos de `src` se usan.

## 3. Validaciones

Las 191 pruebas unitarias, las 54 de navegador y las 44 contra PostgreSQL real pasan. Las de base cubren lo que importa de verdad y vale la pena nombrarlo: no se puede vender sin existencias, un producto repetido en un pedido se rechaza, las categorías de gastos operativos se rechazan, un operador puede facturar pero **no** leer la tabla de costos, una factura fallida devuelve el número, las existencias y las instantáneas, y el cambio de tasa reprecia el catálogo sin tocar documentos ya emitidos.

## 4. Seguridad

### La base de datos: nada que reprocharle

Se auditó la base desplegada, no el código. El resultado es el mejor posible:

- **Una cuenta anónima no tiene ni un solo permiso.** Ni `SELECT`, ni `INSERT`, en ninguna de las 27 tablas de `public` y `private`, y no puede ejecutar ninguna de las 16 funciones. Aunque alguien tenga la URL del proyecto y la clave publicable —que de todos modos viaja en el navegador de cualquier usuario—, no obtiene nada.
- **Una cuenta con sesión sólo puede leer.** No hay una sola política de `INSERT`, `UPDATE` o `DELETE` en ninguna tabla. Toda escritura pasa por una función que comprueba el rol antes de nada.
- **Las 10 funciones `SECURITY DEFINER` comprueban el rol en su primera línea**, todas con `search_path` vacío. El aviso del asesor de Supabase sobre ellas es un falso positivo: son precisamente las que el programa llama, y se defienden solas.
- **Los costos son del dueño.** `product_costs`, `expense_records`, `purchase_shipments`, `document_item_costs` y las demás tablas contables sólo las lee `admin`.
- El esquema `private` es inalcanzable desde la API. Las seis tablas que el asesor marca «RLS sin política» están así **a propósito**: sin política y sin permisos, nadie entra.
- El depósito de fotos `product-images` es **privado**, limitado a 5 MB y a imágenes; sólo el Administrador sube y borra.
- `SuperAdmin` funciona: `private.staff_role()` lo traduce a `admin` y exige la cuenta activa.
- `npm audit`: **0 vulnerabilidades**.

### Contraseñas y claves

- **No hay ningún secreto en el código.** El único archivo con una clave es `.env.local`, que no está en Git y sólo contiene la clave publicable —pública por diseño—. Se confirmó leyendo el índice de Git: de los 168 archivos versionados, los únicos `.env` son `.env.example` y `.env.test`, y ninguno lleva claves.
- `vite.config.ts` revisa el paquete compilado antes de escribirlo y **detiene la compilación** si encuentra un secreto. Los servidores de desarrollo sólo escuchan en 127.0.0.1. Es una buena defensa y conviene no quitarla.
- **La protección de contraseñas filtradas sigue desactivada** en Supabase Auth. Es un interruptor en el panel y compara contra HaveIBeenPwned: enciéndalo. Ya venía señalado como pendiente.
- El correo sigue usando el SMTP de prueba de Supabase. También venía señalado.

### El repositorio de GitHub es público

`https://github.com/diegourbiaviles1/LCP-Control` está **abierto a cualquiera**. Se confirmó cargándolo sin sesión.

No es una filtración: no hay claves adentro y una cuenta anónima no puede hacer nada contra la base. Pero sí publica **la URL del proyecto de Supabase** (en `.env.example`) y las dieciséis migraciones completas: cada política, cada función, cada tabla. Un atacante no necesita adivinar nada sobre la forma del sistema.

Es una decisión suya, no un defecto. Si el proyecto es su portafolio, tiene sentido dejarlo así —el diseño aguanta ser leído—. Si no lo es, **ponerlo en privado cuesta dos clics** en Settings → General → Danger Zone → Change visibility.

### Usuarios

Dos cuentas, **las dos Administrador**:

| Correo | Nombre | Alta | Último ingreso |
| --- | --- | --- | --- |
| `avilesurbinadiego@gmail.com` | Diego | 13 sep | 14 sep |
| `leoaguilarnovoa@gmail.com` | Emmanuel | 13 sep | 13 sep |

Hay además una invitación pendiente para `lacasadelperfumenic@gmail.com` como **SuperAdmin**.

Administrador lo puede todo: ve los costos, los márgenes y el resultado del negocio, cambia el tipo de cambio —que reprecia los 780 precios en córdobas— y da de alta y de baja al personal. **Vale la pena confirmar que la segunda cuenta necesita ese alcance.** Si sólo tiene que facturar, el rol Ventas le sirve y no le enseña los costos; si maneja bodega, Inventario. Se cambia en Negocio → Usuarios, sin tocar código.

## 5. Checkout del módulo de reportes (contabilidad)

### Cuadra

Se comprobaron las cifras del panel contra sí mismas, línea por línea, en la vista con datos de muestra. **No hay una sola diferencia de centavo:**

- Ventas netas 523 709.40 − costo de ventas 342 990.88 = margen bruto **180 718.52** ✓
- Margen bruto − gastos 53 200.00 − mermas 1 223.90 = resultado **126 294.62** ✓
- Las cinco cuentas: 4 900 + 2 450 + 45 850 = **53 200.00**, con préstamos (7 800) y operativos (28 182.60) correctamente **fuera** del total que resta ✓
- Las tres listas de precios suman exactamente las ventas netas, el costo y el margen del período ✓
- Los dos meses de «Evolución mes a mes» suman exactamente el período completo, en las cuatro columnas ✓
- Un pedido de muestra: 11 × 698.91 = 7 688.01, envío 177.92 ÷ 16 unidades = 11.12 por unidad, costo puesto 698.91 + 11.12 = **710.03** ✓, y los renglones suman el total de la caja ✓

### Cómo está construido por dentro

- El costo de cada venta se **congela** al emitir la factura (`document_item_costs`), con su tipo de cambio y su impuesto. Cambiar el costo promedio mañana no reescribe una factura de ayer.
- Un costo desconocido **nunca** se sustituye por el promedio actual ni por un precio de venta: se cuenta como unidad sin costo y el margen queda en blanco. Es la decisión correcta y está aplicada con rigor en todo el archivo.
- Las mermas se fotografían igual, sólo cuando hay salida real (`before > after`), con cantidad positiva y tipo acotado. No hay forma de que una entrada se cuente como merma.
- Los gastos operativos no se teclean: salen de los pedidos. Una categoría que la aplicación ya no conozca no se reparte a ojo, queda fuera y se ve en el historial.

### Tres cosas a vigilar

**1. El primer pedido de cualquier perfume va a perder su costo. Esto es urgente.**

Ninguno de los 260 perfumes tiene costo promedio (`product_costs`: 260 filas, **0 con costo**) y los 520 saldos están creados. En `record_shipment`:

```sql
case when v_total=0 then v_landed
     when v_average is not null then round((v_average*v_total+v_landed*v_quantity)/(v_total+v_quantity),6) end
```

Si el perfume tiene existencias contadas (`v_total > 0`) y todavía no tiene costo (`v_average` nulo), el `case` no tiene rama y devuelve **nulo**: el costo del pedido nuevo, que sí está documentado, se descarta.

Y hay una trampa detrás: si después se intenta arreglar con «Registrar costo inicial», la función sí acepta —porque el promedio está en nulo— pero **aplica ese costo inicial a todas las unidades**, incluidas las que acaban de llegar con su costo real documentado. El costo del pedido se pierde dos veces.

El camino limpio es **cargar los costos iniciales de los 260 perfumes antes de registrar el primer pedido real** (Reportes → Costos y precios → «Cargar costos desde lista», pegando código y costo desde Excel). Si prefiere que el programa no dependa de ese orden, hay que decidir qué hacer en ese hueco: valorar sólo las unidades nuevas, o rechazar el pedido hasta que haya costo inicial. Es una decisión contable, no la tomo por usted.

**2. Un costo inicial equivocado no se puede corregir.** `set_opening_cost` rechaza cualquier producto que ya tenga promedio. Si se carga un costo mal tecleado, la única forma de moverlo es registrar pedidos hasta que el promedio ponderado lo diluya. Antes de cargar los 260, conviene revisar el archivo de Excel con calma.

**3. Dos pedidos simultáneos con los mismos perfumes en distinto orden pueden trabarse.** `record_shipment` bloquea los productos en el orden en que vienen en el formulario, no ordenados. Con un solo Administrador registrando pedidos no va a pasar nunca; lo dejo anotado porque ordenar los renglones antes de bloquear es una línea.

### Un detalle de presentación que sigue pendiente

`formatCurrency` imprime **«NIO 523,709.40»** mientras la insignia de al lado dice **«1 USD = 36.6 C$»**. En la misma pantalla conviven las dos notaciones. Cambiar `currencyDisplay` a símbolo daría «C$523,709.40» y «US$1,991.00», que es lo que se lee en Nicaragua. Es **una línea** en `src/lib/format.ts`, pero toca todas las pantallas, las facturas impresas, los PDF y las exportaciones a Excel. Ya venía señalado dos veces; sigue siendo decisión suya. Si quiere, lo hago y le muestro las facturas impresas antes y después.

## 6. Archivos innecesarios

**No pude borrarlos.** El puente que le da a mi entorno un terminal sobre su computadora sigue caído por la actualización de Windows del 8 de septiembre; puedo leer y escribir archivos —por eso las correcciones sí llegaron— pero no ejecutar `rm`. El proyecto ya trae el comando exacto:

```
npm run clean
```

Borra `dist`, `test-results`, `playwright-report`, `coverage` y `tsconfig.tsbuildinfo`, y nada más: está escrito con una lista fija y se niega a seguir enlaces. Lo que recupera:

| Carpeta | Peso | Qué es |
| --- | --- | --- |
| `test-results/` | **15.04 MB** (47 archivos) | Capturas, PDF y dos vídeos de cámara falsa de la última corrida de pruebas |
| `dist/` | **2.17 MB** (22 archivos) | La compilación; se rehace con `npm run build` |
| **Total** | **17.2 MB** | Todo regenerable |

Dos detalles más, que decide usted:

- **`Claude outputs/`** (0.98 MB, 7 archivos): los PDF, el Excel y las capturas de ejemplo de los trabajos anteriores. Están ignorados por Git. Si ya no los consulta, se borran a mano.
- **`private-data/mensaje-commit.txt`**: un mensaje de commit del 14 de septiembre que quedó suelto. Ignorado por Git también.

Y una observación que importa más que los megas: **la carpeta del proyecto está dentro de OneDrive.** Cada corrida de pruebas escribe 15 MB de capturas que OneDrive sube a la nube y vuelve a sincronizar en cada equipo. Correr `npm run clean` después de las pruebas —o sacar el proyecto de OneDrive y dejar que Git sea el respaldo— le ahorra ese vaivén.

## 7. Lo que encontré y no toqué

**30 archivos no pasan `prettier --check`** y `npm run check` no lo revisa, así que nadie se entera. La revisión anterior contaba siete; ahora son treinta. Lo medí antes de decidir: formatearlos cambia **4 727 líneas en 26 archivos**, y sólo `AccountingPanel.tsx` reescribe **2 254 líneas**, porque ese archivo está escrito a propósito con componentes en una sola línea larga y prettier corta a 80 columnas.

Reformatearlos ahora habría enterrado las cuatro correcciones reales bajo cinco mil líneas de ruido. Las opciones son tres y las tres son legítimas: dejarlo como está y no volver a mencionarlo; subir `printWidth` en `.prettierrc.json` para que respete el estilo denso y entonces sí formatear; o aceptar el reformateo completo en un commit propio, sin nada más adentro. Dígame cuál y lo hago.

Como deuda de fondo, sin urgencia: `styles.css` sigue con cerca de 196 colores escritos a mano y muy pocos `var()`. El sistema de tokens ya existe y funciona en `identity.css` y en `accounting.css`; lo que falta es que la hoja grande lo adopte.

## 8. Archivos modificados

| Archivo | Qué cambió |
| --- | --- |
| `src/app/App.tsx` | Reportes y Administración pasan a carga diferida |
| `src/styles/accounting.css` | El módulo deja de arrastrar la página en el teléfono; las cuentas comparten rejilla |
| `src/features/reports/AccountingPanel.tsx` | `LedgerTable` acepta anchos de columna; las cuatro cuentas los usan |
| `src/styles/styles.css` | La separación entre córdobas y dólares pesa más que los títulos que separa |

## 9. Alcance

Se instalaron las dependencias y se compiló el proyecto; se corrieron lint, las 191 pruebas unitarias, el build, las 54 pruebas de navegador en Chromium (escritorio y móvil) y las 44 comprobaciones contra PostgreSQL real. Se recorrieron las nueve pantallas con datos de muestra en tres tamaños, midiendo alineación de cada columna de cada tabla, desbordamiento horizontal y errores de consola. Se auditó la base desplegada: permisos de tabla, políticas RLS, cuerpos y permisos de las 16 funciones, depósito de archivos, cuentas y avisos del asesor de Supabase. Se revisó el índice de Git y la visibilidad del repositorio remoto.

**No** se probó contra la API de Supabase desde fuera —la red de mi entorno bloquea ese dominio—, así que la comprobación de que una cuenta anónima no puede hacer nada se hizo sobre los permisos de la base, que es el mismo control que aplica PostgREST. **No** se registraron operaciones reales: la base de producción quedó tal como estaba.

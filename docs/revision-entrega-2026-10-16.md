# Revisión de entrega - 16 de octubre de 2026

Partimos de `main` en `b4b63a4`. Se contrastaron las notas de la reunión del 13 de octubre, el PDF de costos de octubre y el comportamiento del programa. Los nuevos mensajes de commit se escriben en español.

## Notas de la reunión

- Se retiró la acción nueva **Minuta de depósito**. Los registros históricos se pueden consultar.
- Las ventas ya alimentaban el mayor automáticamente. Ahora se consultan también como comprobantes diarios **VE**, con su contrapartida en caja, banco, crédito o POS, y **CV**, para costo de ventas e inventario. Se derivan de las mismas partidas: no se insertan asientos duplicados.
- Ambos comprobantes tienen detalle y PDF. Se separan ingreso/cobro y costo/inventario. La nota «Costo y cuenta van distintos» no especifica una reclasificación adicional.
- Se protege la integridad del comprobante: una factura sin detalle contable completo permanece visible como pendiente, aunque le falten todos los registros de costo. No se muestra una suma parcial como definitiva; otros días conocidos mantienen sus importes.
- Se corrigió el detalle de comprobantes en pantallas pequeñas, conservando visibles Cuenta, Debe y Haber.

## Prueba de uso prolongado

`npm run test:store` ejecuta todas las migraciones en PostgreSQL/WASM desechable. Un modelo independiente calcula los importes esperados y los compara diariamente con la base. El reloj se modifica únicamente dentro de esa base aislada.

| Recorrido                            |    Volumen |
| ------------------------------------ | ---------: |
| Jornadas con apertura y cierre       |         30 |
| Productos / saldos por ubicación     |  260 / 520 |
| Facturas emitidas                    |      1,200 |
| Facturas vigentes / anuladas         | 1,170 / 30 |
| Renglones vigentes facturados        |      5,467 |
| Unidades vendidas vigentes           |      7,916 |
| Proformas                            |        120 |
| Compras                              |         90 |
| Llamadas a funciones de negocio      |      2,315 |
| Comprobantes automáticos conciliados |         60 |
| Verificaciones aprobadas             |     38,352 |

Se recorren efectivo NIO y USD, crédito, POS y las seis cuentas bancarias; abonos, anulaciones, sobrepagos, liquidaciones de tarjetas, tasas y bases distintas, compras con envío, promedio ponderado, pérdidas y sobrantes, gastos, transferencias, permisos y reintentos. Cada jornada verifica todos los mayores, auxiliares por documento, caja por moneda, existencias y costos. Las fechas cerradas rechazan modificaciones. Incluye factura y proforma de 100 productos.

El corte final concilia ventas C$13,791,904.40, costo de ventas C$1,787,002.90, inventario C$2,384,526.88 y POS pendiente cero. Caja: C$1,447,650 y US$41,690. Estas cifras son exclusivamente de la simulación; no son resultados reales del negocio.

## Navegador, documentos y calidad

- 17 rutas a 1440, 390 y 320 px, con 260 productos y formularios conectados al SQL desechable.
- Productos, clientes, proveedores, compras, ventas, proformas, créditos, comprobantes y cierre; sin errores de ejecución o API ni desborde de página en los casos ejecutados.
- Comprobantes automáticos VE/CV en los tres tamaños, detalle, PDF y ausencia de acciones de minuta/anulación sobre comprobantes derivados.
- Factura y proforma de 100 productos: tres páginas carta. Facturas simples y comprobantes VE/CV: una página carta. Extracción comprueba texto dentro de la hoja y se revisan renders.
- Se mantienen las pruebas de 40 cálculos/presentación, jornada, 71 controles de tienda, 46 de catálogo/acceso y 70 de auditoría contable. Se agregaron 43 comprobaciones de comprobantes automáticos y 57 de importación de costos.
- `npm run check`: ESLint, TypeScript y compilación de producción.

Las capturas, PDF y resultados detallados están en `output/system-review/` y `output/extended-store-review/`, excluidos de Git.

## Cruce de costos y presentaciones

El PDF tiene 18 páginas y **272 filas** con costos en USD y NIO. El catálogo real consultado contiene **260 productos LCP**; hay además ocho productos DEMO de una presentación anterior. Las 260 referencias tienen candidato nominal, sin asignar una fila de costos dos veces. Se identificaron 256 coincidencias de alta confianza y cuatro para confirmar presentación.

Los costos comerciales y la extracción completa se conservan en `output/cost-review/`, excluido de Git. La fuente conserva la columna NIO original, incluso cuando el PDF muestra decimales de fórmula; la importación contable admite seis decimales. No se deduce el costo local a partir de un dólar redondeado ni de una tasa diferente de la usada por el documento.

Confirmaciones del usuario recibidas el 16 de octubre:

- `LCP-0242`: **Dg Devotion** del PDF corresponde al mismo **set de dos piezas, masculino**. Se actualizó su género.
- `LCP-0243` y `LCP-0245`: Light Blue masculino pequeño y femenino son ambos de **100 ml**. Se guardó esa capacidad para evitar la discrepancia comercial entre 3.3 y 3.4 oz.
- `LCP-0256`: Cool Water corresponde a **4.2 oz**; se conserva esa presentación y se acepta su costo confirmado.

Cuatro tamaños vacíos tienen respaldo explícito en el PDF: Odyssey Dubai Chocolate, Be EDT Men y One Million Lucky de 3.4 oz; Le Beau Paradise Garden grande de 4.2 oz.

Se corrigieron las capacidades de [Mandarin Sky Elixir a 100 ml](https://www.armaf.ae/products/odyssey-mandarin-sky-elixir-limited-edition) y [Le Beau Le Parfum pequeño a 75 ml](https://www.jeanpaulgaultier.com/ww/en/p/range-le-beau/le-beau-le-parfum-eau-de-parfum-intense-000000000065180318?ean=8435415062213), según sus fabricantes. Antes figuraban 3.49 y 2.7 oz. Prada Black conserva 3.4 oz en el catálogo; su fabricante publica 100 ml. La diferencia comercial 3.3/3.4 oz entre nombre y columna queda documentada y no genera otro producto.

Las **12 referencias adicionales** del PDF son Hawas Reyna; Odyssey Homme White Edition SET 4PCS; Odyssey Nexus; Club de Nuit Woman 6.8 oz; Club de Nuit Overdose; Badee al Oud Amethyst Fusion; Khamrah Dukhan; Supremacy Collectors Edition; Set Liquid Brun + Vulcan Feu; 212 Sexy Men; 360 Red Set; y Miss Dior EDP. Requieren alta comercial con sus precios de venta, presentación e imagen; no se les inventaron esos datos.

## Carga en Supabase

Se aplicaron las migraciones `20261016180756_comprobantes_automaticos_de_ventas.sql` y `20261016181420_completar_comprobantes_automaticos.sql`. Son funciones de lectura con controles de rol; el asesor mantiene los avisos anteriores y no añade advertencias nuevas.

El usuario confirmó que el PDF contiene los costos reales de las existencias. Se realizó primero un ensayo terminado en `ROLLBACK`: las huellas de precios, existencias y documentos coincidieron y siguió habiendo solamente un costo conocido. Después se confirmó la carga transaccional de **259 costos iniciales** y se preservó **un promedio previo**, para dejar **260 de 260 perfumes reales con costo**. Se completaron además los cuatro tamaños vacíos indicados.

La carga deja 260 auditorías con SHA-256 del PDF (`0466cb02ca133b52f7e7f422c58e913d2e1cba3f8bab7f6a2d1772cd52732e33`), producto, página, fila, costo NIO, costo USD y estado anterior/posterior. La comprobación contra los 259 valores importados devuelve cero discrepancias. Una repetición no duplica registros ni sobrescribe datos posteriores.

`LCP-0183` ya tenía promedio C$1,900 y movimientos anteriores. La lista informa costo C$1,853.77; quedó conservada como soporte en la auditoría, sin sustituir el promedio histórico ni reescribir ventas. Su conciliación debe hacerse con los soportes de esas existencias.

Tras la carga se conservaron exactamente las huellas de precios de venta (`05380613a50ba4f989f34ebd7e83bcd9`), existencias (`65f37f508cfd369b23dd8adb524c71cd`), documentos (`46ccf5d8aadfd90a9faab22c98079cfe`) y comprobantes manuales (`fb15247417bc19392cc10db45413fd2b`). Los USD de referencia del PDF no reemplazan la base independiente de los precios de venta. Los conteos pendientes no se convierten en ceros.

El generador `scripts/import/costos-iniciales.mjs` no se conecta a la base y produce SQL para revisión. Su terminación predeterminada es `ROLLBACK`; `--commit` genera la variante confirmable. Prueba de regresión: `scripts/tests/cost-import.mjs`. El manifiesto comercial y las verificaciones quedan en `output/cost-review/`, fuera de Git.

## Alcance y puesta en marcha

La prueba de volumen no escribió ventas ficticias en Supabase. No demuestra concurrencia entre varias conexiones PostgreSQL reales ni verifica impresora/lector físico, recepción de correos o compartir nativo de teléfono. Los avisos anteriores del asesor de seguridad se conservan y deben evaluarse según su alcance; no se abrieron permisos para silenciarlos.

La base conserva una jornada de presentación del 13 de octubre abierta y datos DEMO previos a esta revisión. Antes del uso real hay que gestionar ese cierre y la limpieza acordada del lote, completar conteos y conciliar apertura con datos reales. Un costo unitario conocido no constituye por sí mismo un inventario contado ni reconstruye costos de ventas antiguas. Hay 259 productos reales que todavía necesitan conteo en sus dos ubicaciones.

El respaldo automático sigue pendiente por decisión del usuario.

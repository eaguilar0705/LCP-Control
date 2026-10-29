# Precios, descuentos y proformas · 29 de octubre de 2026

- Los costos nuevos se ingresan y muestran con dos decimales. El cálculo del costo conserva cinco; los snapshots y valores históricos no se reescriben. El inventario sigue conservando su valor total exacto en centavos.
- El catálogo público redondea hacia arriba a dólares enteros. Cada enlace entrega exclusivamente su lista y su oferta; no permite elegir otra lista.
- Tienda online permite seleccionar un catálogo, consultar solo su precio y guardar o retirar una oferta indicando el precio final. El porcentaje se calcula automáticamente. La revisión y el precio base protegen contra cambios simultáneos.
- Facturación permite preparar una factura desde una proforma guardada. Conserva cliente, productos y descuentos, revisa los precios vigentes y usa una identidad nueva. El borrador de proforma se conserva. Prepararla no emite ni descuenta inventario.
- Facturas y proformas admiten precio final por perfume y descuento sobre el total. Se guardan precios originales, descuentos e importes netos. Los cobros, el mayor y las devoluciones usan esos importes netos. El reparto y las devoluciones parciales conservan exactamente los centavos.
- La impresión y el PDF muestran el descuento y el precio unitario neto, con hasta cinco decimales cuando es necesario. El total permanece en centavos.
- El historial del perfume vuelve a estar disponible en su edición. Lee snapshots de importación y edición, agrupa por mes e indica la variación de cada lista. Solo muestra hechos registrados, sin inventar precios anteriores.
- Las anulaciones de facturas, comprobantes, gastos, abonos, cierres y compras requieren SuperAdmin en la base y en la interfaz. Registrar operaciones y abrir o cerrar jornadas mantiene los permisos anteriores.
- Los mensajes de Emprendedor, VIP, Premium y Menudeo cambian según el catálogo. Son información comercial; no introducen bloqueos automáticos por cantidades mínimas.

## Verificación

- `npm run check`: lint, tipos y compilación.
- `npm run test:accounting`: 113 pruebas unitarias.
- `npm run test:discounts`: 8 pruebas del modelo y 60 comprobaciones SQL de descuentos, devoluciones, roles, historial, redondeo y ofertas independientes.
- `npm run test:storefront`: 155 comprobaciones.
- `npm run test:financial-corrections`: 103 comprobaciones de valor de inventario, 73 de devoluciones/pagos, 2.164 de correcciones de compras y 2.289 de recuperación/paginación. Incluye 500 compras y anulaciones.
- Integridad empresarial: 1.083 comprobaciones y 13 escenarios.
- Simulación de siete jornadas: 61.090 verificaciones, 280 facturas, 28 proformas y 21 compras; documentos, inventario, caja y mayor conciliados. Base PostgreSQL desechable, sin escrituras de prueba en producción.
- Navegador: guardar proforma con ambos descuentos, abrirla en Facturación, emitirla en la base aislada y guardar oferta VIP. Verificación visual en escritorio y a 390 px, sin desbordamiento.
- Factura y proforma PDF con 16 productos y descuentos: una hoja carta; renderizadas y revisadas visualmente.
- Catálogo público: sintaxis, límites de publicación, prueba de actualización y build.

Migraciones aplicadas en Supabase:

1. `20261029181802_restringir_anulaciones_y_recuperar_historial.sql`
2. `20261029181803_descuentos_por_catalogo_y_documento.sql`

La comprobación posterior a las migraciones conservó los 289 productos, los 2.306 precios y todos los conteos sin cambios. No se crearon ventas, clientes ni movimientos de prueba en producción.

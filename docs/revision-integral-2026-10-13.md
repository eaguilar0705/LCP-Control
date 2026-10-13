# Revisión integral — 13 de octubre de 2026

Revisión de `main`, partiendo de `d47ecf5`. Se comprobaron los recorridos de tienda y contabilidad con las migraciones reales en PostgreSQL desechable (PGlite). El navegador ejecuta los formularios de la aplicación contra esa base mediante un adaptador de transporte de pruebas. No se introdujeron operaciones ficticias en Supabase.

## Correcciones

- **Cobros y pagos:** se recuperó el acceso desde Contabilidad a las facturas pendientes, deudas de compras, abonos y sus anulaciones. Los abonos se enlazan a su documento; las cuentas bancarias se seleccionan y conservan por separado.
- **Apertura contable:** los créditos iniciales se obtienen del comprobante de apertura del libro actual. El módulo anterior sigue siendo compatible cuando todavía no existe ese comprobante. Se evita registrar otra apertura antigua sobre la nueva.
- **Conteos:** un aumento de existencias por ajuste conserva el costo promedio y registra el aumento de inventario y su contrapartida. La devolución de una factura conserva su tratamiento propio y no genera una ganancia ficticia. Un costo desconocido continúa pendiente. No se reconstruyeron costos históricos sin evidencia.
- **Compras en dólares:** el asiento y la deuda redondean mercancía y envío de la misma forma, evitando diferencias de un centavo.
- **Integridad del reporte:** se detectan facturas con parte del detalle contable faltante, incluso si otro producto de la misma factura sí conserva su costo.
- **Caja diaria:** el efectivo contado al abrir ya incluye las operaciones anteriores a esa apertura. Estas no se descuentan ni suman por segunda vez. Los comprobantes de apertura contable tampoco duplican la caja física.
- **Operaciones simultáneas:** las funciones públicas toman el bloqueo de jornada antes de bloquear productos o créditos, conservando el mismo orden que compras, anulaciones y cierre. Se evita la inversión de bloqueos identificada durante la revisión del SQL.
- **Tarjetas:** una liquidación no puede superar el saldo POS pendiente. Una factura POS no puede eliminarse si deja sin respaldo dinero ya liquidado. Comisión y retención admiten bases distintas, manteniendo debe y haber iguales.
- **Actualización de pantallas:** la recarga conserva una referencia estable para que el temporizador de la jornada no se reinicie en cada renderizado.
- **Móvil:** se muestran todas las secciones de Contabilidad; se corrigieron filtros y exportación recortados a 320 px. Cobros y pagos presentan los datos en bloques legibles. El inventario pasa a una columna en pantallas de hasta 380 px.

## Evidencia automatizada

| Comprobación | Resultado |
| --- | --- |
| Modelos contables y exportación Excel | 20 pruebas aprobadas |
| Jornada, reintentos, permisos y cierre definitivo | Prueba de base aprobada |
| Recorrido completo de tienda y contabilidad | 71 comprobaciones aprobadas |
| Productos, contactos, usuarios, privacidad y ediciones simultáneas | 46 comprobaciones aprobadas |
| Navegador con 260 productos | 17 rutas a 1440, 390 y 320 px, sin errores de ejecución ni de API |
| Formularios en esos tres tamaños | Apertura, factura, proforma, compra, edición de producto, altas/edición/eliminación de contactos, abonos, comprobante y cierre |
| Documentos | Descargas PDF y Excel; factura y proforma de 100 productos, tres páginas carta, sin texto fuera de la hoja |
| Fotografías | Conversión real de PNG 2400 × 1600 a WebP 1200 × 800 en Chrome |
| Autenticación | Solicitud de recuperación simulada y rechazo de pantalla de nueva contraseña sin sesión; acceso de roles comprobado en SQL |
| Calidad del código | ESLint, TypeScript y compilación de producción aprobados |

El día de control parte de inventario cero y registra dos compras de diez unidades con costos distintos y envío. Se comprueban promedio C$100, ocho unidades vendidas, una dañada y una recuperada por conteo. El corte intermedio concilia inventario C$1,200, costo de ventas C$800, merma C$100, ganancia por conteo C$100, créditos por cobrar C$400, proveedores C$600, caja C$3,650 y US$110. El debe y haber coinciden. Luego se verifican devoluciones, detalles incompletos, las seis cuentas bancarias, abonos anulados y la imposibilidad de modificar operaciones de una jornada cerrada.

La devolución con existencias en tienda y bodega ya usaba el promedio correcto; se agregó cobertura de regresión y se conservó esa implementación.

## Reproducción

```text
npm ci
npm run check
npm run test:accounting
npm run test:database
npm run dev -- --port 5173
# En otra terminal, con Chrome instalado:
npm run test:browser
```

El servidor de desarrollo necesita la configuración de Supabase para mostrar el inicio de sesión. Durante las pruebas, todas las solicitudes a Supabase son interceptadas: SQL se ejecuta en memoria; Auth y entrega de correo se simulan. Las capturas y PDF de prueba quedan en `output/system-review/`, excluido de Git. La instancia desechable se cierra al finalizar.

## Supabase y datos reales

Se aplicó `20261013183154_audit_accounting_workflows.sql` y se verificó la lectura de libro, créditos y jornada con permisos de administrador. Las huellas de contenido de productos, precios, existencias, documentos y clientes coincidieron antes y después de la migración: 260 productos, 1,560 precios, 520 registros de ubicación, dos documentos y dos clientes.

Al revisar producción siguen pendientes **los costos de los 260 productos**, **519 de los 520 conteos por ubicación** y **el comprobante de apertura contable**. No deben interpretarse los resultados incompletos como utilidad cero. Los datos deben registrarse con los valores reales de la tienda.

258 productos tienen imagen almacenada y todas sus referencias corresponden a objetos existentes. Dos productos aún no tienen imagen almacenada; no se asignaron fotografías por suposición.

El asesor de Supabase mantiene los avisos previos: 15 funciones administrativas públicas con `SECURITY DEFINER` y protección de contraseñas filtradas desactivada. No aparecieron advertencias nuevas. El nuevo registro privado de ganancias por conteo tiene RLS y acceso directo revocado; su aviso informativo de ausencia de políticas es intencional.

## Límites de la comprobación

Los recorridos demuestran los casos ejecutados; no garantizan ausencia absoluta de errores. No se probaron una impresora física, cámara/lector de barras físico, entrega real de correos ni el menú nativo de compartir de un teléfono. La concurrencia se revisó en el SQL; PGlite no sustituye una prueba de carga con varias conexiones PostgreSQL. No se cambiaron tasas contractuales, saldos reales ni decisiones tributarias. Los comprobantes de ajuste siguen requiriendo criterio del responsable contable.

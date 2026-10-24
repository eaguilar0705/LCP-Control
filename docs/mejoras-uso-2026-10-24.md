# Uso cotidiano — 24 de octubre de 2026

## Facturación y proformas

- Catálogo y documento juntos en escritorio. Los productos elegidos se desplazan dentro del documento, conservando el total y las acciones a mano.
- Cliente, pago, ubicación y vigencia en un panel plegable con resumen. Plegarlo conserva los datos. Si falta corregir alguno, «Revisar datos» abre el panel y enfoca el campo correspondiente.
- Fichas de productos más compactas, con imagen, presentación, existencias, precio y botón Agregar.
- En móvil, accesos fijos a Buscar productos y Ver documento, con cantidad de referencias y total. Volver a buscar conserva la búsqueda y enfoca el campo.
- Se mantienen borradores, impresión, PDF, WhatsApp y las protecciones al emitir o recuperar una respuesta perdida.

## Inventario y directorios

- Búsqueda y escáner visibles. Los siete filtros de inventario se agrupan en Filtros, con contador de filtros aplicados; plegarlos conserva la selección.
- Existencias, cantidad de resultados y cambio entre tarjetas y tabla ocupan menos espacio.
- Acciones de entrada, salida, dañado y ajuste adaptadas a teléfonos pequeños.
- Clientes y proveedores con búsqueda, filtros y cantidad de resultados juntos.

## Verificación

La revisión usa bases locales desechables, con las migraciones del proyecto y solicitudes de la aplicación interceptadas. No inserta registros en producción ni envía mensajes o correos reales.

`npm run test:browser:usability` comprueba los filtros y los flujos de factura/proforma con diez referencias, cantidades, cambio de moneda/lista, validaciones, datos plegados, borradores, emisión, impresión y descarga de PDF. Incluye escritorio, tableta y móvil, hasta 320 px, y comprueba que búsqueda y emisión puedan consultarse juntas en escritorio.

También se ejecutaron las regresiones generales de navegador, comprobantes automáticos de ventas, compras y costo promedio, listas de precios y contingencias de emisión, además de las pruebas unitarias contables, tipos, lint y compilación.

No se modifican reglas contables, permisos, cálculos, funciones de base de datos ni formatos de impresión.

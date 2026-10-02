# Clasificación del catálogo — 1 de octubre de 2026

Se revisaron los 260 registros existentes. El archivo `perfume-genders-2026-10-01.json` conserva la categoría, las fuentes y la justificación de cada SKU, incluyendo tamaños, sets y body sprays.

Resultado aplicado en Supabase: **107 masculinos, 84 femeninos y 68 unisex**. **LCP-0183 permanece sin género (Por confirmar)** por decisión del usuario: el título dice «212 3.4 EDT L», pero la foto almacenada muestra «212 MEN NYC».

## Criterio

- Se utiliza la categoría comercial del producto, no una inferencia por sus notas olfativas ni una restricción sobre quién puede usarlo.
- Se consultaron fichas de marcas, bases especializadas y distribuidores. Cuando el nombre original identifica expresamente Men, Women, Pour Homme, Uomo o Woman, esto se registra como evidencia del catálogo (fuentes vacías), sin atribuirlo a una verificación externa.
- Los tamaños y sets conservan la clasificación de su perfume. Los body sprays se contrastaron con las líneas y colecciones de Armaf.
- CK One y CK Be se clasificaron como unisex pese a que los nombres importados incluyen «men».
- Se comprobaron las fotos del catálogo para identificar Club de Nuit Intense MAN, United Dreams Together FOR HER, 360 BLACK FOR MEN, 360 RED FOR MEN y Cool Water masculino.
- Las fichas comerciales pueden discrepar. Las observaciones por SKU documentan los casos detectados; en Armaf Sillage, Bling, Precieux I y Arabian Sky se contrastaron campos contradictorios con la descripción o una fuente adicional. La clasificación puede corregirse desde la edición de productos si se confirma otra presentación.

## Aplicación y verificación

Se respaldaron los productos antes de actualizar. Una única transacción modificó exclusivamente `gender` y aumentó `revision` de los 259 registros clasificados. La operación exigía coincidencia de identificador, SKU, nombre y revisión, además de género previo vacío; de no coincidir exactamente 259 productos, se revertía completa.

La lectura posterior confirmó las 259 categorías y que LCP-0183 seguía vacío. La comparación de todos los demás campos de productos y de las huellas de precios y existencias no encontró cambios. El respaldo privado queda excluido de Git.

## Transferencias bancarias

La migración `20261002002433_bank_transfer_accounts.sql`, aplicada en Supabase, permite Bac C$, Bac $, LAFISE C$, LAFISE $, Ficohsa C$ y Ficohsa $. Se conserva la transferencia genérica para documentos anteriores. La cuenta elegida se mantiene en borradores, facturas, impresión y reportes. La moneda de la cuenta no altera automáticamente la moneda ni los importes del documento.

Verificación: 393 pruebas unitarias, 12 pruebas de base de datos aislada para facturas y 2 pruebas de navegador (escritorio y móvil), además de lint y compilación. Las pruebas de las seis cuentas ejercitaron la función de emisión y el descuento de inventario en una base aislada, sin emitir facturas de prueba en producción.

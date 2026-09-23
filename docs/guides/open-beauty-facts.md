# Consulta de códigos de barras en Open Beauty Facts

El auditor consulta la API pública de [Open Beauty Facts](https://world.openbeautyfacts.org/) por marca y compara sus fichas con un catálogo JSON. Genera candidatos; no escribe en Supabase ni reemplaza SKU o códigos ya registrados.

```sh
node scripts/openbeautyfacts/audit_openbeautyfacts.mjs --catalog private-data/database-import/products.json
node scripts/openbeautyfacts/audit_openbeautyfacts.mjs --offline
node --test tests/scripts/openbeautyfacts_matching.test.mjs
```

Para ampliar con fichas clasificadas como perfumes (incluso cuando su etiqueta de marca no coincide con la búsqueda inicial):

```sh
node scripts/openbeautyfacts/fetch_openbeautyfacts_perfumes.mjs
node scripts/openbeautyfacts/audit_openbeautyfacts.mjs --offline --supplement private-data/openbeautyfacts/category-search.json
```

El suplemento consulta hasta 500 fichas de categorías, con el mismo intervalo entre solicitudes. Se compara solo cuando el nombre o la marca contienen un alias de la marca del catálogo. Si la categoría crece por encima de ese límite, la salida se marca incompleta; usar la exportación del proveedor para recorridos de mayor volumen. No ejecutar consultas simultáneas, porque el límite de la API se comparte por IP.

Entrada: arreglo de objetos con `name`, `brand`, `size`, `unit`, `sku` (o `barcode`) e `id` opcional. Para la exportación de los Excel originales, `size_source` identifica los tamaños en onzas. Si no hay unidad, queda pendiente de verificar. Solo se usan datos descriptivos: los precios, existencias, clientes y credenciales nunca se envían a Open Beauty Facts.

Salida por defecto: `private-data/openbeautyfacts/report.json`, `informe.md`, `candidatos.csv` y caché de respuestas. Esta carpeta está excluida de Git y del sitio web. Conserva los códigos como texto al abrir el CSV en Excel para no perder ceros iniciales; JSON y Markdown mantienen el código exacto.

Se consultan las marcas y sus alias, con páginas de 100 registros y un límite de 20 páginas por marca; cualquier límite/error queda marcado como incompleto. Las consultas se separan por al menos 7,2 segundos, identifican la aplicación mediante User-Agent y reutilizan respuestas completas durante 24 horas. HTTP 403/429 detiene el recorrido. `--offline` permite volver a comparar sin consumir solicitudes. No es una búsqueda mientras se escribe.

La [documentación oficial](https://openfoodfacts.github.io/openfoodfacts-server/api/) especifica 10 consultas de búsqueda por minuto/IP y recomienda limitar los campos. La búsqueda estructurada usa `/api/v2/search`; una búsqueda por nombres libres no funciona en ese endpoint. Este auditor usa `brands_tags`, con alternativas OR documentadas, y compara nombres localmente. No encontrar candidatos en estas consultas no demuestra que el producto no exista bajo otra marca o descripción.

Se comprueba longitud y dígito verificador GTIN, nombre, volumen aproximado oz/ml, concentración, género y conjuntos cuando esos datos están disponibles. «Nombre y tamaño comparables» no significa «confirmado»: hace falta contrastar el código con la caja o proveedor. No se debe elegir por nombre si cambia EDP/EDT, el tamaño, un set o una variante. El catálogo puede tener presentaciones todavía sin especificar.

Los datos de Open Beauty Facts son [ODbL, con atribución y compartir igual](https://wiki.openfoodfacts.org/images/e/ed/OpenBeautyFacts.pdf). Los resultados se conservan como una colección de referencia separada y atribuida. Este flujo no publica el inventario privado ni importa masivamente información externa. Antes de automatizar una incorporación permanente, revisar las condiciones de reutilización; confirmar un código físicamente permite registrar la evidencia propia de la tienda.

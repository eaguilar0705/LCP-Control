# Error al editar perfumes con precios incompletos

El editor intentaba acceder directamente a `value.prices[tier].NIO` aunque
Supabase no hubiera devuelto esa lista. La versión publicada reproducía
`TypeError: Cannot read properties of undefined (reading 'NIO')` al abrir un
perfume de prueba sin precios VIP, mostrando «No pudimos cargar esta pantalla».
La reproducción interceptó todas las llamadas a Supabase y utilizó PostgreSQL
desechable; no se consultaron ni modificaron los datos del negocio.

`productInput` ahora prepara las tres listas base y ambas monedas antes de
mostrar el formulario. Conserva los precios existentes y las listas adicionales,
y permite completar los importes faltantes. Un valor faltante se representa con
cero en el formulario, pero la validación sigue exigiendo precios positivos antes
de guardar. La preparación del formulario no escribe en la base de datos.

## Comprobación

```sh
npm run check
npm run typecheck
node --test scripts/tests/price-lists.test.mjs
npm run test:browser:product-editor
```

La prueba de navegador compila la aplicación y comprueba cinco escenarios a
1440, 390 y 320 px: una lista faltante, todos los precios ausentes, una moneda
faltante, precios completos y una base sin la tabla opcional de porcentajes.
Comprueba apertura, validación, conservación de importes existentes, guardado,
conversión de precios y reapertura con historial. Los resultados y las capturas
se generan en `output/product-editor/`.

Para comprobar la interfaz publicada con los mismos datos aislados, establecer
`LCP_TEST_BASE_URL=https://lcp-control.pages.dev` antes de ejecutar la prueba.
Las llamadas a Supabase también se interceptan en ese modo.

## Publicación

Publicar la nueva compilación de `output/dist/` en el proyecto existente de
Cloudflare Pages, usando las variables públicas de Supabase del negocio como
indica el README. No requiere migraciones. Una pestaña que siga mostrando el
error necesita recargarse después de publicar la corrección.

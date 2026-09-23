// Optional category supplement, capped at 500 records. For larger datasets use
// the provider's exports instead of crawling the whole database through the API.
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'
const query = 'en:perfumes|en:eau-de-toilette|en:women-perfumes|en:men-perfumes'
const result = {
  query,
  fetchedAt: new Date().toISOString(),
  complete: false,
  count: 0,
  products: [],
}
await mkdir('private-data/openbeautyfacts', { recursive: true })
for (let page = 1; page <= 5; page++) {
  // Initial delay also separates this request from a just-completed brand audit.
  await pause(7200)
  const url = new URL('https://world.openbeautyfacts.org/api/v2/search')
  url.search = new URLSearchParams({
    categories_tags: query,
    page: String(page),
    page_size: '100',
    fields:
      'code,product_name,brands,quantity,product_quantity,product_quantity_unit',
    sort_by: 'product_name',
  }).toString()
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'LCP-Control/0.1 (https://github.com/diegourbiaviles1/LCP-Control)',
      },
      signal: AbortSignal.timeout(30000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    if (!Array.isArray(data.products) || !Number.isFinite(data.count))
      throw new Error('Respuesta inesperada')
    result.count = data.count
    result.products.push(...data.products)
    console.log(
      `${result.products.length}/${result.count} fichas de categorías de perfumes`,
    )
    if (result.products.length >= result.count) {
      result.complete = true
      break
    }
    if (!data.products.length) throw new Error('Página vacía antes del total')
  } catch (error) {
    result.error = error.message
    break
  }
}
if (!result.complete && !result.error)
  result.error =
    'Límite de 500 fichas; usar exportación del proveedor para ampliar.'
await writeFile(
  'private-data/openbeautyfacts/category-search.json',
  JSON.stringify(result, null, 2),
)
if (result.error) console.log(result.error)

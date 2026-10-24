import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  cacheDir: fileURLToPath(
    new URL('../../output/cache/price-list-tests', import.meta.url),
  ),
  server: { middlewareMode: true, hmr: false, ws: false },
  ssr: { noExternal: ['@lcp/contracts'] },
})
after(() => server.close())
const pricing = await server.ssrLoadModule('/src/lib/pricing.ts')
const { productInput, productInputSchema } = await server.ssrLoadModule(
  '/src/features/products/product.ts',
)
const { documentDraftSchema, draftTotal, draftPreview } =
  await server.ssrLoadModule('/src/features/sales/document.ts')
const { tierBreakdown, inventoryHealth, idleFromSold, shrinkageFromUnits } =
  await server.ssrLoadModule('/src/features/reports/model.ts')
const { catalogMargins } = await server.ssrLoadModule(
  '/src/features/reports/accounting.ts',
)
const pair = (USD) => ({ USD, NIO: Math.round(USD * 37 * 100) / 100 })
const prices = {
  emprendedor: pair(30),
  vip: pair(29),
  premium: pair(28),
  lista_cuarta: pair(27.03),
  lista_quinta: pair(25),
}
const product = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  revision: 0,
  name: 'Perfume',
  brand: 'Marca',
  category: 'designer',
  gender: 'unisex',
  size: 100,
  unit: 'ml',
  manufacturerBarcode: '',
  minimumStock: 0,
  active: true,
  imagePath: null,
  prices,
  price: 9999,
  currency: 'NIO',
}
const draft = {
  id: 'borrador',
  kind: 'invoice',
  reference: 'FAC-B1',
  customer: 'Cliente',
  customerId: null,
  phone: '',
  taxId: '',
  currency: 'NIO',
  tier: 'lista_cuarta',
  payment: 'cash',
  location: 'store',
  notes: '',
  createdAt: '2026-10-24T16:00:00Z',
  lines: [
    {
      productId: product.id,
      name: 'Perfume',
      barcode: 'LCP-0001',
      size: '100 ml',
      quantity: 2,
      prices: structuredClone(prices),
    },
  ],
}

test('la ficha conserva las listas cuarta y quinta al validar', () => {
  const parsed = productInputSchema.parse(productInput(product))
  assert.deepEqual(parsed.prices.lista_cuarta, prices.lista_cuarta)
  assert.deepEqual(parsed.prices.lista_quinta, prices.lista_quinta)
})
test('la ficha no exige importes para una lista nueva sin precio', () => {
  const copy = structuredClone(product)
  delete copy.prices.lista_cuarta
  delete copy.prices.lista_quinta
  const parsed = productInputSchema.parse(productInput(copy))
  assert.equal(Object.hasOwn(parsed.prices, 'lista_cuarta'), false)
})
test('no convierte la falta de precio en cero ni en el de otra lista', () => {
  assert.equal(pricing.productPrice(product, 'lista_nueva', 'NIO'), null)
  assert.equal(
    pricing.productPrice(
      { ...product, prices: { ...prices, lista_cero: pair(0) } },
      'lista_cero',
      'NIO',
    ),
    null,
  )
  assert.equal(
    pricing.productPrice(
      { ...product, prices: undefined },
      'lista_cuarta',
      'NIO',
    ),
    null,
  )
  assert.equal(pricing.productPrice(product, 'lista_cuarta', 'NIO'), 1000.11)
})
test('el borrador guarda todas las listas y calcula sin errores de centavos', () => {
  const parsed = documentDraftSchema.parse(JSON.parse(JSON.stringify(draft)))
  assert.equal(parsed.tier, 'lista_cuarta')
  assert.deepEqual(parsed.lines[0].prices.lista_quinta, pair(25))
  assert.equal(draftTotal(parsed.lines, parsed.tier, 'NIO'), 2000.22)
  assert.equal(
    draftPreview(parsed, { name: 'Tienda', address: '', phone: '' }).total,
    2000.22,
  )
})
test('un borrador anterior se abre sin la nueva lista y señala el precio faltante', () => {
  const copy = structuredClone(draft)
  delete copy.lines[0].prices.lista_cuarta
  const parsed = documentDraftSchema.parse(copy)
  assert.equal(draftTotal(parsed.lines, 'lista_cuarta', 'NIO'), null)
  assert.throws(
    () => draftPreview(parsed, { name: 'Tienda', address: '', phone: '' }),
    /sin precio/,
  )
  assert.equal(draftTotal(parsed.lines, 'emprendedor', 'NIO'), 2220)
})
test('los porcentajes heredados no alteran el precio manual de nuevas listas', () => {
  const result = pricing.applyPricing(
    prices,
    {
      purchasePrice: 10,
      purchaseCurrency: 'USD',
      markups: { emprendedor: 50, vip: null, premium: null, lista_cuarta: 999 },
    },
    37,
  )
  assert.equal(result.emprendedor.USD, 15)
  assert.deepEqual(result.lista_cuarta, prices.lista_cuarta)
  assert.deepEqual(result.lista_quinta, prices.lista_quinta)
})
test('los reportes incluyen las listas conocidas y también códigos históricos desconocidos', () => {
  pricing.setPriceTiers([
    ...pricing.defaultPriceTiers,
    { code: 'lista_cuarta', name: 'Lista del cliente', sortOrder: 4 },
  ])
  try {
    const documents = [
      {
        ...draft,
        total: 100,
        kind: 'invoice',
        currency: 'NIO',
        tier: 'lista_cuarta',
      },
      {
        ...draft,
        total: 200,
        kind: 'invoice',
        currency: 'NIO',
        tier: 'lista_anterior',
      },
    ]
    const report = tierBreakdown(documents, 'NIO')
    assert.equal(report.length, 2)
    assert.equal(
      report.find((row) => row.key === 'lista_cuarta').label,
      'Lista del cliente',
    )
    assert.equal(
      report.find((row) => row.key === 'lista_anterior').label,
      'lista_anterior',
    )
  } finally {
    pricing.setPriceTiers(pricing.defaultPriceTiers)
  }
})
test('la cotización en córdobas anticipa el precio definitivo guardado', () => {
  const usd = pricing.convertPrice(1000, 'NIO', 'USD', 37)
  assert.equal(usd, 27.03)
  assert.equal(pricing.convertPrice(usd, 'USD', 'NIO', 37), 1000.11)
})

test('una valoración parcial no convierte el precio faltante en valor cero', () => {
  const missing = structuredClone(product)
  missing.id = 'segundo'
  delete missing.prices.lista_cuarta
  const inventory = [product, missing].map((p) => ({
    product: p,
    quantities: { warehouse: 1, store: 2 },
  }))
  const health = inventoryHealth(inventory, 'lista_cuarta', 'NIO')
  assert.equal(health.listValue, null)
  assert.equal(health.missingPrices, 1)
  assert.equal(health.units, 6)
  const idle = idleFromSold(new Set(), inventory, 'lista_cuarta', 'NIO')
  assert.equal(idle.find((row) => row.productId === 'segundo').listValue, null)
  const damaged = shrinkageFromUnits(
    [
      { productId: 'segundo', units: 2 },
      { productId: 'retirado', units: 3 },
    ],
    inventory,
    'lista_cuarta',
    'NIO',
  )
  assert.equal(
    damaged.every((row) => row.listValue === null),
    true,
  )
})

test('las existencias pendientes de conteo también dejan la valoración pendiente', () => {
  const health = inventoryHealth(
    [{ product, quantities: { warehouse: null, store: 5 } }],
    'lista_cuarta',
    'NIO',
  )
  assert.equal(health.listValue, null)
  assert.equal(health.uncounted, 1)
})

test('los márgenes del catálogo incluyen nuevas listas sin inventar márgenes faltantes', () => {
  const source = {
    inventory: [{ product, quantities: { warehouse: 1, store: 2 } }],
    accounting: { costs: [{ productId: product.id, averageCostNio: 100 }] },
  }
  const margins = catalogMargins(source)
  assert.equal(margins.find((row) => row.tier === 'lista_cuarta').priced, 1)
  assert.equal(margins.find((row) => row.tier === 'lista_quinta').priced, 1)
})

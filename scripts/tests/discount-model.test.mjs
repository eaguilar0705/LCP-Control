import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  cacheDir: fileURLToPath(
    new URL('../../output/cache/discount-tests', import.meta.url),
  ),
  server: { middlewareMode: true, hmr: false, ws: false },
  ssr: { noExternal: ['@lcp/contracts'] },
})
after(() => server.close())
const { draftTotal, draftAmounts, draftPreview, documentDraftSchema } =
  await server.ssrLoadModule('/src/features/sales/document.ts')
const { returnLineAmount } = await server.ssrLoadModule(
  '/src/features/sales/salesReturns.ts',
)
const pricing = await server.ssrLoadModule('/src/lib/pricing.ts')
const permissions = await server.ssrLoadModule('/src/lib/permissions.ts')
const lines = [
  {
    productId: 'a',
    name: 'Perfume A',
    barcode: 'A',
    size: '100 ml',
    quantity: 3,
    prices: { vip: { USD: 30, NIO: 1110 } },
    discount: { tier: 'vip', currency: 'USD', amount: 28 },
  },
  {
    productId: 'b',
    name: 'Perfume B',
    barcode: 'B',
    size: '100 ml',
    quantity: 1,
    prices: { vip: { USD: 20, NIO: 740 } },
  },
]
const discount = { tier: 'vip', currency: 'USD', amount: 4.01 }
test('los descuentos del perfume y del total se conservan en el borrador', () => {
  const draft = documentDraftSchema.parse({
    id: 'draft',
    kind: 'proforma',
    reference: 'PRO-B1',
    customer: 'Cliente',
    customerId: null,
    taxId: '',
    currency: 'USD',
    tier: 'vip',
    payment: 'pending',
    location: 'store',
    notes: '',
    createdAt: '2026-10-29T12:00:00Z',
    lines,
    discount,
  })
  assert.equal(draftTotal(draft.lines, 'vip', 'USD', draft.discount), 99.99)
  const preview = draftPreview(draft, { name: 'La Casa del Perfume' }, 37)
  assert.equal(preview.total, 99.99)
  assert.equal(preview.originalTotal, 110)
  assert.equal(preview.discountAmount, 10.01)
  assert.equal(
    Math.round(preview.items.reduce((s, l) => s + l.lineTotal, 0) * 100),
    9999,
  )
})
test('cambiar de moneda no convierte un descuento USD en córdobas', () =>
  assert.equal(draftTotal(lines, 'vip', 'NIO', discount), 4070))
test('un descuento superior al precio o al subtotal bloquea la emisión', () => {
  assert.equal(
    draftTotal(lines, 'vip', 'USD', { ...discount, amount: 104 }),
    null,
  )
  assert.equal(
    draftTotal(
      [{ ...lines[0], discount: { ...lines[0].discount, amount: 31 } }],
      'vip',
      'USD',
    ),
    null,
  )
})
test('reparto sin importes cero y entradas vacías sin fallar la pantalla', () => {
  assert.equal(
    draftTotal(
      [
        {
          ...lines[0],
          quantity: 1,
          prices: { vip: { USD: 0.01, NIO: 0.37 } },
          discount: undefined,
        },
        lines[1],
      ],
      'vip',
      'USD',
      { ...discount, amount: 20 },
    ),
    null,
  )
  assert.equal(
    draftAmounts([{ ...lines[0], quantity: NaN }], 'vip', 'USD', discount).size,
    0,
  )
})
test('el reparto es estable al cambiar el orden y conserva centavos con importes grandes', () => {
  assert.deepEqual(
    draftAmounts(lines, 'vip', 'USD', discount),
    draftAmounts([...lines].reverse(), 'vip', 'USD', discount),
  )
  const large = lines.map((l) => ({
    ...l,
    quantity: 9999,
    prices: { vip: { USD: 9999999.99, NIO: 9999999.99 } },
    discount: undefined,
  }))
  const result = draftAmounts(large, 'vip', 'USD', {
    ...discount,
    amount: 9876543.21,
  })
  const sum = [...result.values()].reduce(
    (s, v) => s + BigInt(Math.round(v * 100)),
    0n,
  )
  assert.equal(
    sum,
    BigInt(
      Math.round(
        draftTotal(large, 'vip', 'USD', { ...discount, amount: 9876543.21 }) *
          100,
      ),
    ),
  )
})
test('la nota de crédito anticipa el importe neto de cada devolución parcial', () => {
  const item = { quantity: 3, returned: 0, unitPrice: 280, lineTotal: 800 }
  assert.equal(returnLineAmount(item, 1), 266.67)
  assert.equal(returnLineAmount({ ...item, returned: 1 }, 2), 533.33)
  assert.equal(returnLineAmount(item, 4), 0)
})
test('costos visibles con dos decimales y promedios calculados con cinco', () => {
  assert.equal(pricing.exactCost(123.45678), '123.46')
  assert.equal(pricing.shippingPerUnit(0.01, 3), 0.00333)
  assert.equal(pricing.weightedAverageCost(5, 1100, 10, 1000), 1033.33333)
  assert.equal(pricing.landedUnitCost(1.01, 0.00333, 37), 37.49321)
})
test('solo SuperAdmin dispone de las capacidades de anulación', () => {
  for (const role of ['admin', 'operator', 'warehouse', 'viewer', null]) {
    assert.equal(permissions.can(role, 'operation.void'), false)
    assert.equal(permissions.can(role, 'document.delete'), false)
  }
  assert.equal(permissions.can('superadmin', 'operation.void'), true)
  assert.equal(permissions.can('superadmin', 'document.delete'), true)
})

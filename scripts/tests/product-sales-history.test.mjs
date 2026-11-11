import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  cacheDir: fileURLToPath(
    new URL('../../output/cache/product-sales-history-tests', import.meta.url),
  ),
  server: { middlewareMode: true, hmr: false, ws: false },
  ssr: { noExternal: ['@lcp/contracts'] },
})
after(() => server.close())
const { parseProductSalesHistory, productSaleDay, readProductSalesHistory } =
  await server.ssrLoadModule(
    '/src/features/products/productSalesHistoryService.ts',
  )
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
const asOf = '2026-11-10T21:00:00+00:00'
const sale = (extra = {}) => ({
  documentId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
  number: 'FAC-000001',
  createdAt: '2026-11-10T20:15:00+00:00',
  customerId: 'cccccccc-cccc-4ccc-8ccc-000000000001',
  customerName: 'Cliente de la factura',
  currency: 'NIO',
  location: 'store',
  quantity: 3,
  unitPrice: 33.333333,
  lineTotal: 100,
  originalUnitPrice: 35,
  invoiceDiscount: 5,
  returnedQuantity: 1,
  returnedAmount: 33.33,
  status: 'partially_returned',
  revision: 1,
  cancelledAt: null,
  removedAt: null,
  ...extra,
})
const page = (extra = {}) => ({
  productId,
  asOf,
  offset: 0,
  limit: 20,
  total: 1,
  rows: [sale()],
  ...extra,
})
const rejects = (input, offset = 0, snapshot = null) =>
  assert.throws(
    () => parseProductSalesHistory(input, productId, offset, snapshot),
    /historial completo/,
  )

test('preserva precio neto de seis decimales, moneda y descuentos guardados sin usar precios de catálogo', () => {
  const source = page()
  const parsed = parseProductSalesHistory(source, productId)
  assert.deepEqual(parsed, source)
  assert.equal(parsed.rows[0].unitPrice, 33.333333)
  assert.equal(parsed.rows[0].lineTotal, 100)
  assert.equal(parsed.rows[0].invoiceDiscount, 5)
  assert.equal(parsed.rows[0].returnedAmount, 33.33)
  const dollars = page({
    rows: [
      sale({
        currency: 'USD',
        unitPrice: 10.25,
        lineTotal: 30.75,
        originalUnitPrice: 10.5,
        invoiceDiscount: 0.75,
        returnedAmount: 10.25,
      }),
    ],
  })
  assert.deepEqual(
    parseProductSalesHistory(dollars, productId).rows,
    dollars.rows,
  )
})

test('distingue el vacío legítimo de una respuesta fallida o incompleta', () => {
  assert.deepEqual(
    parseProductSalesHistory(page({ total: 0, rows: [] }), productId).rows,
    [],
  )
  for (const value of [
    null,
    undefined,
    {},
    [],
    page({ rows: [] }),
    page({ total: 0 }),
    page({ total: '1' }),
    page({ total: -1 }),
    page({ total: 0.5 }),
    page({ productId: 'otro' }),
    page({ offset: 20 }),
    page({ limit: 50 }),
    page({ asOf: 'sin fecha' }),
  ])
    rejects(value)
})

test('valida identidad, cliente, moneda, importes y estados sin rellenar campos con cero', () => {
  for (const extra of [
    { documentId: '' },
    { number: '' },
    { customerId: null },
    { customerName: '' },
    { currency: 'EUR' },
    { location: 'otra' },
    { createdAt: 'fecha inválida' },
    { quantity: 0 },
    { quantity: 1.5 },
    { unitPrice: null },
    { unitPrice: '33.33' },
    { originalUnitPrice: undefined },
    { invoiceDiscount: -1 },
    { lineTotal: Infinity },
    { returnedQuantity: 4 },
    { returnedQuantity: -1 },
    { returnedAmount: 101 },
    { returnedAmount: NaN },
    { status: 'unknown' },
    { revision: -1 },
    { cancelledAt: undefined },
    { removedAt: 'sin fecha' },
  ])
    rejects(page({ rows: [sale(extra)] }))
  const duplicated = sale()
  rejects(page({ total: 2, rows: [duplicated, duplicated] }))
})

test('conserva facturas corregidas, anuladas y renglones retirados como registros históricos explícitos', () => {
  for (const status of [
    'issued',
    'partially_returned',
    'returned',
    'cancelled',
    'removed',
  ]) {
    const source = page({
      rows: [
        sale({
          status,
          cancelledAt: status === 'cancelled' ? asOf : null,
          removedAt: status === 'removed' ? asOf : null,
        }),
      ],
    })
    const result = parseProductSalesHistory(source, productId)
    assert.equal(result.rows[0].status, status)
    assert.equal(result.rows[0].revision, 1)
    assert.equal(result.rows[0].customerName, 'Cliente de la factura')
    assert.equal(result.rows[0].lineTotal, 100)
  }
})

test('la página siguiente respeta el snapshot solicitado y no acepta páginas truncadas o duplicadas', () => {
  const rows = Array.from({ length: 5 }, (_, index) =>
    sale({
      documentId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index + 1).padStart(12, '0')}`,
    }),
  )
  const source = page({ total: 25, offset: 20, rows })
  assert.deepEqual(
    parseProductSalesHistory(source, productId, 20, asOf),
    source,
  )
  assert.deepEqual(
    parseProductSalesHistory(source, productId, 20, '2026-11-10T21:00:00Z'),
    source,
  )
  rejects(source, 20, '2026-11-11T21:00:00Z')
  rejects({ ...source, rows: rows.slice(0, 4) }, 20, asOf)
  rejects({ ...source, rows: [...rows, rows[0]] }, 20, asOf)
  assert.deepEqual(
    parseProductSalesHistory(
      page({ total: 10, offset: 20, rows: [] }),
      productId,
      20,
      asOf,
    ).rows,
    [],
  )
})

test('el enlace del día usa Managua aunque UTC o la zona del equipo indiquen otra fecha', () => {
  assert.equal(productSaleDay('2026-11-11T02:30:00Z'), '2026-11-10')
  assert.equal(productSaleDay('2026-11-11T06:00:00Z'), '2026-11-11')
  assert.equal(productSaleDay('2026-11-10T20:30:00-06:00'), '2026-11-10')
})

test('rechaza parámetros de consulta inválidos antes de acceder al servicio', async () => {
  for (const args of [
    ['producto'],
    [productId, -1],
    [productId, 0.5],
    [productId, 0, 'ayer'],
    [productId, 0, null, -1],
    [productId, 0, null, 1.5],
    [productId, 0, null, NaN],
    [productId, 0, null, '25'],
  ]) {
    await assert.rejects(
      readProductSalesHistory(...args),
      /Revisa el perfume y la página/,
    )
  }
})

test('detecta cambios de pertenencia al producto entre páginas e invita a actualizar', () => {
  const source = page()
  assert.deepEqual(
    parseProductSalesHistory(source, productId, 0, asOf, 1),
    source,
  )
  for (const total of [0, 2]) {
    assert.throws(
      () => parseProductSalesHistory(source, productId, 0, asOf, total),
      /historial cambió.*Actualizar ventas/,
    )
  }
  assert.deepEqual(
    parseProductSalesHistory(
      page({ total: 0, rows: [] }),
      productId,
      0,
      asOf,
      0,
    ).rows,
    [],
  )
})

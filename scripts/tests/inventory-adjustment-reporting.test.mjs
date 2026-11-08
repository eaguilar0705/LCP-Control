import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  logLevel: 'error',
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  server: { middlewareMode: true, hmr: false, ws: false },
  ssr: { noExternal: ['@lcp/contracts'] },
})
const { ledgerDigest } = await server.ssrLoadModule(
  '/src/features/reports/accounting.ts',
)
await server.close()
const range = { from: '2026-11-01', to: '2026-11-07' }
const date = '2026-11-07T18:00:00Z'
const movement = (id, adjustmentKind) => ({
  id,
  productId: 'perfume',
  type: 'ADJUSTMENT',
  quantity: 15,
  beforeQuantity: 20,
  afterQuantity: 15,
  createdAt: date,
  adjustmentKind,
})
const snapshot = (row, unitCostNio = 100) => ({
  movementId: row.id,
  productId: row.productId,
  adjustmentKind: row.adjustmentKind,
  type: row.type,
  quantity: 5,
  unitCostNio,
  totalCostNio: unitCostNio === null ? null : 500,
  createdAt: date,
})
const source = (movements, movementCosts) => ({
  documents: [],
  customers: [],
  inventory: [],
  movements,
  window: range,
  truncated: false,
  accounting: {
    available: true,
    costs: [],
    shipments: [],
    expenses: [],
    saleCosts: [],
    movementCosts,
    truncated: false,
  },
})

test('corregir 20 unidades mal digitadas a 15 no genera pérdida en reportes locales ni mensuales', () => {
  const correction = movement('correction', 'correction')
  for (const costs of [
    [snapshot(correction)],
    [snapshot(correction, null)],
    [],
  ]) {
    const report = ledgerDigest(source([correction], costs), range)
    assert.equal(report.inventoryWriteOffNio, 0)
    assert.equal(report.missingWriteOffUnits, 0)
    assert.deepEqual(report.months, [])
  }
})

test('pérdidas explícitas e históricas conservan su costo, sin sumar las correcciones', () => {
  const correction = movement('correction', 'correction')
  const loss = movement('loss', 'loss')
  const legacy = movement('legacy')
  const rows = [correction, loss, legacy]
  const report = ledgerDigest(
    source(
      rows,
      rows.map((row) => snapshot(row)),
    ),
    range,
  )
  assert.equal(report.inventoryWriteOffNio, 1000)
  assert.equal(report.missingWriteOffUnits, 0)
  assert.equal(report.months[0].inventoryWriteOffNio, 1000)
})

test('las pérdidas sin costo siguen pendientes, sin confundirlas con correcciones de cantidades', () => {
  const correction = movement('correction', 'correction')
  const loss = movement('loss', 'loss')
  const report = ledgerDigest(source([correction, loss], []), range)
  assert.equal(report.inventoryWriteOffNio, 0)
  assert.equal(report.missingWriteOffUnits, 5)
  assert.equal(report.months[0].missingWriteOffUnits, 5)
})

test('anular una pérdida neutraliza su importe sin ocultar el movimiento original', () => {
  const loss = movement('loss', 'loss')
  const original = source([loss], [snapshot(loss)])
  original.accounting.inventoryAdjustmentReversals = [
    {
      movementId: loss.id,
      occurredOn: '2026-11-07',
      inventoryWriteOffNio: -500,
    },
  ]
  const report = ledgerDigest(original, range)
  assert.equal(report.inventoryWriteOffNio, 0)
  assert.equal(report.missingWriteOffUnits, 0)
  assert.equal(original.movements.length, 1)
  assert.equal(original.accounting.movementCosts[0].totalCostNio, 500)
})

test('la reversión se reconoce en su fecha sin modificar la pérdida de períodos anteriores', () => {
  const loss = movement('loss', 'loss')
  const original = source([loss], [snapshot(loss)])
  original.accounting.inventoryAdjustmentReversals = [
    {
      movementId: loss.id,
      occurredOn: '2026-12-01',
      inventoryWriteOffNio: -500,
    },
  ]
  assert.equal(ledgerDigest(original, range).inventoryWriteOffNio, 500)
  const december = ledgerDigest(original, {
    from: '2026-12-01',
    to: '2026-12-01',
  })
  assert.equal(december.inventoryWriteOffNio, -500)
  assert.equal(december.months[0].inventoryWriteOffNio, -500)
  assert.equal(december.missingWriteOffUnits, 0)
})

test('el movimiento de reversión no se convierte en otra merma ni en un costo faltante', () => {
  const reversedGain = { ...movement('reverse'), reversalOf: 'original-gain' }
  const input = source([reversedGain], [])
  assert.equal(ledgerDigest(input, range).missingWriteOffUnits, 0)
  input.accounting.movementCosts = [
    { ...snapshot(reversedGain), reversalOf: 'original-gain' },
  ]
  const report = ledgerDigest(input, range)
  assert.equal(report.inventoryWriteOffNio, 0)
  assert.equal(report.missingWriteOffUnits, 0)
})

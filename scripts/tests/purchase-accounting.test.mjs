import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../frontend', import.meta.url)), cacheDir: fileURLToPath(new URL('../../output/cache/purchase-accounting', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, ssr: { noExternal: ['@lcp/contracts'] } })
after(() => server.close())
const { createAccountingAdapter } = await server.ssrLoadModule('/src/services/adapters/accounting.ts')
const { rowsOf } = await server.ssrLoadModule('/src/features/accounting/financeRows.ts')
const day = '2026-10-25'
const shipment = { id: 'purchase', request_id: 'purchase-request', incurred_on: day, supplier: 'Proveedor QA', agency: '', reference: 'COMPRA-QA', note: '', currency: 'NIO', exchange_rate: 1, shipping_amount: 0, goods_amount: 1000, units: 10, shipping_per_unit: 0, account: 'credito', created_at: day + 'T14:00:00Z', event_kind: 'purchase', goods_nio: 1000, shipping_nio: 0, purchase_shipment_lines: [] }
const opening = { id: 'opening', request_id: 'opening', occurred_on: day, kind: 'opening', account: 'caja', to_account: null, amount: 1000, currency: 'NIO', exchange_rate: 1, counterparty: '', description: 'Apertura', reference: '', created_at: day + 'T13:00:00Z', voided_at: null, void_reason: null }
const paid = { ...opening, id: 'payment', kind: 'supplier_payment', amount: 3, currency: 'USD', exchange_rate: 36.615, shipment_id: shipment.id, description: 'Abono real' }
const refund = { ...paid, id: 'refund', amount: -3, amount_nio: -109.85, read_only: true, compensation_kind: 'recording_error', description: 'Corrección de pago registrado por error' }
const cancellation = { ...shipment, id: 'correction', original_shipment_id: shipment.id, event_kind: 'cancellation', goods_amount: -1000, goods_nio: -1000, units: -10, refund_entries: [refund] }
function adapter(events) {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'admin' } }, error: null }) },
    from(table) {
      const data = table === 'finance_entries' ? [opening, paid] : table === 'staff_members' ? { role: 'admin', active: true } : []
      const result = { data, error: null, count: Array.isArray(data) ? data.length : 1 }
      const query = new Proxy({}, { get: (_, key) => key === 'then' ? (resolve, reject) => Promise.resolve(result).then(resolve, reject) : () => query })
      return query
    },
    rpc: async name => ({ data: name === 'purchase_report_events' ? { rows: events, count: events.length } : name === 'inventory_value_rows' ? { rows: [], count: 0 } : { caja: 0, banco: 0, cobrar: 0, missing: 0 }, error: null }),
  }
  return createAccountingAdapter(() => client, error => new Error(error?.message ?? 'Error SQL'))
}
test('la fuente de compras conserva original y reversión con importes NIO firmados', async () => {
  const source = await adapter([shipment, cancellation]).getSource({ from: day, to: day }, { lines: false })
  assert.equal(source.available, true)
  assert.equal(source.truncated, false)
  assert.equal(source.shipments.length, 2)
  assert.equal(source.shipments.reduce((total, row) => total + row.goodsNio + row.shippingNio, 0), 0)
  assert.equal(source.shipments.reduce((total, row) => total + row.units, 0), 0)
  assert.equal(source.shipments[1].eventKind, 'cancellation')
})
test('el reintegro compensatorio no deja deuda ni caja residual y no se puede anular en UI', async () => {
  const ledger = await adapter([shipment, cancellation]).getFinance({ from: day, to: day })
  assert.equal(ledger.position.cash.caja, 1000)
  assert.equal(ledger.position.payablesNio, 0)
  assert.equal(ledger.turnovers.proveedores.debitNio, 1109.85)
  assert.equal(ledger.turnovers.proveedores.creditNio, 1109.85)
  const rows = rowsOf(ledger)
  assert.equal(rows.find(row => row.id === paid.id).readOnly, true)
  const reversal = rows.find(row => row.id === refund.id)
  assert.equal(reversal.readOnly, true)
  assert.equal(reversal.type, 'Corrección de pago')
  assert.equal(reversal.amountNio, 109.85)
  assert.equal(reversal.sign, 1)
})
test('un reemplazo con abonos conservados no crea reintegros ni duplica pagos', async () => {
  const kept = { ...cancellation, refund_entries: [] }
  const replacement = { ...shipment, id: 'replacement', goods_amount: 900, goods_nio: 900, units: 9 }
  const ledger = await adapter([shipment, kept, replacement]).getFinance({ from: day, to: day })
  assert.equal(ledger.entries.filter(row => row.kind === 'supplier_payment').length, 1)
  assert.equal(ledger.position.cash.caja, 890.15)
  assert.equal(ledger.position.payablesNio, 790.15)
})

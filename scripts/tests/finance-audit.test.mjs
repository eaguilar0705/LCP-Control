import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  cacheDir: fileURLToPath(
    new URL('../../output/cache/finance-audit', import.meta.url),
  ),
  server: { middlewareMode: true, hmr: false, ws: false },
  ssr: { noExternal: ['@lcp/contracts'] },
})
after(() => server.close())
const { salesByPayment } = await server.ssrLoadModule(
  '/src/features/accounting/finance.ts',
)
const { countedTotalNio } = await server.ssrLoadModule(
  '/src/features/accounting/cashflow.ts',
)
const { dailyMetrics, dailyAccountRows, dailyMoney } =
  await server.ssrLoadModule('/src/features/accounting/dailyActivity.ts')
const { createAccountingAdapter } = await server.ssrLoadModule(
  '/src/services/adapters/accounting.ts',
)

test('an incomplete sales aggregate is rejected instead of inventing zero sales', async () => {
  const opening = {
    id: 'opening',
    request_id: 'opening',
    occurred_on: '2026-10-01',
    kind: 'opening',
    account: 'caja',
    to_account: null,
    amount: 100,
    currency: 'NIO',
    exchange_rate: 1,
    counterparty: '',
    description: '',
    reference: '',
    created_at: '2026-10-01T12:00:00Z',
    voided_at: null,
    void_reason: null,
  }
  for (const sales of [
    null,
    {},
    { caja: 10, banco: 20, cobrar: 0 },
    { caja: true, banco: 20, cobrar: 0, missing: 0 },
    { caja: ' ', banco: 20, cobrar: 0, missing: 0 },
  ]) {
    const client = {
      from(table) {
        const result = {
          data: table === 'finance_entries' ? [opening] : [],
          error: null,
          count: table === 'finance_entries' ? 1 : 0,
        }
        const query = new Proxy(
          {},
          {
            get: (_, name) =>
              name === 'then'
                ? (resolve, reject) =>
                    Promise.resolve(result).then(resolve, reject)
                : () => query,
          },
        )
        return query
      },
      rpc: async () => ({ data: sales, error: null }),
    }
    const adapter = createAccountingAdapter(
      () => client,
      (e) => new Error(e?.message ?? 'Database error'),
    )
    await assert.rejects(
      adapter.getFinance({ from: '2026-10-01', to: '2026-10-13' }),
      /ventas|importe|completo/i,
    )
  }
})

test('a payment with no known method or amount remains incomplete, never bank cash', () => {
  assert.deepEqual(
    salesByPayment([
      { paymentMethod: null, amountNio: 300 },
      { paymentMethod: 'unknown', amountNio: 200 },
      { paymentMethod: 'cash', amountNio: Number.NaN },
      { paymentMethod: 'cash', amountNio: 50 },
      { paymentMethod: 'pending', amountNio: 40 },
      { paymentMethod: 'bank_transfer', amountNio: 30 },
    ]),
    { caja: 50, cobrar: 40, banco: 30, missing: 3 },
  )
})

test('a cash count with no dollars does not multiply zero by an unused invalid rate', () => {
  assert.equal(
    countedTotalNio({
      countedNio: 125,
      countedUsd: 0,
      exchangeRate: Number.NaN,
    }),
    125,
  )
  assert.equal(
    countedTotalNio({
      countedNio: 125,
      countedUsd: 1,
      exchangeRate: Number.NaN,
    }),
    null,
  )
  assert.equal(
    countedTotalNio({ countedNio: 125, countedUsd: 2, exchangeRate: 36.5 }),
    198,
  )
})

test('daily inflows and net stay pending when sales are incomplete while known outflows remain visible', () => {
  const flow = {
    available: true,
    missingSales: 1,
    opening: { caja: 100, banco: 200 },
    closing: { caja: null, banco: 200 },
    rows: [
      {
        account: 'caja',
        category: 'sales',
        inflowNio: 50,
        outflowNio: 0,
        missingSales: 1,
      },
      {
        account: 'caja',
        category: 'expense',
        inflowNio: 0,
        outflowNio: 10,
        missingSales: 0,
      },
    ],
  }
  const report = {
    sales: {
      NIO: { current: { count: 1, revenue: 50 } },
      USD: { current: { count: 0, revenue: 0 } },
    },
  }
  const metrics = dailyMetrics(report, flow)
  assert.equal(metrics[3][1], 'Pendiente')
  assert.equal(metrics[4][1], dailyMoney(10))
  assert.equal(metrics[5][1], 'Pendiente')
  const rows = dailyAccountRows(flow)
  assert.equal(rows[0].cells[2], 'Pendiente')
  assert.equal(rows[0].cells[3], dailyMoney(10))
  assert.equal(rows[1].cells[2], dailyMoney(0))
})

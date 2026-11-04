import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  cacheDir: fileURLToPath(
    new URL('../../output/cache/shipping-accounting-tests', import.meta.url),
  ),
  server: { middlewareMode: true, hmr: false, ws: false },
  ssr: { noExternal: ['@lcp/contracts'] },
})
after(() => server.close())
const { accountingSummary, ledgerDigest } = await server.ssrLoadModule(
  '/src/features/reports/accounting.ts',
)
const { incomeStatement } = await server.ssrLoadModule(
  '/src/features/reports/statement.ts',
)
const { accountingSheets } = await server.ssrLoadModule(
  '/src/features/reports/accountingExport.ts',
)
const { digestFromSource, digestFromPayload } = await server.ssrLoadModule(
  '/src/features/reports/digest.ts',
)
const { journalModel } = await server.ssrLoadModule(
  '/src/features/accounting/journalModel.ts',
)
const { financeLedger } = await server.ssrLoadModule(
  '/src/features/accounting/finance.ts',
)
const { rowsOf } = await server.ssrLoadModule(
  '/src/features/accounting/financeRows.ts',
)

const range = { from: '2026-11-01', to: '2026-11-30' }
function source() {
  return {
    documents: [
      {
        id: 'invoice',
        kind: 'invoice',
        number: 'FAC-1',
        createdAt: '2026-11-02T18:00:00Z',
        currency: 'NIO',
        total: 1050,
        shippingAmount: 50,
        shippingNio: 50,
        tier: 'premium',
        paymentMethod: 'transfer',
        location: 'store',
        customerId: 'customer',
        customerName: 'Cliente',
        items: [
          {
            productId: 'perfume',
            description: 'Perfume',
            quantity: 1,
            lineTotal: 1000,
          },
        ],
      },
    ],
    customers: [],
    movements: [],
    inventory: [],
    truncated: false,
    accounting: {
      available: true,
      truncated: false,
      costs: [],
      shipments: [],
      movementCosts: [],
      saleCosts: [
        {
          documentId: 'invoice',
          productId: 'perfume',
          quantity: 1,
          unitCostNio: 400,
          totalCostNio: 400,
          netRevenueNio: 1000,
          taxNio: 0,
        },
      ],
      expenses: [
        {
          id: 'shipping-payment',
          requestId: 'payment',
          incurredOn: '2026-11-03',
          createdAt: '2026-11-03T18:00:00Z',
          category: 'envios',
          description: 'Pago motorizado FAC-1',
          amount: 30,
          currency: 'NIO',
          exchangeRate: 1,
          reference: 'FAC-1',
          account: 'banco',
          bankLedgerAccount: '1120-003',
          voidedAt: null,
          voidReason: null,
        },
      ],
    },
  }
}

test('shipping collected is a liability; only store-funded shipping expenses reduce income', () => {
  const input = source()
  const summary = accountingSummary(input, range)
  assert.equal(summary.revenueNio, 1000)
  assert.equal(summary.shippingNio, 50)
  assert.equal(summary.costOfSalesNio, 400)
  assert.equal(summary.grossProfitNio, 600)
  assert.equal(summary.products[0].profitNio, 600)
  assert.equal(summary.expensesNio, 30)
  assert.equal(summary.netProfitNio, 570)
  assert.equal(
    summary.expenseByAccount.find((row) => row.account === 'ventas').amountNio,
    30,
  )
  assert.equal(
    incomeStatement(summary).some((row) => row.key === 'shipping'),
    false,
  )
  const sheets = accountingSheets(input, range, 'Tienda')
  assert.equal(
    sheets[0].rows.some(([label]) => label === 'Cobros por envío'),
    false,
  )
  const months = sheets.find((sheet) => sheet.name === 'Evolución mensual')
  assert.equal(months.rows[0].length, months.columns.length)
  assert.equal(months.rows[0][2], 50)
  const digest = ledgerDigest(input, range)
  assert.equal(digest.shippingNio, 50)
  assert.equal(digest.months[0].shippingNio, 50)
  input.accounting.expenses[0].voidedAt = '2026-11-04T18:00:00Z'
  assert.equal(accountingSummary(input, range).netProfitNio, 600)
})

test('foreign shipping uses the frozen converted amount; missing conversion leaves profit pending', () => {
  const input = source()
  Object.assign(input.documents[0], {
    currency: 'USD',
    shippingAmount: 2,
    shippingNio: 73.25,
  })
  assert.equal(accountingSummary(input, range).shippingNio, 73.25)
  input.documents[0].shippingNio = null
  const incomplete = accountingSummary(input, range)
  assert.equal(incomplete.netProfitNio, null)
  assert.equal(incomplete.missingRevenueLines, 1)
  delete input.documents[0].shippingAmount
  delete input.documents[0].shippingNio
  assert.equal(accountingSummary(input, range).shippingNio, 0)
})

test('manual shipping payments join recorded expenses exactly once and respect their accounting date', () => {
  const input = source()
  input.accounting.shippingExpenses = [
    { incurredOn: '2026-11-03', amountNio: 7 },
    { incurredOn: '2026-11-04', amountNio: -2 },
    { incurredOn: '2026-10-31', amountNio: 120 },
  ]
  const summary = accountingSummary(input, range)
  assert.equal(summary.expensesNio, 35)
  assert.equal(
    summary.expenseGroups.find((row) => row.category === 'envios').amountNio,
    35,
  )
  assert.equal(summary.netProfitNio, 565)
  const digest = ledgerDigest(input, range)
  assert.equal(digest.shippingExpenseNio, 5)
  assert.equal(digest.months[0].shippingExpenseNio, 5)
  const report = digestFromSource(input, range)
  assert.equal(accountingSummary(report, range).netProfitNio, 565)
  input.documents = []
  input.accounting.saleCosts = []
  assert.equal(ledgerDigest(input, range).months[0].shippingExpenseNio, 5)
})

test('database digest preserves shipping by month and accepts older digests with zero shipping', () => {
  const generated = digestFromSource(source(), range)
  const payload = {
    version: 1,
    sales: generated.sales,
    movements: generated.movements,
    ledger: generated.ledger,
  }
  const decoded = digestFromPayload(payload, generated)
  assert.equal(accountingSummary(decoded, range).netProfitNio, 570)
  assert.equal(decoded.ledger.shippingNio, 50)
  assert.equal(decoded.ledger.months[0].shippingNio, 50)
  assert.equal(decoded.ledger.shippingExpenseNio, 0)
  delete payload.ledger.shippingNio
  delete payload.ledger.months[0].shippingNio
  delete payload.ledger.shippingExpenseNio
  delete payload.ledger.months[0].shippingExpenseNio
  const legacy = digestFromPayload(payload, generated)
  assert.equal(legacy.ledger.shippingNio, 0)
  assert.equal(legacy.ledger.months[0].shippingNio, 0)
  assert.equal(legacy.ledger.shippingExpenseNio, 0)
  assert.equal(legacy.ledger.months[0].shippingExpenseNio, 0)
})

test('carrier expense reduces its payment account and keeps the selected bank in history', () => {
  const payment = source().accounting.expenses[0]
  const ledger = financeLedger(
    {
      entries: [
        {
          id: 'opening',
          requestId: 'opening',
          kind: 'opening',
          account: 'banco',
          occurredOn: range.from,
          createdAt: `${range.from}T18:00:00Z`,
          amount: 0,
          currency: 'NIO',
          exchangeRate: 1,
          counterparty: '',
          description: '',
          reference: '',
          voidedAt: null,
          voidReason: null,
        },
      ],
      expenses: [payment],
      shipments: [],
      sales: { caja: 0, banco: 1050, cobrar: 0, missing: 0 },
    },
    range,
  )
  assert.equal(ledger.position.cash.banco, 1020)
  assert.equal(ledger.position.loansNio, 0)
  assert.equal(
    rowsOf(ledger, { '1120-003': 'LAFISE córdobas' })[0].account,
    'LAFISE córdobas',
  )
})

test('journal statements keep shipping payable outside income and preserve store shipping expense', () => {
  const account = (code, bucket, nature, debit, credit) => ({
    code,
    name: code,
    bucket,
    nature,
    postable: true,
    parent: null,
    opening: 0,
    debit,
    credit,
    closing: debit - credit,
  })
  const model = journalModel(
    {
      startOn: range.from,
      ...range,
      entries: [],
      missingCosts: 0,
      missingSales: 0,
      accounts: [
        account('1120-003', 'asset', 'debit', 1050, 30),
        account('1130', 'asset', 'debit', 0, 400),
        account('4110', 'revenue', 'credit', 0, 1000),
        account('2117', 'liability', 'credit', 0, 50),
        account('5120', 'cost', 'debit', 400, 0),
        account('5130-011', 'expense', 'debit', 30, 0),
      ],
    },
    'Tienda',
  )
  assert.equal(
    model.income.find((row) => row.description === 'Utilidad bruta').periodNio,
    600,
  )
  assert.equal(model.income.at(-1).periodNio, 570)
  assert.equal(
    model.income.some((row) => row.code === '2117'),
    false,
  )
  assert.equal(
    model.balance.right.find((row) => row.code === '2117').amount,
    50,
  )
  assert.equal(
    model.income.find((row) => row.code === '5130-011').periodNio,
    30,
  )
})

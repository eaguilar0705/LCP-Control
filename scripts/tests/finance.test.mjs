import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  cacheDir: fileURLToPath(
    new URL('../../output/cache/finance-tests', import.meta.url),
  ),
  server: { middlewareMode: true, hmr: false, ws: false },
  ssr: { noExternal: ['@lcp/contracts'] },
})
after(() => server.close())
const { financeLedger, financeTurnovers, toNio } = await server.ssrLoadModule(
  '/src/features/accounting/finance.ts',
)

const range = { from: '2026-10-03', to: '2026-10-10' }
function entry(kind, account, amount, extra = {}) {
  return {
    id: `${kind}-${account}-${amount}`,
    requestId: `${kind}-${account}-${amount}`,
    occurredOn: '2026-10-05',
    createdAt: '2026-10-05T12:00:00Z',
    kind,
    account,
    toAccount: null,
    amount,
    currency: 'NIO',
    exchangeRate: 1,
    counterparty: '',
    description: '',
    reference: '',
    voidedAt: null,
    voidReason: null,
    ...extra,
  }
}
function expense(category, account, amount, extra = {}) {
  return {
    id: `${category}-${account}-${amount}`,
    requestId: `${category}-${account}-${amount}`,
    incurredOn: '2026-10-04',
    createdAt: '2026-10-04T12:00:00Z',
    category,
    account,
    amount,
    currency: 'NIO',
    exchangeRate: 1,
    description: category,
    reference: '',
    voidedAt: null,
    voidReason: null,
    ...extra,
  }
}
function fixtures() {
  return {
    entries: [
      ...[
        ['caja', 1000],
        ['banco', 500],
        ['cobrar', 200],
        ['prestamos', 300],
        ['proveedores', 400],
      ].map(([account, amount]) =>
        entry('opening', account, amount, { occurredOn: '2026-10-01' }),
      ),
      entry('capital', 'caja', 60),
      entry('withdrawal', 'banco', 40),
      entry('transfer', 'caja', 70, { toAccount: 'banco' }),
      entry('loan', 'caja', 150),
      entry('supplier_payment', 'banco', 50),
      entry('collection', 'caja', 90),
    ],
    expenses: [
      expense('renta', 'caja', 25),
      expense('prestamo_bancario', 'banco', 35),
    ],
    shipments: [
      { incurredOn: '2026-10-04', account: 'caja', amountNio: 200 },
      { incurredOn: '2026-10-04', account: 'banco', amountNio: 120 },
      { incurredOn: '2026-10-04', account: 'credito', amountNio: 250 },
    ],
    sales: { caja: 120, banco: 80, cobrar: 100, missing: 0 },
  }
}

test('gross financial movements preserve opening capital and all payment sources', () => {
  const ledger = financeLedger(fixtures(), range)
  assert.deepEqual(ledger.turnovers, {
    caja: { debitNio: 1420, creditNio: 295 },
    banco: { debitNio: 650, creditNio: 245 },
    cobrar: { debitNio: 300, creditNio: 90 },
    prestamos: { debitNio: 35, creditNio: 450 },
    proveedores: { debitNio: 50, creditNio: 650 },
    capital: { debitNio: 740, creditNio: 1760 },
  })
  assert.deepEqual(ledger.position.cash, { caja: 1125, banco: 405 })
  assert.equal(ledger.position.receivablesNio, 210)
  assert.equal(ledger.position.loansNio, 415)
  assert.equal(ledger.position.payablesNio, 600)
  assert.equal(ledger.position.capitalNio, 1020)
  const naturalBalances = {
    ...ledger.position.cash,
    cobrar: ledger.position.receivablesNio,
    prestamos: ledger.position.loansNio,
    proveedores: ledger.position.payablesNio,
    capital: ledger.position.capitalNio,
  }
  for (const [account, amount] of Object.entries(naturalBalances)) {
    const { debitNio, creditNio } = ledger.turnovers[account]
    const debitNature = ['caja', 'banco', 'cobrar'].includes(account)
    assert.equal(
      debitNature ? debitNio - creditNio : creditNio - debitNio,
      amount,
    )
  }
})

test('voided and out-of-cut records do not change cumulative movements', () => {
  const rows = fixtures()
  const expected = financeLedger(fixtures(), range)
  rows.entries.push(
    entry('opening', 'caja', 999, {
      occurredOn: '2026-09-01',
      voidedAt: '2026-09-02T12:00:00Z',
    }),
    entry('capital', 'caja', 999, { occurredOn: '2026-09-30' }),
    entry('loan', 'caja', 999, { occurredOn: '2026-10-11' }),
    entry('collection', 'caja', 999, {
      voidedAt: '2026-10-05T13:00:00Z',
    }),
  )
  rows.expenses.push(
    expense('renta', 'caja', 999, { voidedAt: '2026-10-04T13:00:00Z' }),
    expense('renta', 'caja', 999, { incurredOn: '2026-09-30' }),
    expense('prestamo_bancario', 'banco', 999, { incurredOn: '2026-10-11' }),
  )
  rows.shipments.push(
    { incurredOn: '2026-09-30', account: 'caja', amountNio: 999 },
    { incurredOn: '2026-10-11', account: 'credito', amountNio: 999 },
  )
  const ledger = financeLedger(rows, range)
  assert.deepEqual(ledger.turnovers, expected.turnovers)
  assert.deepEqual(ledger.position, expected.position)
  assert.equal(ledger.position.startOn, '2026-10-01')
  assert.equal(
    ledger.entries.some((row) => row.kind === 'opening'),
    false,
  )
  assert(ledger.entries.some((row) => row.voidedAt))
  assert(ledger.expenses.some((row) => row.voidedAt))
})

test('two cuts retain gross period movements and lack of opening stays unavailable', () => {
  const current = financeLedger(fixtures(), range)
  const opening = financeLedger(
    {
      ...fixtures(),
      sales: { caja: 50, banco: 40, cobrar: 20, missing: 0 },
    },
    { from: '2026-09-01', to: '2026-10-02' },
  )
  assert.deepEqual(opening.turnovers.capital, {
    debitNio: 700,
    creditNio: 1700,
  })
  const period = Object.fromEntries(
    Object.entries(current.turnovers).map(([account, ending]) => [
      account,
      {
        debitNio: ending.debitNio - opening.turnovers[account].debitNio,
        creditNio: ending.creditNio - opening.turnovers[account].creditNio,
      },
    ]),
  )
  assert.deepEqual(period, {
    caja: { debitNio: 370, creditNio: 295 },
    banco: { debitNio: 110, creditNio: 245 },
    cobrar: { debitNio: 80, creditNio: 90 },
    prestamos: { debitNio: 35, creditNio: 150 },
    proveedores: { debitNio: 50, creditNio: 250 },
    capital: { debitNio: 40, creditNio: 60 },
  })
  const noOpening = financeLedger({ ...fixtures(), entries: [] }, range)
  assert.equal(noOpening.position.started, false)
  assert.equal(noOpening.turnovers, undefined)
  assert.equal(
    financeTurnovers({ available: false, startOn: '2026-10-01' }),
    undefined,
  )
})

test('USD movements use each saved rate and round before composing account balances', () => {
  const ledger = financeLedger(
    {
      entries: [
        entry('opening', 'caja', 100, {
          occurredOn: '2026-10-01',
          currency: 'USD',
          exchangeRate: 36.5,
        }),
        entry('capital', 'caja', 10, { currency: 'USD', exchangeRate: 36.25 }),
        entry('withdrawal', 'caja', 0.105, {
          currency: 'USD',
          exchangeRate: 3,
        }),
      ],
      expenses: [
        expense('renta', 'caja', 0.1, { currency: 'USD', exchangeRate: 2.005 }),
      ],
      shipments: [
        { incurredOn: '2026-10-04', account: 'caja', amountNio: 0.02 },
      ],
      sales: { caja: 0.01, banco: 0, cobrar: 0, missing: 0 },
    },
    range,
  )
  assert.equal(toNio({ amount: 1.005, exchangeRate: 2 }), 2.01)
  assert.deepEqual(ledger.turnovers.caja, {
    debitNio: 4012.51,
    creditNio: 0.54,
  })
  assert.deepEqual(ledger.turnovers.capital, {
    debitNio: 0.32,
    creditNio: 4012.5,
  })
  assert.equal(ledger.position.cash.caja, 4011.97)
  assert.equal(ledger.position.capitalNio, 4012.18)
  const { debitNio, creditNio } = ledger.turnovers.caja
  assert.equal(
    Math.round((debitNio - creditNio) * 100) / 100,
    ledger.position.cash.caja,
  )
})

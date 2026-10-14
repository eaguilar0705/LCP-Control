import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as jsxDevRuntime from 'react/jsx-dev-runtime'
import * as lucide from 'lucide-react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const { createElement } = React
// Keep the hook dispatcher shared with the native react-dom/server renderer.
const bridgeKey = '__lcpAccountingAuditLibraries'
globalThis[bridgeKey] = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  'react/jsx-dev-runtime': jsxDevRuntime,
  'lucide-react': lucide,
}
const server = await createServer({
  configFile: false,
  logLevel: 'error',
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  cacheDir: fileURLToPath(
    new URL('../../output/cache/accounting-audit-tests', import.meta.url),
  ),
  esbuild: { jsx: 'automatic' },
  plugins: [
    {
      name: 'native-react-in-render-tests',
      enforce: 'pre',
      resolveId(id) {
        if (Object.hasOwn(globalThis[bridgeKey], id))
          return `\0audit-library:${id}`
      },
      load(id) {
        if (!id.startsWith('\0audit-library:')) return
        const name = id.slice('\0audit-library:'.length)
        return Object.keys(globalThis[bridgeKey][name])
          .filter((key) => key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key))
          .map(
            (key) =>
              `export const ${key} = globalThis[${JSON.stringify(bridgeKey)}][${JSON.stringify(name)}][${JSON.stringify(key)}];`,
          )
          .join('\n')
      },
    },
  ],
  server: { middlewareMode: true, hmr: false, ws: false },
  ssr: {
    noExternal: ['@lcp/contracts'],
  },
})
after(async () => {
  await server.close()
  delete globalThis[bridgeKey]
})
const { buildAccountingModel } = await server.ssrLoadModule(
  '/src/features/accounting/accountingModel.ts',
)
const { accountingWorkbookSheets } = await server.ssrLoadModule(
  '/src/features/accounting/accountingWorkbook.ts',
)
const { AccountingTables } = await server.ssrLoadModule(
  '/src/features/accounting/AccountingTables.tsx',
)
const { balanceSheet } = await server.ssrLoadModule(
  '/src/features/accounting/balanceSheet.ts',
)
const { financialRatios } = await server.ssrLoadModule(
  '/src/features/accounting/ratios.ts',
)
const { accountingSummary } = await server.ssrLoadModule(
  '/src/features/reports/accounting.ts',
)
const { localDay } = await server.ssrLoadModule(
  '/src/features/reports/model.ts',
)
const { formatCurrency } = await server.ssrLoadModule('/src/lib/format.ts')
const range = { from: '2026-10-01', to: '2026-10-13' }
const accounts = ['caja', 'banco', 'cobrar', 'prestamos', 'proveedores']

function report(part = range) {
  return {
    range: { ...part },
    sales: {},
    inventory: [
      { product: { id: 'perfume' }, quantities: { store: 2, warehouse: 3 } },
    ],
    truncated: false,
    accounting: {
      available: true,
      truncated: false,
      costs: [{ productId: 'perfume', averageCostNio: 100 }],
      shipments: [],
      expenses: [],
      saleCosts: [],
      movementCosts: [],
    },
    ledger: {
      revenueNio: 1000,
      salesTaxNio: 0,
      costOfSalesNio: 400,
      missingCostUnits: 0,
      missingRevenueLines: 0,
      soldUnits: 4,
      inventoryWriteOffNio: 0,
      missingWriteOffUnits: 0,
      products: [],
      tiers: [],
      months: [],
    },
  }
}
const position = () => ({
  started: true,
  startOn: range.from,
  openedAccounts: [...accounts],
  cash: { caja: 500, banco: 300 },
  receivablesNio: 100,
  loansNio: 50,
  payablesNio: 100,
  capitalNio: 750,
  missingSales: 0,
})
const ledger = () => ({
  available: true,
  position: position(),
  entries: [],
  expenses: [],
  turnovers: Object.fromEntries(
    [...accounts, 'capital'].map((account) => [
      account,
      { debitNio: 0, creditNio: 0 },
    ]),
  ),
})
const model = () =>
  buildAccountingModel({
    report: report(),
    cumulativeReport: report(),
    openingReport: null,
    ledger: ledger(),
    openingLedger: null,
    accumulatedFrom: range.from,
    businessName: 'Negocio de prueba',
  })

test('an expense reversal increases income on screen and in the workbook', () => {
  const data = model()
  data.income = [
    {
      code: '5130-reversal',
      description: 'Reversión de gasto',
      kind: 'line',
      periodNio: -50,
      accumulatedNio: -50,
      negative: true,
    },
    {
      code: '5130-expense',
      description: 'Gasto normal',
      kind: 'line',
      periodNio: 25,
      accumulatedNio: 25,
      negative: true,
    },
  ]
  const html = renderToStaticMarkup(
    createElement(AccountingTables, {
      view: 'income',
      model: data,
      ledger: ledger(),
      onChanged() {},
      readOnly: true,
    }),
  )
  const reversal = html.match(/<tr[^>]*>[^]*?5130-reversal[^]*?<\/tr>/)[0]
  assert.ok(reversal.includes(formatCurrency(50, 'NIO')))
  assert.ok(!reversal.includes(`(${formatCurrency(50, 'NIO')})`))
  assert.ok(!reversal.includes(formatCurrency(-50, 'NIO')))
  assert.ok(html.includes(`(${formatCurrency(25, 'NIO')})`))
  assert.ok(!html.includes('Pendiente indica información insuficiente'))
  const income = accountingWorkbookSheets(data)[2]
  assert.equal(income.rows[0][2], 50)
  assert.equal(income.rows[1][2], -25)
})

test('pending values and real zero remain distinct in screen and workbook', () => {
  const data = model()
  data.income = [
    {
      code: '0',
      description: 'Cero conocido',
      kind: 'line',
      periodNio: 0,
      accumulatedNio: 0,
    },
    {
      code: '?',
      description: 'Dato faltante',
      kind: 'line',
      periodNio: null,
      accumulatedNio: null,
    },
  ]
  const html = renderToStaticMarkup(
    createElement(AccountingTables, {
      view: 'income',
      model: data,
      ledger: ledger(),
      onChanged() {},
      readOnly: true,
    }),
  )
  assert.ok(html.includes(formatCurrency(0, 'NIO')))
  assert.ok(html.includes('Pendiente'))
  assert.ok(html.includes('Pendiente indica información insuficiente'))
  const rows = accountingWorkbookSheets(data)[2].rows
  assert.equal(rows[0][2], 0)
  assert.equal(rows[1][2], 'Pendiente')
})

test('an unknown expense outside the period cannot invalidate that period', () => {
  const period = report()
  period.accounting.expenses.push({
    id: 'legacy',
    incurredOn: '2026-09-30',
    category: 'legacy_category',
    amount: 7,
    exchangeRate: 1,
    voidedAt: null,
  })
  const cumulative = report({ from: '2026-01-01', to: range.to })
  cumulative.accounting.expenses = [...period.accounting.expenses]
  const data = buildAccountingModel({
    report: period,
    cumulativeReport: cumulative,
    openingReport: null,
    ledger: ledger(),
    openingLedger: null,
    accumulatedFrom: '2026-01-01',
    businessName: 'Negocio de prueba',
  })
  assert.equal(data.income.find((r) => r.code === '5130').periodNio, 0)
  assert.equal(data.income.at(-1).periodNio, 600)
  assert.equal(data.income.at(-1).accumulatedNio, null)
})

test('unknown expenses with missing or invalid dates remain pending', () => {
  for (const incurredOn of [undefined, '', 'bad-date', '2026-02-31']) {
    const source = report()
    source.accounting.expenses.push({
      id: 'legacy',
      incurredOn,
      category: 'legacy_category',
      amount: 7,
      exchangeRate: 1,
      voidedAt: null,
    })
    const data = buildAccountingModel({
      report: source,
      cumulativeReport: source,
      openingReport: null,
      ledger: ledger(),
      openingLedger: null,
      accumulatedFrom: range.from,
      businessName: 'Negocio de prueba',
    })
    assert.equal(data.income.at(-1).periodNio, null)
  }
})

test('provisional financial ratios cannot manufacture equity from assets minus debts', () => {
  const today = localDay(new Date())
  const summary = accountingSummary(report(), range)
  const groups = financialRatios(summary, position(), {
    from: today,
    to: today,
  })
  const ratios = groups.flatMap((group) => group.ratios)
  assert.equal(ratios.find((r) => r.key === 'leverage').value, null)
  assert.equal(ratios.find((r) => r.key === 'roe').value, null)
  assert.equal(ratios.find((r) => r.key === 'current').value, 1400 / 150)
})

test('unreconciled sales taxes invalidate the provisional liability total and ratios', () => {
  const source = report()
  source.ledger.salesTaxNio = 150
  const summary = accountingSummary(source, range)
  const rows = balanceSheet(summary, position())
  assert.equal(rows.find((r) => r.key === 'liabilitiesTotal').amount, null)
  assert.equal(rows.find((r) => r.key === 'salesTax').amount, null)
  const today = localDay(new Date())
  const ratios = financialRatios(summary, position(), {
    from: today,
    to: today,
  }).flatMap((group) => group.ratios)
  for (const key of ['current', 'quick', 'cash', 'workingCapital', 'debtRatio'])
    assert.equal(ratios.find((r) => r.key === key).value, null, key)
})

test('ratios cannot treat missing invoice revenue as complete sales', () => {
  const source = report()
  source.ledger.missingRevenueLines = 1
  const summary = accountingSummary(source, range)
  const today = localDay(new Date())
  const ratios = financialRatios(summary, position(), {
    from: today,
    to: today,
  }).flatMap((group) => group.ratios)
  for (const key of [
    'grossMargin',
    'netMargin',
    'expenseShare',
    'collectionDays',
  ])
    assert.equal(ratios.find((r) => r.key === key).value, null, key)
})

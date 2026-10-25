import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

// Load the real TypeScript modules with the same resolver used by the app.
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  cacheDir: fileURLToPath(
    new URL('../../output/cache/accounting-tests', import.meta.url),
  ),
  server: { middlewareMode: true, hmr: false, ws: false },
  ssr: { noExternal: ['@lcp/contracts'] },
})
after(() => server.close())
const { buildAccountingModel, accountingViews } = await server.ssrLoadModule(
  '/src/features/accounting/accountingModel.ts',
)
const { accountingWorkbookSheets } = await server.ssrLoadModule(
  '/src/features/accounting/accountingWorkbook.ts',
)
const { buildWorkbook } = await server.ssrLoadModule('/src/lib/xlsx.ts')
const { localDay } = await server.ssrLoadModule(
  '/src/features/reports/model.ts',
)
const { accountingSummary, inventoryTurnover } = await server.ssrLoadModule(
  '/src/features/reports/accounting.ts',
)

const range = { from: '2026-10-01', to: '2026-10-31' }
const accounts = ['caja', 'banco', 'cobrar', 'prestamos', 'proveedores']

test('el valor y la rotación usan centavos reconocidos; una lectura de cantidades obsoleta no inventa valorización', () => {
  const source = report()
  source.inventory[0].quantities = { store: 3, warehouse: 0 }
  source.accounting.costs[0] = {
    productId: 'perfume',
    averageCostNio: 1033.333333,
    updatedAt: range.to,
    inventoryValueNio: 3100.01,
    inventoryQuantity: 3,
  }
  let summary = accountingSummary(source, range)
  assert.equal(summary.inventoryCostNio, 3100.01)
  assert.equal(summary.unvaluedProducts, 0)
  source.inventory[0].quantities.store = 2
  summary = accountingSummary(source, range)
  assert.equal(summary.unvaluedProducts, 1)
  assert.equal(inventoryTurnover(summary, range).turnoverPerYear, null)
})
const emptySales = () => ({
  current: { revenue: 0, count: 0, units: 0, customers: 0 },
  previous: { revenue: 0, count: 0, units: 0, customers: 0 },
  proformas: 0,
  converted: 0,
  days: [],
  weekdays: [],
  payments: [],
  tiers: [],
  products: [],
  newCustomers: 0,
  returning: 0,
  topCustomers: [],
  lapsed: [],
  visits: [],
})
function report(part = range) {
  return {
    range: { ...part },
    sales: { NIO: emptySales(), USD: emptySales() },
    movements: { damagedByProduct: [] },
    computedIn: 'browser',
    truncated: false,
    inventory: [
      { product: { id: 'perfume' }, quantities: { store: 2, warehouse: 3 } },
    ],
    accounting: {
      available: true,
      truncated: false,
      costs: [
        { productId: 'perfume', averageCostNio: 100, updatedAt: range.to },
      ],
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
      inventoryWriteOffNio: 20,
      missingWriteOffUnits: 0,
      products: [],
      tiers: [],
      months: [],
      belowCost: { count: 0, lossNio: 0, rows: [] },
    },
  }
}
function expense(category, amount, voidedAt = null) {
  return {
    id: category,
    requestId: category,
    createdAt: `${range.to}T12:00:00Z`,
    incurredOn: range.to,
    category,
    description: category,
    amount,
    currency: 'NIO',
    exchangeRate: 1,
    reference: '',
    account: 'caja',
    voidedAt,
    voidReason: null,
  }
}
const turnovers = (amount) =>
  Object.fromEntries(
    [...accounts, 'capital'].map((account) => [
      account,
      { debitNio: amount, creditNio: amount / 2 },
    ]),
  )
function fixtures() {
  const period = report()
  period.accounting.expenses = [
    expense('renta', 70),
    expense('interes_bancario', 10),
    expense('impuestos_dgi', 5),
    expense('prestamo_bancario', 40),
    expense('mobiliario', 15),
  ]
  const cumulative = report({ from: '2026-01-01', to: range.to })
  Object.assign(cumulative.ledger, {
    revenueNio: 4000,
    costOfSalesNio: 1600,
    inventoryWriteOffNio: 80,
  })
  cumulative.accounting.expenses = period.accounting.expenses.map((row) => ({
    ...row,
  }))
  const opening = report({ from: '2026-01-01', to: '2026-09-30' })
  Object.assign(opening.ledger, {
    revenueNio: 3000,
    costOfSalesNio: 1200,
    inventoryWriteOffNio: 60,
  })
  const openingLedger = {
    available: true,
    entries: [],
    expenses: [],
    turnovers: turnovers(100),
    position: {
      started: true,
      startOn: '2025-01-01',
      openedAccounts: [...accounts],
      cash: { caja: 100, banco: 200 },
      receivablesNio: 50,
      loansNio: 20,
      payablesNio: 30,
      capitalNio: 300,
      missingSales: 0,
    },
  }
  const ledger = {
    ...openingLedger,
    turnovers: turnovers(200),
    position: {
      ...openingLedger.position,
      openedAccounts: [...accounts],
      cash: { caja: 800, banco: 400 },
      capitalNio: 350,
    },
  }
  return {
    report: period,
    cumulativeReport: cumulative,
    openingReport: opening,
    ledger,
    openingLedger,
    accumulatedFrom: '2026-01-01',
    businessName: 'La Casa del Perfume',
  }
}
const trial = (model, code) => model.trial.find((row) => row.code === code)
const income = (model, code) => model.income.find((row) => row.code === code)
const gross = (model) =>
  model.income.find((row) => row.description === 'Utilidad bruta')
const balanceResult = (model) =>
  model.balance.right.find(
    (row) => row.description === 'Resultado acumulado registrado',
  )

test('the four views use actual natural balances and gross period movements', () => {
  const model = buildAccountingModel(fixtures())
  assert.deepEqual(Object.keys(accountingViews), [
    'catalog',
    'trial',
    'income',
    'balance',
  ])
  assert.deepEqual(trial(model, '1110'), {
    code: '1110',
    description: 'Caja de la perfumería',
    openingNio: 100,
    debitNio: 100,
    creditNio: 50,
    closingNio: 800,
  })
  assert.equal(trial(model, '2113').openingNio, 20)
  assert.equal(trial(model, '2113').closingNio, 20)
  assert.equal(trial(model, '4110').openingNio, 3000)
  assert.equal(trial(model, '4110').creditNio, 1000)
  assert.equal(trial(model, '4110').closingNio, 4000)
  assert.equal(trial(model, '1130').openingNio, null)
  assert.equal(model.trialTotals.openingNio, null)
  assert.equal(model.trialTotals.closingNio, null)
  assert.equal(model.balance.right.at(-1).amount, null)
})

test('income preserves loan and furniture semantics; balance uses accumulated result', () => {
  const model = buildAccountingModel(fixtures())
  assert.equal(income(model, '5130').periodNio, 85)
  assert.equal(income(model, '5140').periodNio, 10)
  assert.equal(income(model, '6000').periodNio, 5)
  assert.equal(gross(model).periodNio, 600)
  assert.equal(model.income.at(-1).periodNio, 480)
  assert.equal(model.income.at(-1).accumulatedNio, 2220)
  assert.equal(balanceResult(model).amount, 2220)
  assert.deepEqual(model.warningsByView.income, [])
})

test('historical and unvalued inventory remain pending', () => {
  const args = fixtures()
  args.report.range.to = '2020-01-31'
  const historical = buildAccountingModel(args)
  assert.equal(trial(historical, '1130').closingNio, null)
  const today = localDay(new Date())
  args.report.range = { from: `${today.slice(0, 7)}-01`, to: today }
  args.cumulativeReport.range.to = today
  const current = buildAccountingModel(args)
  assert.equal(trial(current, '1130').closingNio, 500)
  assert(
    !current.warningsByView.balance.some(
      (warning) =>
        warning.includes('inventario inicial') ||
        warning.includes('inventario histórico'),
    ),
  )
  args.cumulativeReport.accounting.costs = []
  const unvalued = buildAccountingModel(args)
  assert.equal(trial(unvalued, '1130').closingNio, null)
  assert(
    unvalued.warningsByView.balance.some((warning) =>
      warning.includes('sin costo promedio'),
    ),
  )
})

test('partial queries and missing snapshots never produce a known gross or net result', () => {
  const args = fixtures()
  args.report.truncated = true
  let model = buildAccountingModel(args)
  assert.equal(gross(model).periodNio, null)
  assert.equal(model.income.at(-1).periodNio, null)
  assert(
    model.warningsByView.income.some((warning) =>
      warning.includes('parciales'),
    ),
  )
  args.report.truncated = false
  args.report.ledger.missingCostUnits = 1
  model = buildAccountingModel(args)
  assert.equal(trial(model, '5120').debitNio, null)
  assert.equal(gross(model).periodNio, null)
  assert.equal(model.income.at(-1).periodNio, null)
  args.report.ledger.missingCostUnits = 0
  args.cumulativeReport.ledger = null
  model = buildAccountingModel(args)
  assert.equal(gross(model).accumulatedNio, null)
  assert.equal(balanceResult(model).amount, null)
})

test('missing financial sales and missing openings affect financial views only', () => {
  const args = fixtures()
  args.ledger.position.missingSales = 1
  let model = buildAccountingModel(args)
  assert.equal(trial(model, '1110').closingNio, null)
  assert.equal(trial(model, '1110').debitNio, null)
  assert.deepEqual(model.warningsByView.income, [])
  args.ledger.position.missingSales = 0
  args.ledger.position.openedAccounts = ['caja']
  model = buildAccountingModel(args)
  assert.equal(trial(model, '1120').closingNio, null)
  assert.equal(trial(model, '3110').closingNio, null)
  assert.deepEqual(model.warningsByView.income, [])
})

test('opening before the first finance entry means unknown balance, zero turnover start', () => {
  const args = fixtures()
  args.ledger.position.startOn = range.from
  Object.assign(args.openingLedger.position, { started: false, startOn: null })
  args.openingLedger.turnovers = undefined
  const model = buildAccountingModel(args)
  assert.equal(trial(model, '1110').openingNio, null)
  assert.equal(trial(model, '1110').debitNio, 200)
  assert.equal(trial(model, '1110').creditNio, 100)
})

test('financial opening mid-period cannot claim comparable full-period movement totals', () => {
  const args = fixtures()
  args.ledger.position.startOn = '2026-10-15'
  Object.assign(args.openingLedger.position, { started: false, startOn: null })
  const model = buildAccountingModel(args)
  assert.equal(trial(model, '1110').debitNio, 200)
  assert.equal(model.trialTotals.debitNio, null)
  assert.equal(model.trialTotals.creditNio, null)
  assert(
    model.warningsByView.trial.some((warning) =>
      warning.includes('2026-10-15'),
    ),
  )
  assert.deepEqual(model.warningsByView.income, [])
})

test('unknown active expenses make affected expense balances and net result pending', () => {
  const args = fixtures()
  args.report.accounting.expenses.push(expense('legacy_category', 7))
  args.cumulativeReport.accounting.expenses.push(expense('legacy_category', 7))
  args.openingReport.accounting.expenses.push({
    ...expense('legacy_category', 7),
    incurredOn: args.openingReport.range.to,
  })
  const model = buildAccountingModel(args)
  for (const code of ['5130', '5140', '6000']) {
    assert.equal(income(model, code).periodNio, null)
    assert.equal(income(model, code).accumulatedNio, null)
    assert.equal(trial(model, code).openingNio, null)
    assert.equal(trial(model, code).closingNio, null)
  }
  assert.equal(gross(model).periodNio, 600)
  assert.equal(model.income.at(-1).periodNio, null)
  assert.equal(model.income.at(-1).accumulatedNio, null)
  assert.equal(balanceResult(model).amount, null)
  assert.equal(model.trialTotals.debitNio, null)
  assert(
    model.warningsByView.income.some((warning) =>
      warning.includes('categorías desconocidas'),
    ),
  )
})

test('voided unknown expenses do not invalidate known results', () => {
  const args = fixtures()
  args.report.accounting.expenses.push(expense('legacy_category', 7, range.to))
  const model = buildAccountingModel(args)
  assert.equal(model.income.at(-1).periodNio, 480)
  assert.deepEqual(model.warningsByView.income, [])
})

test('saved sales taxes remain separate from revenue and their liability stays pending', () => {
  const args = fixtures()
  args.report.ledger.salesTaxNio = 150
  const model = buildAccountingModel(args)
  assert(model.catalog.some((row) => row.code === '2116'))
  assert.equal(trial(model, '2116').creditNio, 150)
  assert.equal(trial(model, '2116').closingNio, null)
  assert.equal(income(model, '4110').periodNio, 1000)
  assert.equal(
    model.balance.right.find((row) => row.description === 'Total pasivo')
      .amount,
    null,
  )
})

test('export contains exactly the four views with pending values and relevant warnings', () => {
  const model = buildAccountingModel(fixtures())
  const sheets = accountingWorkbookSheets(model)
  assert.equal(sheets.length, 4)
  assert.deepEqual(
    sheets.map((sheet) => sheet.name),
    Object.values(accountingViews),
  )
  assert.deepEqual(
    sheets[0].columns.map((column) => column.header),
    ['Código', 'Descripción'],
  )
  assert.deepEqual(
    sheets[1].columns.map((column) => column.header),
    ['Cuenta', 'Descripción', 'Saldo inicial', 'Debe', 'Haber', 'Saldo final'],
  )
  assert.equal(sheets[3].columns.length, 7)
  assert.equal(sheets[1].rows.at(-1)[2], 'Pendiente')
  assert.equal(sheets[1].rows.at(-1)[5], 'Pendiente')
  assert.equal(sheets[2].rows.find((row) => row[0] === '5120')[2], -400)
  assert.equal(sheets[2].rows.at(-1)[2], 480)
  assert.equal(sheets[2].rows.at(-1)[3], 2220)
  assert(
    !sheets[2].notes.some(
      (note) =>
        note.includes('patrimonio inicial') ||
        note.includes('inventario histórico'),
    ),
  )
  assert(sheets[3].notes.some((note) => note.includes('por conciliar')))
})

test('the generated Excel package keeps four sheets and typed monetary values', async () => {
  const sheets = accountingWorkbookSheets(buildAccountingModel(fixtures()))
  const blob = buildWorkbook(sheets)
  const bytes = Buffer.from(await blob.arrayBuffer())
  const files = new Map()
  // Read the ZIP container independently of the workbook model.
  for (let offset = 0; bytes.readUInt32LE(offset) === 0x04034b50;) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0)
    const size = bytes.readUInt32LE(offset + 18)
    const nameLength = bytes.readUInt16LE(offset + 26)
    const extraLength = bytes.readUInt16LE(offset + 28)
    const start = offset + 30 + nameLength + extraLength
    const name = bytes
      .subarray(offset + 30, offset + 30 + nameLength)
      .toString('utf8')
    files.set(name, bytes.subarray(start, start + size).toString('utf8'))
    offset = start + size
  }
  assert.equal(
    [...files.keys()].filter((name) => name.startsWith('xl/worksheets/'))
      .length,
    4,
  )
  const workbook = files.get('xl/workbook.xml')
  for (const name of Object.values(accountingViews))
    assert(workbook.includes(`name="${name}"`))
  assert.match(
    files.get('xl/worksheets/sheet3.xml'),
    /<c[^>]*><v>-400<\/v><\/c>/,
  )
  assert.match(
    files.get('xl/worksheets/sheet3.xml'),
    /<c[^>]*><v>480<\/v><\/c>/,
  )
  assert.match(
    files.get('xl/worksheets/sheet2.xml'),
    /t="inlineStr"><is><t[^>]*>Pendiente<\/t>/,
  )
})

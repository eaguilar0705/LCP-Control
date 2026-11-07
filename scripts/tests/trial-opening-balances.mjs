import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
  warehouse,
  viewer,
  outsider,
} from './database-fixture.mjs'

// PostgreSQL desechable: no consulta ni modifica la base del negocio.
const db = await database({
  beforeMigration: process.env.LCP_TEST_BEFORE_MIGRATION,
})
const server = await createServer({
  configFile: false,
  logLevel: 'error',
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  cacheDir: fileURLToPath(
    new URL('../../output/cache/trial-opening-balances', import.meta.url),
  ),
  server: { middlewareMode: true, hmr: false, ws: false },
  ssr: { noExternal: ['@lcp/contracts'] },
})
const { journalModel } = await server.ssrLoadModule(
  '/src/features/accounting/journalModel.ts',
)
const { accountingWorkbookSheets } = await server.ssrLoadModule(
  '/src/features/accounting/accountingWorkbook.ts',
)
const day = '2026-11-03'
let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const call = (name, input) =>
  rpc(db, name, { requestId: crypto.randomUUID(), ...input })
const ledger = async (from = '2026-11-01', to = '2026-11-07') =>
  (await one('select public.ledger_report($1,$2) r', [from, to])).r
const amounts = (report, code) => {
  const a = report.accounts.find((row) => row.code === code)
  return [a.opening, a.debit, a.credit, a.closing]
}
const openingLines = (cash = 1000) => [
  { account: '1110-001', debit: cash, credit: 0 },
  { account: '1130', debit: 500, credit: 0 },
  { account: '2111', debit: 0, credit: 200 },
  { account: '3110-001', debit: 0, credit: cash + 300 },
]
const voucher = (kind, lines) => ({
  kind,
  occurredOn: day,
  description: 'Regresión de apertura separada',
  reference: 'QA-APERTURA',
  currency: 'NIO',
  exchangeRate: 1,
  lines,
})
const reconciles = (report) => {
  for (const a of report.accounts.filter((row) => row.postable))
    eq(
      Math.round((a.opening + a.debit - a.credit) * 100),
      Math.round(a.closing * 100),
      `${a.code}: inicial + Debe - Haber conserva el saldo final firmado`,
    )
  const total = report.accounts
    .filter((a) => a.postable)
    .reduce(
      (sum, a) => [
        sum[0] + a.opening,
        sum[1] + a.debit,
        sum[2] + a.credit,
        sum[3] + a.closing,
      ],
      [0, 0, 0, 0],
    )
  eq(total[0], 0, 'los saldos iniciales firmados cuadran')
  eq(total[1], total[2], 'los movimientos brutos cuadran sin la apertura')
  eq(total[3], 0, 'los saldos finales firmados cuadran')
}
const presentation = (
  report,
  cash,
  periodProfit,
  accumulatedProfit = periodProfit,
) => {
  const model = journalModel(report, 'Prueba de apertura')
  const trial = model.trial.find((a) => a.code === '1110-001')
  eq(
    [trial.openingNio, trial.debitNio, trial.creditNio, trial.closingNio],
    cash,
    'la pantalla conserva apertura y movimientos separados',
  )
  const supplier = model.trial.find((a) => a.code === '2111')
  eq(
    [
      supplier.openingNio,
      supplier.debitNio,
      supplier.creditNio,
      supplier.closingNio,
    ],
    [200, 0, 0, 200],
    'la pantalla presenta los saldos acreedores según su naturaleza',
  )
  eq(model.trialTotals.openingNio, 0)
  eq(model.trialTotals.closingNio, 0)
  eq(model.trialTotals.debitNio, model.trialTotals.creditNio)
  eq(
    model.income.at(-1).periodNio,
    periodProfit,
    'la apertura no se vuelve ingreso del período',
  )
  eq(model.income.at(-1).accumulatedNio, accumulatedProfit)
  eq(
    model.balance.left.at(-1).amount,
    model.balance.right.at(-1).amount,
    'el estado de situación financiera conserva la conciliación',
  )
  const sheets = accountingWorkbookSheets(model)
  eq(
    sheets[1].rows.find((row) => row[0] === '1110-001').slice(2),
    cash,
    'Excel usa las mismas cuatro columnas que pantalla',
  )
  eq(sheets[1].rows.find((row) => row[0] === '2111').slice(2), [200, 0, 0, 200])
  eq(sheets[2].rows.at(-1).slice(2), [periodProfit, accumulatedProfit])
}

try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select '2026-11-03T15:00:00Z'::timestamptz$$",
  )
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Administrador','admin'),($2,'Caja','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer'),($5,'Propietario','superadmin')",
    [admin, operator, warehouse, viewer, outsider],
  )
  await identity(db, admin)
  const opening = await call(
    'record_journal_entry',
    voucher('opening', openingLines()),
  )
  const initial = await ledger()
  eq(
    amounts(initial, '1110-001'),
    [1000, 0, 0, 1000],
    'la apertura dentro del rango pertenece a Saldo inicial y no a Debe',
  )
  eq(amounts(initial, '1130'), [500, 0, 0, 500])
  eq(amounts(initial, '2111'), [-200, 0, 0, -200])
  eq(amounts(initial, '3110-001'), [-1300, 0, 0, -1300])
  reconciles(initial)
  presentation(initial, [1000, 0, 0, 1000], 0)
  await call('open_business_day', {
    expectedDay: day,
    openingNio: 1000,
    openingUsd: 0,
  })
  await call(
    'record_journal_entry',
    voucher('income', [
      { account: '1110-001', debit: 200, credit: 0 },
      { account: '4190', debit: 0, credit: 200 },
    ]),
  )
  const expense = await call(
    'record_journal_entry',
    voucher('expense', [
      { account: '5130-002', debit: 30, credit: 0 },
      { account: '1110-001', debit: 0, credit: 30 },
    ]),
  )
  await call('record_finance_entry', {
    kind: 'capital',
    amount: 50,
    occurredOn: day,
    account: 'caja',
    currency: 'NIO',
    exchangeRate: 1,
    description: 'Aporte operativo de la fecha de apertura',
  })
  for (const from of ['2026-11-01', day]) {
    const report = await ledger(from)
    eq(amounts(report, '1110-001'), [1000, 250, 30, 1220])
    eq(amounts(report, '3110-001'), [-1300, 0, 50, -1350])
    eq(amounts(report, '4190'), [0, 0, 200, -200])
    eq(amounts(report, '5130-002'), [0, 30, 0, 30])
    eq(report.startOn, day)
    eq(report.missingCosts, 0)
    eq(report.missingSales, 0)
    eq(report.purchaseAccounting, {
      pendingCount: 0,
      pendingTotalNio: 0,
      unpostedDifferenceNio: 0,
    })
    eq(
      report.accounts.find((a) => a.code === '1110-001').displayCode,
      '1110-001',
    )
    eq(
      report.entries.filter((e) => e.kind === 'opening').length,
      1,
      'la apertura sigue consultable como comprobante',
    )
    reconciles(report)
    presentation(report, [1000, 250, 30, 1220], 170)
  }
  const later = await ledger('2026-11-04')
  eq(
    amounts(later, '1110-001'),
    [1220, 0, 0, 1220],
    'períodos posteriores arrastran apertura y movimientos anteriores',
  )
  eq(amounts(later, '3110-001'), [-1350, 0, 0, -1350])
  reconciles(later)
  presentation(later, [1220, 0, 0, 1220], 0, 170)
  const before = await ledger('2026-11-01', '2026-11-02')
  eq(
    amounts(before, '1110-001'),
    [0, 0, 0, 0],
    'un corte anterior no anticipa la apertura',
  )
  eq(before.entries.length, 0)
  await call('correct_opening_journal', {
    entryId: opening,
    expectedRevision: 0,
    description: 'Apertura corregida',
    reference: 'QA-APERTURA',
    lines: openingLines(1200),
  })
  const corrected = await ledger()
  eq(
    amounts(corrected, '1110-001'),
    [1200, 250, 30, 1420],
    'corregir la apertura actualiza inicial sin crear movimiento',
  )
  eq(amounts(corrected, '3110-001'), [-1500, 0, 50, -1550])
  eq(
    (await one('select public.get_journal_entry($1) r', [opening])).r
      .openingHistory.length,
    1,
  )
  reconciles(corrected)
  presentation(corrected, [1200, 250, 30, 1420], 170)
  await identity(db, outsider)
  await db.query('select public.void_journal_entry($1,$2)', [
    expense,
    'Gasto duplicado de prueba',
  ])
  const voided = await ledger()
  eq(
    amounts(voided, '1110-001'),
    [1200, 250, 0, 1450],
    'la anulación retira solo el movimiento',
  )
  eq(amounts(voided, '5130-002'), [0, 0, 0, 0])
  reconciles(voided)
  presentation(voided, [1200, 250, 0, 1450], 200)
  for (const id of [operator, warehouse, viewer]) {
    await identity(db, id)
    await assert.rejects(() => ledger(), /permission|insufficient/i)
    checks++
  }
  await identity(db, '', 'anon')
  await assert.rejects(() => ledger(), /permission|insufficient/i)
  checks++
  console.log(
    `PASS saldos iniciales separados: ${checks} verificaciones, apertura dentro del rango, movimientos de la misma fecha, arrastre, corrección, anulación y permisos`,
  )
} finally {
  await server.close()
  await db.close()
}

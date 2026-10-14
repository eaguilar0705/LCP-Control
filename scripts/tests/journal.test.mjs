import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  cacheDir: fileURLToPath(
    new URL('../../output/cache/journal-tests', import.meta.url),
  ),
  server: { middlewareMode: true, hmr: false, ws: false },
  ssr: { noExternal: ['@lcp/contracts'] },
})
after(() => server.close())
const { journalModel, cardSettlement } = await server.ssrLoadModule(
  '/src/features/accounting/journalModel.ts',
)
const { accountingWorkbookSheets } = await server.ssrLoadModule(
  '/src/features/accounting/accountingWorkbook.ts',
)
const account = (code, bucket, nature, opening, debit, credit) => ({
  code,
  name: code,
  bucket,
  nature,
  postable: true,
  parent: null,
  opening,
  debit,
  credit,
  closing: opening + debit - credit,
})
const fixture = () => ({
  startOn: '2026-10-01',
  from: '2026-10-02',
  to: '2026-10-11',
  missingCosts: 0,
  missingSales: 0,
  entries: [],
  accounts: [
    account('1110-001', 'asset', 'debit', 100, 1000, 200),
    account('1130', 'asset', 'debit', 5000, 0, 600),
    account('1340', 'asset', 'debit', 0, 15, 0),
    account('1120-001', 'asset', 'debit', 0, 940, 0),
    account('1142', 'asset', 'debit', 0, 1000, 1000),
    account('3110-001', 'equity', 'credit', -5100, 0, 0),
    account('4110', 'revenue', 'credit', 0, 0, 2000),
    account('5120', 'cost', 'debit', 0, 600, 0),
    account('5130-002', 'expense', 'debit', 0, 200, 0),
    account('5140-001', 'expense', 'debit', 0, 45, 0),
  ],
})
test('trial balance and balance sheet reconcile with real equity, cash, card commission and creditable withholding', () => {
  const m = journalModel(fixture(), 'Tienda')
  assert.deepEqual(m.warnings, [])
  assert.equal(m.trialTotals.closingNio, 0)
  assert.equal(m.trialTotals.debitNio, m.trialTotals.creditNio)
  assert.equal(m.income.at(-1).periodNio, 1155)
  assert.equal(
    m.income.find((r) => r.description === 'Utilidad bruta').periodNio,
    1400,
  )
  assert.equal(m.balance.left.at(-1).amount, 6255)
  assert.equal(m.balance.right.at(-1).amount, 6255)
})
test('missing opening or historical cost never presents an invented balanced statement', () => {
  for (const change of [
    { startOn: null },
    { missingCosts: 1 },
    { missingSales: 1 },
  ]) {
    const m = journalModel({ ...fixture(), ...change }, 'Tienda')
    assert.equal(m.balance.right.at(-1).amount, null)
    assert.equal(m.income.at(-1).periodNio, null)
    assert.ok(m.warnings.length)
  }
})

test('two missing costs preserve known balances, sales and expenses without inventing inventory or profit', () => {
  const f = {
    ...fixture(),
    startOn: '2026-10-13',
    from: '2026-10-01',
    to: '2026-10-13',
  }
  f.accounts.push(
    account('4190', 'revenue', 'credit', 0, 0, 25),
    account('5150', 'expense', 'debit', 0, 25, 0),
    account('2111', 'liability', 'credit', -100, 0, 0),
    account('1140', 'asset', 'debit', 100, 0, 0),
    account('1120-003', 'asset', 'debit', 0, 0, 0),
  )
  const complete = journalModel(f, 'Tienda')
  const m = journalModel({ ...f, missingCosts: 2 }, 'Tienda')
  const affected = new Set(['1130', '5120', '4190', '5150'])
  for (const row of m.trial) {
    if (affected.has(row.code)) {
      for (const column of [
        'openingNio',
        'debitNio',
        'creditNio',
        'closingNio',
      ])
        assert.equal(row[column], null, `${row.code}: ${column}`)
    } else {
      assert.deepEqual(
        row,
        complete.trial.find((r) => r.code === row.code),
      )
    }
  }
  for (const row of m.income.filter((r) => r.kind === 'line')) {
    if (affected.has(row.code)) {
      assert.equal(row.periodNio, null)
      assert.equal(row.accumulatedNio, null)
    } else {
      assert.deepEqual(
        row,
        complete.income.find((r) => r.code === row.code),
      )
    }
  }
  for (const side of ['left', 'right']) {
    for (const row of m.balance[side].filter(
      (r) => r.code && r.kind === 'line',
    )) {
      if (affected.has(row.code)) assert.equal(row.amount, null)
      else
        assert.deepEqual(
          row,
          complete.balance[side].find((r) => r.code === row.code),
        )
    }
  }
  assert.equal(m.income.find((r) => r.code === '4110').periodNio, 2000)
  assert.equal(
    m.balance.right.find((r) => r.description === 'Total pasivo').amount,
    100,
  )
  assert.equal(m.trial.find((r) => r.code === '1120-003').closingNio, 0)
  assert.ok(Object.values(m.trialTotals).every((v) => v === null))
  assert.equal(m.balance.left.at(-1).amount, null)
  assert.equal(m.balance.right.at(-1).amount, null)
  assert.equal(
    m.income.find((r) => r.description === 'Utilidad bruta').periodNio,
    null,
  )
  assert.equal(m.income.at(-1).periodNio, null)
  assert.equal(m.income.at(-1).accumulatedNio, null)
  assert.ok(m.warnings.includes('2 movimientos sin costo histórico.'))
  assert.ok(
    m.warnings.some((w) => w.includes('Se muestran los importes conocidos.')),
  )

  const sheets = accountingWorkbookSheets(m)
  assert.equal(sheets[1].rows.find((r) => r[0] === '1110-001')[5], 900)
  assert.equal(sheets[1].rows.find((r) => r[0] === '1130')[5], 'Pendiente')
  assert.equal(sheets[1].rows.at(-1)[5], 'Pendiente')
  assert.equal(sheets[2].rows.find((r) => r[0] === '4110')[2], 2000)
  assert.equal(sheets[2].rows.find((r) => r[0] === '5120')[2], 'Pendiente')
  assert.equal(sheets[2].rows.at(-1)[2], 'Pendiente')
  assert.equal(sheets[3].rows.find((r) => r[0] === '1110-001')[2], 900)
  assert.equal(sheets[3].rows.find((r) => r[0] === '1130')[2], 'Pendiente')
})

test('missing opening, future opening or incomplete sales still block all amounts even with missing costs', () => {
  for (const change of [
    { startOn: null },
    { startOn: '2026-10-12' },
    { missingSales: 1 },
  ]) {
    const m = journalModel(
      { ...fixture(), missingCosts: 2, ...change },
      'Tienda',
    )
    assert.ok(
      m.trial.every((r) =>
        [r.openingNio, r.debitNio, r.creditNio, r.closingNio].every(
          (v) => v === null,
        ),
      ),
    )
    assert.ok(
      m.income.every((r) => r.periodNio === null && r.accumulatedNio === null),
    )
    assert.ok(m.balance.left.every((r) => r.amount === null))
    assert.ok(m.balance.right.every((r) => r.amount === null))
  }
})

test('a monthly period starting before the opening still shows the recorded balances and results', () => {
  const f = {
    ...fixture(),
    startOn: '2026-10-13',
    from: '2026-10-01',
    to: '2026-10-13',
  }
  const m = journalModel(f, 'Tienda')
  assert.deepEqual(m.warnings, ['El libro contable comienza el 2026-10-13.'])
  assert.ok(m.trial.every((r) => r.debitNio !== null && r.creditNio !== null))
  assert.equal(m.trialTotals.debitNio, m.trialTotals.creditNio)
  assert.equal(m.income.at(-1).periodNio, 1155)
  assert.equal(m.balance.left.at(-1).amount, 6255)
  assert.equal(m.balance.right.at(-1).amount, 6255)
})

test('a period ending before the opening does not invent known balances', () => {
  const m = journalModel(
    { ...fixture(), startOn: '2026-10-13', to: '2026-10-12' },
    'Tienda',
  )
  assert.deepEqual(m.warnings, [
    'El período termina antes de la apertura del 2026-10-13.',
  ])
  assert.equal(m.trialTotals.debitNio, null)
  assert.equal(m.income.at(-1).periodNio, null)
  assert.equal(m.balance.right.at(-1).amount, null)
})
test('contra assets and losses reduce the appropriate balance instead of plugging equity', () => {
  const f = fixture()
  f.accounts.push(
    account('1290', 'asset', 'credit', 0, 0, 1600),
    account('5130-011', 'expense', 'debit', 0, 1600, 0),
  )
  const m = journalModel(f, 'Tienda')
  assert.equal(m.income.at(-1).periodNio, -445)
  assert.equal(m.balance.left.at(-1).amount, m.balance.right.at(-1).amount)
})
test('card settlement rates are inputs; withholding is separate from the fee', () => {
  assert.deepEqual(cardSettlement(1000, 4.5, 1.5), {
    commission: 45,
    withholding: 15,
    net: 940,
  })
  assert.deepEqual(cardSettlement(1000, 0, 0), {
    commission: 0,
    withholding: 0,
    net: 1000,
  })
  assert.throws(() => cardSettlement(1000, 90, 20))
  assert.throws(() => cardSettlement(0, 4.5, 1.5))
  assert.deepEqual(cardSettlement(1000, 90, 20, 'net_commission'), {
    commission: 900,
    withholding: 20,
    net: 80,
  })
  assert.throws(() => cardSettlement(1000, 0, 101, 'net_commission'))
})

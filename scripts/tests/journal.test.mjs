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

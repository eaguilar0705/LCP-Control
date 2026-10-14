import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  cacheDir: fileURLToPath(
    new URL('../../output/cache/journal-audit', import.meta.url),
  ),
  server: { middlewareMode: true, hmr: false, ws: false },
  ssr: { noExternal: ['@lcp/contracts'] },
})
after(() => server.close())
const journal = await server.ssrLoadModule(
  '/src/features/accounting/journalModel.ts',
)
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

test('gross trading profit excludes other income while net profit includes it', () => {
  const model = journal.journalModel(
    {
      startOn: '2026-10-01',
      from: '2026-10-01',
      to: '2026-10-13',
      missingSales: 0,
      missingCosts: 0,
      entries: [],
      accounts: [
        account('4110', 'revenue', 'credit', 0, 1000),
        account('4190', 'revenue', 'credit', 0, 100),
        account('5120', 'cost', 'debit', 600, 0),
        account('1110-001', 'asset', 'debit', 500, 0),
      ],
    },
    'Tienda',
  )
  const gross = model.income.find((r) => r.description === 'Utilidad bruta')
  assert.equal(gross.periodNio, 400)
  assert.equal(gross.accumulatedNio, 400)
  assert.equal(model.income.at(-1).periodNio, 500)
})

test('card settlement rejects a rounded zero gross or an unknown withholding base', () => {
  assert.throws(() => journal.cardSettlement(0.001, 0, 0))
  assert.throws(() => journal.cardSettlement(100, 0, 0, 'unknown'))
})

test('a voucher must balance after individual USD conversions, not only in original currency', () => {
  const totals = journal.journalTotals(
    [
      { account: '1110-002', debit: 0.01, credit: 0 },
      { account: '1120-002', debit: 0.01, credit: 0 },
      { account: '4110', debit: 0, credit: 0.02 },
    ],
    36.5,
  )
  assert.equal(totals.debit, totals.credit)
  assert.equal(totals.debitNio, 0.74)
  assert.equal(totals.creditNio, 0.73)
  assert.equal(totals.valid, false)
  assert.equal(
    journal.journalTotals(
      [
        { account: '1110-002', debit: 10, credit: 0 },
        { account: '4110', debit: 0, credit: 10 },
      ],
      36.5,
    ).valid,
    true,
  )
})

test('negative opposite-side entries and fractional cents cannot create a valid voucher', () => {
  for (const lines of [
    [
      { account: '1110-001', debit: 10, credit: -2 },
      { account: '4110', debit: -2, credit: 10 },
    ],
    [
      { account: '1110-001', debit: 0.001, credit: 0 },
      { account: '4110', debit: 0, credit: 0.001 },
    ],
    [
      { account: '1110-001', debit: Number.POSITIVE_INFINITY, credit: 0 },
      { account: '4110', debit: 0, credit: Number.POSITIVE_INFINITY },
    ],
  ])
    assert.equal(journal.journalTotals(lines).valid, false)
})

test('standard cash and bank accounts only accept their declared currency', () => {
  for (const code of ['1110-001', '1120-001', '1120-003', '1120-005']) {
    assert.equal(journal.accountAcceptsCurrency(code, 'NIO'), true)
    assert.equal(journal.accountAcceptsCurrency(code, 'USD'), false)
  }
  for (const code of ['1110-002', '1120-002', '1120-004', '1120-006']) {
    assert.equal(journal.accountAcceptsCurrency(code, 'USD'), true)
    assert.equal(journal.accountAcceptsCurrency(code, 'NIO'), false)
  }
  assert.equal(journal.accountAcceptsCurrency('4110', 'USD'), true)
})

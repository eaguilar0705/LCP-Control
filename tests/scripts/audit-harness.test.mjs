import assert from 'node:assert/strict'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { postgrestRows } from '../audit/harness.mjs'

test('the audit API returns SQL dates without shifting the business day or changing timestamps', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const result = await db.query(`select date '2026-10-03' as occurred_on,
    timestamptz '2026-10-03T15:30:00Z' as created_at, null::date as valid_until`)
  const [row] = JSON.parse(JSON.stringify(postgrestRows(result)))
  assert.equal(row.occurred_on, '2026-10-03')
  assert.equal(row.created_at, '2026-10-03T15:30:00.000Z')
  assert.equal(row.valid_until, null)
  assert.ok(
    row.occurred_on <= '2026-10-03',
    'a transaction on the cutoff day must remain in its ledger',
  )
  const dateLabel = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Managua',
  }).format(new Date(`${row.occurred_on}T12:00:00Z`))
  assert.equal(dateLabel, '2026-10-03')
})

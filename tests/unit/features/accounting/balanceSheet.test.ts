import { expect, it } from 'vitest'
import { catalogAdapter } from '@/services/adapters/catalog'
import { digestFromSource } from '@/features/reports/digest'
import { accountingSummary } from '@/features/reports/accounting'
import { localDay, presetRange } from '@/features/reports/model'
import { balanceSheet } from '@/features/accounting/balanceSheet'

const range = presetRange('30d', localDay(new Date()))
const report = digestFromSource(
  await catalogAdapter.getReportSource(range),
  range,
)

it('cuadra activos con pasivo y patrimonio', () => {
  const summary = accountingSummary(report, range)
  const rows = new Map(balanceSheet(summary).map((row) => [row.key, row]))
  expect(rows.get('inventory')?.amount).toBe(summary.inventoryCostNio)
  expect(rows.get('assetsTotal')?.amount).toBe(rows.get('total')?.amount)
  // Lo que el sistema no registra sale sin importe, nunca como cero.
  for (const key of ['cash', 'receivables', 'loans', 'payables'])
    expect(rows.get(key)?.amount).toBeNull()
})

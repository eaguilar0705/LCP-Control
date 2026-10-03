import { expect, it } from 'vitest'
import { catalogAdapter } from '@/services/adapters/catalog'
import { digestFromSource } from '@/features/reports/digest'
import { accountingSummary } from '@/features/reports/accounting'
import { localDay, presetRange } from '@/features/reports/model'
import { balanceSheet } from '@/features/accounting/balanceSheet'
import { emptyPosition } from '@/features/accounting/finance'

const range = presetRange('30d', localDay(new Date()))
const report = digestFromSource(
  await catalogAdapter.getReportSource(range),
  range,
)
const summary = accountingSummary(report, range)
const keyed = (rows: ReturnType<typeof balanceSheet>) =>
  new Map(rows.map((row) => [row.key, row]))

it('sin saldo inicial, caja y deudas salen sin importe y el balance cuadra', () => {
  const rows = keyed(balanceSheet(summary, emptyPosition))
  expect(rows.get('inventory')?.amount).toBe(summary.inventoryCostNio)
  expect(rows.get('assetsTotal')?.amount).toBe(rows.get('total')?.amount)
  // Lo que todavía no se registra sale sin importe, nunca como cero.
  for (const key of ['cash', 'bank', 'receivables', 'loans', 'payables'])
    expect(rows.get(key)?.amount).toBeNull()
})

it('con saldos registrados suma caja, bancos y deudas y sigue cuadrando', async () => {
  const ledger = await catalogAdapter.getFinance(range)
  const { position } = ledger
  expect(position.started).toBe(true)
  const rows = keyed(balanceSheet(summary, position))
  expect(rows.get('cash')?.amount).toBe(position.cash.caja)
  expect(rows.get('bank')?.amount).toBe(position.cash.banco)
  expect(rows.get('loans')?.amount).toBe(position.loansNio)
  expect(rows.get('capital')?.amount).toBe(position.capitalNio)
  expect(rows.get('assetsTotal')?.amount).toBe(rows.get('total')?.amount)
})

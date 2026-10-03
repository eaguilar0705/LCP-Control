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

it('sin saldo inicial los totales incompletos quedan pendientes', () => {
  const rows = keyed(balanceSheet(summary, emptyPosition))
  expect(rows.get('inventory')?.amount).toBe(summary.inventoryCostNio)
  expect(rows.get('assetsTotal')?.amount).toBeNull()
  expect(rows.get('total')?.amount).toBeNull()
  // Lo que todavía no se registra sale sin importe, nunca como cero.
  for (const key of ['cash', 'bank', 'receivables', 'loans', 'payables'])
    expect(rows.get(key)?.amount).toBeNull()
})

it('con saldos registrados suma activos y conserva el patrimonio pendiente de conciliar', async () => {
  const ledger = await catalogAdapter.getFinance(range)
  const { position } = ledger
  expect(position.started).toBe(true)
  const rows = keyed(balanceSheet(summary, position))
  expect(rows.get('cash')?.amount).toBe(position.cash.caja)
  expect(rows.get('bank')?.amount).toBe(position.cash.banco)
  expect(rows.get('loans')?.amount).toBe(position.loansNio)
  expect(rows.get('capital')?.amount).toBe(position.capitalNio)
  expect(rows.get('assetsTotal')?.amount).toBeCloseTo(
    summary.inventoryCostNio +
      position.cash.caja +
      position.cash.banco +
      position.receivablesNio,
    2,
  )
  expect(rows.get('earlier')?.amount).toBeNull()
  expect(rows.get('total')?.amount).toBeNull()
})

it('no usa el inventario actual para aparentar un balance histórico completo', async () => {
  const { position } = await catalogAdapter.getFinance(range)
  const rows = keyed(balanceSheet(summary, position, '2020-01-01'))
  expect(rows.get('inventory')?.amount).toBeNull()
  expect(rows.get('assetsTotal')?.amount).toBeNull()
})

it('no trata las ventas sin importe ni los perfumes sin costo como ceros', async () => {
  const { position } = await catalogAdapter.getFinance(range)
  const rows = keyed(
    balanceSheet(
      { ...summary, unvaluedProducts: 2 },
      { ...position, missingSales: 1 },
    ),
  )
  for (const key of [
    'cash',
    'bank',
    'receivables',
    'inventory',
    'assetsTotal',
    'liabilitiesTotal',
  ])
    expect(rows.get(key)?.amount).toBeNull()
})

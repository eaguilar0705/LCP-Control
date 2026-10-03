import { expect, it } from 'vitest'
import { financialRatios } from '@/features/accounting/ratios'
import {
  emptyPosition,
  type FinancePosition,
} from '@/features/accounting/finance'
import type { accountingSummary } from '@/features/reports/accounting'

type Summary = ReturnType<typeof accountingSummary>
const summary = {
  revenueNio: 10000,
  costOfSalesNio: 6000,
  grossProfitNio: 4000,
  expensesNio: 1000,
  netProfitNio: 3000,
  inventoryCostNio: 20000,
  unvaluedProducts: 0,
  missingCostUnits: 0,
  purchasesNio: 3000,
} as Summary
const range = { from: '2026-09-01', to: '2026-09-30' }
const position: FinancePosition = {
  started: true,
  startOn: '2026-09-01',
  cash: { caja: 5000, banco: 15000 },
  receivablesNio: 5000,
  loansNio: 15000,
  payablesNio: 5000,
  capitalNio: 10000,
  missingSales: 0,
}
const value = (groups: ReturnType<typeof financialRatios>, key: string) =>
  groups.flatMap((group) => group.ratios).find((ratio) => ratio.key === key)!
    .value

it('calcula liquidez, deuda, rentabilidad y actividad', () => {
  const groups = financialRatios(summary, position, range)
  // Activo corriente 45 000; pasivo 20 000; patrimonio 25 000.
  expect(value(groups, 'current')).toBeCloseTo(2.25)
  expect(value(groups, 'quick')).toBeCloseTo(1.25)
  expect(value(groups, 'cash')).toBeCloseTo(1)
  expect(value(groups, 'workingCapital')).toBe(25000)
  expect(value(groups, 'debtRatio')).toBeCloseTo(20000 / 45000)
  expect(value(groups, 'leverage')).toBeCloseTo(0.8)
  expect(value(groups, 'grossMargin')).toBeCloseTo(0.4)
  expect(value(groups, 'netMargin')).toBeCloseTo(0.3)
  expect(value(groups, 'roe')).toBeCloseTo(0.12)
  // 5 000 por cobrar sobre ventas de 10 000 en 30 días.
  expect(value(groups, 'collectionDays')).toBeCloseTo(15)
  expect(value(groups, 'paymentDays')).toBeCloseTo(50)
})

it('sin saldo inicial deja en blanco lo que depende del balance', () => {
  const groups = financialRatios(summary, emptyPosition, range)
  expect(value(groups, 'current')).toBeNull()
  expect(value(groups, 'roe')).toBeNull()
  expect(value(groups, 'grossMargin')).toBeCloseTo(0.4)
})

import { describe, expect, it } from 'vitest'
import { catalogAdapter } from '@/services/adapters/catalog'
import {
  digestFromPayload,
  digestFromSource,
  reportView,
} from '@/features/reports/digest'
import {
  accountingByMonth,
  accountingSummary,
  belowCostSales,
  belowCostSummary,
  emptyAccounting,
} from '@/features/reports/accounting'
import {
  concentration,
  customerActivity,
  idleStock,
  inRange,
  lapsedCustomers,
  localDay,
  movementSummary,
  movementsInRange,
  paymentBreakdown,
  presetRange,
  previousRange,
  proformaConversion,
  purchaseFrequency,
  revenueByDay,
  salesByWeekday,
  shrinkage,
  stockCoverage,
  summary,
  tierBreakdown,
  topProducts,
} from '@/features/reports/model'

const range = presetRange('90d', localDay(new Date()))
const source = await catalogAdapter.getReportSource(range)
const report = digestFromSource(source, range)
const view = reportView(report)
const current = inRange(source.documents, range)
const previous = inRange(source.documents, previousRange(range))
const cents = (value: number) => Math.round(value * 100) / 100

describe('el resumen responde lo mismo que la lista de facturas', () => {
  it('hay datos que comparar', () => {
    expect(view.currencies.length).toBeGreaterThan(0)
    expect(current.length).toBeGreaterThan(20)
  })

  it.each(['NIO', 'USD'] as const)('ventas en %s', (currency) => {
    const round = <T extends { revenue: number }>(rows: T[]) =>
      rows.map((row) => ({ ...row, revenue: cents(row.revenue) }))
    const totals = summary(current, currency)
    const revenue = cents(totals.revenue)
    expect(view.summary(currency)).toEqual({
      ...totals,
      revenue,
      average: totals.count ? revenue / totals.count : 0,
    })
    expect(view.previousSummary(currency).revenue).toBe(cents(summary(previous, currency).revenue))
    expect(round(view.revenueByDay(currency))).toEqual(round(revenueByDay(current, currency, range)))
    expect(view.topProducts(currency, 1000)).toEqual(round(topProducts(current, currency, 1000)))
    expect(view.productShare(currency)).toBeCloseTo(
      concentration(topProducts(current, currency, 1000).map((row) => row.revenue), 10) ?? NaN,
    )
    const shares = (rows: { value: number }[]) => rows.map((row) => ({ ...row, value: cents(row.value) }))
    expect(view.paymentBreakdown(currency)).toEqual(shares(paymentBreakdown(current, currency)))
    expect(view.tierBreakdown(currency)).toEqual(shares(tierBreakdown(current, currency)))
    const activity = customerActivity(current, source.customers, currency, range)
    expect(view.customerActivity(currency)).toEqual({ ...activity, top: round(activity.top) })
    expect(view.lapsedCustomers(currency)).toEqual(
      lapsedCustomers(source.documents, range, currency).map((row) => ({
        ...row,
        previousRevenue: cents(row.previousRevenue),
      })),
    )
    expect(view.purchaseFrequency(currency, range.to, 6)).toEqual(
      purchaseFrequency(source.documents, currency, range.to, 6),
    )
    expect(round(view.salesByWeekday(currency))).toEqual(round(salesByWeekday(current, currency)))
    expect(view.proformaConversion(currency)).toEqual(proformaConversion(current, currency))
  })

  it('inventario, reposición y mermas', () => {
    const first = view.first
    const inPeriod = movementsInRange(source.movements, range)
    expect(view.movementSummary()).toEqual(movementSummary(inPeriod))
    expect(view.stockCoverage(first, 50)).toEqual(stockCoverage(current, source.inventory, range, first, 50))
    expect(view.idleStock('vip', first, 50)).toEqual(idleStock(current, source.inventory, 'vip', first, 50))
    expect(view.shrinkage('vip', first, 50)).toEqual(shrinkage(inPeriod, source.inventory, 'vip', first, 50))
  })

  it('contabilidad: el mismo estado de resultados, por mes y bajo costo', () => {
    const fromRows = accountingSummary(source, range)
    const fromDigest = accountingSummary(report, range)
    expect(fromDigest.revenueNio).toBeCloseTo(fromRows.revenueNio, 2)
    expect(fromDigest.costOfSalesNio).toBeCloseTo(fromRows.costOfSalesNio, 2)
    expect(fromDigest.netProfitNio).toBe(fromRows.netProfitNio)
    expect(fromDigest.missingCostUnits).toBe(fromRows.missingCostUnits)
    expect(fromDigest.missingWriteOffUnits).toBe(fromRows.missingWriteOffUnits)
    expect(fromDigest.expenseByAccount).toEqual(fromRows.expenseByAccount)
    expect(fromDigest.products.map((row) => row.productId).sort()).toEqual(
      fromRows.products.map((row) => row.productId).sort(),
    )
    expect(accountingByMonth(report, range).map((row) => [row.month, row.totals.netProfitNio, row.totals.expensesNio])).toEqual(
      accountingByMonth(source, range).map((row) => [row.month, row.totals.netProfitNio, row.totals.expensesNio]),
    )
    expect(belowCostSummary(report, range).count).toBe(belowCostSales(source, range).length)
  })

  it('pide un periodo que el resumen no cubre y lo dice en vez de inventar ceros', () => {
    expect(() => accountingSummary(report, { from: '2020-01-01', to: '2020-12-31' })).toThrow(/no cubre/)
  })
})

describe('lectura del resumen que manda la base', () => {
  const payload = () =>
    JSON.parse(
      JSON.stringify({ version: 1, sales: report.sales, movements: report.movements, ledger: report.ledger }),
    )
  const rest = { range, inventory: source.inventory, accounting: source.accounting!, truncated: false }

  it('reconstruye el mismo resumen', () => {
    const parsed = digestFromPayload(payload(), rest)
    expect(parsed.computedIn).toBe('database')
    expect(parsed.sales).toEqual(report.sales)
    expect(parsed.ledger).toEqual(report.ledger)
  })

  it('una cifra faltante o de otra versión detiene el reporte', () => {
    const missing = payload()
    delete missing.sales.NIO.current.revenue
    expect(() => digestFromPayload(missing, rest)).toThrow(/incompleto/)
    const text = payload()
    text.sales.USD.days = [{ day: '2026-09-01', revenue: '10', count: 1 }]
    expect(() => digestFromPayload(text, rest)).toThrow(/incompleto/)
    expect(() => digestFromPayload({ ...payload(), version: 2 }, rest)).toThrow(/incompleto/)
    expect(() => digestFromPayload(null, rest)).toThrow(/incompleto/)
  })

  it('sin permiso contable no usa el libro aunque venga', () => {
    const parsed = digestFromPayload(payload(), { ...rest, accounting: structuredClone(emptyAccounting) })
    expect(parsed.ledger).toBeNull()
  })
})

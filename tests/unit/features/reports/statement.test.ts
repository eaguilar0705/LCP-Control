import { expect, it } from 'vitest'
import { accountingSummary } from '../../../../src/features/reports/accounting'
import type { ReportData } from '../../../../src/features/reports/digest'
import {
  closeOf,
  dailyClose,
  dailyTotals,
  incomeStatement,
  shareOfRevenue,
} from '../../../../src/features/reports/statement'

const range = { from: '2026-09-01', to: '2026-09-30' }
const sales = (days: { day: string; revenue: number; count: number }[]) =>
  ({ days }) as ReportData['sales']['NIO']
const expense = (
  id: string,
  incurredOn: string,
  category: string,
  amount: number,
  extra: object = {},
) => ({
  id,
  requestId: id,
  incurredOn,
  category,
  description: id,
  amount,
  currency: 'NIO',
  exchangeRate: 1,
  reference: '',
  createdAt: `${incurredOn}T15:00:00Z`,
  voidedAt: null,
  voidReason: null,
  ...extra,
})
const report = {
  range,
  sales: {
    NIO: sales([
      { day: '2026-09-10', revenue: 1500, count: 2 },
      { day: '2026-09-12', revenue: 800, count: 1 },
      // Fuera del período pedido: no entra en el cierre.
      { day: '2026-08-31', revenue: 999, count: 1 },
    ]),
    USD: sales([{ day: '2026-09-10', revenue: 40, count: 1 }]),
  },
  ledger: {
    revenueNio: 2000,
    salesTaxNio: 300,
    costOfSalesNio: 1200,
    missingCostUnits: 0,
    missingRevenueLines: 0,
    soldUnits: 4,
    inventoryWriteOffNio: 50,
    missingWriteOffUnits: 0,
    products: [],
    tiers: [],
    months: [],
    belowCost: { count: 0, lossNio: 0, rows: [] },
  },
  accounting: {
    available: true,
    truncated: false,
    costs: [],
    saleCosts: [],
    shipments: [
      {
        id: 's1',
        incurredOn: '2026-09-12',
        currency: 'USD',
        exchangeRate: 36.5,
        goodsAmount: 100,
        shippingAmount: 10,
        units: 5,
      },
    ],
    expenses: [
      expense('renta', '2026-09-10', 'renta', 300),
      expense('dgi', '2026-09-10', 'impuestos_dgi', 10, {
        currency: 'USD',
        exchangeRate: 36.5,
      }),
      expense('cuota', '2026-09-12', 'prestamo_bancario', 500),
      expense('anulado', '2026-09-12', 'renta', 900, {
        voidedAt: '2026-09-13T00:00:00Z',
      }),
    ],
  },
  inventory: [],
  truncated: false,
} as unknown as ReportData

it('orders the period result as an income statement', () => {
  const rows = incomeStatement(accountingSummary(report, range))
  const amount = (key: string) => rows.find((row) => row.key === key)!.amount
  expect(rows.map((row) => row.key)).toEqual([
    'revenue',
    'cost',
    'gross',
    'operating',
    'impuestos',
    'financieros',
    'ventas',
    'writeOff',
    'operatingTotal',
    'net',
    'memo',
    'loans',
    'purchases',
    'tax',
  ])
  expect(amount('gross')).toBe(800)
  expect(amount('ventas')).toBe(300)
  expect(amount('impuestos')).toBe(365)
  // 665 de gastos más 50 de mermas; la cuota del préstamo no resta.
  expect(amount('operatingTotal')).toBe(715)
  expect(amount('net')).toBe(85)
  expect(amount('loans')).toBe(500)
  expect(amount('purchases')).toBe(4015)
  expect(shareOfRevenue(amount('gross'), 2000)).toBe(0.4)
  expect(shareOfRevenue(null, 2000)).toBeNull()
  expect(shareOfRevenue(10, 0)).toBeNull()
})

it('closes each day with its sales, purchases and expenses', () => {
  const rows = dailyClose(report, range)
  expect(rows).toEqual([
    {
      day: '2026-09-12',
      sales: { NIO: 800, USD: 0 },
      invoices: 1,
      purchasesNio: 4015,
      expensesNio: 500,
    },
    {
      day: '2026-09-10',
      sales: { NIO: 1500, USD: 40 },
      invoices: 3,
      purchasesNio: 0,
      expensesNio: 665,
    },
  ])
  expect(dailyTotals(rows)).toEqual({
    sales: { NIO: 2300, USD: 40 },
    invoices: 4,
    purchasesNio: 4015,
    expensesNio: 1165,
  })
  expect(closeOf(rows, '2026-09-11')).toEqual({
    day: '2026-09-11',
    sales: { NIO: 0, USD: 0 },
    invoices: 0,
    purchasesNio: 0,
    expensesNio: 0,
  })
})

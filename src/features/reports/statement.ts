import type { Currency } from '../../lib/domain'
import {
  expenseAccounts,
  expenseCategories,
  expensesInRange,
  roundMoney,
  shipmentsInRange,
  type accountingSummary,
} from './accounting'
import type { ReportData } from './digest'
import { compareText, type ReportRange } from './model'

type AccountingSummary = ReturnType<typeof accountingSummary>

/**
 * El resultado del período en el orden de un estado de resultados: ventas,
 * costo, utilidad bruta, gastos y utilidad neta. No calcula nada nuevo: ordena
 * las cifras de `accountingSummary`, así que la pantalla y las exportaciones
 * no pueden dar totales distintos.
 */
export interface StatementRow {
  key: string
  label: string
  /** `null`: la cifra depende de información que todavía falta. */
  amount: number | null
  /** `heading` no lleva importe; `info` se informa y no entra en el resultado. */
  kind: 'heading' | 'line' | 'subtotal' | 'total' | 'info'
  /** Los renglones que restan se muestran entre paréntesis. */
  negative?: boolean
}
export function incomeStatement(summary: AccountingSummary): StatementRow[] {
  const deducting = summary.expenseByAccount.filter((row) => row.deducts)
  const operating = roundMoney(
    summary.expensesNio + summary.inventoryWriteOffNio,
  )
  return [
    { key: 'revenue', label: 'Ventas netas', amount: summary.revenueNio, kind: 'line' },
    { key: 'cost', label: 'Costo de ventas', amount: summary.costOfSalesNio, kind: 'line', negative: true },
    { key: 'gross', label: 'Utilidad bruta', amount: summary.grossProfitNio, kind: 'subtotal' },
    { key: 'operating', label: 'Gastos de operación', amount: null, kind: 'heading' },
    ...deducting.map((row) => ({
      key: row.account,
      label: expenseAccounts[row.account].label,
      amount: row.amountNio,
      kind: 'line' as const,
      negative: true,
    })),
    { key: 'writeOff', label: 'Mermas y otras salidas', amount: summary.inventoryWriteOffNio, kind: 'line', negative: true },
    { key: 'operatingTotal', label: 'Total gastos de operación', amount: operating, kind: 'subtotal', negative: true },
    { key: 'net', label: 'Utilidad neta', amount: summary.netProfitNio, kind: 'total' },
    { key: 'memo', label: 'Partidas informativas', amount: null, kind: 'heading' },
    { key: 'loans', label: 'Pago de préstamos', amount: summary.loanPaymentsNio, kind: 'info' },
    { key: 'purchases', label: 'Compras de mercadería', amount: summary.purchasesNio, kind: 'info' },
  ]
}
/** Parte de las ventas netas que representa un renglón; `null` sin ventas. */
export function shareOfRevenue(
  amount: number | null,
  revenueNio: number,
): number | null {
  return amount === null || revenueNio <= 0 ? null : amount / revenueNio
}

/**
 * Lo que pasó un día: lo facturado en cada moneda, lo que entró de mercadería
 * y lo que se gastó. Las ventas son el total de las facturas, en su moneda; las
 * compras y los gastos van en córdobas con el tipo de cambio de cada operación.
 */
export interface DailyClose {
  day: string
  sales: Record<Currency, number>
  invoices: number
  /** Mercadería más envío de los pedidos fechados ese día. */
  purchasesNio: number
  /** Gastos registrados y no anulados, incluidas las cuotas de préstamo. */
  expensesNio: number
}
const emptyDay = (day: string): DailyClose => ({
  day,
  sales: { NIO: 0, USD: 0 },
  invoices: 0,
  purchasesNio: 0,
  expensesNio: 0,
})
/** Los días del período con algún movimiento, del más reciente al más antiguo. */
export function dailyClose(
  report: Pick<ReportData, 'sales' | 'accounting'>,
  range: ReportRange,
): DailyClose[] {
  const days = new Map<string, DailyClose>()
  const at = (day: string) => {
    const row = days.get(day) ?? emptyDay(day)
    days.set(day, row)
    return row
  }
  for (const currency of ['NIO', 'USD'] as Currency[])
    for (const point of report.sales[currency].days) {
      if (point.day < range.from || point.day > range.to) continue
      const row = at(point.day)
      row.sales[currency] += point.revenue
      row.invoices += point.count
    }
  for (const shipment of shipmentsInRange(report, range))
    at(shipment.incurredOn).purchasesNio +=
      roundMoney(shipment.goodsAmount * shipment.exchangeRate) +
      roundMoney(shipment.shippingAmount * shipment.exchangeRate)
  for (const expense of expensesInRange(report, range)) {
    // Igual que en el resultado: una categoría desconocida no se suma a ojo.
    if (expense.voidedAt || !expenseCategories[expense.category]) continue
    at(expense.incurredOn).expensesNio += roundMoney(
      expense.amount * expense.exchangeRate,
    )
  }
  return [...days.values()]
    .map((row) => ({
      ...row,
      sales: { NIO: roundMoney(row.sales.NIO), USD: roundMoney(row.sales.USD) },
      purchasesNio: roundMoney(row.purchasesNio),
      expensesNio: roundMoney(row.expensesNio),
    }))
    .sort((a, b) => compareText(b.day, a.day))
}
/** El cierre de un día concreto; en cero si no tuvo movimiento. */
export function closeOf(rows: DailyClose[], day: string): DailyClose {
  return rows.find((row) => row.day === day) ?? emptyDay(day)
}
export function dailyTotals(rows: DailyClose[]): Omit<DailyClose, 'day'> {
  const total = emptyDay('')
  for (const row of rows) {
    total.sales.NIO += row.sales.NIO
    total.sales.USD += row.sales.USD
    total.invoices += row.invoices
    total.purchasesNio += row.purchasesNio
    total.expensesNio += row.expensesNio
  }
  return {
    sales: { NIO: roundMoney(total.sales.NIO), USD: roundMoney(total.sales.USD) },
    invoices: total.invoices,
    purchasesNio: roundMoney(total.purchasesNio),
    expensesNio: roundMoney(total.expensesNio),
  }
}

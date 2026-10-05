import type { Currency } from '../../lib/domain'
import { formatCurrency } from '../../lib/format'
import { roundMoney, type ShipmentRecord } from '../reports/accounting'
import type { ReportData } from '../reports/digest'
import { cashflowTotals, type CashflowReport } from './cashflow'
import {
  moneyAccountOrder,
  moneyAccounts,
  shipmentPayments,
  type FinanceLedger,
} from './finance'
import { rowsOf } from './financeRows'
import { paymentLabels } from '../reports/model'

export const dailyMoney = (amount: number | null) =>
  amount === null ? 'Pendiente' : formatCurrency(amount, 'NIO')
export const dailyPayment = (method: string | null) =>
  paymentLabels[method ?? 'pending'] ?? method ?? 'Pendiente de pago'

export function dailyMetrics(report: ReportData, flow: CashflowReport) {
  const totals = cashflowTotals(flow.rows)
  return [
    [
      'Facturas emitidas',
      String(report.sales.NIO.current.count + report.sales.USD.current.count),
    ],
    [
      'Ventas en córdobas',
      formatCurrency(report.sales.NIO.current.revenue, 'NIO'),
    ],
    [
      'Ventas en dólares',
      formatCurrency(report.sales.USD.current.revenue, 'USD'),
    ],
    [
      'Entradas de dinero',
      dailyMoney(flow.available ? totals.inflowNio : null),
    ],
    [
      'Salidas de dinero',
      dailyMoney(flow.available ? totals.outflowNio : null),
    ],
    ['Flujo neto del día', dailyMoney(flow.available ? totals.netNio : null)],
  ]
}

export function dailyAccountRows(flow: CashflowReport) {
  return moneyAccountOrder.map((account) => {
    const rows = flow.rows.filter((row) => row.account === account)
    return {
      id: account,
      cells: [
        moneyAccounts[account],
        dailyMoney(flow.opening[account]),
        dailyMoney(
          flow.available
            ? rows.reduce((sum, row) => sum + row.inflowNio, 0)
            : null,
        ),
        dailyMoney(
          flow.available
            ? rows.reduce((sum, row) => sum + row.outflowNio, 0)
            : null,
        ),
        dailyMoney(flow.closing[account]),
      ],
    }
  })
}

export function dailyPaymentRows(report: ReportData) {
  return (['NIO', 'USD'] as Currency[]).flatMap((currency) =>
    report.sales[currency].payments.map((row) => ({
      id: `${currency}:${row.key}`,
      cells: [
        dailyPayment(row.key),
        currency,
        row.count,
        formatCurrency(row.value, currency),
      ],
    })),
  )
}

export function dailyNotices(
  report: ReportData,
  ledger: FinanceLedger,
  flow: CashflowReport,
) {
  const notices: string[] = []
  if (report.truncated || report.accounting.truncated)
    notices.push(
      'El día tiene más registros de los que se pudieron cargar. Los datos mostrados son parciales.',
    )
  if (!ledger.available || !report.accounting.available)
    notices.push(
      'El detalle contable está pendiente de activar en la base de datos.',
    )
  if (!flow.available)
    notices.push(
      'El flujo de dinero está pendiente de activar. Puedes consultar las ventas disponibles.',
    )
  if (flow.missingSales > 0)
    notices.push(
      `Hay ${flow.missingSales} facturas sin importe contable confirmado. Las entradas y salidas muestran los importes conocidos; los saldos afectados quedan pendientes.`,
    )
  return notices
}

export interface DailyActivity {
  id: string
  createdAt: string
  type: string
  detail: string
  account: string
  amount: number
  currency: Currency
  amountNio: number
  voidReason: string | null
}

/** Detalle informativo: no suma ventas, transferencias ni abonos dos veces. */
export function dailyActivities(
  ledger: FinanceLedger,
  shipments: ShipmentRecord[],
  day: string,
): DailyActivity[] {
  const originals = new Map<string, { amount: number; currency: Currency }>([
    ...ledger.entries.map((row) => [`entry:${row.id}`, row] as const),
    ...ledger.expenses.map((row) => [`expense:${row.id}`, row] as const),
  ])
  const movements = rowsOf(ledger)
    .filter((row) => row.day === day)
    .map((row): DailyActivity => {
      const original = originals.get(`${row.source}:${row.id}`)!
      return {
        ...row,
        id: `${row.source}:${row.id}`,
        amount: original.amount,
        currency: original.currency,
      }
    })
  const purchases = shipments
    .filter((row) => row.incurredOn === day)
    .map((row): DailyActivity => ({
      id: `purchase:${row.id}`,
      createdAt: row.createdAt,
      type: 'Compra de mercadería',
      detail: [row.supplier, row.reference, row.note]
        .filter(Boolean)
        .join(' · '),
      account: row.account ? shipmentPayments[row.account] : 'Sin dato',
      amount: roundMoney(row.goodsAmount + row.shippingAmount),
      currency: row.currency,
      amountNio: roundMoney(
        roundMoney(row.goodsAmount * row.exchangeRate) +
          roundMoney(row.shippingAmount * row.exchangeRate),
      ),
      voidReason: null,
    }))
  return [...movements, ...purchases].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  )
}

export function validClosingDay(day: string, today: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today) return false
  const parsed = new Date(`${day}T12:00:00Z`)
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === day
  )
}

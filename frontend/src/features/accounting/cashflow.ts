import type {
  CashflowCategory,
  CashflowRow,
  CashflowReport,
  CashClosingInput,
} from '@lcp/contracts/cashflow'
export type {
  CashflowCategory,
  CashflowRow,
  CashflowBalances,
  CashflowReport,
  CashflowLedger,
  CashClosingInput,
  CashClosingRecord,
} from '@lcp/contracts/cashflow'
import { roundMoney } from '../reports/accounting'

export const cashflowCategories = {
  sales: 'Ventas cobradas',
  collection: 'Cobros a clientes',
  purchases: 'Pedidos pagados',
  supplier_payment: 'Pagos a proveedores',
  expense: 'Gastos',
  loan_payment: 'Pago de préstamos',
  capital: 'Aportes del dueño',
  withdrawal: 'Retiros del dueño',
  loan: 'Préstamos recibidos',
  transfer: 'Transferencias internas',
  opening: 'Saldo inicial',
  journal: 'Comprobantes contables',
} as const satisfies Record<CashflowCategory, string>
export const emptyCashflow: CashflowReport = {
  available: false,
  from: '',
  to: '',
  startOn: null,
  opening: { caja: null, banco: null },
  closing: { caja: null, banco: null },
  missingSales: 0,
  rows: [],
  totals: { inflowNio: 0, outflowNio: 0, netNio: 0 },
}

export function countedTotalNio(
  input: Pick<CashClosingInput, 'countedNio' | 'countedUsd' | 'exchangeRate'>,
): number | null {
  const { countedNio, countedUsd, exchangeRate } = input
  if (
    !Number.isFinite(countedNio) ||
    countedNio < 0 ||
    !Number.isFinite(countedUsd) ||
    countedUsd < 0
  )
    return null
  if (
    countedUsd > 0 &&
    (exchangeRate === null ||
      !Number.isFinite(exchangeRate) ||
      exchangeRate <= 0)
  )
    return null
  const total = countedNio + (countedUsd === 0 ? 0 : countedUsd * exchangeRate!)
  return Number.isFinite(total) ? roundMoney(total) : null
}

export function cashClosingDifference(
  input: Pick<CashClosingInput, 'countedNio' | 'countedUsd' | 'exchangeRate'>,
  expectedNio: number | null,
): number | null {
  const total = countedTotalNio(input)
  return total === null || expectedNio === null || !Number.isFinite(expectedNio)
    ? null
    : roundMoney(total - expectedNio)
}

/** Transferencias y apertura se muestran, pero no son cobros ni pagos externos. */
export function cashflowTotals(rows: CashflowRow[]) {
  const external = rows.filter(
    (row) => row.category !== 'transfer' && row.category !== 'opening',
  )
  const inflowNio = roundMoney(
    external.reduce((sum, row) => sum + row.inflowNio, 0),
  )
  const outflowNio = roundMoney(
    external.reduce((sum, row) => sum + row.outflowNio, 0),
  )
  return { inflowNio, outflowNio, netNio: roundMoney(inflowNio - outflowNio) }
}

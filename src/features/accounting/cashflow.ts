import { roundMoney } from '../reports/accounting'
import type { MoneyAccount } from './finance'

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
} as const
export type CashflowCategory = keyof typeof cashflowCategories
export interface CashflowRow {
  day: string
  account: MoneyAccount
  category: CashflowCategory
  inflowNio: number
  outflowNio: number
  operations: number
  /** Facturas cobradas cuyo importe histórico no está completo. */
  missingSales: number
}
export type CashflowBalances = Record<MoneyAccount, number | null>
export interface CashflowReport {
  available: boolean
  from: string
  to: string
  startOn: string | null
  /** Antes de `from`; null cuando no hay base o hay ventas incompletas. */
  opening: CashflowBalances
  /** Hasta el final de `to`, con las tasas guardadas en cada operación. */
  closing: CashflowBalances
  /** Acumuladas desde el saldo inicial, porque también afectan el saldo final. */
  missingSales: number
  rows: CashflowRow[]
  totals: { inflowNio: number; outflowNio: number; netNio: number }
}
export type CashflowLedger = CashflowReport
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

export interface CashClosingInput {
  requestId: string
  closedOn: string
  /** Efectivo contado físicamente en cada moneda. */
  countedNio: number
  countedUsd: number
  /** Obligatoria si hay dólares; no toma la tasa actual del catálogo. */
  exchangeRate: number | null
  note: string
}
export interface CashClosingRecord extends CashClosingInput {
  id: string
  countedTotalNio: number
  expectedNio: number
  differenceNio: number
  createdAt: string
  voidedAt: string | null
  voidReason: string | null
  /** Expectativa recalculada; el cierre original se conserva intacto. */
  currentExpectedNio: number | null
  currentMissingSales: number
  changed: boolean
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
  return roundMoney(countedNio + countedUsd * (exchangeRate ?? 1))
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

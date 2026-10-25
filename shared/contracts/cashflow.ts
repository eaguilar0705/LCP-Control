import type { MoneyAccount } from './finance'

export type CashflowCategory =
  | 'sales'
  | 'collection'
  | 'purchases'
  | 'purchase_refund'
  | 'purchase_correction'
  | 'supplier_payment'
  | 'expense'
  | 'loan_payment'
  | 'capital'
  | 'withdrawal'
  | 'loan'
  | 'transfer'
  | 'opening'
  | 'journal'

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

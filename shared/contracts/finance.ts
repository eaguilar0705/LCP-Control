import type { Currency } from './domain'
import type { ExpenseRecord } from './accounting'

export type MoneyAccount = 'caja' | 'banco'

export type FinanceAccount =
  'caja' | 'banco' | 'cobrar' | 'prestamos' | 'proveedores'

export type ShipmentPayment = 'caja' | 'banco' | 'credito'

export type FinanceKind =
  | 'opening'
  | 'capital'
  | 'withdrawal'
  | 'transfer'
  | 'loan'
  | 'supplier_payment'
  | 'collection'

export interface FinanceEntryInput {
  requestId: string
  occurredOn: string
  kind: FinanceKind
  /** Saldo inicial: cualquier cuenta. Lo demás: caja o banco. */
  account: FinanceAccount
  /** Sólo en transferencias. */
  toAccount: MoneyAccount | null
  amount: number
  currency: Currency
  exchangeRate: number
  counterparty: string
  description: string
  reference: string
  /** Factura a crédito que se cobra; sólo en `collection`. */
  documentId?: string | null
  /** Pedido a crédito que se paga; sólo en `supplier_payment`. */
  shipmentId?: string | null
}

export interface FinanceEntryRecord extends FinanceEntryInput {
  id: string
  createdAt: string
  voidedAt: string | null
  voidReason: string | null
}

export interface PaidExpense extends ExpenseRecord {
  account: MoneyAccount
}

/** Lo facturado desde el primer saldo inicial, en córdobas, por forma de pago. */
export interface SalesByPayment {
  caja: number
  banco: number
  cobrar: number
  /** Facturas sin importe congelado: no se suman a ojo. */
  missing: number
}

/** Lo que hace falta para calcular los saldos a una fecha. */
export interface FinanceSource {
  available: boolean
  /** Día del primer saldo inicial; `null` mientras no haya ninguno. */
  startOn: string | null
  at: string
  /** Movimientos del contador hasta `at`, anulados incluidos. */
  entries: FinanceEntryRecord[]
  /** Gastos desde `startOn` hasta `at`, anulados incluidos. */
  expenses: {
    amountNio: number
    account: MoneyAccount
    financing: boolean
    voided: boolean
  }[]
  /** Pedidos desde `startOn` hasta `at`. */
  shipments: { amountNio: number; account: ShipmentPayment }[]
  sales: SalesByPayment
}

export interface FinancePosition {
  started: boolean
  startOn: string | null
  /** Cuentas con un saldo inicial explícito (también cuando su importe es cero). */
  openedAccounts?: FinanceAccount[]
  cash: Record<MoneyAccount, number>
  receivablesNio: number
  loansNio: number
  payablesNio: number
  /** Saldos iniciales netos más aportes, menos retiros. */
  capitalNio: number
  missingSales: number
}

/** Lo que enseña la pestaña de movimientos: los saldos y lo registrado en el período. */
export interface FinanceLedger {
  available: boolean
  position: FinancePosition
  /**
   * Movimientos brutos desde el primer saldo inicial hasta el corte. Se
   * comparan dos cortes para obtener el Debe y Haber reales de un período.
   * Sin saldo inicial no hay una base contable y el campo queda sin definir.
   */
  turnovers?: Record<
    FinanceAccount | 'capital',
    { debitNio: number; creditNio: number }
  >
  entries: FinanceEntryRecord[]
  expenses: PaidExpense[]
}

/** Una factura, un pedido o el saldo inicial agregado pendiente de liquidar. */
export interface CreditAccount {
  id: string
  kind: 'receivable' | 'payable'
  counterparty: string
  reference: string
  occurredOn: string
  /** `null` indica una factura histórica sin importe contable congelado. */
  originalNio: number | null
  paidNio: number | null
  balanceNio: number | null
  documentId: string | null
  shipmentId: string | null
}

export interface CreditLedger {
  available: boolean
  at: string
  startOn: string | null
  rows: CreditAccount[]
  /** El saldo inicial no tiene detalle de facturas o pedidos anteriores. */
  unallocatedNio: { receivables: number; payables: number }
  /** Movimientos anteriores que no identificaban la deuda liquidada. */
  legacyPayments: number
}

import type { Currency } from '../../lib/domain'
import {
  expenseAccounts,
  expenseCategories,
  roundMoney,
  type ExpenseRecord,
} from '../reports/accounting'
import type { ReportRange } from '../reports/model'

/**
 * Caja, bancos y deudas. Las ventas, los pedidos y los gastos ya registrados
 * mueven estos saldos solos; el contador sólo teclea lo que no es ninguno de
 * ellos: saldos iniciales, aportes y retiros, transferencias, préstamos,
 * pagos a proveedores y cobros. Los saldos cuentan a partir del primer saldo
 * inicial: lo anterior no se conoce y no se adivina.
 */
export const moneyAccounts = { caja: 'Caja', banco: 'Banco' } as const
export type MoneyAccount = keyof typeof moneyAccounts
export const moneyAccountOrder = Object.keys(moneyAccounts) as MoneyAccount[]

export const financeAccounts = {
  ...moneyAccounts,
  cobrar: 'Cuentas por cobrar',
  prestamos: 'Préstamos por pagar',
  proveedores: 'Cuentas por pagar a proveedores',
} as const
export type FinanceAccount = keyof typeof financeAccounts

/** Cómo se pagó un pedido: con dinero del negocio o a crédito del proveedor. */
export const shipmentPayments = { ...moneyAccounts, credito: 'Crédito del proveedor' } as const
export type ShipmentPayment = keyof typeof shipmentPayments

export const financeKinds = {
  opening: 'Saldo inicial',
  capital: 'Aporte del dueño',
  withdrawal: 'Retiro del dueño',
  transfer: 'Transferencia',
  loan: 'Préstamo recibido',
  supplier_payment: 'Pago a proveedor',
  collection: 'Cobro a cliente',
} as const
export type FinanceKind = keyof typeof financeKinds
export const financeKindOrder = Object.keys(financeKinds) as FinanceKind[]

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
  expenses: { amountNio: number; account: MoneyAccount; financing: boolean; voided: boolean }[]
  /** Pedidos desde `startOn` hasta `at`. */
  shipments: { amountNio: number; account: ShipmentPayment }[]
  sales: SalesByPayment
}
export interface FinancePosition {
  started: boolean
  startOn: string | null
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
  entries: FinanceEntryRecord[]
  expenses: PaidExpense[]
}

export const emptySales: SalesByPayment = { caja: 0, banco: 0, cobrar: 0, missing: 0 }
export const emptyPosition: FinancePosition = {
  started: false, startOn: null, cash: { caja: 0, banco: 0 },
  receivablesNio: 0, loansNio: 0, payablesNio: 0, capitalNio: 0, missingSales: 0,
}
export const emptyLedger: FinanceLedger = {
  available: false, position: emptyPosition, entries: [], expenses: [],
}

export const toNio = (row: { amount: number; exchangeRate: number }) =>
  roundMoney(row.amount * row.exchangeRate)
export const isMoneyAccount = (value: string): value is MoneyAccount =>
  Object.hasOwn(moneyAccounts, value)
/** Un pago de préstamo baja la deuda; los demás gastos sólo sacan dinero. */
export const reducesLoan = (expense: Pick<ExpenseRecord, 'category'>) => {
  const account = expenseCategories[expense.category]?.account
  return !!account && expenseAccounts[account].effect === 'financing'
}

/** El primer saldo inicial vigente hasta `at`. */
export function financeStart(entries: FinanceEntryRecord[], at: string) {
  let start: string | null = null
  for (const row of entries)
    if (row.kind === 'opening' && !row.voidedAt && row.occurredOn <= at && (!start || row.occurredOn < start))
      start = row.occurredOn
  return start
}

export function financePosition(source: FinanceSource): FinancePosition {
  const { startOn, at } = source
  if (!source.available || !startOn) return { ...emptyPosition, cash: { ...emptyPosition.cash } }
  const cash: Record<MoneyAccount, number> = { caja: source.sales.caja, banco: source.sales.banco }
  let receivables = source.sales.cobrar
  let loans = 0
  let payables = 0
  let capital = 0
  for (const row of source.entries) {
    if (row.voidedAt || row.occurredOn < startOn || row.occurredOn > at) continue
    const amount = toNio(row)
    const money = isMoneyAccount(row.account) ? row.account : null
    switch (row.kind) {
      case 'opening':
        if (money) cash[money] += amount
        else if (row.account === 'cobrar') receivables += amount
        else if (row.account === 'prestamos') loans += amount
        else payables += amount
        capital += row.account === 'prestamos' || row.account === 'proveedores' ? -amount : amount
        break
      case 'capital':
        if (money) cash[money] += amount
        capital += amount
        break
      case 'withdrawal':
        if (money) cash[money] -= amount
        capital -= amount
        break
      case 'transfer':
        if (money && row.toAccount) {
          cash[money] -= amount
          cash[row.toAccount] += amount
        }
        break
      case 'loan':
        if (money) cash[money] += amount
        loans += amount
        break
      case 'supplier_payment':
        if (money) cash[money] -= amount
        payables -= amount
        break
      case 'collection':
        if (money) cash[money] += amount
        receivables -= amount
        break
    }
  }
  for (const row of source.shipments) {
    if (row.account === 'credito') payables += row.amountNio
    else cash[row.account] -= row.amountNio
  }
  for (const row of source.expenses) {
    if (row.voided) continue
    cash[row.account] -= row.amountNio
    if (row.financing) loans -= row.amountNio
  }
  return {
    started: true,
    startOn,
    cash: { caja: roundMoney(cash.caja), banco: roundMoney(cash.banco) },
    receivablesNio: roundMoney(receivables),
    loansNio: roundMoney(loans),
    payablesNio: roundMoney(payables),
    capitalNio: roundMoney(capital),
    missingSales: source.sales.missing,
  }
}

const inRange = (day: string, range: ReportRange) => day >= range.from && day <= range.to
/**
 * Arma lo que enseña la pestaña de movimientos a partir de filas ya leídas:
 * todos los movimientos del contador hasta el fin del período, los gastos y
 * pedidos desde el saldo inicial y lo facturado en ese mismo tramo.
 */
export function financeLedger(
  rows: {
    entries: FinanceEntryRecord[]
    expenses: PaidExpense[]
    shipments: { incurredOn: string; amountNio: number; account: ShipmentPayment }[]
    sales: SalesByPayment
  },
  range: ReportRange,
): FinanceLedger {
  const startOn = financeStart(rows.entries, range.to)
  const sinceStart = (day: string) => !!startOn && day >= startOn && day <= range.to
  const position = financePosition({
    available: true,
    startOn,
    at: range.to,
    entries: rows.entries,
    expenses: rows.expenses
      .filter((row) => sinceStart(row.incurredOn))
      .map((row) => ({ amountNio: toNio(row), account: row.account, financing: reducesLoan(row), voided: !!row.voidedAt })),
    shipments: rows.shipments.filter((row) => sinceStart(row.incurredOn)),
    sales: startOn ? rows.sales : emptySales,
  })
  const byDate = <T extends { createdAt: string }>(a: T, b: T, day: (row: T) => string) =>
    day(b).localeCompare(day(a)) || b.createdAt.localeCompare(a.createdAt)
  return {
    available: true,
    position,
    entries: rows.entries
      .filter((row) => inRange(row.occurredOn, range))
      .sort((a, b) => byDate(a, b, (row) => row.occurredOn)),
    expenses: rows.expenses
      .filter((row) => inRange(row.incurredOn, range))
      .sort((a, b) => byDate(a, b, (row) => row.incurredOn)),
  }
}

/** Lo facturado por forma de pago: efectivo a caja, pendiente por cobrar, lo demás a bancos. */
export function salesByPayment(
  invoices: { paymentMethod: string | null; amountNio: number | null }[],
): SalesByPayment {
  const total = { ...emptySales }
  for (const row of invoices) {
    if (row.amountNio === null) total.missing++
    else if (row.paymentMethod === 'cash') total.caja += row.amountNio
    else if (row.paymentMethod === 'pending') total.cobrar += row.amountNio
    else total.banco += row.amountNio
  }
  return {
    caja: roundMoney(total.caja),
    banco: roundMoney(total.banco),
    cobrar: roundMoney(total.cobrar),
    missing: total.missing,
  }
}

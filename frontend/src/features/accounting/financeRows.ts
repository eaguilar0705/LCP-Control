import { useAccess } from '../../app/AccessContext'
import { can } from '../../lib/permissions'
import { expenseLabel } from '../reports/accounting'
import {
  financeAccounts,
  financeKinds,
  moneyAccounts,
  reducesLoan,
  toNio,
  type FinanceKind,
  type FinanceLedger,
} from './finance'

/** Una fila de la lista: un movimiento del contador o un gasto. */
export interface Row {
  id: string
  source: 'entry' | 'expense'
  day: string
  createdAt: string
  type: string
  detail: string
  account: string
  amountNio: number
  /** Positivo si entra dinero o baja una deuda a favor; negativo si sale. */
  sign: 1 | -1 | 0
  voidReason: string | null
}

/** Si el movimiento suma o resta en la cuenta que se muestra en la fila. */
const entrySign = (kind: FinanceKind): Row['sign'] =>
  kind === 'withdrawal' || kind === 'supplier_payment'
    ? -1
    : kind === 'transfer'
      ? 0
      : 1

export function rowsOf(ledger: FinanceLedger): Row[] {
  const entries = ledger.entries.map((entry): Row => ({
    id: entry.id,
    source: 'entry',
    day: entry.occurredOn,
    createdAt: entry.createdAt,
    type: financeKinds[entry.kind],
    detail: [entry.counterparty, entry.reference, entry.description]
      .filter(Boolean)
      .join(' · '),
    account: entry.toAccount
      ? `${financeAccounts[entry.account]} → ${moneyAccounts[entry.toAccount]}`
      : financeAccounts[entry.account],
    amountNio: toNio(entry),
    sign: entrySign(entry.kind),
    voidReason: entry.voidedAt ? (entry.voidReason ?? '') : null,
  }))
  const expenses = ledger.expenses.map((expense): Row => ({
    id: expense.id,
    source: 'expense',
    day: expense.incurredOn,
    createdAt: expense.createdAt,
    type: reducesLoan(expense)
      ? `Pago de préstamo · ${expenseLabel(expense.category)}`
      : (expenseLabel(expense.category) ?? 'Gasto'),
    detail: expense.description,
    account: moneyAccounts[expense.account] ?? expense.account,
    amountNio: toNio(expense),
    sign: -1,
    voidReason: expense.voidedAt ? (expense.voidReason ?? '') : null,
  }))
  return [...entries, ...expenses].sort(
    (a, b) =>
      b.day.localeCompare(a.day) || b.createdAt.localeCompare(a.createdAt),
  )
}

/** Sólo Administración escribe, y nunca en la vista local ni sin la actualización. */
export function useWritable(ledger: FinanceLedger) {
  const { demo, role } = useAccess()
  return !demo && can(role, 'finance.read') && ledger.available
}

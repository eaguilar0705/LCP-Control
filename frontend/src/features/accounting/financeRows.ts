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
  readOnly?: boolean
}

/** Si el movimiento suma o resta en la cuenta que se muestra en la fila. */
const entrySign = (kind: FinanceKind): Row['sign'] =>
  kind === 'withdrawal' || kind === 'supplier_payment'
    ? -1
    : kind === 'transfer'
      ? 0
      : 1

export function rowsOf(
  ledger: FinanceLedger,
  bankNames: Record<string, string> = {},
): Row[] {
  const entries = ledger.entries.map((entry): Row => ({
    id: entry.id,
    source: 'entry',
    day: entry.occurredOn,
    createdAt: entry.createdAt,
    type:
      entry.readOnly && entry.amount < 0
        ? entry.compensationKind === 'recording_error'
          ? 'Corrección de pago'
          : 'Devolución de pago'
        : financeKinds[entry.kind],
    detail: [entry.counterparty, entry.reference, entry.description]
      .filter(Boolean)
      .join(' · '),
    account: entry.toAccount
      ? `${financeAccounts[entry.account]} → ${moneyAccounts[entry.toAccount]}`
      : (entry.bankLedgerAccount && bankNames[entry.bankLedgerAccount]) ||
        financeAccounts[entry.account],
    amountNio:
      entry.readOnly && entry.amount < 0
        ? Math.abs(toNio(entry))
        : toNio(entry),
    sign: entry.readOnly && entry.amount < 0 ? 1 : entrySign(entry.kind),
    ...(entry.readOnly ? { readOnly: true } : {}),
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

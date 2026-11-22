import { supabase } from '../../lib/supabase'
import { AppError } from '../../lib/errors'
import type {
  AutomaticJournalRecord,
  JournalRecord,
  LedgerReport,
} from './journalModel'

export const accountMovementPageSize = 50

interface LedgerAccountOption {
  code: string
  display_code?: string | null
  displayCode?: string
  name: string
  active: boolean
  postable: boolean
}

interface AccountMovement {
  id: string
  day: string
  source: string
  description: string
  reference: string
  debit: number | null
  credit: number | null
  balance: number | null
}

export interface AccountMovementPage {
  account: string
  from: string | null
  to: string
  offset: number
  total: number
  revision: string
  opening: number | null
  debit: number | null
  credit: number | null
  closing: number | null
  rows: AccountMovement[]
}

export async function readLedgerAccountOptions() {
  const accounts = await journalRpc<LedgerAccountOption[]>(
    'ledger_accounts_list',
    {},
  )
  if (
    !Array.isArray(accounts) ||
    accounts.some(
      (account) =>
        !account ||
        typeof account.code !== 'string' ||
        typeof account.name !== 'string' ||
        typeof account.active !== 'boolean' ||
        typeof account.postable !== 'boolean',
    )
  )
    throw new AppError(
      'unexpected',
      'No se recibió la lista completa de cuentas. Vuelve a consultar.',
    )

  return accounts.filter((account) => account.postable)
}

export async function readAccountMovements(
  account: string,
  from: string | null,
  to: string,
  offset: number,
): Promise<AccountMovementPage> {
  const page = await journalRpc<AccountMovementPage>(
    'ledger_account_movements',
    { p_account: account, p_from: from, p_to: to, p_offset: offset },
  )
  const validAmount = (amount: number | null) =>
    amount === null || Number.isFinite(amount)
  if (
    page.account !== account ||
    page.from !== from ||
    page.to !== to ||
    page.offset !== offset ||
    typeof page.revision !== 'string' ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    ![page.opening, page.debit, page.credit, page.closing].every(validAmount) ||
    !Array.isArray(page.rows) ||
    page.rows.length !==
      Math.max(0, Math.min(accountMovementPageSize, page.total - offset)) ||
    page.rows.some(
      (row) =>
        !row ||
        ![row.id, row.day, row.source, row.description, row.reference].every(
          (value) => typeof value === 'string',
        ) ||
        ![row.debit, row.credit, row.balance].every(validAmount),
    )
  )
    throw new AppError(
      'unexpected',
      'No se recibieron todos los movimientos de la cuenta. Vuelve a consultar.',
    )

  return page
}

export interface JournalPage {
  entries: (JournalRecord | AutomaticJournalRecord)[]
  total: number
  offset: number
  limit: number
  asOf: string
  from: string
  to: string
}
export async function readJournalPage(
  from: string,
  to: string,
  offset = 0,
  asOf: string | null = null,
  total: number | null = null,
) {
  const result = await journalRpc<JournalPage>('journal_entries_page', {
    p_from: from,
    p_to: to,
    p_offset: offset,
    p_limit: 50,
    p_as_of: asOf,
    p_expected_total: total,
  })
  if (
    !Array.isArray(result.entries) ||
    result.entries.some((entry) => !entry || typeof entry.id !== 'string') ||
    !Number.isInteger(result.total) ||
    result.total < 0 ||
    result.offset !== offset ||
    result.from !== from ||
    result.to !== to ||
    result.entries.length > 50 ||
    typeof result.asOf !== 'string'
  )
    throw new AppError(
      'unexpected',
      'No se recibió la página completa de comprobantes. Vuelve a intentarlo.',
    )
  return result
}

export async function journalRpc<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  if (!supabase)
    throw new AppError('configuration', 'No hay conexión con la tienda.')
  const isWrite = [
    'record_journal_entry',
    'correct_opening_journal',
    'record_inventory_receipt',
    'post_inventory_receipt',
    'cancel_inventory_receipt',
    'correct_journal_entry',
    'classify_purchase',
    'revise_purchase_receipt',
    'correct_finance_entry',
    'save_accounting_draft',
    'adopt_inventory_counts_as_purchase',
    'void_inventory_adjustment',
  ].includes(name)
  const confirmationMessage = isWrite
    ? name.includes('inventory_receipt')
      ? 'No pudimos confirmar el guardado. Usa «Verificar guardado» para recuperar el resultado sin duplicarlo.'
      : 'No pudimos confirmar si el comprobante se guardó. Usa «Verificar guardado» para recuperar el resultado sin duplicarlo.'
    : 'No pudimos conectar con la información contable. Inténtalo de nuevo.'
  const { data, error, status } = await supabase.rpc(name, args)
  if (error) {
    // Un corte de red o un error del servidor no confirma que PostgreSQL haya
    // revertido el guardado. La interfaz debe verificar la solicitud original.
    if (status === 0 || status >= 500)
      throw new AppError('network', confirmationMessage)
    if (
      status === 401 ||
      status === 403 ||
      error.code === '42501' ||
      error.code === 'PGRST301'
    )
      throw new AppError(
        'unauthorized',
        'No tienes permiso para esta operación.',
      )
    const message = error.message?.trim()
    const readable = message && message.length <= 300 ? message : null
    if (status === 429 || error.code === 'LCP429')
      throw new AppError(
        'rate_limited',
        (error.code === 'LCP429' ? readable : null) ??
          'Demasiadas operaciones seguidas. Espera un momento.',
      )
    if (['P0001', 'P1001', 'P1002'].includes(error.code))
      throw new AppError(
        'validation',
        readable ?? 'Revisa los datos del comprobante.',
      )
    throw new AppError(
      status === 400 || status === 422 ? 'validation' : 'unexpected',
      'No pudimos completar la operación contable. Revisa los datos e inténtalo de nuevo.',
    )
  }
  if (data === null || data === undefined)
    throw new AppError(
      isWrite ? 'network' : 'unexpected',
      isWrite
        ? confirmationMessage
        : 'No se recibió el detalle contable. Inténtalo de nuevo.',
    )
  return data as T
}
export async function readLedgerBalances(from: string, to: string) {
  const data = await journalRpc<LedgerReport>('ledger_report', {
    p_from: from,
    p_to: to,
  })
  if (
    !Array.isArray(data.accounts) ||
    !Array.isArray(data.entries) ||
    data.from !== from ||
    data.to !== to ||
    !Number.isInteger(data.missingCosts) ||
    data.missingCosts < 0 ||
    !Number.isInteger(data.missingSales) ||
    data.missingSales < 0 ||
    data.accounts.some(
      (a) => ![a.opening, a.debit, a.credit, a.closing].every(Number.isFinite),
    )
  )
    throw new AppError(
      'unexpected',
      'No se recibieron los saldos contables completos. Vuelve a consultar el período.',
    )
  return data
}

export async function readLedger(from: string, to: string) {
  const [data, automaticEntries] = await Promise.all([
    readLedgerBalances(from, to),
    journalRpc<AutomaticJournalRecord[]>('sales_journal_entries', {
      p_from: from,
      p_to: to,
    }),
  ])
  if (
    !Array.isArray(automaticEntries) ||
    automaticEntries.some(
      (entry) =>
        !entry.automatic ||
        !Number.isInteger(entry.missingSales) ||
        entry.missingSales < 0 ||
        !Number.isInteger(entry.missingCosts) ||
        entry.missingCosts < 0 ||
        !Array.isArray(entry.lines) ||
        !['sales', 'sales_cost'].includes(entry.kind) ||
        entry.lines.some(
          (line) =>
            ![line.debit, line.credit, line.debit_nio, line.credit_nio].every(
              (amount) => amount === null || Number.isFinite(amount),
            ),
        ),
    )
  )
    throw new AppError(
      'unexpected',
      'No se recibió el libro contable completo. Vuelve a consultar el período.',
    )
  return { ...data, automaticEntries }
}

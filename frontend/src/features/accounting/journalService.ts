import { supabase } from '../../lib/supabase'
import { AppError } from '../../lib/errors'
import type {
  AutomaticJournalRecord,
  JournalRecord,
  LedgerReport,
} from './journalModel'

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
  const confirmationMessage =
    name === 'record_journal_entry'
      ? 'No pudimos confirmar si el comprobante se guardó. Usa «Verificar guardado» para recuperar el resultado sin duplicarlo.'
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
      name === 'record_journal_entry' ? 'network' : 'unexpected',
      name === 'record_journal_entry'
        ? confirmationMessage
        : 'No se recibió el detalle contable. Inténtalo de nuevo.',
    )
  return data as T
}
export async function readLedger(from: string, to: string) {
  const args = { p_from: from, p_to: to }
  const [data, automaticEntries] = await Promise.all([
    journalRpc<LedgerReport>('ledger_report', args),
    journalRpc<AutomaticJournalRecord[]>('sales_journal_entries', args),
  ])
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
    ) ||
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

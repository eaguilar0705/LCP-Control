import { supabase } from '../../lib/supabase'
import { AppError } from '../../lib/errors'
import type { LedgerReport } from './journalModel'

export async function journalRpc<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  if (!supabase)
    throw new AppError('configuration', 'No hay conexión con la tienda.')
  const { data, error } = await supabase.rpc(name, args)
  if (error)
    throw new AppError(
      'validation',
      error.code === '42501'
        ? 'No tienes permiso para esta operación.'
        : error.message,
    )
  if (data === null || data === undefined)
    throw new AppError(
      'unexpected',
      'No se recibió la confirmación o el detalle del comprobante contable.',
    )
  return data as T
}
export async function readLedger(from: string, to: string) {
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
      'No se recibió el libro contable completo. Vuelve a consultar el período.',
    )
  return data
}

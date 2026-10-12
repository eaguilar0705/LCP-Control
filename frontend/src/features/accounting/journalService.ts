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
  return data as T
}
export const readLedger = (from: string, to: string) =>
  journalRpc<LedgerReport>('ledger_report', { p_from: from, p_to: to })

import { supabase } from '../../lib/supabase'
import { AppError } from '../../lib/errors'

export interface DailyReport {
  returnsCount?: number
  returnedUnits?: number
  returnedNio?: number
  netSalesNio?: number
  invoices: number
  units: number
  products: { product_id: string; description: string; units: number }[]
  payments: {
    method: string
    currency: 'NIO' | 'USD'
    invoices: number
    amount: number
    units: number
  }[]
  cashMovementNio: number
  cashMovementUsd: number
  expectedNio: number
  expectedUsd: number
  countedNio?: number
  countedUsd?: number
  differenceNio?: number
  differenceUsd?: number
  note?: string
  openingNio?: number
  openingUsd?: number
  openedAt?: string
  closedAt?: string
}
export interface BusinessDay {
  today: string
  day: string
  status: 'not_opened' | 'open' | 'closed'
  openDay: string | null
  openedAt: string | null
  closedAt: string | null
  openingNio: number | null
  openingUsd: number | null
  report: DailyReport | null
  revision: number
  reopenCount: number
  serverNow: string
  stateToken: string
}
export interface BusinessDayEvent {
  id: string
  day: string
  event: 'close' | 'reopen'
  revision: number
  createdAt: string
  actorId: string
  actorName: string
  reason: string
  requestId: string
  report: DailyReport | null
}
async function callDayRpc(name: string, args: Record<string, unknown>) {
  if (!supabase)
    throw new AppError(
      'configuration',
      'La conexión con la tienda no está disponible.',
    )
  const { data, error, status } = await supabase.rpc(name, args)
  if (error) {
    if (
      !navigator.onLine ||
      status === 0 ||
      status >= 500 ||
      /failed to fetch|network|load failed|timeout/i.test(error.message)
    )
      throw new AppError(
        'network',
        'No pudimos confirmar la operación. Revisa tu conexión y reintenta sin cambiar los datos.',
      )
    if (error.code === '42501' || status === 401 || status === 403)
      throw new AppError(
        'unauthorized',
        'No tienes permiso para esta operación.',
      )
    if (error.code === 'LCP429' || status === 429)
      throw new AppError(
        'rate_limited',
        'Demasiadas operaciones seguidas. Espera un momento y vuelve a verificar.',
      )
    throw new AppError(
      'validation',
      error.code === 'P0001' && error.message.trim().length <= 300
        ? error.message.trim()
        : 'No pudimos completar la operación de jornada. Revisa los datos e inténtalo de nuevo.',
    )
  }
  return data
}
export async function dayRpc(
  name: string,
  args: Record<string, unknown>,
): Promise<BusinessDay> {
  const data = await callDayRpc(name, args)
  if (!data || !['not_opened', 'open', 'closed'].includes(data.status))
    throw new AppError('unexpected', 'No se recibió el estado de la jornada.')
  return data as BusinessDay
}
export const getBusinessDay = () => dayRpc('get_business_day', {})
export async function getBusinessDayHistory(
  day: string,
): Promise<BusinessDayEvent[]> {
  const data = await callDayRpc('get_business_day_history', { p_day: day })
  if (!Array.isArray(data))
    throw new AppError(
      'unexpected',
      'No se recibió el historial de la jornada.',
    )
  return data as BusinessDayEvent[]
}

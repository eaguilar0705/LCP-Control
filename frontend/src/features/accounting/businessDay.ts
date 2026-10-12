import { supabase } from '../../lib/supabase'
import { AppError } from '../../lib/errors'

export interface DailyReport {
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
}
export async function dayRpc(
  name: string,
  args: Record<string, unknown>,
): Promise<BusinessDay> {
  if (!supabase)
    throw new AppError(
      'configuration',
      'La conexión con la tienda no está disponible.',
    )
  const { data, error } = await supabase.rpc(name, args)
  if (error)
    throw new AppError(
      'validation',
      error.code === '42501'
        ? 'No tienes permiso para esta operación.'
        : error.message,
    )
  if (!data || !['not_opened', 'open', 'closed'].includes(data.status))
    throw new AppError('unexpected', 'No se recibió el estado de la jornada.')
  return data as BusinessDay
}
export const getBusinessDay = () => dayRpc('get_business_day', {})

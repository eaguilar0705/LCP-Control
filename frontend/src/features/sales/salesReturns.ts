import { supabase } from '../../lib/supabase'
import { AppError } from '../../lib/errors'
import type { Currency, PaymentMethod } from '../../lib/domain'

export interface SalesReturnInput {
  requestId: string
  documentId: string
  reason: string
  refundMethod: PaymentMethod
  items: { itemId: string; quantity: number; restock: boolean }[]
}
export interface SalesReturnResult {
  id: string
  number: string
  amount: number
  refundNio: number
  creditReductionNio: number
}
export interface InvoiceReturnDetail {
  documentId: string
  number: string
  currency: Currency
  exchangeRate: number
  items: {
    id: string
    description: string
    quantity: number
    returned: number
    unitPrice: number
    lineTotal?: number
  }[]
  returns: (SalesReturnResult & {
    date: string
    reason: string
    journalEntryId: string
  })[]
}
export function returnLineAmount(
  item: InvoiceReturnDetail['items'][number],
  quantity: number,
) {
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < 0 ||
    quantity > item.quantity - item.returned
  )
    return 0
  const cents = BigInt(
    Math.round((item.lineTotal ?? item.unitPrice * item.quantity) * 100),
  )
  const denominator = BigInt(item.quantity)
  const portion = (units: number) =>
    (2n * cents * BigInt(units) + denominator) / (2n * denominator)
  return (
    Number(portion(item.returned + quantity) - portion(item.returned)) / 100
  )
}
async function returnsRpc<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  if (!supabase)
    throw new AppError('configuration', 'No hay conexión con la tienda.')
  const { data, error, status } = await supabase.rpc(name, args)
  if (error) {
    if (status === 0 || status >= 500)
      throw new AppError(
        'network',
        'No pudimos confirmar la devolución. Verifica el guardado antes de crear otra.',
      )
    if (status === 401 || status === 403 || error.code === '42501')
      throw new AppError(
        'unauthorized',
        'No tienes permiso para esta operación.',
      )
    if (status === 429 || error.code === 'LCP429')
      throw new AppError(
        'rate_limited',
        'Espera un momento antes de verificar el guardado de nuevo.',
      )
    throw new AppError(
      'validation',
      error.message?.length <= 400
        ? error.message
        : 'Revisa los datos de la devolución.',
    )
  }
  if (!data)
    throw new AppError(
      'network',
      'No se recibió la confirmación de la devolución. Verifica el guardado.',
    )
  return data as T
}
export const invoiceReturnDetail = (id: string) =>
  returnsRpc<InvoiceReturnDetail>('invoice_return_detail', { p_id: id })
export const recordSalesReturn = (input: SalesReturnInput) =>
  returnsRpc<SalesReturnResult>('record_sales_return', { p_input: input })

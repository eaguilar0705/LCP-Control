import type {
  ProductSaleRecord,
  ProductSalesHistoryPage,
} from '@lcp/contracts/productSalesHistory'
import { AppError } from '../../lib/errors'
import { journalRpc } from '../accounting/journalService'

export const PRODUCT_SALES_PAGE_SIZE = 20
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value))
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const amount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string =>
  typeof value === 'string' && uuid.test(value)
const statuses = new Set([
  'issued',
  'partially_returned',
  'returned',
  'cancelled',
  'removed',
])

function isSale(row: unknown): row is ProductSaleRecord {
  return (
    record(row) &&
    id(row.documentId) &&
    id(row.customerId) &&
    typeof row.number === 'string' &&
    row.number.trim().length > 0 &&
    typeof row.customerName === 'string' &&
    row.customerName.trim().length > 0 &&
    timestamp(row.createdAt) &&
    (row.currency === 'NIO' || row.currency === 'USD') &&
    (row.location === 'store' || row.location === 'warehouse') &&
    integer(row.quantity) &&
    row.quantity > 0 &&
    [
      row.unitPrice,
      row.lineTotal,
      row.originalUnitPrice,
      row.invoiceDiscount,
      row.returnedAmount,
    ].every(amount) &&
    integer(row.returnedQuantity) &&
    row.returnedQuantity <= row.quantity &&
    (row.returnedAmount as number) <= (row.lineTotal as number) &&
    typeof row.status === 'string' &&
    statuses.has(row.status) &&
    integer(row.revision) &&
    (row.cancelledAt === null || timestamp(row.cancelledAt)) &&
    (row.removedAt === null || timestamp(row.removedAt))
  )
}

/** Reject incomplete pages instead of showing a failed or malformed query as no sales. */
export function parseProductSalesHistory(
  value: unknown,
  productId: string,
  offset = 0,
  asOf: string | null = null,
  expectedTotal: number | null = null,
): ProductSalesHistoryPage {
  if (
    !record(value) ||
    value.productId !== productId ||
    !timestamp(value.asOf) ||
    (asOf !== null && Date.parse(value.asOf) !== Date.parse(asOf)) ||
    value.offset !== offset ||
    value.limit !== PRODUCT_SALES_PAGE_SIZE ||
    !integer(value.total) ||
    !Array.isArray(value.rows) ||
    value.rows.length !==
      Math.min(PRODUCT_SALES_PAGE_SIZE, Math.max(0, value.total - offset)) ||
    !value.rows.every(isSale) ||
    new Set(value.rows.map((row) => row.documentId)).size !== value.rows.length
  )
    throw new AppError(
      'unexpected',
      'No se recibió el historial completo de ventas del perfume. Vuelve a intentarlo.',
    )
  if (
    expectedTotal !== null &&
    (!integer(expectedTotal) || value.total !== expectedTotal)
  )
    throw new AppError(
      'validation',
      'El historial cambió mientras revisabas las páginas. Pulsa «Actualizar ventas» para volver al inicio.',
    )
  return value as unknown as ProductSalesHistoryPage
}

export async function readProductSalesHistory(
  productId: string,
  offset = 0,
  asOf: string | null = null,
  expectedTotal: number | null = null,
) {
  if (
    !id(productId) ||
    !integer(offset) ||
    (asOf !== null && !timestamp(asOf)) ||
    (expectedTotal !== null && !integer(expectedTotal))
  )
    throw new AppError(
      'validation',
      'Revisa el perfume y la página del historial de ventas.',
    )
  const result = await journalRpc<unknown>('product_sales_history', {
    p_product: productId,
    p_offset: offset,
    p_limit: PRODUCT_SALES_PAGE_SIZE,
    p_as_of: asOf,
    p_expected_total: expectedTotal,
  })
  return parseProductSalesHistory(
    result,
    productId,
    offset,
    asOf,
    expectedTotal,
  )
}

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Managua',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
export function productSaleDay(createdAt: string) {
  const parts = dayFormat.formatToParts(new Date(createdAt))
  const part = (type: string) =>
    parts.find((value) => value.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

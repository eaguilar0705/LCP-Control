import { supabase } from '../../lib/supabase'
import { AppError } from '../../lib/errors'
import { businessFromRow } from '../../lib/business'
import type {
  BusinessSettings,
  Currency,
  DocumentRecord,
  InventoryLocation,
  InvoicePayment,
  PaymentMethod,
  PriceTier,
  ShippingMethod,
} from '../../lib/domain'

export interface InvoiceCorrectionInput {
  requestId: string
  documentId: string
  expectedRevision: number
  customerId: string | null
  customerName: string
  customerPhone: string | null
  customerTaxId: string
  tier: PriceTier
  currency: Currency
  exchangeRate: number
  catalogRate?: number
  location: InventoryLocation
  paymentMethod: PaymentMethod | 'pending'
  payments?: InvoicePayment[]
  notes: string
  invoiceDiscount: number
  shippingMethod: ShippingMethod | null
  shippingAmount: number
  expectedTotal: number
  items: {
    productId: string
    quantity: number
    unitPrice: number
    finalUnitPrice: number
  }[]
}
interface InvoiceSnapshot {
  id: string
  revision: number
  kind: 'invoice'
  number: string
  customer_id: string
  customer_name: string
  customer_phone: string | null
  customer_tax_id: string
  issuer: BusinessSettings
  tier_code: PriceTier
  currency: Currency
  total: number
  location: InventoryLocation
  payment_method: PaymentMethod | 'pending'
  notes: string
  created_at: string
  original_total: number
  discount_amount: number
  invoice_discount: number
  catalog_rate: number | null
  shipping_method: ShippingMethod | null
  shipping_amount: number
  shipping_nio: number
  items: {
    id: string
    product_id: string
    description: string
    quantity: number
    unit_price: number
    original_unit_price: number | null
    invoice_discount: number
    line_total: number
  }[]
  costs: { exchange_rate: number }[]
  payments: {
    method: PaymentMethod
    currency: Currency
    amount: number
    exchange_rate: number
  }[]
  collections: {
    id: string
    amount: number
    currency: Currency
    exchange_rate: number
    occurred_on: string
    voided_at: string | null
    bank_ledger_account?: string | null
  }[]
}
export interface EditableInvoice extends DocumentRecord {
  revision: number
}
export interface InvoiceEditDetail {
  document: EditableInvoice
  hasReturns: boolean
  collections: InvoiceSnapshot['collections']
  history: {
    id: string
    revision: number
    actorName: string
    createdAt: string
    before: EditableInvoice
    after: EditableInvoice
  }[]
}
function invoiceFromSnapshot(raw: InvoiceSnapshot): EditableInvoice {
  if (
    !raw ||
    raw.kind !== 'invoice' ||
    !Array.isArray(raw.items) ||
    !Number.isInteger(raw.revision) ||
    !Number.isFinite(Number(raw.total))
  )
    throw new AppError(
      'unexpected',
      'No se recibió la factura completa. Actualiza el historial.',
    )
  return {
    id: raw.id,
    revision: raw.revision,
    kind: 'invoice',
    number: raw.number,
    customerId: raw.customer_id,
    customerName: raw.customer_name,
    customerPhone: raw.customer_phone,
    customerTaxId: raw.customer_tax_id ?? '',
    issuer: businessFromRow(raw.issuer),
    tier: raw.tier_code,
    currency: raw.currency,
    total: Number(raw.total),
    location: raw.location,
    validUntil: null,
    paymentMethod: raw.payment_method,
    notes: raw.notes,
    createdAt: raw.created_at,
    originalTotal: Number(raw.original_total),
    discountAmount: Number(raw.discount_amount),
    invoiceDiscount: Number(raw.invoice_discount),
    catalogRate: raw.catalog_rate === null ? null : Number(raw.catalog_rate),
    exchangeRate:
      raw.currency === 'NIO' ? 1 : Number(raw.costs[0]?.exchange_rate),
    taxRate: 0,
    shippingMethod: raw.shipping_method,
    shippingAmount: Number(raw.shipping_amount),
    shippingNio: Number(raw.shipping_nio),
    payments: raw.payments.map((p) => ({
      method: p.method,
      currency: p.currency,
      amount: Number(p.amount),
      exchangeRate: Number(p.exchange_rate),
    })),
    items: raw.items.map((i) => ({
      id: i.id,
      productId: i.product_id,
      description: i.description,
      quantity: i.quantity,
      unitPrice: Number(i.unit_price),
      originalUnitPrice: Number(i.original_unit_price ?? i.unit_price),
      invoiceDiscount: Number(i.invoice_discount),
      lineTotal: Number(i.line_total),
    })),
  }
}
async function call<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  if (!supabase)
    throw new AppError(
      'configuration',
      'La conexión con la tienda no está disponible.',
    )
  const { data, error, status } = await supabase.rpc(name, args)
  if (error) {
    if (
      status === 0 ||
      status >= 500 ||
      /fetch|network|timeout/i.test(error.message)
    )
      throw new AppError(
        'network',
        'No pudimos confirmar el guardado. Reintenta con los mismos datos para verificarlo sin duplicarlo.',
      )
    if (error.code === '42501' || status === 401 || status === 403)
      throw new AppError(
        'unauthorized',
        'Solo un SuperAdmin puede editar facturas.',
      )
    if (error.code === 'LCP429' || status === 429)
      throw new AppError(
        'rate_limited',
        'Espera un momento y vuelve a verificar la edición.',
      )
    throw new AppError(
      'validation',
      ['P0001', 'P1001', 'P1002'].includes(error.code) &&
        error.message.length <= 400
        ? error.message
        : 'Revisa los datos de la factura e inténtalo de nuevo.',
    )
  }
  if (!data)
    throw new AppError(
      'network',
      'No recibimos la confirmación. Verifica el guardado antes de cambiar los datos.',
    )
  return data as T
}
export async function getInvoiceEditDetail(
  id: string,
): Promise<InvoiceEditDetail> {
  const raw = await call<{
    document: InvoiceSnapshot
    hasReturns: boolean
    history: {
      id: string
      revision: number
      actorName: string
      createdAt: string
      before: InvoiceSnapshot
      after: InvoiceSnapshot
    }[]
  }>('invoice_edit_detail', { p_id: id })
  return {
    document: invoiceFromSnapshot(raw.document),
    hasReturns: raw.hasReturns,
    collections: raw.document.collections.filter((c) => !c.voided_at),
    history: raw.history.map((h) => ({
      ...h,
      before: invoiceFromSnapshot(h.before),
      after: invoiceFromSnapshot(h.after),
    })),
  }
}
export async function correctInvoice(
  input: InvoiceCorrectionInput,
): Promise<EditableInvoice> {
  return invoiceFromSnapshot(
    await call<InvoiceSnapshot>('correct_invoice', { p_input: input }),
  )
}

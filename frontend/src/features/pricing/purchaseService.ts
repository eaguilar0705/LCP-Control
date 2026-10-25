import type { ShipmentInput } from '@lcp/contracts/accounting'
import type { Currency } from '../../lib/domain'
import { journalRpc } from '../accounting/journalService'

export const purchaseBanks = [
  { code: '1120-001', name: 'BAC C$', currency: 'NIO' },
  { code: '1120-002', name: 'BAC US$', currency: 'USD' },
  { code: '1120-003', name: 'LAFISE C$', currency: 'NIO' },
  { code: '1120-004', name: 'LAFISE US$', currency: 'USD' },
  { code: '1120-005', name: 'Ficohsa C$', currency: 'NIO' },
  { code: '1120-006', name: 'Ficohsa US$', currency: 'USD' },
] as const
export const purchaseBankName = (code: string | null) =>
  purchaseBanks.find((bank) => bank.code === code)?.name ?? 'Banco'
export type PurchasePaymentTreatment =
  'refund' | 'recording_error' | 'keep_payments'
export const purchaseConfirmation = (treatment: PurchasePaymentTreatment) =>
  treatment === 'keep_payments'
    ? 'Confirmo que los abonos reales se aplicarán al reemplazo, sin devolver dinero.'
    : treatment === 'recording_error'
      ? 'Confirmo que los pagos originales también fueron un error de registro y deben corregirse.'
      : 'Confirmo que el proveedor devolvió los pagos a la misma caja o cuenta bancaria.'

export interface PurchaseHistoryRecord {
  id: string
  request_id: string
  incurred_on: string
  supplier: string
  agency: string
  reference: string
  note: string
  currency: Currency
  account: 'caja' | 'banco' | 'credito'
  bank_ledger_account: string | null
  exchange_rate: number
  shipping_amount: number
  goods_amount: number
  units: number
  created_at: string
  lines: {
    product_id: string
    product_name: string
    product_sku: string
    location: 'store' | 'warehouse'
    quantity: number
    unit_price: number
    landed_unit_cost_nio: number
  }[]
  before_states: {
    product_id: string
    store_before: number
    warehouse_before: number
    cost_before: number | null
  }[]
  correction: null | {
    id: string
    occurred_on: string
    reason: string
    replacement_id: string | null
    actor_name: string
    refunded_nio: number
    payment_treatment: PurchasePaymentTreatment
    reallocated_nio: number
  }
  correction_problem: string | null
  refund_nio: number
}
export interface PurchaseCorrectionInput {
  requestId: string
  shipmentId: string
  reason: string
  refundConfirmed: boolean
  paymentTreatment?: PurchasePaymentTreatment
  replacement?: Omit<ShipmentInput, 'requestId'>
}
export const correctPurchase = (input: PurchaseCorrectionInput) =>
  journalRpc<{ id: string; replacementId: string | null }>('correct_purchase', {
    p_input: input,
  })
export const readPurchases = (before?: { created_at: string; id: string }) =>
  journalRpc<PurchaseHistoryRecord[]>('purchase_history', {
    p_before: before?.created_at ?? null,
    p_before_id: before?.id ?? null,
  })

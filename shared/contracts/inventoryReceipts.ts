import type { ShipmentInput, ShipmentLineInput } from './accounting'

/** Received goods remain outside saleable stock and the ledger until review. */
export type InventoryReceiptInput = Omit<
  ShipmentInput,
  'account' | 'bankLedgerAccount'
>

export interface InventoryReceiptRecord extends Omit<
  InventoryReceiptInput,
  'requestId' | 'lines'
> {
  id: string
  revision: number
  status: 'pending' | 'posted' | 'cancelled'
  createdAt: string
  createdBy: string
  createdByName: string
  reviewedAt: string | null
  reviewedByName: string | null
  shipmentId: string | null
  cancelReason: string | null
  units: number
  lines: (ShipmentLineInput & { productName: string; sku: string })[]
  posting?: {
    incurredOn: string
    currency: ShipmentInput['currency']
    exchangeRate: number
    goodsAmount: number
    shippingAmount: number
    account: 'caja' | 'banco' | 'credito'
    bankLedgerAccount: string | null
    corrected: boolean
  } | null
}

export interface InventoryReceiptPage {
  receipts: InventoryReceiptRecord[]
  hasMore: boolean
}

export interface PostInventoryReceiptInput {
  requestId: string
  receiptId: string
  expectedRevision: number
  purchase: Omit<ShipmentInput, 'requestId'>
}

export interface CancelInventoryReceiptInput {
  requestId: string
  receiptId: string
  expectedRevision: number
  reason: string
}

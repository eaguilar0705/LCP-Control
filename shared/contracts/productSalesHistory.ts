import type { Currency, InventoryLocation } from './domain'

export type ProductSaleStatus =
  'issued' | 'partially_returned' | 'returned' | 'cancelled' | 'removed'

/** One authoritative invoice line for a product; amounts stay in invoice currency. */
export interface ProductSaleRecord {
  documentId: string
  number: string
  createdAt: string
  customerId: string
  customerName: string
  currency: Currency
  location: InventoryLocation
  quantity: number
  /** Effective unit price after the line's share of the invoice discount, up to six decimals. */
  unitPrice: number
  lineTotal: number
  originalUnitPrice: number
  /** The discount allocated to this product's line, in the invoice currency. */
  invoiceDiscount: number
  returnedQuantity: number
  returnedAmount: number
  status: ProductSaleStatus
  revision: number
  cancelledAt: string | null
  removedAt: string | null
}

export interface ProductSalesHistoryPage {
  productId: string
  asOf: string
  offset: number
  limit: number
  total: number
  rows: ProductSaleRecord[]
}

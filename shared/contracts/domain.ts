export const paymentMethods = [
  'cash',
  'card_pos',
  'bank_transfer',
  'bac_nio',
  'bac_usd',
  'lafise_nio',
  'lafise_usd',
  'ficohsa_nio',
  'ficohsa_usd',
] as const

export type UserRole =
  'superadmin' | 'admin' | 'operator' | 'warehouse' | 'viewer'

export interface UserProfile {
  id: string
  email: string
  role: UserRole | null
}

export type Currency = 'NIO' | 'USD'

export type InventoryLocation = 'warehouse' | 'store'

export type Category = 'arabian' | 'designer' | 'niche' | 'unspecified'

export type Gender = 'male' | 'female' | 'unisex' | 'unspecified'

export type PriceTier = 'emprendedor' | 'vip' | 'premium'

/**
 * Un cambio de precio de una lista. `beforeUsd` en nulo es el precio con el que
 * el perfume entró al catálogo: no hubo un precio anterior que mostrar.
 */
export interface PriceChange {
  changedAt: string
  actor: string
  tier: PriceTier
  beforeUsd: number | null
  afterUsd: number
  beforeNio: number | null
  afterNio: number
  catalogRate: number | null
  /** Porcentaje de ganancia configurado en la lista. Nulo en una lista a mano. */
  markup?: number | null
  /**
   * Costo promedio (C$) sobre el que se calculó el precio. Nulo si la lista no
   * salió del costo: a mano o pendiente de costo.
   */
  averageCost?: number | null
  /** Precio de compra sobre el que se calculó el precio de la lista. */
  purchasePrice?: number | null
  purchaseCurrency?: Currency | null
  /** El sistema lo cambió solo (registros del 27-09 al 02-10-2026). */
  automatic?: boolean
  /** Por qué cambió el costo: una compra, el costo inicial, una factura eliminada… */
  cause?: PriceChangeCause | null
  /** El pedido, la factura o el respaldo que lo produjo. */
  causeReference?: string | null
}

export type PriceChangeCause =
  'purchase' | 'opening_cost' | 'invoice_deleted' | 'migration' | 'cost'

/**
 * Precio de compra del perfume y cuánto se le gana en cada lista sobre él. Una
 * lista con porcentaje se calcula sola en cuanto hay precio de compra; una sin
 * porcentaje conserva su precio a mano. Sólo lo leen los dueños.
 */
export interface PricingInput {
  /** Lo que el dueño pagó por cada unidad; `null` mientras no se escriba. */
  purchasePrice: number | null
  purchaseCurrency: Currency
  /** Porcentaje de ganancia sobre el precio de compra, por lista. */
  markups: Record<PriceTier, number | null>
}

export interface ProductPricing extends PricingInput {
  productId: string
  /**
   * Costo promedio vigente en córdobas (seis decimales), el de la contabilidad
   * del inventario. `null` mientras no se conozca. No interviene en el precio
   * de venta: sirve para el margen y el inventario valorado.
   */
  averageCost: number | null
  updatedAt: string | null
}

/**
 * Los porcentajes y costos de todo el catálogo. `available` es falso mientras
 * la base no tenga la actualización que los guarda: la pantalla lo dice en
 * lugar de fallar.
 */
export interface PricingList {
  available: boolean
  rows: ProductPricing[]
}

export type PaymentMethod = (typeof paymentMethods)[number]

export interface Product {
  revision?: number
  imagePath?: string | null
  id: string
  barcode: string
  barcodeKind?: 'internal' | 'manufacturer'
  manufacturerBarcode?: string | null
  name: string
  brand: string
  category: Category
  gender: Gender
  size: number | null
  unit: 'ml' | 'oz'
  price: number
  currency: Currency
  minimumStock: number | null
  active: boolean
  prices?: Record<PriceTier, Record<Currency, number>>
  imageUrl?: string | null
  imageSource?: string | null
  availabilityNote?: string
  sourceRow?: number
  sizeSource?: string
}

export interface InventoryItem {
  product: Product
  quantities: Record<InventoryLocation, number | null>
}

export interface BusinessSettings {
  name: string
  address: string
  phone: string
  legalName?: string
  taxId?: string
  email?: string
  branch?: string
  billingDetails?: string
}

/**
 * Tasa propuesta, no histórica: cada factura, compra y gasto guarda la suya al
 * registrarse. Cambiarla aquí no altera ninguna operación ya emitida.
 */
export interface ExchangeRate {
  usdToNio: number
  updatedAt: string | null
}

export interface CustomerRecord {
  id: string
  name: string
  phone: string | null
  priceTier: PriceTier
}

// Facturas descuentan inventario; las proformas sólo cotizan. El tipo nunca se
// deduce del contenido: viaja explícito desde la pantalla hasta PostgreSQL.
export type DocumentKind = 'invoice' | 'proforma'

export interface DocumentItemRecord {
  id: string
  productId: string
  description: string
  quantity: number
  unitPrice: number
  lineTotal: number
}

export interface DocumentRecord {
  /** NIO per unit of document currency, saved at issuance. */
  exchangeRate?: number | null
  /**
   * Tasa con la que se cotizó el catálogo el día de la emisión. Es otra cosa
   * que `exchangeRate`, que es la conversión contable: una factura en córdobas
   * convierte a 1 para la contabilidad y aun así necesita ésta para imprimir su
   * equivalente en dólares.
   */
  catalogRate?: number | null
  /** Percentage included in the displayed selling prices. */
  taxRate?: number
  previewKind?: 'draft' | 'example'
  customerTaxId?: string
  id: string
  kind: DocumentKind
  number: string
  customerId: string
  customerName: string
  customerPhone: string | null
  issuer: BusinessSettings
  tier: PriceTier
  currency: Currency
  total: number
  location: InventoryLocation | null
  validUntil: string | null
  paymentMethod: PaymentMethod | 'pending' | null
  notes: string
  createdAt: string
  items: DocumentItemRecord[]
}

export interface NewDocumentItem {
  productId: string
  quantity: number
  expectedUnitPrice?: number
}

export interface NewDocument {
  expectedTotal?: number
  exchangeRate?: number
  taxRate?: number
  customerTaxId?: string
  requestId: string
  kind: DocumentKind
  customerId?: string | null
  customerName?: string
  customerPhone?: string | null
  tier: PriceTier
  currency: Currency
  location?: InventoryLocation | null
  paymentMethod?: PaymentMethod | 'pending' | null
  validUntil?: string | null
  notes: string
  items: NewDocumentItem[]
}

export interface MovementRequest {
  requestId: string
  productId: string
  location: InventoryLocation
  type: 'ENTRY' | 'EXIT' | 'DAMAGED' | 'ADJUSTMENT'
  quantity: number
  reference?: string
  note: string
}

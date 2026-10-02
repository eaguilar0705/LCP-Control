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
  /**
   * Precio de compra del modelo anterior (hasta el 27-09-2026), sólo en los
   * registros viejos que se calcularon con él.
   */
  purchasePrice?: number | null
  purchaseCurrency?: Currency | null
  /** El sistema lo cambió solo al cambiar el costo promedio. */
  automatic?: boolean
  /** Por qué cambió el costo: una compra, el costo inicial, una factura eliminada… */
  cause?: PriceChangeCause | null
  /** El pedido, la factura o el respaldo que lo produjo. */
  causeReference?: string | null
}
export type PriceChangeCause =
  'purchase' | 'opening_cost' | 'invoice_deleted' | 'migration' | 'cost'
/**
 * Cuánto se le gana a cada lista sobre el costo promedio del inventario. Una
 * lista con porcentaje se calcula sola en cuanto el perfume tiene costo; una
 * sin porcentaje conserva su precio a mano. Sólo lo leen los dueños.
 */
export interface PricingInput {
  /** Porcentaje de ganancia sobre el costo promedio, por lista. */
  markups: Record<PriceTier, number | null>
}
export interface ProductPricing extends PricingInput {
  productId: string
  /**
   * Costo promedio vigente en córdobas (seis decimales), el de la contabilidad
   * del inventario. `null` mientras no se conozca. Es de sólo lectura: cambia
   * con las compras y el costo inicial, nunca desde la pantalla de precios.
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
export const bankTransferLabels = {
  bac_nio: 'Bac C$',
  bac_usd: 'Bac $',
  lafise_nio: 'LAFISE C$',
  lafise_usd: 'LAFISE $',
  ficohsa_nio: 'Ficohsa C$',
  ficohsa_usd: 'Ficohsa $',
} as const
export const paymentMethods = [
  'cash', 'card_pos', 'bank_transfer',
  'bac_nio', 'bac_usd', 'lafise_nio', 'lafise_usd', 'ficohsa_nio', 'ficohsa_usd',
] as const
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
}
export interface NewDocument {
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
export const labels = {
  category: {
    arabian: 'Árabe',
    designer: 'Diseñador',
    niche: 'Nicho',
    unspecified: 'Por confirmar',
  },
  gender: {
    male: 'Masculino',
    female: 'Femenino',
    unisex: 'Unisex',
    unspecified: 'Por confirmar',
  },
  location: { warehouse: 'Bodega', store: 'Tienda' },
  payment: {
    cash: 'Efectivo',
    card_pos: 'POS / Tarjeta',
    bank_transfer: 'Transferencia bancaria',
    ...bankTransferLabels,
  },
  documentKind: { invoice: 'Factura', proforma: 'Proforma' },
}
/**
 * Política de cambios y devoluciones que se imprime al pie de cada factura
 * (no en proformas), en la vista HTML y en el PDF.
 */
export const returnPolicy = {
  title: 'Política de cambios y devoluciones:',
  text: 'Por favor, revise su producto antes de retirarse de la tienda. Una vez entregado y verificado, no se realizan cambios ni devoluciones por preferencia personal, aroma o elección del producto.\n\nEn caso de presentar un posible defecto de fabricación, el producto deberá ser llevado a nuestra sucursal para su revisión. Luego de la evaluación, se determinará si cumple con las condiciones para realizar el cambio correspondiente.\n\nEl producto deberá conservar su empaque, presentación y contenido en las condiciones en que fue entregado. La presentación de esta factura será necesaria para cualquier solicitud de revisión o cambio.',
} as const

export const documentCopy: Record<
  DocumentKind,
  {
    title: string
    singular: string
    plural: string
    stamp: string
    prefix: string
    subtitle: string
    notice: string
  }
> = {
  invoice: {
    title: 'Facturación',
    singular: 'factura',
    plural: 'facturas',
    stamp: 'FACTURA',
    prefix: 'FAC-',
    subtitle: 'Cobra y descuenta del inventario.',
    notice:
      'Al emitirla se descuentan las existencias y se registra el impuesto incluido según la tasa indicada. Es un documento de control administrativo, no un comprobante fiscal.',
  },
  proforma: {
    title: 'Proformas',
    singular: 'proforma',
    plural: 'proformas',
    stamp: 'PROFORMA',
    prefix: 'PRO-',
    subtitle: 'Cotiza sin cobrar ni mover inventario.',
    notice:
      'Es una cotización con vigencia. No cobra, no descuenta existencias y no sustituye a una factura. Los precios rigen hasta la fecha de vigencia indicada.',
  },
}

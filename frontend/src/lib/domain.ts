export { paymentMethods } from '@lcp/contracts/domain'
import type { DocumentKind } from '@lcp/contracts/domain'
export type {
  UserRole,
  UserProfile,
  Currency,
  InventoryLocation,
  Category,
  Gender,
  PriceTier,
  PriceTierDefinition,
  NewPriceTier,
  PriceListSave,
  PriceChange,
  PriceChangeCause,
  PricingInput,
  ProductPricing,
  PricingList,
  PaymentMethod,
  Product,
  InventoryItem,
  BusinessSettings,
  ExchangeRate,
  CustomerRecord,
  DocumentKind,
  DocumentItemRecord,
  DocumentRecord,
  InvoicePayment,
  NewDocumentItem,
  NewDocument,
  MovementRequest,
} from '@lcp/contracts/domain'

export const bankTransferLabels = {
  bac_nio: 'Bac C$',
  bac_usd: 'Bac $',
  lafise_nio: 'LAFISE C$',
  lafise_usd: 'LAFISE $',
  ficohsa_nio: 'Ficohsa C$',
  ficohsa_usd: 'Ficohsa $',
} as const
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
  }
> = {
  invoice: {
    title: 'Facturación',
    singular: 'factura',
    plural: 'facturas',
    stamp: 'FACTURA',
    prefix: 'FAC-',
  },
  proforma: {
    title: 'Proformas',
    singular: 'proforma',
    plural: 'proformas',
    stamp: 'PROFORMA',
    prefix: 'PRO-',
  },
}

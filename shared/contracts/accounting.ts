import type { Currency, InventoryLocation, PriceTier } from './domain'

/** Accounting values use NIO; every USD transaction carries its own saved rate. */

/**
 * La mercadería entra por agencia de envíos: una caja con varios perfumes donde
 * lo único que se paga aparte del proveedor es el peso del paquete. Por eso un
 * pedido tiene un solo costo de envío y tantos renglones como perfumes traiga,
 * cada uno con su precio original ya negociado.
 */
export interface ShipmentLineInput {
  productId: string
  location: InventoryLocation
  quantity: number
  unitPrice: number
}

export interface ShipmentInput {
  requestId: string
  incurredOn: string
  /** A quién se le compró la mercadería. */
  supplier: string
  /** Agencia que cobró el peso del paquete. */
  agency: string
  reference: string
  note: string
  currency: Currency
  exchangeRate: number
  /** Lo que cobró la agencia por el peso de todo el pedido. */
  shippingAmount: number
  lines: ShipmentLineInput[]
  /** Con qué se pagó: caja, banco o a crédito del proveedor. */
  account?: 'caja' | 'banco' | 'credito'
}

export interface OpeningCostInput {
  requestId: string
  productId: string
  unitCost: number
  currency: Currency
  exchangeRate: number
  note: string
}

export type ExpenseAccount =
  'impuestos' | 'prestamos' | 'financieros' | 'ventas' | 'operativos'

export type ExpenseCategory =
  | 'impuestos_dgi'
  | 'impuestos_alma'
  | 'prestamo_acreedor'
  | 'prestamo_bancario'
  | 'interes_bancario'
  | 'interes_acreedor'
  | 'renta'
  | 'salario'
  | 'papeleria'
  | 'combustible'
  | 'agua_luz'
  | 'internet'
  | 'limpieza'
  | 'mobiliario'
  | 'viatico'
  | 'marketing'

export interface ExpenseInput {
  requestId: string
  incurredOn: string
  category: ExpenseCategory
  description: string
  amount: number
  currency: Currency
  exchangeRate: number
  reference: string
  /** De dónde salió el dinero. */
  account?: 'caja' | 'banco'
}

export interface ShipmentLine extends ShipmentLineInput {
  id: string
  /** Precio original del renglón, sin el envío. */
  goodsAmount: number
  /** Parte del peso que le tocó a este renglón, en la moneda del pedido. */
  shippingShare: number
  /** Precio original más su parte del envío, ya en córdobas. */
  landedUnitCostNio: number
}

export interface ShipmentRecord extends Omit<ShipmentInput, 'lines'> {
  id: string
  createdAt: string
  units: number
  goodsAmount: number
  shippingPerUnit: number
  lines: ShipmentLine[]
}

export interface ExpenseRecord extends ExpenseInput {
  id: string
  createdAt: string
  voidedAt: string | null
  voidReason: string | null
}

export interface AverageCost {
  productId: string
  averageCostNio: number | null
  updatedAt: string
}

export interface SaleCostSnapshot {
  documentId: string
  productId: string
  quantity: number
  unitCostNio: number | null
  netRevenueNio: number | null
  taxNio: number | null
}

export interface AccountingSource {
  available: boolean
  costs: AverageCost[]
  shipments: ShipmentRecord[]
  expenses: ExpenseRecord[]
  saleCosts: SaleCostSnapshot[]
  movementCosts?: {
    movementId: string
    productId: string
    type: string
    quantity: number
    unitCostNio: number | null
    createdAt: string
  }[]
  truncated: boolean
}

/**
 * La parte del libro que crece con las ventas: renglones facturados con su
 * costo congelado, y salidas de inventario con el suyo. La base de datos la
 * calcula igual en `public.report_digest`; esta versión la usan la vista local
 * y el respaldo cuando esa función todavía no está instalada.
 */
export interface LedgerTotals {
  revenueNio: number
  salesTaxNio: number
  costOfSalesNio: number
  missingCostUnits: number
  missingRevenueLines: number
  soldUnits: number
  inventoryWriteOffNio: number
  missingWriteOffUnits: number
}

export interface LedgerProduct {
  productId: string
  description: string
  quantity: number
  netRevenueNio: number
  costNio: number
  missingUnits: number
}

export interface LedgerTier {
  tier: PriceTier
  netRevenueNio: number
  costNio: number
  missingUnits: number
}

export interface LedgerPeriod extends LedgerTotals {
  products: LedgerProduct[]
  tiers: LedgerTier[]
}

export interface LedgerDigest extends LedgerPeriod {
  /** Meses con movimiento dentro del periodo, recortados a él. */
  months: (LedgerTotals & { month: string })[]
  /** `rows` trae las mayores; `count` y `lossNio` cuentan todas. */
  belowCost: { count: number; lossNio: number; rows: BelowCostSale[] }
}

export interface BelowCostSale {
  documentId: string
  number: string
  createdAt: string
  productId: string
  description: string
  quantity: number
  netRevenueNio: number
  costNio: number
  lossNio: number
}

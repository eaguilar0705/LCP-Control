import type {
  Currency,
  DocumentKind,
  InventoryItem,
  InventoryLocation,
  PaymentMethod,
  PriceTier,
} from './domain'
import type { AccountingSource } from './accounting'

/**
 * Los reportes se calculan en el navegador a partir de los documentos del
 * periodo; no hay tablas de resumen que mantener al día ni que puedan quedar
 * desincronizadas de los documentos emitidos. Cada cifra sale de las mismas
 * filas que el historial.
 *
 * Las ventas comerciales se muestran por moneda original. La proyección
 * contable separada usa los tipos de cambio guardados al registrar operaciones.
 */

export interface ReportItem {
  productId: string
  description: string
  quantity: number
  lineTotal: number
}

export interface ReportDocument {
  id: string
  kind: DocumentKind
  number: string
  createdAt: string
  currency: Currency
  total: number
  tier: PriceTier
  paymentMethod: PaymentMethod | 'pending' | null
  location: InventoryLocation | null
  customerId: string
  customerName: string
  items: ReportItem[]
}

export interface ReportCustomer {
  id: string
  name: string
  createdAt: string
}

export interface ReportMovement {
  id?: string
  beforeQuantity?: number | null
  afterQuantity?: number
  productId: string
  type: string
  quantity: number
  createdAt: string
}

export interface ReportSource {
  /** Separate administrative projection; never exposed by catalogue reads. */
  accounting?: AccountingSource
  documents: ReportDocument[]
  customers: ReportCustomer[]
  movements: ReportMovement[]
  inventory: InventoryItem[]
  /**
   * Tramo realmente consultado, más ancho que el periodo elegido: incluye el
   * periodo anterior para poder comparar. `inRange` acota lo que necesite cada
   * cálculo.
   */
  window: ReportRange
  /** La consulta alcanzó su límite: el periodo tiene más documentos. */
  truncated: boolean
}

export interface ReportRange {
  from: string
  to: string
}

export interface Summary {
  revenue: number
  count: number
  average: number
  units: number
  customers: number
}

export interface DayPoint {
  day: string
  revenue: number
  count: number
}

export interface ProductSales {
  productId: string
  description: string
  quantity: number
  revenue: number
}

export interface Share {
  key: string
  label: string
  value: number
  count: number
}

export interface MovementSummary {
  entries: number
  exits: number
  damaged: number
  adjustments: number
  sales: number
}

/** Compras de cada cliente en la ventana: lo que hace falta para su ritmo. */
export interface CustomerVisits {
  id: string
  name: string
  orders: number
  firstDay: string
  lastDay: string
  /** Días distintos con compra: dos facturas el mismo día son una visita. */
  distinctDays: number
}

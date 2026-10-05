import type { Currency, InventoryItem } from './domain'
import type { AccountingSource, LedgerDigest } from './accounting'
import type {
  CustomerVisits,
  DayPoint,
  MovementSummary,
  ProductSales,
  ReportRange,
} from './reports'

export interface SalesTotals {
  revenue: number
  count: number
  units: number
  /** Clientes distintos que compraron. */
  customers: number
}

export interface DigestShare {
  key: string
  value: number
  count: number
}

export interface DigestLapsed {
  id: string
  name: string
  lastPurchase: string
  previousRevenue: number
  orders: number
}

export interface CurrencyDigest {
  current: SalesTotals
  previous: SalesTotals
  /** Proformas del periodo y cuántas terminaron en factura del mismo cliente. */
  proformas: number
  converted: number
  /** Sólo los días con ventas; la serie completa se rellena al mostrarla. */
  days: DayPoint[]
  weekdays: { weekday: number; revenue: number; count: number }[]
  payments: DigestShare[]
  tiers: DigestShare[]
  /** Todos los productos vendidos, del que más ingresó al que menos. */
  products: ProductSales[]
  newCustomers: number
  returning: number
  topCustomers: { id: string; name: string; revenue: number; count: number }[]
  lapsed: DigestLapsed[]
  visits: CustomerVisits[]
}

export interface MovementDigest extends MovementSummary {
  damagedByProduct: { productId: string; units: number }[]
}

export interface ReportData {
  range: ReportRange
  sales: Record<Currency, CurrencyDigest>
  movements: MovementDigest
  /** `null` sin permiso de contabilidad o sin el módulo instalado. */
  ledger: LedgerDigest | null
  /** Pedidos, gastos y costos promedio: pocas filas, se leen completas. */
  accounting: AccountingSource
  inventory: InventoryItem[]
  /** Sólo en el cálculo del navegador: alguna consulta llegó a su tope. */
  truncated: boolean
  /** Dónde se sumaron las ventas. */
  computedIn: 'database' | 'browser'
}

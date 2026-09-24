import type {
  Currency,
  DocumentKind,
  InventoryItem,
  InventoryLocation,
  PaymentMethod,
  PriceTier,
} from '../../lib/domain'
import { productPrice } from '../../lib/pricing'
import { totalStock } from '../inventory/model'
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

const MANAGUA = 'America/Managua'

/** Fecha local del negocio (yyyy-mm-dd) de una marca de tiempo UTC. */
export function localDay(value: string | Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MANAGUA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

export function addDays(day: string, amount: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

/** Días del rango, ambos extremos incluidos. Vacío si el rango está invertido. */
export function daysInRange({ from, to }: ReportRange): string[] {
  const days: string[] = []
  for (let day = from; day <= to; day = addDays(day, 1)) {
    days.push(day)
    if (days.length > 400) break // Un rango absurdo no debe colgar la pantalla.
  }
  return days
}

/**
 * Cambia un extremo del periodo sin dejarlo invertido: si «Desde» pasa de
 * «Hasta» (o al revés), el otro extremo se mueve al mismo día. Un rango
 * invertido no traía datos y la pantalla lo presentaba como un periodo en cero.
 */
export function adjustRange(
  range: ReportRange,
  edge: 'from' | 'to',
  day: string,
): ReportRange {
  const next = { ...range, [edge]: day }
  // Invertido: el extremo que no se tocó se alinea con el día elegido.
  return next.from <= next.to ? next : { from: day, to: day }
}

export function presetRange(preset: Preset, today = localDay(new Date())) {
  const spans: Record<Preset, number> = {
    '7d': 6,
    '30d': 29,
    '90d': 89,
    '365d': 364,
  }
  return { from: addDays(today, -spans[preset]), to: today }
}
export type Preset = '7d' | '30d' | '90d' | '365d'
export const presetLabels: Record<Preset, string> = {
  '7d': 'Últimos 7 días',
  '30d': 'Últimos 30 días',
  '90d': 'Últimos 90 días',
  '365d': 'Último año',
}

export function invoices(documents: ReportDocument[], currency: Currency) {
  return documents.filter(
    (document) => document.kind === 'invoice' && document.currency === currency,
  )
}

/** Monedas con al menos una factura, para no dibujar paneles vacíos. */
export function currenciesWithSales(documents: ReportDocument[]): Currency[] {
  return (['NIO', 'USD'] as Currency[]).filter(
    (currency) => invoices(documents, currency).length > 0,
  )
}

export interface Summary {
  revenue: number
  count: number
  average: number
  units: number
  customers: number
}
export function summary(
  documents: ReportDocument[],
  currency: Currency,
): Summary {
  const sold = invoices(documents, currency)
  const revenue = sold.reduce((sum, document) => sum + document.total, 0)
  return {
    revenue,
    count: sold.length,
    average: sold.length ? revenue / sold.length : 0,
    units: sold.reduce(
      (sum, document) =>
        sum + document.items.reduce((count, item) => count + item.quantity, 0),
      0,
    ),
    customers: new Set(sold.map((document) => document.customerId)).size,
  }
}

export interface DayPoint {
  day: string
  revenue: number
  count: number
}
/** Serie diaria completa: los días sin ventas valen cero, no se omiten. */
export function revenueByDay(
  documents: ReportDocument[],
  currency: Currency,
  range: ReportRange,
): DayPoint[] {
  const byDay = new Map<string, DayPoint>()
  for (const day of daysInRange(range))
    byDay.set(day, { day, revenue: 0, count: 0 })
  for (const document of invoices(documents, currency)) {
    const point = byDay.get(localDay(document.createdAt))
    if (!point) continue
    point.revenue += document.total
    point.count += 1
  }
  return [...byDay.values()]
}

export interface ProductSales {
  productId: string
  description: string
  quantity: number
  revenue: number
}
export function topProducts(
  documents: ReportDocument[],
  currency: Currency,
  limit = 10,
): ProductSales[] {
  const byProduct = new Map<string, ProductSales>()
  for (const document of invoices(documents, currency))
    for (const item of document.items) {
      const current = byProduct.get(item.productId) ?? {
        productId: item.productId,
        description: item.description,
        quantity: 0,
        revenue: 0,
      }
      current.quantity += item.quantity
      current.revenue += item.lineTotal
      byProduct.set(item.productId, current)
    }
  return [...byProduct.values()]
    .sort((a, b) => b.revenue - a.revenue || b.quantity - a.quantity)
    .slice(0, limit)
}

export const paymentLabels: Record<string, string> = {
  cash: 'Efectivo',
  card_pos: 'POS / Tarjeta',
  bank_transfer: 'Transferencia',
  pending: 'Pendiente de pago',
}
export interface Share {
  key: string
  label: string
  value: number
  count: number
}
export function paymentBreakdown(
  documents: ReportDocument[],
  currency: Currency,
): Share[] {
  const byMethod = new Map<string, Share>()
  for (const document of invoices(documents, currency)) {
    const key = document.paymentMethod ?? 'pending'
    const current = byMethod.get(key) ?? {
      key,
      label: paymentLabels[key] ?? key,
      value: 0,
      count: 0,
    }
    current.value += document.total
    current.count += 1
    byMethod.set(key, current)
  }
  // Orden fijo: el color sigue a la forma de pago, no a su posición en el mes.
  return Object.keys(paymentLabels)
    .map((key) => byMethod.get(key))
    .filter((share): share is Share => !!share)
}

export const tierLabels: Record<PriceTier, string> = {
  emprendedor: 'Emprendedor',
  vip: 'VIP',
  premium: 'Premium',
}
export function tierBreakdown(
  documents: ReportDocument[],
  currency: Currency,
): Share[] {
  const byTier = new Map<string, Share>()
  for (const document of invoices(documents, currency)) {
    const current = byTier.get(document.tier) ?? {
      key: document.tier,
      label: tierLabels[document.tier],
      value: 0,
      count: 0,
    }
    current.value += document.total
    current.count += 1
    byTier.set(document.tier, current)
  }
  return (Object.keys(tierLabels) as PriceTier[])
    .map((tier) => byTier.get(tier))
    .filter((share): share is Share => !!share)
}

export interface CustomerActivity {
  newCustomers: number
  returning: number
  /** Clientes que más compraron en el periodo, por importe. */
  top: { id: string; name: string; revenue: number; count: number }[]
}
/**
 * «Nuevo» es el cliente registrado dentro del periodo; «recurrente», el que ya
 * existía antes y volvió a comprar. Se mide sobre quienes compraron, no sobre
 * el total de fichas, para que la cifra hable de ventas y no del directorio.
 */
export function customerActivity(
  documents: ReportDocument[],
  customers: ReportCustomer[],
  currency: Currency,
  range: ReportRange,
): CustomerActivity {
  const created = new Map(
    customers.map((customer) => [customer.id, localDay(customer.createdAt)]),
  )
  const byCustomer = new Map<
    string,
    { id: string; name: string; revenue: number; count: number }
  >()
  for (const document of invoices(documents, currency)) {
    const current = byCustomer.get(document.customerId) ?? {
      id: document.customerId,
      name: document.customerName,
      revenue: 0,
      count: 0,
    }
    current.revenue += document.total
    current.count += 1
    byCustomer.set(document.customerId, current)
  }
  let newCustomers = 0
  for (const id of byCustomer.keys()) {
    const day = created.get(id)
    if (day && day >= range.from && day <= range.to) newCustomers += 1
  }
  return {
    newCustomers,
    returning: byCustomer.size - newCustomers,
    top: [...byCustomer.values()]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8),
  }
}

export interface InventoryHealth {
  available: number
  low: number
  out: number
  uncounted: number
  units: number
  /** Valor a precio de lista, sólo orientativo: no es el costo de compra. */
  listValue: number
}
export function inventoryHealth(
  items: InventoryItem[],
  tier: PriceTier,
  currency: Currency,
): InventoryHealth {
  const health: InventoryHealth = {
    available: 0,
    low: 0,
    out: 0,
    uncounted: 0,
    units: 0,
    listValue: 0,
  }
  for (const item of items) {
    const total = totalStock(item)
    if (total === null) {
      health.uncounted += 1
      continue
    }
    health.units += total
    const price = productPrice(item.product, tier, currency)
    if (price !== null) health.listValue += price * total
    if (total === 0) health.out += 1
    else if (
      item.product.minimumStock !== null &&
      total < item.product.minimumStock
    )
      health.low += 1
    else health.available += 1
  }
  return health
}

export interface MovementSummary {
  entries: number
  exits: number
  damaged: number
  adjustments: number
  sales: number
}
export function movementSummary(movements: ReportMovement[]): MovementSummary {
  const totals: MovementSummary = {
    entries: 0,
    exits: 0,
    damaged: 0,
    adjustments: 0,
    sales: 0,
  }
  for (const movement of movements) {
    const quantity = Math.abs(movement.quantity)
    if (movement.type === 'ENTRY') totals.entries += quantity
    else if (movement.type === 'EXIT') totals.exits += quantity
    else if (movement.type === 'DAMAGED') totals.damaged += quantity
    else if (movement.type === 'ADJUSTMENT') totals.adjustments += 1
    else if (movement.type === 'SALE') totals.sales += quantity
  }
  return totals
}

export function proformaCount(documents: ReportDocument[], currency: Currency) {
  return documents.filter(
    (document) =>
      document.kind === 'proforma' && document.currency === currency,
  ).length
}

/* -------------------------------------------------------------------------
   Fase 1: lecturas que no necesitan ningún dato nuevo en la base.

   Varias de ellas comparan el periodo con el anterior o buscan clientes que
   dejaron de comprar, así que el proveedor carga una ventana más ancha que el
   rango elegido: desde el inicio del periodo previo. `inRange` es lo que
   separa una cosa de la otra, y toda función que reciba documentos espera que
   ya vengan acotados.
   ------------------------------------------------------------------------- */

/** Periodo inmediatamente anterior, de la misma duración. */
export function previousRange(range: ReportRange): ReportRange {
  const length = daysInRange(range).length || 1
  return {
    from: addDays(range.from, -length),
    to: addDays(range.from, -1),
  }
}

export function inRange(documents: ReportDocument[], range: ReportRange) {
  return documents.filter((document) => {
    const day = localDay(document.createdAt)
    return day >= range.from && day <= range.to
  })
}

export function movementsInRange(movements: ReportMovement[], range: ReportRange) {
  return movements.filter((row) => {
    const day = localDay(row.createdAt)
    return day >= range.from && day <= range.to
  })
}

/**
 * Variación proporcional entre dos cifras. Devuelve `null` cuando no hay base
 * de comparación: partir de cero y llegar a algo no es «un aumento del 100 %»,
 * es un periodo que no existía.
 */
export function change(current: number, previous: number): number | null {
  if (previous === 0) return null
  return (current - previous) / previous
}

export interface Coverage {
  productId: string
  description: string
  stock: number
  perDay: number
  /** Días que duran las existencias al ritmo del periodo. */
  days: number
}
/**
 * Qué reponer y con cuánta urgencia. Sólo entran productos que se vendieron y
 * tienen conteo: sin ventas no hay ritmo que proyectar, y sin conteo no se sabe
 * qué queda.
 */
export function stockCoverage(
  documents: ReportDocument[],
  inventory: InventoryItem[],
  range: ReportRange,
  currency: Currency,
  limit = 10,
): Coverage[] {
  const days = daysInRange(range).length || 1
  const sold = new Map<string, number>()
  for (const document of invoices(documents, currency))
    for (const item of document.items)
      sold.set(item.productId, (sold.get(item.productId) ?? 0) + item.quantity)

  const rows: Coverage[] = []
  for (const item of inventory) {
    const units = sold.get(item.product.id)
    const stock = totalStock(item)
    if (!units || stock === null) continue
    const perDay = units / days
    rows.push({
      productId: item.product.id,
      description: `${item.product.brand} · ${item.product.name}`,
      stock,
      perDay,
      days: perDay > 0 ? stock / perDay : Infinity,
    })
  }
  return rows.sort((a, b) => a.days - b.days).slice(0, limit)
}

export interface IdleProduct {
  productId: string
  description: string
  stock: number
  listValue: number
}
/** Existencias que no se movieron en el periodo: capital detenido en bodega. */
export function idleStock(
  documents: ReportDocument[],
  inventory: InventoryItem[],
  tier: PriceTier,
  currency: Currency,
  limit = 10,
): IdleProduct[] {
  const sold = new Set<string>()
  for (const document of documents.filter((row) => row.kind === 'invoice'))
    for (const item of document.items) sold.add(item.productId)

  const rows: IdleProduct[] = []
  for (const item of inventory) {
    const stock = totalStock(item)
    if (stock === null || stock <= 0 || sold.has(item.product.id)) continue
    const price = productPrice(item.product, tier, currency) ?? 0
    rows.push({
      productId: item.product.id,
      description: `${item.product.brand} · ${item.product.name}`,
      stock,
      listValue: price * stock,
    })
  }
  return rows.sort((a, b) => b.listValue - a.listValue).slice(0, limit)
}

/** Parte del total que aportan los `top` mayores valores, entre 0 y 1. */
export function concentration(values: number[], top: number): number | null {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return null
  const head = [...values]
    .sort((a, b) => b - a)
    .slice(0, top)
    .reduce((sum, value) => sum + value, 0)
  return head / total
}

export interface LapsedCustomer {
  id: string
  name: string
  lastPurchase: string
  daysSince: number
  previousRevenue: number
  orders: number
}
/**
 * Clientes que compraron en el periodo anterior y no en éste. Es una lista para
 * llamar, así que se ordena por lo que dejaron de facturar, no por antigüedad.
 */
export function lapsedCustomers(
  documents: ReportDocument[],
  range: ReportRange,
  currency: Currency,
  limit = 8,
): LapsedCustomer[] {
  const previous = previousRange(range)
  const active = new Set(
    invoices(inRange(documents, range), currency).map(
      (document) => document.customerId,
    ),
  )
  const before = new Map<string, LapsedCustomer>()
  for (const document of invoices(inRange(documents, previous), currency)) {
    if (active.has(document.customerId)) continue
    const day = localDay(document.createdAt)
    const current = before.get(document.customerId) ?? {
      id: document.customerId,
      name: document.customerName,
      lastPurchase: day,
      daysSince: 0,
      previousRevenue: 0,
      orders: 0,
    }
    current.previousRevenue += document.total
    current.orders += 1
    if (day > current.lastPurchase) current.lastPurchase = day
    before.set(document.customerId, current)
  }
  for (const customer of before.values())
    customer.daysSince = daysBetween(customer.lastPurchase, range.to)
  return [...before.values()]
    .sort((a, b) => b.previousRevenue - a.previousRevenue)
    .slice(0, limit)
}

/** Días naturales entre dos fechas locales, sin arrastrar horas ni zonas. */
export function daysBetween(from: string, to: string): number {
  const start = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  )
  const end = Date.UTC(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10)),
  )
  return Math.round((end - start) / 86400000)
}

export interface Frequency {
  id: string
  name: string
  orders: number
  /** Días promedio entre compras; null con una sola compra registrada. */
  averageDays: number | null
  daysSinceLast: number
}
/**
 * Cada cuánto vuelve cada cliente. Se calcula sobre toda la ventana cargada,
 * no sólo el periodo, porque con treinta días casi nadie tendría dos compras.
 */
export function purchaseFrequency(
  documents: ReportDocument[],
  currency: Currency,
  today: string,
  limit = 10,
): Frequency[] {
  const byCustomer = new Map<string, { name: string; days: string[] }>()
  for (const document of invoices(documents, currency)) {
    const entry = byCustomer.get(document.customerId) ?? {
      name: document.customerName,
      days: [],
    }
    entry.days.push(localDay(document.createdAt))
    byCustomer.set(document.customerId, entry)
  }
  return [...byCustomer.entries()]
    .map(([id, entry]) => {
      const days = [...new Set(entry.days)].sort()
      const first = days[0]
      const last = days[days.length - 1]
      return {
        id,
        name: entry.name,
        orders: entry.days.length,
        averageDays:
          days.length > 1 ? daysBetween(first, last) / (days.length - 1) : null,
        daysSinceLast: daysBetween(last, today),
      }
    })
    .sort((a, b) => b.orders - a.orders)
    .slice(0, limit)
}

export const weekdayLabels = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado',
]
export interface WeekdaySales {
  weekday: number
  label: string
  revenue: number
  count: number
}
/** Ventas repartidas por día de la semana, para decidir personal y horarios. */
export function salesByWeekday(
  documents: ReportDocument[],
  currency: Currency,
): WeekdaySales[] {
  const totals = weekdayLabels.map((label, weekday) => ({
    weekday,
    label,
    revenue: 0,
    count: 0,
  }))
  for (const document of invoices(documents, currency)) {
    // Se toma el día local ya resuelto: el día de la semana debe ser el del
    // negocio, no el que resulte de la hora UTC.
    const day = localDay(document.createdAt)
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay()
    totals[weekday].revenue += document.total
    totals[weekday].count += 1
  }
  return totals
}

export interface Shrinkage {
  productId: string
  description: string
  units: number
  listValue: number
}
/** Unidades dañadas y lo que habrían facturado a precio de lista. */
export function shrinkage(
  movements: ReportMovement[],
  inventory: InventoryItem[],
  tier: PriceTier,
  currency: Currency,
  limit = 8,
): Shrinkage[] {
  const catalogue = new Map(inventory.map((item) => [item.product.id, item]))
  const rows = new Map<string, Shrinkage>()
  for (const movement of movements) {
    if (movement.type !== 'DAMAGED') continue
    const item = catalogue.get(movement.productId)
    const units = Math.abs(movement.quantity)
    const current = rows.get(movement.productId) ?? {
      productId: movement.productId,
      description: item
        ? `${item.product.brand} · ${item.product.name}`
        : 'Producto retirado del catálogo',
      units: 0,
      listValue: 0,
    }
    current.units += units
    current.listValue += item
      ? (productPrice(item.product, tier, currency) ?? 0) * units
      : 0
    rows.set(movement.productId, current)
  }
  return [...rows.values()]
    .sort((a, b) => b.listValue - a.listValue || b.units - a.units)
    .slice(0, limit)
}

export interface Conversion {
  proformas: number
  converted: number
  rate: number | null
}
/**
 * Aproximación: se cuenta una proforma como convertida si ese mismo cliente
 * recibió una factura después, dentro de la ventana cargada. Nada enlaza hoy
 * una proforma con su factura, así que la cifra orienta pero no prueba.
 */
export function proformaConversion(
  documents: ReportDocument[],
  currency: Currency,
): Conversion {
  const sales = documents.filter(
    (document) => document.kind === 'invoice' && document.currency === currency,
  )
  const quotes = documents.filter(
    (document) =>
      document.kind === 'proforma' && document.currency === currency,
  )
  const converted = quotes.filter((quote) =>
    sales.some(
      (sale) =>
        sale.customerId === quote.customerId &&
        sale.createdAt >= quote.createdAt,
    ),
  ).length
  return {
    proformas: quotes.length,
    converted,
    rate: quotes.length ? converted / quotes.length : null,
  }
}

import type { Currency, InventoryItem, PriceTier } from '../../lib/domain'
import { AppError } from '../../lib/errors'
import {
  emptyAccounting,
  ledgerDigest,
  roundMoney,
  type AccountingSource,
  type LedgerDigest,
  type LedgerTotals,
} from './accounting'
import {
  change,
  concentration,
  coverageFromSold,
  customerActivity,
  customerVisits,
  damagedUnits,
  daysBetween,
  fillDays,
  frequencyOf,
  idleFromSold,
  inRange,
  inventoryHealth,
  lapsedCustomers,
  movementSummary,
  movementsInRange,
  paymentBreakdown,
  paymentLabels,
  previousRange,
  proformaConversion,
  proformaCount,
  salesByDay,
  salesByWeekday,
  shrinkageFromUnits,
  summary,
  tierBreakdown,
  tierLabels,
  topProducts,
  weekdayLabels,
  type CustomerVisits,
  type DayPoint,
  type MovementSummary,
  type ProductSales,
  type ReportRange,
  type ReportSource,
  type Share,
  type Summary,
} from './model'

/**
 * Resumen de un periodo: todo lo que muestran los reportes, ya sumado. Lo
 * calcula PostgreSQL (`public.report_digest`) y viaja como un objeto pequeño,
 * sin importar cuántas facturas tenga el periodo. `digestFromSource` hace el
 * mismo cálculo en el navegador a partir de las filas: lo usan la vista local
 * y el respaldo mientras la función no esté instalada, y las pruebas lo
 * comparan contra la base para que ambos den siempre lo mismo.
 */

/** Largo de las listas de clientes que trae el resumen (el Excel usa hasta 200). */
export const DIGEST_LIST_LIMIT = 200

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

function totals(documents: ReportSource['documents'], currency: Currency): SalesTotals {
  const { revenue, count, units, customers } = summary(documents, currency)
  return { revenue: roundMoney(revenue), count, units, customers }
}
function rounded<T extends { revenue: number }>(rows: T[]): T[] {
  return rows.map((row) => ({ ...row, revenue: roundMoney(row.revenue) }))
}
function shares(rows: Share[]): DigestShare[] {
  return rows.map(({ key, value, count }) => ({
    key,
    value: roundMoney(value),
    count,
  }))
}

/** El mismo resumen que devuelve la base, calculado con las filas del periodo. */
export function digestFromSource(
  source: ReportSource,
  range: ReportRange,
): ReportData {
  const current = inRange(source.documents, range)
  const previous = inRange(source.documents, previousRange(range))
  const currency = (code: Currency): CurrencyDigest => {
    const activity = customerActivity(
      current,
      source.customers,
      code,
      range,
      DIGEST_LIST_LIMIT,
    )
    return {
      current: totals(current, code),
      previous: totals(previous, code),
      proformas: proformaCount(current, code),
      converted: proformaConversion(current, code).converted,
      days: rounded(salesByDay(current, code)),
      weekdays: rounded(
        salesByWeekday(current, code)
          .filter((day) => day.count > 0)
          .map(({ weekday, revenue, count }) => ({ weekday, revenue, count })),
      ),
      payments: shares(paymentBreakdown(current, code)),
      tiers: shares(tierBreakdown(current, code)),
      products: rounded(topProducts(current, code, Infinity)),
      newCustomers: activity.newCustomers,
      returning: activity.returning,
      topCustomers: rounded(activity.top),
      lapsed: lapsedCustomers(
        source.documents,
        range,
        code,
        DIGEST_LIST_LIMIT,
      ).map(({ id, name, lastPurchase, previousRevenue, orders }) => ({
        id,
        name,
        lastPurchase,
        previousRevenue: roundMoney(previousRevenue),
        orders,
      })),
      visits: customerVisits(source.documents, code).slice(
        0,
        DIGEST_LIST_LIMIT,
      ),
    }
  }
  const movements = movementsInRange(source.movements, range)
  const accounting = source.accounting ?? structuredClone(emptyAccounting)
  return {
    range,
    sales: { NIO: currency('NIO'), USD: currency('USD') },
    movements: {
      ...movementSummary(movements),
      damagedByProduct: damagedUnits(movements),
    },
    ledger: accounting.available ? ledgerDigest(source, range) : null,
    accounting,
    inventory: source.inventory,
    truncated: source.truncated,
    computedIn: 'browser',
  }
}

/**
 * Lo que devuelve `public.report_digest`, revisado antes de usarlo: una cifra
 * que falte o no sea número detiene el reporte en lugar de mostrarse como cero.
 */
export function digestFromPayload(
  payload: unknown,
  rest: Pick<ReportData, 'range' | 'inventory' | 'accounting' | 'truncated'>,
): ReportData {
  const broken = () => {
    throw new AppError(
      'unexpected',
      'La base de datos devolvió un resumen de reportes incompleto. Inténtalo de nuevo.',
    )
  }
  const object = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : broken()
  const list = (value: unknown) =>
    Array.isArray(value) ? (value as Record<string, unknown>[]) : broken()
  const number = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : broken()
  const text = (value: unknown) => (typeof value === 'string' ? value : broken())
  const root = object(payload)
  if (root.version !== 1) broken()
  const totals = (value: unknown): SalesTotals => {
    const row = object(value)
    return {
      revenue: number(row.revenue),
      count: number(row.count),
      units: number(row.units),
      customers: number(row.customers),
    }
  }
  const shares = (value: unknown): DigestShare[] =>
    list(value).map((row) => ({
      key: text(row.key),
      value: number(row.value),
      count: number(row.count),
    }))
  const currency = (value: unknown): CurrencyDigest => {
    const row = object(value)
    return {
      current: totals(row.current),
      previous: totals(row.previous),
      proformas: number(row.proformas),
      converted: number(row.converted),
      days: list(row.days).map((day) => ({
        day: text(day.day),
        revenue: number(day.revenue),
        count: number(day.count),
      })),
      weekdays: list(row.weekdays).map((day) => ({
        weekday: number(day.weekday),
        revenue: number(day.revenue),
        count: number(day.count),
      })),
      payments: shares(row.payments),
      tiers: shares(row.tiers),
      products: list(row.products).map((product) => ({
        productId: text(product.productId),
        description: text(product.description),
        quantity: number(product.quantity),
        revenue: number(product.revenue),
      })),
      newCustomers: number(row.newCustomers),
      returning: number(row.returning),
      topCustomers: list(row.topCustomers).map((client) => ({
        id: text(client.id),
        name: text(client.name),
        revenue: number(client.revenue),
        count: number(client.count),
      })),
      lapsed: list(row.lapsed).map((client) => ({
        id: text(client.id),
        name: text(client.name),
        lastPurchase: text(client.lastPurchase),
        previousRevenue: number(client.previousRevenue),
        orders: number(client.orders),
      })),
      visits: list(row.visits).map((client) => ({
        id: text(client.id),
        name: text(client.name),
        orders: number(client.orders),
        firstDay: text(client.firstDay),
        lastDay: text(client.lastDay),
        distinctDays: number(client.distinctDays),
      })),
    }
  }
  const ledgerTotals = (row: Record<string, unknown>): LedgerTotals => ({
    revenueNio: number(row.revenueNio),
    salesTaxNio: number(row.salesTaxNio),
    costOfSalesNio: number(row.costOfSalesNio),
    missingCostUnits: number(row.missingCostUnits),
    missingRevenueLines: number(row.missingRevenueLines),
    soldUnits: number(row.soldUnits),
    inventoryWriteOffNio: number(row.inventoryWriteOffNio),
    missingWriteOffUnits: number(row.missingWriteOffUnits),
  })
  const ledger = (value: unknown): LedgerDigest | null => {
    if (value === null || value === undefined) return null
    const row = object(value)
    const losses = object(row.belowCost)
    return {
      ...ledgerTotals(row),
      products: list(row.products).map((product) => ({
        productId: text(product.productId),
        description: text(product.description),
        quantity: number(product.quantity),
        netRevenueNio: number(product.netRevenueNio),
        costNio: number(product.costNio),
        missingUnits: number(product.missingUnits),
      })),
      tiers: list(row.tiers).map((tier) => ({
        tier: text(tier.tier) as PriceTier,
        netRevenueNio: number(tier.netRevenueNio),
        costNio: number(tier.costNio),
        missingUnits: number(tier.missingUnits),
      })),
      months: list(row.months).map((month) => ({
        month: text(month.month),
        ...ledgerTotals(month),
      })),
      belowCost: {
        count: number(losses.count),
        lossNio: number(losses.lossNio),
        rows: list(losses.rows).map((loss) => ({
          documentId: text(loss.documentId),
          number: text(loss.number),
          createdAt: text(loss.createdAt),
          productId: text(loss.productId),
          description: text(loss.description),
          quantity: number(loss.quantity),
          netRevenueNio: number(loss.netRevenueNio),
          costNio: number(loss.costNio),
          lossNio: number(loss.lossNio),
        })),
      },
    }
  }
  const sales = object(root.sales)
  const movements = object(root.movements)
  return {
    ...rest,
    sales: { NIO: currency(sales.NIO), USD: currency(sales.USD) },
    movements: {
      entries: number(movements.entries),
      exits: number(movements.exits),
      damaged: number(movements.damaged),
      adjustments: number(movements.adjustments),
      sales: number(movements.sales),
      damagedByProduct: list(movements.damagedByProduct).map((row) => ({
        productId: text(row.productId),
        units: number(row.units),
      })),
    },
    // Sin permiso contable la base no manda el libro, y la contabilidad tampoco
    // se muestra; si la manda, se usa aunque las filas chicas vengan vacías.
    ledger: rest.accounting.available ? ledger(root.ledger) : null,
    computedIn: 'database',
  }
}

function toSummary(totals: SalesTotals): Summary {
  return {
    ...totals,
    average: totals.count ? totals.revenue / totals.count : 0,
  }
}
function ordered<K extends string>(
  rows: DigestShare[],
  labels: Record<K, string>,
): Share[] {
  // Orden fijo: el color sigue a la forma de pago o a la lista, no a su monto.
  return (Object.keys(labels) as K[]).flatMap((key) => {
    const row = rows.find((share) => share.key === key)
    return row ? [{ ...row, label: labels[key] }] : []
  })
}

/**
 * Las mismas preguntas que antes se hacían a la lista de facturas, ahora
 * contestadas con el resumen. Las pantallas y las exportaciones leen de aquí.
 */
export function reportView(report: ReportData) {
  const { range, sales, inventory, movements } = report
  const currencies = (['NIO', 'USD'] as Currency[]).filter(
    (code) => sales[code].current.count > 0,
  )
  const first = currencies[0] ?? 'NIO'
  const soldAnywhere = new Set(
    (['NIO', 'USD'] as Currency[]).flatMap((code) =>
      sales[code].products.map((product) => product.productId),
    ),
  )
  return {
    range,
    currencies,
    /** Moneda de referencia para lo que no va por moneda (inventario). */
    first,
    summary: (code: Currency) => toSummary(sales[code].current),
    previousSummary: (code: Currency) => toSummary(sales[code].previous),
    variation: (code: Currency) =>
      change(sales[code].current.revenue, sales[code].previous.revenue),
    revenueByDay: (code: Currency) => fillDays(sales[code].days, range),
    topProducts: (code: Currency, limit = 10) =>
      sales[code].products.slice(0, limit),
    productShare: (code: Currency) =>
      concentration(
        sales[code].products.map((product) => product.revenue),
        10,
      ),
    paymentBreakdown: (code: Currency) =>
      ordered(sales[code].payments, paymentLabels),
    tierBreakdown: (code: Currency) =>
      ordered(sales[code].tiers, tierLabels as Record<PriceTier, string>),
    customerActivity: (code: Currency, limit = 8) => ({
      newCustomers: sales[code].newCustomers,
      returning: sales[code].returning,
      top: sales[code].topCustomers.slice(0, limit),
    }),
    lapsedCustomers: (code: Currency, limit = 8) =>
      sales[code].lapsed.slice(0, limit).map((client) => ({
        ...client,
        daysSince: daysBetween(client.lastPurchase, range.to),
      })),
    purchaseFrequency: (code: Currency, today: string, limit = 10) =>
      sales[code].visits.slice(0, limit).map((row) => frequencyOf(row, today)),
    salesByWeekday: (code: Currency) =>
      weekdayLabels.map((label, weekday) => {
        const row = sales[code].weekdays.find((day) => day.weekday === weekday)
        return { weekday, label, revenue: row?.revenue ?? 0, count: row?.count ?? 0 }
      }),
    proformaCount: (code: Currency) => sales[code].proformas,
    proformaConversion: (code: Currency) => ({
      proformas: sales[code].proformas,
      converted: sales[code].converted,
      rate: sales[code].proformas
        ? sales[code].converted / sales[code].proformas
        : null,
    }),
    stockCoverage: (code: Currency, limit = 10) =>
      coverageFromSold(
        new Map(
          sales[code].products.map((product) => [
            product.productId,
            product.quantity,
          ]),
        ),
        inventory,
        range,
        limit,
      ),
    idleStock: (tier: PriceTier, code: Currency, limit = 10) =>
      idleFromSold(soldAnywhere, inventory, tier, code, limit),
    shrinkage: (tier: PriceTier, code: Currency, limit = 8) =>
      shrinkageFromUnits(
        movements.damagedByProduct,
        inventory,
        tier,
        code,
        limit,
      ),
    movementSummary: (): MovementSummary => ({
      entries: movements.entries,
      exits: movements.exits,
      damaged: movements.damaged,
      adjustments: movements.adjustments,
      sales: movements.sales,
    }),
    inventoryHealth: (tier: PriceTier, code: Currency) =>
      inventoryHealth(inventory, tier, code),
  }
}
export type ReportView = ReturnType<typeof reportView>

import type {
  Currency,
  InventoryItem,
  InventoryLocation,
  PriceTier,
  ProductPricing,
} from '../../lib/domain'
import {
  convertPrice,
  landedUnitCost,
  markupPrice,
  priceTiers,
  shippingPerUnit,
  weightedAverageCost,
} from '../../lib/pricing'

/**
 * La vista previa de una compra, con las mismas cuentas que hace la base al
 * registrarla (`record_shipment`): el envío se reparte por igual entre las
 * unidades, el costo de entrada es precio + envío por unidad convertido con la
 * tasa del pedido, y el promedio nuevo pondera las existencias de tienda y
 * bodega con lo que entra. Enseña el costo promedio que va a quedar y el
 * precio de cada lista calculada, antes de guardar nada.
 */

export interface PurchaseLineDraft {
  productId: string
  location: InventoryLocation
  quantity: string
  unitPrice: string
}
export interface TierPreview {
  tier: PriceTier
  markup: number
  before: number | null
  after: number
  afterUsd: number
}
export interface LinePreview {
  productId: string
  quantity: number
  unitPrice: number
  /** Existencias de tienda y bodega antes de la compra; `null` sin conteo. */
  existing: number | null
  previousAverage: number | null
  landed: number | null
  nextAverage: number | null
  prices: TierPreview[]
  problem: string | null
}
interface PurchasePreview {
  lines: LinePreview[]
  units: number
  goods: number
  perUnit: number | null
  /** Motivo general por el que todavía no se puede guardar. */
  problem: string | null
  ready: boolean
}

const MAX_AMOUNT = 1_000_000_000
/** ¿Tiene a lo sumo `decimals` decimales? Tolera el ruido de la coma flotante. */
export function hasDecimals(value: number, decimals: number) {
  const scaled = value * 10 ** decimals
  return Math.abs(scaled - Math.round(scaled)) < 1e-6
}
/** Un número escrito en un campo, o `NaN` si está vacío o no es número. */
export function typed(text: string): number {
  return text.trim() === '' ? NaN : Number(text)
}
export function validRate(currency: Currency, rateText: string): number | null {
  if (currency === 'NIO') return 1
  const rate = typed(rateText)
  return Number.isFinite(rate) &&
    rate > 0 &&
    rate <= 1_000_000 &&
    hasDecimals(rate, 6)
    ? rate
    : null
}
/** Los precios de las listas calculadas con un costo promedio dado. */
export function tierPreviews(
  pricing: ProductPricing | undefined,
  averageCost: number,
  currentPrices:
    Partial<Record<PriceTier, Record<Currency, number>>> | undefined,
  catalogRate: number | null,
): TierPreview[] {
  if (!pricing) return []
  return priceTiers.flatMap((tier) => {
    const markup = pricing.markups[tier]
    if (markup === null) return []
    const after = markupPrice(averageCost, markup)
    return [
      {
        tier,
        markup,
        before: currentPrices?.[tier]?.NIO ?? null,
        after,
        afterUsd: convertPrice(after, 'NIO', 'USD', catalogRate),
      },
    ]
  })
}

export function previewPurchase({
  lines,
  shippingText,
  currency,
  rateText,
  inventory,
  pricing,
  catalogRate,
}: {
  lines: PurchaseLineDraft[]
  shippingText: string
  currency: Currency
  rateText: string
  inventory: InventoryItem[]
  pricing: ProductPricing[]
  catalogRate: number | null
}): PurchasePreview {
  const items = new Map(inventory.map((item) => [item.product.id, item]))
  const rows = new Map(pricing.map((row) => [row.productId, row]))
  const shipping = typed(shippingText)
  const shippingValid =
    Number.isFinite(shipping) &&
    shipping >= 0 &&
    shipping <= MAX_AMOUNT &&
    hasDecimals(shipping, 2)
  const rate = validRate(currency, rateText)
  const seen = new Set<string>()
  const parsed = lines.map((line) => {
    const quantity = typed(line.quantity)
    const unitPrice = typed(line.unitPrice)
    let problem: string | null = null
    if (!line.productId) problem = 'Elige el perfume.'
    else if (seen.has(line.productId))
      problem = 'Este perfume ya está en otro renglón del pedido.'
    else if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 1_000_000
    )
      problem = 'Escribe una cantidad entera mayor que cero.'
    else if (
      !Number.isFinite(unitPrice) ||
      unitPrice < 0 ||
      unitPrice > MAX_AMOUNT ||
      !hasDecimals(unitPrice, 6)
    )
      problem = 'Escribe el costo por unidad (hasta seis decimales).'
    if (line.productId) seen.add(line.productId)
    return { line, quantity, unitPrice, problem }
  })
  const valid = parsed.filter((row) => row.problem === null)
  const units = valid.reduce((total, row) => total + row.quantity, 0)
  const goods = valid.reduce(
    (total, row) => total + row.quantity * row.unitPrice,
    0,
  )
  const perUnit =
    shippingValid && units > 0 ? shippingPerUnit(shipping, units) : null
  const previews = parsed.map((row): LinePreview => {
    const item = items.get(row.line.productId)
    const { store, warehouse } = item?.quantities ?? {
      store: null,
      warehouse: null,
    }
    const existing =
      store === null || warehouse === null ? null : store + warehouse
    const saved = rows.get(row.line.productId)
    const previousAverage = saved?.averageCost ?? null
    let problem = row.problem
    if (!problem && item && !item.product.active)
      problem = 'El perfume está inactivo.'
    if (!problem && existing === null)
      problem = 'Registra primero el conteo de tienda y bodega de este perfume.'
    if (
      !problem &&
      existing !== null &&
      existing > 0 &&
      previousAverage === null
    )
      problem = `Tiene ${existing} unidades contadas y todavía no tiene costo: carga primero su costo inicial.`
    const landed =
      !problem && perUnit !== null && rate !== null
        ? landedUnitCost(row.unitPrice, perUnit, rate)
        : null
    const nextAverage =
      landed !== null && existing !== null
        ? weightedAverageCost(existing, previousAverage, row.quantity, landed)
        : null
    return {
      productId: row.line.productId,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      existing,
      previousAverage,
      landed,
      nextAverage,
      prices:
        nextAverage === null
          ? []
          : tierPreviews(saved, nextAverage, item?.product.prices, catalogRate),
      problem,
    }
  })
  let problem: string | null = null
  if (rate === null)
    problem = 'Escribe el tipo de cambio del pedido (córdobas por dólar).'
  else if (!shippingValid)
    problem = 'Escribe el envío del pedido; si no hubo, escribe 0.'
  else if (valid.length && goods + shipping <= 0)
    problem = 'Revisa el costo de los perfumes y del envío.'
  const ready =
    problem === null &&
    previews.length > 0 &&
    previews.every(
      (line) => line.problem === null && line.nextAverage !== null,
    ) &&
    previews.every((line) =>
      line.prices.every((price) => price.after <= 10_000_000),
    )
  if (
    !problem &&
    previews.some((line) =>
      line.prices.some((price) => price.after > 10_000_000),
    )
  )
    problem =
      'Un precio calculado saldría demasiado alto. Revisa el costo y los porcentajes.'
  return { lines: previews, units, goods, perUnit, problem, ready }
}

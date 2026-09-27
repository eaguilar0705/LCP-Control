import type { Currency, PriceTier, PricingInput, Product } from './domain'
export const priceTierLabels: Record<PriceTier, string> = {
  emprendedor: 'Emprendedor',
  vip: 'VIP',
  premium: 'Premium',
}
export const priceTiers = Object.keys(priceTierLabels) as PriceTier[]
export const currencySymbols: Record<Currency, string> = {
  NIO: 'C$',
  USD: 'US$',
}
export function productPrice(
  product: Product,
  tier: PriceTier,
  currency: Currency,
): number | null {
  return (
    product.prices?.[tier]?.[currency] ??
    (product.currency === currency ? product.price : null)
  )
}
/**
 * El equivalente del mismo importe en la otra moneda. El catálogo se cotiza en
 * dólares y el precio en córdobas sale de la tasa vigente, así que convertir un
 * total con esa misma tasa devuelve el precio que el cliente pagaría si pidiera
 * cobrarse en la otra moneda —no una cifra aproximada—. Devuelve `null` cuando
 * no hay tasa: es preferible no enseñar nada a enseñar una conversión inventada.
 */
export function equivalentAmount(
  total: number,
  currency: Currency,
  rate: number | null | undefined,
): { currency: Currency; amount: number } | null {
  if (
    rate == null ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    !Number.isFinite(total)
  )
    return null
  const value = currency === 'NIO' ? total / rate : total * rate
  if (!Number.isFinite(value)) return null
  return {
    currency: currency === 'NIO' ? 'USD' : 'NIO',
    amount: Math.round(value * 100) / 100,
  }
}
/**
 * Lo que queda de un precio después del costo, entre 0 y 1. Nulo si falta
 * cualquiera de los dos: un margen a medias es peor que no enseñar ninguno.
 */
export function marginRate(
  priceNio: number | null,
  costNio: number | null | undefined,
) {
  if (priceNio === null || priceNio <= 0) return null
  if (costNio === null || costNio === undefined) return null
  if (!Number.isFinite(costNio) || costNio < 0) return null
  return (priceNio - costNio) / priceNio
}
export function lineCents(price: number, quantity: number) {
  if (
    !Number.isFinite(price) ||
    price < 0 ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1
  )
    throw new Error('Revisa el precio y la cantidad.')
  const cents = Math.round(price * 100) * quantity
  if (!Number.isSafeInteger(cents))
    throw new Error('El importe es demasiado grande.')
  return cents
}

// --- Costo promedio más porcentaje de ganancia -----------------------------
//
// Las cuentas se hacen en enteros (millonésimas del costo, centavos, centésimas
// de punto y millonésimas de la tasa) y se redondean a la mitad hacia arriba,
// igual que `round()` de PostgreSQL con `numeric`. Así la pantalla enseña
// exactamente el precio que va a guardar la base, también en los casos de medio
// centavo en que la coma flotante se equivoca (0,5 × 36,61 = 18,305 → 18,31).

/** Un número positivo con `decimals` decimales, en unidades enteras. */
function units(value: number, decimals: number): bigint | null {
  if (!Number.isFinite(value)) return null
  const scaled = Math.round(value * 10 ** decimals)
  return Number.isSafeInteger(scaled) ? BigInt(scaled) : null
}
/** División entera con redondeo a la mitad hacia arriba (sólo positivos). */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator)
}
function fromCents(cents: bigint): number {
  return Number(cents < 1n ? 1n : cents) / 100
}
const MICROS = 1_000_000n
function fromMicros(micros: bigint): number {
  return Number(micros) / 1e6
}
/**
 * Precio de venta: el costo más el porcentaje, al centavo y nunca cero. El
 * costo conserva sus seis decimales: sólo se redondea el precio final.
 * 16.281061 con 25 % → 20.35. `NaN` si alguno de los dos no es válido.
 */
export function markupPrice(cost: number, percent: number): number {
  const micros = units(cost, 6)
  const hundredths = units(percent, 2)
  if (micros === null || hundredths === null || micros < 0n || hundredths < 0n)
    return NaN
  return fromCents(divideHalfUp(micros * (10000n + hundredths), 100_000_000n))
}
/**
 * El mismo precio en otra moneda con la tasa (córdobas por dólar), al centavo.
 * Es la conversión que hace la base al guardar. `NaN` sin una tasa válida.
 */
export function convertPrice(
  amount: number,
  from: Currency,
  to: Currency,
  rate: number | null | undefined,
): number {
  if (!Number.isFinite(amount)) return NaN
  if (from === to) return amount
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return NaN
  const cents = units(amount, 2)
  const micros = units(rate, 6)
  if (cents === null || micros === null || micros <= 0n) return NaN
  return to === 'NIO'
    ? fromCents(divideHalfUp(cents * micros, 1000000n))
    : fromCents(divideHalfUp(cents * 1000000n, micros))
}
/** Resta en centavos: la ganancia de C$ 600 sobre C$ 500 es exactamente 100. */
export function subtractPrices(minuend: number, subtrahend: number): number {
  return (Math.round(minuend * 100) - Math.round(subtrahend * 100)) / 100
}

// --- Costo promedio ponderado ----------------------------------------------
//
// Las mismas cuentas que `record_shipment`, con seis decimales y redondeo a la
// mitad hacia arriba, para enseñar el promedio y los precios nuevos antes de
// guardar una compra.

/** Envío por unidad del pedido: round(envío / unidades, 6). */
export function shippingPerUnit(shipping: number, unitCount: number): number {
  const cents = units(shipping, 2)
  if (
    cents === null ||
    cents < 0n ||
    !Number.isSafeInteger(unitCount) ||
    unitCount < 1
  )
    return NaN
  return fromMicros(divideHalfUp(cents * 10000n, BigInt(unitCount)))
}
/**
 * Costo puesto en bodega en córdobas: (precio del proveedor + envío por unidad)
 * × tasa del pedido, con seis decimales.
 */
export function landedUnitCost(
  unitPrice: number,
  perUnitShipping: number,
  rate: number,
): number {
  const price = units(unitPrice, 6)
  const shipping = units(perUnitShipping, 6)
  const micros = units(rate, 6)
  if (price === null || shipping === null || micros === null) return NaN
  if (price < 0n || shipping < 0n || micros <= 0n) return NaN
  return fromMicros(divideHalfUp((price + shipping) * micros, MICROS))
}
/**
 * Promedio ponderado de las existencias (tienda y bodega) y lo que entra:
 * (existentes × promedio + entrantes × costo) / (existentes + entrantes), con
 * seis decimales. Sin existencias, el promedio es el costo de lo que entra.
 * `null` cuando hay existencias sin costo conocido: no hay base contra la cual
 * promediar y la base de datos rechazaría la compra.
 */
export function weightedAverageCost(
  existingUnits: number,
  existingAverage: number | null,
  incomingUnits: number,
  incomingUnitCost: number,
): number | null {
  if (
    !Number.isSafeInteger(existingUnits) ||
    existingUnits < 0 ||
    !Number.isSafeInteger(incomingUnits) ||
    incomingUnits < 1
  )
    return null
  const incoming = units(incomingUnitCost, 6)
  if (incoming === null || incoming < 0n) return null
  if (existingUnits === 0) return fromMicros(incoming)
  if (existingAverage === null) return null
  const current = units(existingAverage, 6)
  if (current === null || current < 0n) return null
  return fromMicros(
    divideHalfUp(
      current * BigInt(existingUnits) + incoming * BigInt(incomingUnits),
      BigInt(existingUnits + incomingUnits),
    ),
  )
}

// --- Listas calculadas -----------------------------------------------------

export function emptyPricing(): PricingInput {
  return { markups: { emprendedor: null, vip: null, premium: null } }
}
/**
 * Cómo sale el precio de una lista:
 * - `computed`: tiene porcentaje y el perfume tiene costo promedio.
 * - `pending`: tiene porcentaje, pero todavía no hay costo promedio; conserva
 *   su precio publicado (se fija a mano) hasta que lo haya.
 * - `manual`: sin porcentaje; su precio se fija a mano en dólares.
 */
export type TierStatus = 'computed' | 'pending' | 'manual'
export function tierStatus(
  pricing: PricingInput | null | undefined,
  averageCost: number | null | undefined,
  tier: PriceTier,
): TierStatus {
  if (pricing?.markups[tier] == null) return 'manual'
  return averageCost == null || !Number.isFinite(averageCost)
    ? 'pending'
    : 'computed'
}
/**
 * El desglose de una lista calculada: costo promedio, porcentaje aplicado,
 * ganancia y precio de venta en córdobas, más el precio en las dos monedas tal
 * como se guardará. `null` si la lista no se calcula.
 */
export interface TierQuote {
  tier: PriceTier
  cost: number
  percent: number
  profit: number
  price: number
  prices: Record<Currency, number>
}
export function tierQuote(
  pricing: PricingInput | null | undefined,
  averageCost: number | null | undefined,
  tier: PriceTier,
  rate: number | null | undefined,
): TierQuote | null {
  if (tierStatus(pricing, averageCost, tier) !== 'computed') return null
  const percent = pricing!.markups[tier]!
  const cost = averageCost!
  const price = markupPrice(cost, percent)
  if (Number.isNaN(price)) return null
  return {
    tier,
    cost,
    percent,
    profit: profitOf(price, cost),
    price,
    prices: { NIO: price, USD: convertPrice(price, 'NIO', 'USD', rate) },
  }
}
/** Precio menos costo, al centavo (el costo trae seis decimales). */
function profitOf(price: number, cost: number): number {
  const priceMicros = units(price, 6)
  const costMicros = units(cost, 6)
  if (priceMicros === null || costMicros === null) return NaN
  const difference = priceMicros - costMicros
  const cents =
    difference < 0n
      ? -divideHalfUp(-difference, 10000n)
      : divideHalfUp(difference, 10000n)
  return Number(cents) / 100
}
export type TierPrices = Record<PriceTier, Record<Currency, number>>
/**
 * Los precios del perfume con las listas calculadas ya reemplazadas. Las
 * listas a mano y las pendientes de costo quedan como estaban.
 */
export function applyPricing(
  prices: TierPrices,
  pricing: PricingInput | null | undefined,
  averageCost: number | null | undefined,
  rate: number | null | undefined,
): TierPrices {
  const next = structuredClone(prices)
  for (const tier of priceTiers) {
    const quote = tierQuote(pricing, averageCost, tier, rate)
    if (quote) next[tier] = { ...quote.prices }
  }
  return next
}
/** ¿Cambió algo que la base tenga que guardar? */
export function samePricing(a: PricingInput, b: PricingInput): boolean {
  return priceTiers.every((tier) => a.markups[tier] === b.markups[tier])
}
/** Cuántas listas del perfume salen del costo promedio. */
export function computedTiers(
  pricing: PricingInput | null | undefined,
  averageCost: number | null | undefined,
) {
  return priceTiers.filter(
    (tier) => tierStatus(pricing, averageCost, tier) === 'computed',
  ).length
}
/** El costo promedio con sus seis decimales, sin ceros de sobra. */
export function exactCost(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, '')
}

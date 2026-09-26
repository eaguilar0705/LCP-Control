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

// --- Precio de compra más porcentaje de ganancia ----------------------------
//
// Las cuentas se hacen en enteros (centavos, centésimas de punto y
// millonésimas de la tasa) y se redondean a la mitad hacia arriba, igual que
// `round()` de PostgreSQL con `numeric`. Así la pantalla enseña exactamente el
// precio que va a guardar la base, también en los casos de medio centavo en
// que la coma flotante se equivoca (0,5 × 36,61 = 18,305 → 18,31).

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
/**
 * Precio de venta: el de compra más el porcentaje, al centavo y nunca cero.
 * C$ 500 con 20 % → C$ 600. `NaN` si alguno de los dos no es válido.
 */
export function markupPrice(cost: number, percent: number): number {
  const cents = units(cost, 2)
  const hundredths = units(percent, 2)
  if (cents === null || hundredths === null || cents <= 0n || hundredths < 0n)
    return NaN
  return fromCents(divideHalfUp(cents * (10000n + hundredths), 10000n))
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
export function emptyPricing(currency: Currency = 'NIO'): PricingInput {
  return {
    purchasePrice: null,
    purchaseCurrency: currency,
    markups: { emprendedor: null, vip: null, premium: null },
  }
}
/**
 * El desglose de una lista calculada: precio de compra, porcentaje aplicado,
 * ganancia y precio de venta, en la moneda de la compra, más el precio en las
 * dos monedas tal como se guardará. `null` si la lista se fija a mano (falta el
 * precio de compra o su porcentaje).
 */
export interface TierQuote {
  tier: PriceTier
  currency: Currency
  purchasePrice: number
  percent: number
  profit: number
  price: number
  prices: Record<Currency, number>
}
export function tierQuote(
  pricing: PricingInput | null | undefined,
  tier: PriceTier,
  rate: number | null | undefined,
): TierQuote | null {
  const cost = pricing?.purchasePrice
  const percent = pricing?.markups[tier]
  if (cost == null || percent == null) return null
  const price = markupPrice(cost, percent)
  if (Number.isNaN(price)) return null
  const currency = pricing!.purchaseCurrency
  const other: Currency = currency === 'NIO' ? 'USD' : 'NIO'
  return {
    tier,
    currency,
    purchasePrice: cost,
    percent,
    profit: subtractPrices(price, cost),
    price,
    prices: {
      [currency]: price,
      [other]: convertPrice(price, currency, other, rate),
    } as Record<Currency, number>,
  }
}
export type TierPrices = Record<PriceTier, Record<Currency, number>>
/**
 * Los precios del perfume con las listas calculadas ya reemplazadas. Las
 * listas a mano quedan como estaban.
 */
export function applyPricing(
  prices: TierPrices,
  pricing: PricingInput | null | undefined,
  rate: number | null | undefined,
): TierPrices {
  const next = structuredClone(prices)
  for (const tier of priceTiers) {
    const quote = tierQuote(pricing, tier, rate)
    if (quote) next[tier] = { ...quote.prices }
  }
  return next
}
/** ¿Cambió algo que la base tenga que guardar? */
export function samePricing(a: PricingInput, b: PricingInput): boolean {
  return (
    a.purchasePrice === b.purchasePrice &&
    (a.purchasePrice === null || a.purchaseCurrency === b.purchaseCurrency) &&
    priceTiers.every((tier) => a.markups[tier] === b.markups[tier])
  )
}
/** Cuántas listas del perfume salen del precio de compra. */
export function computedTiers(pricing: PricingInput | null | undefined) {
  return pricing?.purchasePrice == null
    ? 0
    : priceTiers.filter((tier) => pricing.markups[tier] != null).length
}

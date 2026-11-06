import type { Currency } from '../../lib/domain'

/** Importes de compra al centavo; las equivalencias nunca son precios de venta. */
function cents(value: number): bigint | null {
  const micros = Math.round(value * 1e6)
  return Number.isFinite(value) && value >= 0 && Number.isSafeInteger(micros)
    ? (BigInt(micros) + 5000n) / 10000n
    : null
}
function convertCents(amount: bigint, rate: number): bigint | null {
  const micros = Math.round(rate * 1e6)
  if (
    !Number.isFinite(rate) ||
    rate <= 0 ||
    !Number.isSafeInteger(micros) ||
    micros <= 0
  )
    return null
  return (amount * BigInt(micros) + 500000n) / 1000000n
}

export function purchaseAmounts({
  goods,
  shipping,
  currency,
  exchangeRate,
  systemRate,
}: {
  goods: number
  shipping: number
  currency: Currency
  exchangeRate: number | null | undefined
  systemRate: number | null | undefined
}) {
  const goodsCents = cents(goods)
  const shippingCents = cents(shipping)
  if (goodsCents === null || shippingCents === null) return null
  const total = Number(goodsCents + shippingCents) / 100
  // En NIO, la tasa contable es 1; la equivalencia usa la tasa del sistema.
  // Una compra USD ya guardada conserva la tasa que respaldó su contabilización.
  const rate = currency === 'NIO' ? systemRate : exchangeRate
  const validRate = rate != null && Number.isFinite(rate) && rate > 0
  const goodsNio = validRate ? convertCents(goodsCents, rate) : null
  const shippingNio = validRate ? convertCents(shippingCents, rate) : null
  const nio =
    currency === 'NIO'
      ? total
      : goodsNio === null || shippingNio === null
        ? null
        : Number(goodsNio + shippingNio) / 100
  return {
    total,
    nio,
    rate: validRate ? rate : null,
    equivalent:
      !validRate || nio === null
        ? null
        : {
            currency: currency === 'NIO' ? ('USD' as const) : ('NIO' as const),
            // Se calcula siempre desde el importe original. El redondeo a dos
            // decimales corresponde solo a la presentación del equivalente USD.
            amount: currency === 'NIO' ? total / rate : nio,
          },
  }
}

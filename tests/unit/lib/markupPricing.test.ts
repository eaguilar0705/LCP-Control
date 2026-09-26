import { describe, expect, it } from 'vitest'
import {
  applyPricing,
  computedTiers,
  convertPrice,
  emptyPricing,
  markupPrice,
  samePricing,
  subtractPrices,
  tierQuote,
} from '@/lib/pricing'
import type { PricingInput } from '@/lib/domain'
import { nioFromUsd, pricingInputSchema } from '@/features/products/product'

const cordobas: PricingInput = {
  purchasePrice: 500,
  purchaseCurrency: 'NIO',
  markups: { emprendedor: 20, vip: 15, premium: null },
}

describe('precio de compra más porcentaje', () => {
  it('sells a C$ 500 perfume at C$ 600 with 20 % and shows the C$ 100 profit', () => {
    expect(markupPrice(500, 20)).toBe(600)
    const quote = tierQuote(cordobas, 'emprendedor', 36.6)
    expect(quote).toEqual({
      tier: 'emprendedor',
      currency: 'NIO',
      purchasePrice: 500,
      percent: 20,
      profit: 100,
      price: 600,
      prices: { NIO: 600, USD: 16.39 },
    })
  })

  it('rounds half a cent up, as PostgreSQL does, even where floating point fails', () => {
    expect(markupPrice(10.05, 10)).toBe(11.06) // 11.055
    expect(markupPrice(33.33, 12.5)).toBe(37.5) // 37.49625
    expect(markupPrice(0.01, 0)).toBe(0.01)
    expect(markupPrice(19.99, 33.33)).toBe(26.65) // 26.652667
    // 0.5 × 36.61 = 18.305; en coma flotante 18.30499… y se iría a 18.30.
    expect(convertPrice(0.5, 'USD', 'NIO', 36.61)).toBe(18.31)
    expect(nioFromUsd(0.5, 36.61)).toBe(18.31)
    expect(convertPrice(600, 'NIO', 'USD', 36.6)).toBe(16.39)
    expect(convertPrice(0.01, 'NIO', 'USD', 2)).toBe(0.01) // 0.005 → 0.01
    expect(convertPrice(20, 'USD', 'USD', null)).toBe(20)
  })

  it('never prices at zero and refuses invalid inputs', () => {
    expect(convertPrice(0.01, 'NIO', 'USD', 36.6)).toBe(0.01)
    expect(markupPrice(0, 20)).toBeNaN()
    expect(markupPrice(-5, 20)).toBeNaN()
    expect(markupPrice(500, -1)).toBeNaN()
    expect(markupPrice(Number.NaN, 20)).toBeNaN()
    expect(convertPrice(10, 'USD', 'NIO', null)).toBeNaN()
    expect(convertPrice(10, 'USD', 'NIO', 0)).toBeNaN()
    expect(convertPrice(Number.NaN, 'USD', 'NIO', 36.6)).toBeNaN()
  })

  it('subtracts in cents', () => {
    expect(subtractPrices(0.3, 0.1)).toBe(0.2)
    expect(subtractPrices(575, 500)).toBe(75)
  })

  it('only computes a list that has both the purchase price and its percentage', () => {
    expect(tierQuote(cordobas, 'premium', 36.6)).toBeNull()
    expect(
      tierQuote({ ...cordobas, purchasePrice: null }, 'emprendedor', 36.6),
    ).toBeNull()
    expect(tierQuote(null, 'vip', 36.6)).toBeNull()
    expect(computedTiers(cordobas)).toBe(2)
    expect(computedTiers({ ...cordobas, purchasePrice: null })).toBe(0)
  })

  it('replaces only the computed lists and keeps the manual ones', () => {
    const prices = {
      emprendedor: { USD: 35, NIO: 1281 },
      vip: { USD: 34, NIO: 1244.4 },
      premium: { USD: 32, NIO: 1171.2 },
    }
    expect(applyPricing(prices, cordobas, 36.6)).toEqual({
      emprendedor: { NIO: 600, USD: 16.39 },
      vip: { NIO: 575, USD: 15.71 },
      premium: { USD: 32, NIO: 1171.2 },
    })
    // Sin tasa, la moneda de la compra se conoce y la otra no.
    expect(applyPricing(prices, cordobas, null).emprendedor).toEqual({
      NIO: 600,
      USD: Number.NaN,
    })
    // Compra en dólares: el dólar queda fijo y el córdoba sale de la tasa.
    expect(
      applyPricing(
        prices,
        { ...cordobas, purchasePrice: 20, purchaseCurrency: 'USD' },
        36.6,
      ).vip,
    ).toEqual({ USD: 23, NIO: 841.8 })
    expect(prices.emprendedor.NIO).toBe(1281)
  })

  it('knows when nothing changed', () => {
    expect(samePricing(emptyPricing(), emptyPricing('USD'))).toBe(true)
    expect(samePricing(cordobas, structuredClone(cordobas))).toBe(true)
    expect(
      samePricing(cordobas, { ...cordobas, purchaseCurrency: 'USD' }),
    ).toBe(false)
    expect(
      samePricing(cordobas, {
        ...cordobas,
        markups: { ...cordobas.markups, premium: 0 },
      }),
    ).toBe(false)
  })

  it('validates the purchase price and percentages with messages for the form', () => {
    expect(pricingInputSchema.safeParse(cordobas).success).toBe(true)
    expect(pricingInputSchema.safeParse(emptyPricing()).success).toBe(true)
    const messages = (value: unknown) =>
      pricingInputSchema.safeParse(value).error?.issues.map((i) => i.message)
    expect(messages({ ...cordobas, purchasePrice: 0 })).toEqual([
      'El precio de compra debe ser mayor que cero.',
    ])
    expect(messages({ ...cordobas, purchasePrice: 12.345 })).toEqual([
      'Usa hasta dos decimales.',
    ])
    expect(
      messages({ ...cordobas, markups: { ...cordobas.markups, vip: 1000.5 } }),
    ).toEqual(['Usa un porcentaje de hasta 1000.'])
    expect(
      messages({ ...cordobas, markups: { ...cordobas.markups, vip: -1 } }),
    ).toEqual(['El porcentaje no puede ser negativo.'])
    expect(
      messages({
        ...cordobas,
        markups: { ...cordobas.markups, vip: Number.NaN },
      }),
    ).toEqual(['Escribe el porcentaje o deja el campo vacío.'])
  })
})

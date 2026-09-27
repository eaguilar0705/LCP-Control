import { describe, expect, it } from 'vitest'
import {
  applyPricing,
  computedTiers,
  convertPrice,
  emptyPricing,
  exactCost,
  landedUnitCost,
  markupPrice,
  samePricing,
  shippingPerUnit,
  subtractPrices,
  tierQuote,
  tierStatus,
  weightedAverageCost,
} from '@/lib/pricing'
import type { PricingInput } from '@/lib/domain'
import { nioFromUsd, pricingInputSchema } from '@/features/products/product'

const excel: PricingInput = {
  markups: { emprendedor: 25, vip: 20, premium: null },
}
// Formulas.xlsx: 13 unidades a 15.675 («15,675» guardado como texto en
// Hoja 1!F10) y entran 20 a 16.675.
const EXCEL_EXISTING = Number('15,675'.replace(',', '.'))
const EXCEL_AVERAGE = weightedAverageCost(13, EXCEL_EXISTING, 20, 16.675)!

describe('costo promedio ponderado', () => {
  it('reproduces Formulas.xlsx: 16.281060… keeps six decimals and sells at 20.35 with 25 %', () => {
    expect(EXCEL_EXISTING).toBe(15.675)
    // (13 × 15.675 + 20 × 16.675) / 33 = 16.28106060…
    expect(EXCEL_AVERAGE).toBe(16.281061)
    expect(Math.abs(EXCEL_AVERAGE - 537.275 / 33)).toBeLessThan(5e-7)
    // Hoja 1!F16: promedio × (1 + 25 %) = 20.3513257… → 20.35 publicado.
    expect(markupPrice(EXCEL_AVERAGE, 25)).toBe(20.35)
    // Es un recargo sobre el costo, no un margen sobre la venta:
    // costo ÷ (1 − 25 %) daría 21.71.
    expect(markupPrice(EXCEL_AVERAGE, 25)).not.toBe(21.71)
    // Redondear el costo antes (16.28) daría el mismo 20.35 aquí, pero no en
    // general: el promedio no se redondea a centavos.
    expect(markupPrice(10.004999, 50)).toBe(15.01)
    expect(markupPrice(10.0, 50)).toBe(15)
  })

  it('starts again from the incoming cost when there is no stock, and refuses a gap', () => {
    expect(weightedAverageCost(0, null, 5, 42.123456)).toBe(42.123456)
    expect(weightedAverageCost(0, 99, 5, 42)).toBe(42)
    // Existencias sin costo: no hay base contra la cual promediar.
    expect(weightedAverageCost(3, null, 5, 42)).toBeNull()
    expect(weightedAverageCost(3, 10, 0, 42)).toBeNull()
    expect(weightedAverageCost(-1, 10, 1, 42)).toBeNull()
    expect(weightedAverageCost(3, 10, 1.5, 42)).toBeNull()
  })

  it('rounds the average half up at six decimals, like PostgreSQL', () => {
    // (1 × 0.000001 + 1 × 0.000002) / 2 = 0.0000015 → 0.000002
    expect(weightedAverageCost(1, 0.000001, 1, 0.000002)).toBe(0.000002)
    expect(weightedAverageCost(2, 115, 4, 127.75)).toBe(123.5)
  })

  it('computes the landed cost with the shipping share and the order rate', () => {
    expect(shippingPerUnit(3, 3)).toBe(1)
    expect(shippingPerUnit(100, 3)).toBe(33.333333)
    expect(shippingPerUnit(0.02, 3)).toBe(0.006667)
    expect(landedUnitCost(2, 1, 36.5)).toBe(109.5)
    expect(landedUnitCost(16.675, 0, 1)).toBe(16.675)
    expect(landedUnitCost(3, 0.5, 36.5)).toBe(127.75)
    expect(shippingPerUnit(10, 0)).toBeNaN()
    expect(landedUnitCost(1, 0, 0)).toBeNaN()
  })

  it('writes the exact cost without trailing zeros', () => {
    expect(exactCost(16.281061)).toBe('16.281061')
    expect(exactCost(109.5)).toBe('109.5')
    expect(exactCost(100)).toBe('100')
  })
})

describe('costo promedio más porcentaje', () => {
  it('breaks a computed list into cost, percentage, profit and price', () => {
    expect(tierQuote(excel, EXCEL_AVERAGE, 'emprendedor', 36.6)).toEqual({
      tier: 'emprendedor',
      cost: 16.281061,
      percent: 25,
      profit: 4.07,
      price: 20.35,
      prices: { NIO: 20.35, USD: 0.56 },
    })
    expect(markupPrice(500, 20)).toBe(600)
  })

  it('rounds half a cent up, as PostgreSQL does, even where floating point fails', () => {
    expect(markupPrice(10.05, 10)).toBe(11.06) // 11.055
    expect(markupPrice(33.33, 12.5)).toBe(37.5) // 37.49625
    expect(markupPrice(0.01, 0)).toBe(0.01)
    expect(markupPrice(19.99, 33.33)).toBe(26.65) // 26.652667
    expect(markupPrice(18.004, 12.5)).toBe(20.25) // 20.2545
    // 0.5 × 36.61 = 18.305; en coma flotante 18.30499… y se iría a 18.30.
    expect(convertPrice(0.5, 'USD', 'NIO', 36.61)).toBe(18.31)
    expect(nioFromUsd(0.5, 36.61)).toBe(18.31)
    expect(convertPrice(600, 'NIO', 'USD', 36.6)).toBe(16.39)
    expect(convertPrice(0.01, 'NIO', 'USD', 2)).toBe(0.01) // 0.005 → 0.01
    expect(convertPrice(20, 'USD', 'USD', null)).toBe(20)
  })

  it('never prices at zero and refuses invalid inputs', () => {
    expect(convertPrice(0.01, 'NIO', 'USD', 36.6)).toBe(0.01)
    // Un costo de cero es posible (mercadería regalada): el piso es un centavo.
    expect(markupPrice(0, 20)).toBe(0.01)
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

  it('computes a list only with a percentage and a known cost; otherwise it is pending or manual', () => {
    expect(tierStatus(excel, 16.28, 'emprendedor')).toBe('computed')
    expect(tierStatus(excel, null, 'emprendedor')).toBe('pending')
    expect(tierStatus(excel, 16.28, 'premium')).toBe('manual')
    expect(tierStatus(null, 16.28, 'vip')).toBe('manual')
    expect(tierQuote(excel, 16.28, 'premium', 36.6)).toBeNull()
    expect(tierQuote(excel, null, 'emprendedor', 36.6)).toBeNull()
    expect(computedTiers(excel, 16.28)).toBe(2)
    expect(computedTiers(excel, null)).toBe(0)
  })

  it('replaces only the computed lists and keeps manual and pending ones', () => {
    const prices = {
      emprendedor: { USD: 35, NIO: 1281 },
      vip: { USD: 34, NIO: 1244.4 },
      premium: { USD: 32, NIO: 1171.2 },
    }
    expect(applyPricing(prices, excel, EXCEL_AVERAGE, 36.6)).toEqual({
      emprendedor: { NIO: 20.35, USD: 0.56 },
      vip: { NIO: 19.54, USD: 0.53 },
      premium: { USD: 32, NIO: 1171.2 },
    })
    // Sin tasa el córdoba se conoce y el dólar no.
    expect(
      applyPricing(prices, excel, EXCEL_AVERAGE, null).emprendedor,
    ).toEqual({
      NIO: 20.35,
      USD: Number.NaN,
    })
    // Sin costo nada se inventa: quedan los precios publicados.
    expect(applyPricing(prices, excel, null, 36.6)).toEqual(prices)
    // Otra tasa mueve el dólar; el córdoba sale del costo y no cambia.
    expect(applyPricing(prices, excel, EXCEL_AVERAGE, 37).emprendedor).toEqual({
      NIO: 20.35,
      USD: 0.55,
    })
    expect(prices.emprendedor.NIO).toBe(1281)
  })

  it('knows when nothing changed', () => {
    expect(samePricing(emptyPricing(), emptyPricing())).toBe(true)
    expect(samePricing(excel, structuredClone(excel))).toBe(true)
    expect(
      samePricing(excel, { markups: { ...excel.markups, premium: 0 } }),
    ).toBe(false)
  })

  it('validates percentages with messages for the form and never sends a cost', () => {
    expect(pricingInputSchema.safeParse(excel).success).toBe(true)
    expect(pricingInputSchema.safeParse(emptyPricing()).success).toBe(true)
    // Un precio de compra que llegue de otra parte no viaja a la base.
    expect(pricingInputSchema.parse({ ...excel, purchasePrice: 500 })).toEqual(
      excel,
    )
    const messages = (value: unknown) =>
      pricingInputSchema.safeParse(value).error?.issues.map((i) => i.message)
    expect(messages({ markups: { ...excel.markups, vip: 1000.5 } })).toEqual([
      'Usa un porcentaje de hasta 1000.',
    ])
    expect(messages({ markups: { ...excel.markups, vip: -1 } })).toEqual([
      'El porcentaje no puede ser negativo.',
    ])
    expect(messages({ markups: { ...excel.markups, vip: 12.345 } })).toEqual([
      'Usa hasta dos decimales.',
    ])
    expect(
      messages({ markups: { ...excel.markups, vip: Number.NaN } }),
    ).toEqual(['Escribe el porcentaje o deja el campo vacío.'])
  })
})

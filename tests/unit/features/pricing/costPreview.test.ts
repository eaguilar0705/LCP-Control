import { describe, expect, it } from 'vitest'
import {
  previewPurchase,
  type PurchaseLineDraft,
} from '@/features/pricing/costPreview'
import type { InventoryItem, Product, ProductPricing } from '@/lib/domain'

function perfume(id: string, active = true): Product {
  return {
    id,
    barcode: id,
    name: id,
    brand: 'Marca',
    category: 'arabian',
    gender: 'unisex',
    size: 100,
    unit: 'ml',
    price: 0,
    currency: 'NIO',
    minimumStock: 0,
    active,
    prices: {
      emprendedor: { NIO: 19.59, USD: 0.54 },
      vip: { NIO: 18.81, USD: 0.51 },
      premium: { NIO: 1171.2, USD: 32 },
    },
  }
}
const inventory: InventoryItem[] = [
  { product: perfume('excel'), quantities: { store: 5, warehouse: 8 } },
  { product: perfume('vacio'), quantities: { store: 0, warehouse: 0 } },
  { product: perfume('sin-costo'), quantities: { store: 3, warehouse: 0 } },
  { product: perfume('sin-conteo'), quantities: { store: 3, warehouse: null } },
  {
    product: perfume('inactivo', false),
    quantities: { store: 0, warehouse: 0 },
  },
]
const pricing: ProductPricing[] = [
  {
    productId: 'excel',
    averageCost: 15.675,
    markups: { emprendedor: 25, vip: 20, premium: null },
    updatedAt: null,
  },
]
const line = (changes: Partial<PurchaseLineDraft>): PurchaseLineDraft => ({
  productId: 'excel',
  location: 'warehouse',
  quantity: '20',
  unitPrice: '16.675',
  ...changes,
})
const preview = (
  lines: PurchaseLineDraft[],
  extra: Partial<Parameters<typeof previewPurchase>[0]> = {},
) =>
  previewPurchase({
    lines,
    shippingText: '0',
    currency: 'NIO',
    rateText: '',
    inventory,
    pricing,
    catalogRate: 36.6,
    ...extra,
  })

describe('vista previa de una compra', () => {
  it('gives the Formulas.xlsx average and the prices of the computed lists', () => {
    const result = preview([line({})])
    expect(result.ready).toBe(true)
    expect(result.problem).toBeNull()
    const [row] = result.lines
    expect(row).toMatchObject({
      existing: 13,
      previousAverage: 15.675,
      landed: 16.675,
      nextAverage: 16.281061,
    })
    expect(row.prices).toEqual([
      {
        tier: 'emprendedor',
        markup: 25,
        before: 19.59,
        after: 20.35,
        afterUsd: 0.56,
      },
      { tier: 'vip', markup: 20, before: 18.81, after: 19.54, afterUsd: 0.53 },
    ])
  })

  it('spreads the order shipping over every unit and converts with the order rate', () => {
    const result = preview(
      [
        line({ quantity: '2', unitPrice: '3' }),
        line({ productId: 'vacio', quantity: '2', unitPrice: '1' }),
      ],
      { currency: 'USD', rateText: '36.5', shippingText: '2' },
    )
    expect(result.perUnit).toBe(0.5)
    expect(result.lines.map((row) => row.landed)).toEqual([127.75, 54.75])
    // Sin existencias, el promedio es el costo de lo que entra.
    expect(result.lines[1].nextAverage).toBe(54.75)
    expect(result.ready).toBe(true)
  })

  it('does not let an order through without the data the database needs', () => {
    expect(
      preview([line({ productId: 'sin-costo' })]).lines[0].problem,
    ).toMatch(/carga primero su costo inicial/)
    expect(
      preview([line({ productId: 'sin-conteo' })]).lines[0].problem,
    ).toMatch(/conteo de tienda y bodega/)
    expect(preview([line({ productId: 'inactivo' })]).lines[0].problem).toMatch(
      /inactivo/,
    )
    expect(preview([line({ quantity: '1.5' })]).lines[0].problem).toMatch(
      /entera/,
    )
    expect(
      preview([line({ unitPrice: '1.1234567' })]).lines[0].problem,
    ).toMatch(/seis decimales/)
    expect(preview([line({}), line({})]).lines[1].problem).toMatch(
      /otro renglón/,
    )
    expect(
      preview([line({})], { currency: 'USD', rateText: '' }).problem,
    ).toMatch(/tipo de cambio/)
    expect(preview([line({})], { shippingText: '' }).problem).toMatch(/envío/)
    expect(preview([line({})], { shippingText: '1.234' }).ready).toBe(false)
    expect(preview([line({ unitPrice: '0' })]).problem).toMatch(
      /Revisa el costo/,
    )
    for (const result of [
      preview([line({ productId: 'sin-costo' })]),
      preview([line({})], { currency: 'USD', rateText: '0' }),
    ])
      expect(result.ready).toBe(false)
  })
})

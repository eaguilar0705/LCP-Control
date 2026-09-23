import { describe, expect, it } from 'vitest'
import {
  productInput,
  productInputSchema,
  optimizeProductImage,
} from '@/features/products/product'
const valid = () => ({
  ...productInput(),
  name: 'Perfume',
  brand: 'Marca',
  prices: {
    emprendedor: { NIO: 1000, USD: 30 },
    vip: { NIO: 950, USD: 28 },
    premium: { NIO: 900, USD: 25 },
  },
})
describe('product editor validation', () => {
  it('keeps unknown size separate from zero and requires all prices', () => {
    expect(productInputSchema.safeParse(valid()).success).toBe(true)
    expect(productInputSchema.safeParse({ ...valid(), size: 0 }).success).toBe(
      false,
    )
    expect(
      productInputSchema.safeParse({
        ...valid(),
        prices: { emprendedor: { NIO: 1, USD: 1 } },
      }).success,
    ).toBe(false)
  })
  it('rejects invalid manufacturer codes and fractional stock thresholds', () => {
    expect(
      productInputSchema.safeParse({
        ...valid(),
        manufacturerBarcode: '123456',
      }).success,
    ).toBe(false)
    expect(
      productInputSchema.safeParse({ ...valid(), minimumStock: 1.5 }).success,
    ).toBe(false)
  })
  it('rejects negative prices and precision beyond cents', () => {
    for (const price of [-1, 1.111, 0, Infinity]) {
      const input = valid()
      input.prices.vip.USD = price
      expect(productInputSchema.safeParse(input).success).toBe(false)
    }
  })
  it('rejects non-image uploads before attempting to decode', async () => {
    await expect(
      optimizeProductImage(
        new File(['<svg/>'], 'image.svg', { type: 'image/svg+xml' }),
      ),
    ).rejects.toThrow('JPG')
  })
})

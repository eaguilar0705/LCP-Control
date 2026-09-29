import { describe, expect, it } from 'vitest'
import { catalogAdapter, catalogProducts } from '@/services/adapters/catalog'
import { createServices } from '@/services'
import {
  emptyFilters,
  filterInventory,
  stockStatus,
  totalStock,
} from '@/features/inventory/model'
import { lineCents } from '@/lib/pricing'
import { draftTotal, type DraftLine } from '@/features/sales/document'
import { dailyReflection, reflections } from '@/features/dashboard/quotes'
describe('synthetic local catalog', () => {
  it('keeps unique internal identifiers and a price for every tier and currency', () => {
    expect(catalogProducts).toHaveLength(30)
    expect(new Set(catalogProducts.map((p) => p.barcode)).size).toBe(30)
    // El precio se fija en dólares y el de córdobas sale de la tasa de la
    // vista local, igual que en la base: 25 × 36.6 = 915.
    expect(catalogProducts[0].prices).toEqual({
      emprendedor: { NIO: 915, USD: 25 },
      vip: { NIO: 878.4, USD: 24 },
      premium: { NIO: 805.2, USD: 22 },
    })
    expect(
      catalogProducts.every(
        (p) => p.barcodeKind === 'internal' && p.manufacturerBarcode === null,
      ),
    ).toBe(true)
    expect(catalogProducts.filter((p) => p.size === null)).toHaveLength(6)
  })
  it('carries no business records: invented codes and no external links', () => {
    expect(catalogProducts.every((p) => /^DEMO-\d{4}$/.test(p.barcode))).toBe(
      true,
    )
    expect(
      catalogProducts.every(
        (p) =>
          !p.imageSource && (!p.imageUrl || p.imageUrl.startsWith('data:')),
      ),
    ).toBe(true)
  })
  it('does not turn unknown stock into zero or low-stock alerts', async () => {
    // La vista local llega contada; lo que no puede pasar es que un saldo sin
    // contar se lea como cero, así que la invariante se prueba sobre una copia
    // sin conteo del mismo catálogo.
    const counted = await catalogAdapter.getInventory()
    expect(counted.every((item) => totalStock(item) !== null)).toBe(true)
    const items = counted.map((item) => ({
      ...item,
      quantities: { store: null, warehouse: null },
    }))
    expect(
      items.every(
        (item) => totalStock(item) === null && stockStatus(item) === 'unknown',
      ),
    ).toBe(true)
    expect(
      await createServices({
        ...catalogAdapter,
        getInventory: async () => items,
      }).inventoryService.getLowStock(),
    ).toEqual([])
    expect(filterInventory(items, { ...emptyFilters, stock: 'out' })).toEqual(
      [],
    )
    expect(
      filterInventory(items, { ...emptyFilters, stock: 'unknown' }),
    ).toHaveLength(30)
  })
  it('finds exact internal codes and combines brand, size and category filters', async () => {
    const first = catalogProducts[0]
    expect(
      (
        await createServices(catalogAdapter).productService.findByBarcode(
          ` ${first.barcode} `,
        )
      )?.id,
    ).toBe(first.id)
    const items = await catalogAdapter.getInventory()
    const filtered = filterInventory(items, {
      ...emptyFilters,
      category: 'niche',
      brand: 'Taller Índigo',
      size: '3.4 oz',
    })
    expect(filtered.map((i) => i.product.name)).toEqual([
      'Cedro 21',
      'Jazmín 22',
    ])
  })
})
describe('document arithmetic', () => {
  const p = catalogProducts[0]
  const lines: DraftLine[] = [
    {
      productId: p.id,
      name: p.name,
      barcode: p.barcode,
      size: '3.4 oz',
      quantity: 3,
      prices: p.prices!,
    },
  ]
  it('selects the quoted price for each currency and tier, preserving quantity', () => {
    expect(draftTotal(lines, 'emprendedor', 'NIO')).toBe(2745)
    expect(draftTotal(lines, 'emprendedor', 'USD')).toBe(75)
    expect(draftTotal(lines, 'premium', 'USD')).toBe(66)
    expect(draftTotal(lines, 'premium', 'NIO')).toBe(2415.6)
    expect(lines[0].quantity).toBe(3)
  })
  it('rounds at the cent and rejects invalid quantities', () => {
    expect(lineCents(19.99, 3)).toBe(5997)
    for (const quantity of [0, -1, 1.5, NaN, Infinity])
      expect(() => lineCents(10, quantity)).toThrow()
  })
})
describe('daily reflections', () => {
  it('contains 365 unique reflections and uses each date exactly once', () => {
    expect(reflections).toHaveLength(365)
    expect(new Set(reflections).size).toBe(365)
    const year = Array.from({ length: 365 }, (_, i) =>
      dailyReflection(new Date(Date.UTC(2027, 0, i + 1, 12))),
    )
    expect(new Set(year).size).toBe(365)
  })
  it('changes at midnight in Nicaragua, independently of the device timezone', () => {
    expect(dailyReflection(new Date('2026-09-28T05:59:59Z'))).not.toBe(
      dailyReflection(new Date('2026-09-28T06:00:00Z')),
    )
    expect(dailyReflection(new Date('2026-09-28T06:00:00Z'))).toBe(
      dailyReflection(new Date('2026-09-29T05:59:59Z')),
    )
  })
  it('keeps calendar dates stable in leap years', () => {
    expect(dailyReflection(new Date('2028-03-01T12:00:00Z'))).toBe(
      dailyReflection(new Date('2027-03-01T12:00:00Z')),
    )
    expect(dailyReflection(new Date('2028-02-29T12:00:00Z'))).toBe(
      reflections[364],
    )
  })
})

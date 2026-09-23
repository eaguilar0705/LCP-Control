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
import { nextReflection, reflections } from '@/features/dashboard/quotes'
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
describe('reflection rotation', () => {
  it('uses every reflection before repeating and avoids an immediate cycle repeat', () => {
    let value: string | null = null
    const storage = {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next
      },
    }
    const seen = Array.from({ length: reflections.length }, () =>
      nextReflection(storage, () => 0),
    )
    expect(new Set(seen).size).toBe(reflections.length)
    expect(nextReflection(storage, () => 0)).not.toBe(seen.at(-1))
  })
  it('tolerates corrupt or unavailable storage', () => {
    expect(reflections).toContain(
      nextReflection({
        getItem: () => '{broken',
        setItem: () => {
          throw new Error('blocked')
        },
      }),
    )
  })
})

import { expect, it } from 'vitest'
import { catalogAdapter } from '@/services/adapters/catalog'
import {
  emptyFilters,
  filterInventory,
  locationTotals,
} from '@/features/inventory/model'

it('finds inventory by manufacturer barcode including leading zeros, or internal label', async () => {
  const items = (await catalogAdapter.getInventory()).slice(0, 2)
  items[0] = {
    ...items[0],
    product: { ...items[0].product, manufacturerBarcode: '012345678905' },
  }
  expect(
    filterInventory(items, { ...emptyFilters, search: '012345678905' }),
  ).toEqual([items[0]])
  expect(
    filterInventory(items, {
      ...emptyFilters,
      search: items[1].product.barcode,
    }),
  ).toEqual([items[1]])
  expect(
    filterInventory(items, { ...emptyFilters, search: '9999999999999' }),
  ).toEqual([])
})

it('consolidates Bodega + Tienda and leaves partial counts out of the total', async () => {
  const [a, b, c] = (await catalogAdapter.getInventory()).slice(0, 3)
  const items = [
    { ...a, quantities: { warehouse: 10, store: 4 } },
    { ...b, quantities: { warehouse: 3, store: null } },
    { ...c, quantities: { warehouse: 0, store: 2 } },
  ]
  expect(locationTotals(items)).toEqual({
    warehouse: 13,
    store: 6,
    total: 16,
    uncounted: 1,
  })
  expect(
    filterInventory(items, {
      ...emptyFilters,
      location: 'warehouse',
      stock: 'out',
    }),
  ).toEqual([items[2]])
  expect(
    filterInventory(items, {
      ...emptyFilters,
      location: 'store',
      stock: 'unknown',
    }),
  ).toEqual([items[1]])
})

import { expect, it } from 'vitest'
import { catalogAdapter } from '../../services/adapters/catalog'
import { emptyFilters, filterInventory } from './model'

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

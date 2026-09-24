import { expect, it } from 'vitest'
import { catalogAdapter } from '@/services/adapters/catalog'
import {
  emptyFilters,
  filterInventory,
  locationTotals,
  lowStockItems,
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

it('busca sin distinguir tildes ni mayúsculas, como el buscador al facturar', async () => {
  const items = await catalogAdapter.getInventory()
  const withAccent = filterInventory(items, {
    ...emptyFilters,
    search: 'Jazmín',
  })
  expect(withAccent.length).toBeGreaterThan(0)
  for (const search of ['jazmin', 'JAZMIN', '  jazmín  '])
    expect(filterInventory(items, { ...emptyFilters, search })).toEqual(
      withAccent,
    )
  // La frase completa: «Cedro 01» es un solo perfume, aunque DEMO-0011 y
  // DEMO-0016 contengan «01» en el código.
  expect(
    filterInventory(items, { ...emptyFilters, search: 'cedro 01' }).map(
      ({ product }) => product.barcode,
    ),
  ).toEqual(['DEMO-0001'])
  expect(
    filterInventory(items, { ...emptyFilters, search: 'nacar' }).length,
  ).toBe(filterInventory(items, { ...emptyFilters, search: 'Nácar' }).length)
})

it('alerta sólo lo contado por debajo de un mínimo mayor que cero', async () => {
  const [a, b, c, d] = (await catalogAdapter.getInventory()).slice(0, 4)
  const minimum = (item: typeof a, value: number | null) => ({
    ...item,
    product: { ...item.product, minimumStock: value },
  })
  const items = [
    { ...minimum(a, 5), quantities: { warehouse: 1, store: 2 } }, // 3 < 5
    { ...minimum(b, 5), quantities: { warehouse: null, store: 1 } }, // sin conteo
    { ...minimum(c, 0), quantities: { warehouse: 0, store: 0 } }, // mínimo 0
    { ...minimum(d, 2), quantities: { warehouse: 1, store: 1 } }, // 2, no baja
  ]
  expect(lowStockItems(items)).toEqual([items[0]])
})

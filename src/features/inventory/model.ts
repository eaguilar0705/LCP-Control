import type {
  InventoryItem,
  Category,
  Gender,
  InventoryLocation,
} from '../../lib/domain'
export type StockFilter = '' | 'low' | 'out' | 'available' | 'unknown'
export interface InventoryFilters {
  search: string
  category: Category | ''
  gender: Gender | ''
  location: InventoryLocation | ''
  stock: StockFilter
  brand: string
  size: string
}
export const emptyFilters: InventoryFilters = {
  search: '',
  category: '',
  gender: '',
  location: '',
  stock: '',
  brand: '',
  size: '',
}
export function totalStock(item: InventoryItem) {
  const { store, warehouse } = item.quantities
  return store === null || warehouse === null ? null : store + warehouse
}
export interface LocationTotals {
  warehouse: number
  store: number
  /** Suma consolidada Bodega + Tienda de los productos con ambos conteos. */
  total: number
  /** Productos con al menos una ubicación sin conteo registrado. */
  uncounted: number
}
/**
 * Totales por ubicación de la lista visible. Cada ubicación suma sólo los
 * conteos registrados; el consolidado suma únicamente los productos con ambos
 * conteos, igual que `totalStock`, para no presentar una cifra parcial como
 * total. `uncounted` avisa cuántos productos quedan fuera.
 */
export function locationTotals(items: InventoryItem[]): LocationTotals {
  return items.reduce<LocationTotals>(
    (sum, item) => {
      const { warehouse, store } = item.quantities
      const total = totalStock(item)
      return {
        warehouse: sum.warehouse + (warehouse ?? 0),
        store: sum.store + (store ?? 0),
        total: sum.total + (total ?? 0),
        uncounted: sum.uncounted + (total === null ? 1 : 0),
      }
    },
    { warehouse: 0, store: 0, total: 0, uncounted: 0 },
  )
}
export function stockStatus(item: InventoryItem) {
  const total = totalStock(item)
  return total === null
    ? 'unknown'
    : total === 0
      ? 'out'
      : item.product.minimumStock !== null && total < item.product.minimumStock
        ? 'low'
        : 'available'
}
export function filterInventory(
  items: InventoryItem[],
  filters: InventoryFilters,
) {
  const query = filters.search.toLocaleLowerCase('es').trim()
  return items.filter((item) => {
    const product = item.product
    const quantity = filters.location
      ? item.quantities[filters.location]
      : totalStock(item)
    return (
      `${product.name} ${product.brand} ${product.barcode} ${product.manufacturerBarcode ?? ''}`
        .toLocaleLowerCase('es')
        .includes(query) &&
      (!filters.category || product.category === filters.category) &&
      (!filters.gender || product.gender === filters.gender) &&
      (!filters.brand || product.brand === filters.brand) &&
      (!filters.size ||
        (product.size === null
          ? 'unknown'
          : `${product.size} ${product.unit}`) === filters.size) &&
      (filters.stock !== 'out' || quantity === 0) &&
      (filters.stock !== 'low' ||
        (quantity !== null &&
          product.minimumStock !== null &&
          quantity < product.minimumStock)) &&
      (filters.stock !== 'available' || (quantity !== null && quantity > 0)) &&
      (filters.stock !== 'unknown' || quantity === null)
    )
  })
}

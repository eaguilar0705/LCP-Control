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

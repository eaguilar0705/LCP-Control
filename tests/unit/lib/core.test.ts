import { describe, expect, it } from 'vitest'
import { can, parseRole } from '@/lib/permissions'
import { quantitySchema } from '@/lib/validation'
import { formatCurrency, formatDate } from '@/lib/format'
import { createServices } from '@/services'
import { demoAdapter } from '@/services/adapters/demo'
import {
  emptyFilters,
  filterInventory,
  totalStock,
} from '@/features/inventory/model'
describe('capabilities fail closed', () => {
  it('denies missing and invalid roles', () => {
    expect(can(null, 'inventory.read')).toBe(false)
    expect(parseRole('owner')).toBeNull()
  })
  it('allows operations and denies administrative capabilities for operators', () => {
    expect(can('operator', 'sale.create')).toBe(true)
    for (const capability of [
      'product.manage',
      'product.edit_cost',
      'inventory.create_entry',
      'inventory.adjust',
      'finance.read',
    ] as const)
      expect(can('operator', capability)).toBe(false)
  })
  it('allows admin management', () =>
    expect(can('admin', 'inventory.adjust')).toBe(true))
})
describe('quantities and currency', () => {
  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '2'])(
    'rejects invalid quantity %s',
    (value) => expect(quantitySchema.safeParse(value).success).toBe(false),
  )
  it('accepts a positive whole quantity', () =>
    expect(quantitySchema.parse(2)).toBe(2))
  it.each(['NIO', 'USD'] as const)(
    'uses explicit %s and two decimals',
    (currency) => {
      const formatted = formatCurrency(1234.5, currency)
      expect(formatted).toContain(currency)
      expect(formatted).toMatch(/1[,.]234[,.]50/)
    },
  )
})
describe('read-only inventory services', () => {
  const { productService, inventoryService } = createServices(demoAdapter)
  it('finds an exact trimmed barcode', async () => {
    expect((await productService.findByBarcode(' LCP-0001 '))?.name).toBe(
      'Producto A',
    )
  })
  it('returns null for an unknown product', async () =>
    expect(await productService.findByBarcode('unknown')).toBeNull())
  it('rejects invalid scans', async () =>
    expect(productService.findByBarcode(' ')).rejects.toThrow())
  it('does not let consumers mutate fixtures', async () => {
    const items = await inventoryService.getInventory()
    items[0].quantities.store = -10
    expect((await inventoryService.getInventory())[0].quantities.store).toBe(12)
  })
  it('counts both locations and includes out of stock in alerts', async () => {
    const items = await inventoryService.getInventory()
    expect(totalStock(items[0])).toBe(30)
    expect(
      (await inventoryService.getLowStock()).map((item) => item.product.name),
    ).toEqual(['Producto B', 'Producto D', 'Producto F'])
  })
  it('combines search, category and location filters', async () => {
    const items = await inventoryService.getInventory()
    expect(
      filterInventory(items, {
        ...emptyFilters,
        search: 'LCP-0004',
        location: 'store',
        stock: 'out',
        category: 'designer',
      }),
    ).toHaveLength(1)
  })
})

describe('fechas sin hora', () => {
  it('mantiene el día de una fecha suelta, sea cual sea la zona del equipo', () => {
    // Medianoche UTC del 20 es todavía el 19 en Managua: sin anclaje, una
    // vigencia o un periodo de reporte se mostrarían un día antes.
    expect(formatDate('2026-09-20')).toBe('20 de septiembre de 2026')
    expect(formatDate('2026-01-01')).toBe('1 de enero de 2026')
    // Con hora explícita se respeta el instante: 03:00 UTC es el día anterior.
    expect(formatDate('2026-09-20T03:00:00Z')).toBe('19 de septiembre de 2026')
  })
})

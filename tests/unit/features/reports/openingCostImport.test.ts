import { describe, expect, it } from 'vitest'
import type { InventoryItem, Product } from '@/lib/domain'
import {
  parseAmount,
  parseOpeningCosts,
} from '@/features/reports/openingCostImport'
import type { ReportSource } from '@/features/reports/model'

const base: Product = {
  id: 'p1',
  barcode: 'LCP-001',
  name: 'Perfume',
  brand: 'Marca',
  category: 'arabian',
  gender: 'unisex',
  size: 100,
  unit: 'ml',
  price: 900,
  currency: 'NIO',
  minimumStock: 2,
  active: true,
}
function item(
  overrides: Partial<Product>,
  quantities: InventoryItem['quantities'],
): InventoryItem {
  return { product: { ...base, ...overrides }, quantities }
}
function source(
  inventory: InventoryItem[],
  costed: string[] = [],
): ReportSource {
  return {
    window: { from: '2026-09-01', to: '2026-09-30' },
    truncated: false,
    customers: [],
    documents: [],
    movements: [],
    inventory,
    accounting: {
      available: true,
      truncated: false,
      shipments: [],
      expenses: [],
      saleCosts: [],
      costs: inventory.map((row) => ({
        productId: row.product.id,
        averageCostNio: costed.includes(row.product.id) ? 400 : null,
        updatedAt: '2026-09-01T18:00:00Z',
      })),
    },
  }
}

describe('lectura de una lista de costos iniciales', () => {
  it('acepta las dos formas de escribir un número y rechaza lo que no lo es', () => {
    expect(parseAmount('420.50')).toBe(420.5)
    expect(parseAmount('1,250.75')).toBe(1250.75)
    expect(parseAmount('1.250,75')).toBe(1250.75)
    expect(parseAmount('1.250')).toBe(1250)
    expect(parseAmount('420,5')).toBe(420.5)
    expect(parseAmount('C$ 1 200,40')).toBe(1200.4)
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('sin costo')).toBeNull()
    expect(parseAmount('-40')).toBeNull()
  })
  it('resuelve códigos con tabulación, punto y coma o coma y omite el encabezado', () => {
    const value = source([
      item({}, { store: 1, warehouse: 2 }),
      item({ id: 'p2', barcode: 'LCP-002' }, { store: 4, warehouse: 0 }),
      item(
        { id: 'p3', barcode: 'LCP-003', manufacturerBarcode: '7501111' },
        { store: 1, warehouse: 1 },
      ),
    ])
    const { rows, problems } = parseOpeningCosts(
      'Código;Costo\nLCP-001\t420.50\nLCP-002;1.100,25\n7501111,Perfume nicho,980\n',
      value,
    )
    expect(problems).toEqual([])
    expect(rows.map((row) => [row.productId, row.unitCost, row.stock])).toEqual(
      [
        ['p1', 420.5, 3],
        ['p2', 1100.25, 4],
        ['p3', 980, 2],
      ],
    )
  })
  it('explica cada fila que no se puede registrar en lugar de descartarla en silencio', () => {
    const value = source(
      [
        item({}, { store: 1, warehouse: 2 }),
        item({ id: 'p2', barcode: 'LCP-002' }, { store: null, warehouse: 3 }),
        item({ id: 'p3', barcode: 'LCP-003' }, { store: 0, warehouse: 0 }),
        item({ id: 'p4', barcode: 'LCP-004' }, { store: 2, warehouse: 2 }),
      ],
      ['p4'],
    )
    const { rows, problems } = parseOpeningCosts(
      'LCP-001\t400\nLCP-001\t500\nLCP-002\t300\nLCP-003\t300\nLCP-004\t300\nLCP-999\t300\nLCP-001x\n',
      value,
    )
    expect(rows).toHaveLength(1)
    expect(problems.map((problem) => [problem.line, problem.reason])).toEqual([
      [2, 'El producto ya aparece en otra fila de la lista.'],
      [3, 'Falta el conteo de tienda o de bodega.'],
      [4, 'No tiene existencias contadas que valorar.'],
      [5, 'Ya tiene costo promedio. Actualízalo registrando la compra.'],
      [6, 'No hay ningún producto con ese código.'],
      [7, 'No hay ningún producto con ese código.'],
    ])
  })
})

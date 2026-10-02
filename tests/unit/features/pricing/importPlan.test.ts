import { describe, expect, it } from 'vitest'
import {
  classifyHeader,
  planPricingImport,
  PricingFileError,
  readCurrency,
} from '@/features/pricing/importPlan'
import { pricingTemplate } from '@/features/pricing/template'
import { buildWorkbook } from '@/lib/xlsx'
import { readSpreadsheet, type SheetRows } from '@/lib/spreadsheet'
import type { Product, ProductPricing } from '@/lib/domain'

function perfume(number: number, changes: Partial<Product> = {}): Product {
  const code = `LCP-${String(number).padStart(4, '0')}`
  return {
    id: `p${number}`,
    revision: number,
    barcode: code,
    manufacturerBarcode: null,
    name: `Perfume ${number}`,
    brand: 'Marca',
    category: 'arabian',
    gender: 'unisex',
    size: 100,
    unit: 'ml',
    price: 1281,
    currency: 'NIO',
    minimumStock: 0,
    active: true,
    prices: {
      emprendedor: { USD: 35, NIO: 1281 },
      vip: { USD: 34, NIO: 1244.4 },
      premium: { USD: 32, NIO: 1171.2 },
    },
    ...changes,
  }
}
const products = [
  perfume(1),
  perfume(2, { manufacturerBarcode: '7501234567890' }),
  perfume(3, { name: 'Jazmín Nocturno', brand: 'Casa Ámbar' }),
  perfume(4, { name: 'Cedro', brand: 'Aurora', size: 3.4, unit: 'oz' }),
  perfume(5, { name: 'Cedro', brand: 'Aurora', size: 1, unit: 'oz' }),
]
// p1: compra de C$ 100 con porcentajes; p2 (US$ 20) y p5 (C$ 900): compra
// sin porcentajes; p3 y p4: sin precio de compra todavía.
const saved: ProductPricing[] = [
  {
    productId: 'p1',
    averageCost: 80,
    purchasePrice: 100,
    purchaseCurrency: 'NIO',
    markups: { emprendedor: 20, vip: 15, premium: 10 },
    updatedAt: null,
  },
  {
    productId: 'p2',
    averageCost: 16.281061,
    purchasePrice: 20,
    purchaseCurrency: 'USD',
    markups: { emprendedor: null, vip: null, premium: null },
    updatedAt: null,
  },
  {
    productId: 'p5',
    averageCost: null,
    purchasePrice: 900,
    purchaseCurrency: 'NIO',
    markups: { emprendedor: null, vip: null, premium: null },
    updatedAt: null,
  },
]
const plan = (rows: SheetRows) =>
  planPricingImport({ rows, products, pricing: saved, rate: 36.6 })
const HEADER = ['Código', '% Emprendedor', '% VIP', '% Premium']

describe('encabezados', () => {
  it('recognises the columns however they are written, purchase price and currency included', () => {
    expect(
      [
        'Código',
        'codigo interno',
        'SKU',
        'EAN',
        'Marca',
        'Nombre del perfume',
        'Producto',
        'Tamaño',
        'Presentación',
        'Costo promedio C$ (informativo, no se importa)',
        'Precio de compra',
        'Costo (C$)',
        'Compra',
        'Moneda',
        '% Emprendedor',
        'Ganancia mayorista',
        '% VIP',
        'Porcentaje Premium',
        '% de ganancia sobre el costo Premium',
        'Emprendedor',
        'Precio VIP',
        'Notas',
        42,
        null,
      ].map(classifyHeader),
    ).toEqual([
      'code',
      'code',
      'code',
      'code',
      'brand',
      'name',
      'name',
      'size',
      'size',
      'ignored',
      'purchase',
      'purchase',
      'purchase',
      'currency',
      'emprendedor',
      'emprendedor',
      'vip',
      'premium',
      'premium',
      null,
      null,
      null,
      null,
      null,
    ])
  })

  it('finds the header under title rows and says what is missing when there is none', () => {
    const result = plan([['Lista de precios'], [], HEADER, ['LCP-0002', 40]])
    expect(result.headerLine).toBe(3)
    expect(result.changes).toHaveLength(1)
    expect(() =>
      plan([
        ['a', 'b'],
        ['LCP-0001', 5],
      ]),
    ).toThrow(PricingFileError)
    // Sin columna que identifique el perfume no hay encabezado válido.
    expect(() =>
      plan([
        ['% VIP', '% Premium'],
        [5, 10],
      ]),
    ).toThrow(/Código/)
    // Un archivo sólo con precios de compra sirve.
    expect(
      plan([
        ['Código', 'Precio de compra'],
        ['LCP-0001', 500],
      ]).changes[0].after.purchasePrice,
    ).toBe(500)
  })

  it('reads currencies written in many ways', () => {
    expect(
      ['C$', 'NIO', 'Córdobas', 'US$', 'USD', '$', 'Dólares', 'EUR', ''].map(
        readCurrency,
      ),
    ).toEqual(['NIO', 'NIO', 'NIO', 'USD', 'USD', 'USD', 'USD', null, null])
  })
})

describe('filas', () => {
  it('computes the new prices from the purchase price, keeping what the row leaves empty', () => {
    const result = plan([
      HEADER,
      // Sólo cambia el porcentaje VIP de un perfume que ya tenía.
      ['LCP-0001', null, 25, null],
      // US$ 20 con 25 % → US$ 25.
      ['LCP-0002', '25%', 20, '10,5'],
    ])
    expect(result.problems).toEqual([])
    expect(result.ignoredColumns).toEqual([])
    const [first, second] = result.changes
    expect(first.line).toBe(2)
    expect(first.after).toEqual({
      purchasePrice: 100,
      purchaseCurrency: 'NIO',
      markups: { emprendedor: 20, vip: 25, premium: 10 },
    })
    expect(first.prices.after.vip).toEqual({ NIO: 125, USD: 3.42 })
    expect(second.pendingTiers).toEqual([])
    expect(second.prices.after).toEqual({
      emprendedor: { USD: 25, NIO: 915 },
      vip: { USD: 24, NIO: 878.4 },
      premium: { USD: 22.1, NIO: 808.86 },
    })
    // Más de un 30 % de diferencia se marca para revisarla.
    expect(second.largeChanges).toEqual(['premium'])
  })

  it('keeps the published price of a perfume without purchase price and marks its lists pending', () => {
    const [change] = plan([HEADER, ['LCP-0003', 30, null, null]]).changes
    expect(change.after.purchasePrice).toBeNull()
    expect(change.pendingTiers).toEqual(['emprendedor'])
    expect(change.prices.after).toEqual(change.prices.before)
    expect(change.largeChanges).toEqual([])
  })

  it('loads the purchase price and its currency, and ignores the informative cost', () => {
    const result = plan([
      [
        'Código',
        'Costo promedio C$ (informativo, no se importa)',
        'Precio de compra',
        'Moneda',
        '% Emprendedor',
      ],
      ['LCP-0003', 999, '500', 'C$', 50],
      ['LCP-0004', 999, 'diez', 'EUR', 50],
    ])
    expect(result.ignoredColumns).toEqual([
      'Costo promedio C$ (informativo, no se importa)',
    ])
    const [change] = result.changes
    expect(change.after).toMatchObject({
      purchasePrice: 500,
      purchaseCurrency: 'NIO',
    })
    expect(change.prices.after.emprendedor.NIO).toBe(750)
    expect(result.problems.map((problem) => problem.reason)).toEqual([
      'El precio de compra «diez» no es un número. La moneda «EUR» no se reconoce. Usa C$ o US$.',
    ])
  })

  it('matches by code, manufacturer barcode or brand and name (with size when needed)', () => {
    const result = plan([
      ['Marca', 'Perfume', 'Tamaño', 'Código', '% VIP'],
      [null, null, null, 7501234567890, 30],
      ['casa ambar', 'jazmin nocturno', null, null, 31],
      ['Aurora', 'Cedro', '3.4 oz', null, 32],
      ['Aurora', 'Cedro', 1, null, 33],
      ['Aurora', 'Cedro', null, null, 34],
      [null, 'Perfume 1', null, 'lcp 0001', 35],
    ])
    expect(
      result.changes.map((change) => [
        change.product.id,
        change.after.markups.vip,
      ]),
    ).toEqual([
      ['p2', 30],
      ['p3', 31],
      ['p4', 32],
      ['p5', 33],
      ['p1', 35],
    ])
    expect(result.problems).toEqual([
      {
        line: 6,
        text: 'Aurora · Cedro · 34',
        reason:
          'Hay varios perfumes con ese nombre. Escribe el código para saber cuál es.',
      },
    ])
  })

  it('explains every row it cannot use and never saves half a row', () => {
    const result = plan([
      HEADER,
      ['LCP-9999', 10],
      [null, 10],
      ['LCP-0002', 'diez', 10, 10],
      ['LCP-0002', 5],
      ['LCP-0004', 2000, 'x', 10],
      ['LCP-0005', 10],
      ['LCP-0005', 6],
      [],
      ['', '  '],
    ])
    expect(result.changes.map((change) => change.product.id)).toEqual(['p5'])
    expect(result.problems.map(({ line, reason }) => [line, reason])).toEqual([
      [2, 'No hay ningún perfume con el código «LCP-9999».'],
      [3, 'Falta el código o el nombre del perfume.'],
      [4, 'El porcentaje de Emprendedor «diez» no es un número.'],
      [
        5,
        'El perfume ya aparece en la fila 4. Deja una sola fila por perfume.',
      ],
      [
        6,
        'El porcentaje de Emprendedor debe estar entre 0 y 1000. El porcentaje de VIP «x» no es un número.',
      ],
      [
        8,
        'El perfume ya aparece en la fila 7. Deja una sola fila por perfume.',
      ],
    ])
  })

  it('rejects a percentage that would sell too high', () => {
    const result = plan([HEADER, ['LCP-0005', 1000]])
    expect(result.changes).toHaveLength(1)
    const expensive = planPricingImport({
      rows: [HEADER, ['LCP-0005', 1000]],
      products,
      pricing: [{ ...saved[2], purchasePrice: 1_000_000 }],
      rate: 36.6,
    })
    expect(expensive.changes).toEqual([])
    expect(expensive.problems.map((problem) => problem.reason)).toEqual([
      'El precio de venta de Emprendedor saldría demasiado alto. Revisa el precio de compra y el porcentaje.',
    ])
  })

  it('counts the rows that change nothing', () => {
    const result = plan([
      HEADER,
      ['LCP-0001', 20, 15, 10],
      ['LCP-0001 ', '', '', ''],
    ])
    expect(result.changes).toEqual([])
    expect(result.unchanged).toBe(1)
    expect(result.problems).toHaveLength(1)
  })
})

describe('plantilla', () => {
  it('downloads the catalogue with the purchase price and loads back without changes', async () => {
    const sheet = pricingTemplate(
      [...products, perfume(6, { active: false })],
      saved,
      new Date('2026-09-26T18:00:00Z'),
    )
    expect(sheet.columns.map((column) => column.header)).toEqual([
      'Código',
      'Marca',
      'Perfume',
      'Tamaño',
      'Precio de compra',
      'Moneda de compra',
      '% Emprendedor',
      '% VIP',
      '% Premium',
    ])
    expect(sheet.rows).toHaveLength(5)
    expect(sheet.rows.find((row) => row[0] === 'LCP-0001')).toEqual([
      'LCP-0001',
      'Marca',
      'Perfume 1',
      '100 ml',
      100,
      'C$',
      20,
      15,
      10,
    ])
    expect(
      sheet.rows.find((row) => row[0] === 'LCP-0002')?.slice(4, 6),
    ).toEqual([20, 'US$'])
    const rows = await readSpreadsheet(buildWorkbook([sheet]))
    const result = plan(rows)
    expect(result.problems).toEqual([])
    expect(result.changes).toEqual([])
    expect(result.unchanged).toBe(5)
    expect(result.ignoredColumns).toEqual([])
    // Llenar la plantilla y volverla a cargar da los cambios.
    const edited = rows.map((row) =>
      row[0] === 'LCP-0002' ? [...row.slice(0, 4), 30, 'US$', 25, 40, 30] : row,
    )
    const [change] = plan(edited).changes
    expect(change.product.id).toBe('p2')
    expect(change.prices.after.emprendedor).toEqual({ USD: 37.5, NIO: 1372.5 })
  })
})

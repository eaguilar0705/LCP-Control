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
const saved: ProductPricing[] = [
  {
    productId: 'p1',
    purchasePrice: 500,
    purchaseCurrency: 'NIO',
    markups: { emprendedor: 20, vip: 15, premium: 10 },
    updatedAt: null,
  },
]
const plan = (rows: SheetRows, defaultCurrency: 'NIO' | 'USD' = 'NIO') =>
  planPricingImport({
    rows,
    products,
    pricing: saved,
    rate: 36.6,
    defaultCurrency,
  })
const HEADER = [
  'Código',
  'Precio de compra',
  'Moneda',
  '% Emprendedor',
  '% VIP',
  '% Premium',
]

describe('encabezados', () => {
  it('recognises the columns however they are written', () => {
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
        'Precio de compra',
        'Costo (C$)',
        'Compra',
        'Moneda',
        '% Emprendedor',
        'Ganancia mayorista',
        '% VIP',
        'Porcentaje Premium',
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
      'purchasePrice',
      'purchasePrice',
      'purchasePrice',
      'currency',
      'emprendedor',
      'emprendedor',
      'vip',
      'premium',
      null,
      null,
      null,
      null,
      null,
    ])
  })

  it('finds the header under title rows and says what is missing when there is none', () => {
    const result = plan([['Lista de precios'], [], HEADER, ['LCP-0002', 400]])
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
        ['Precio de compra', '% VIP'],
        [5, 10],
      ]),
    ).toThrow(/Código/)
  })

  it('reads currencies written in many ways', () => {
    expect(
      [
        'C$',
        'c$',
        'NIO',
        'Córdobas',
        'cordoba',
        'US$',
        'USD',
        '$',
        'Dólares',
        'u$s',
        'EUR',
        '',
      ].map(readCurrency),
    ).toEqual([
      'NIO',
      'NIO',
      'NIO',
      'NIO',
      'NIO',
      'USD',
      'USD',
      'USD',
      'USD',
      'USD',
      null,
      null,
    ])
  })
})

describe('filas', () => {
  it('computes the new prices, keeping what the row leaves empty', () => {
    const result = plan([
      HEADER,
      // Sólo cambia el porcentaje VIP de un perfume que ya tenía precio.
      ['LCP-0001', null, null, null, 25, null],
      // Precio y porcentajes nuevos, en dólares.
      ['LCP-0002', '20', 'US$', '25%', 20, '10,5'],
    ])
    expect(result.problems).toEqual([])
    expect(result.unchanged).toBe(0)
    const [first, second] = result.changes
    expect(first.line).toBe(2)
    expect(first.after).toEqual({
      purchasePrice: 500,
      purchaseCurrency: 'NIO',
      markups: { emprendedor: 20, vip: 25, premium: 10 },
    })
    expect(first.prices.after.vip).toEqual({ NIO: 625, USD: 17.08 })
    expect(second.after).toEqual({
      purchasePrice: 20,
      purchaseCurrency: 'USD',
      markups: { emprendedor: 25, vip: 20, premium: 10.5 },
    })
    expect(second.prices.after).toEqual({
      emprendedor: { USD: 25, NIO: 915 },
      vip: { USD: 24, NIO: 878.4 },
      premium: { USD: 22.1, NIO: 808.86 },
    })
    // Emprendedor baja 28,6 % (de C$ 1 281 a C$ 915) y no llega al aviso;
    // Premium baja 30,9 % (de C$ 1 171,20 a C$ 808,86) y se marca.
    expect(second.largeChanges).toEqual(['premium'])
  })

  it('uses the chosen currency when the file does not say it', () => {
    const [change] = plan(
      [
        ['Código', 'Costo'],
        ['LCP-0003', 1000],
      ],
      'USD',
    ).changes
    expect(change.after.purchaseCurrency).toBe('USD')
    expect(change.after.markups).toEqual({
      emprendedor: null,
      vip: null,
      premium: null,
    })
    // Sin porcentaje nada se calcula todavía: los precios quedan como estaban.
    expect(change.prices.after).toEqual(change.prices.before)
  })

  it('flags a price that moves more than 30 %', () => {
    const [change] = plan([HEADER, ['LCP-0003', 100, 'C$', 10, 10, 10]]).changes
    expect(change.largeChanges).toEqual(['emprendedor', 'vip', 'premium'])
  })

  it('matches by code, manufacturer barcode or brand and name (with size when needed)', () => {
    const result = plan([
      ['Marca', 'Perfume', 'Tamaño', 'Código', 'Precio de compra'],
      [null, null, null, 7501234567890, 300],
      ['casa ambar', 'jazmin nocturno', null, null, 310],
      ['Aurora', 'Cedro', '3.4 oz', null, 320],
      ['Aurora', 'Cedro', 1, null, 330],
      ['Aurora', 'Cedro', null, null, 340],
      [null, 'Perfume 1', null, 'lcp 0001', 350],
    ])
    expect(
      result.changes.map((change) => [
        change.product.id,
        change.after.purchasePrice,
      ]),
    ).toEqual([
      ['p2', 300],
      ['p3', 310],
      ['p4', 320],
      ['p5', 330],
      ['p1', 350],
    ])
    expect(result.problems).toEqual([
      {
        line: 6,
        text: 'Aurora · Cedro · 340',
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
      ['LCP-0002', 'diez', 'C$', 10, 10, 10],
      ['LCP-0002', -5],
      ['LCP-0003', 0.001],
      ['LCP-0004', 12, 'EUR', 2000, 'x', 10],
      ['LCP-0001', null, 'US$'],
      ['LCP-0005', 5, null, 10],
      ['LCP-0005', 6],
      ['LCP-0001', 20000000, 'C$'],
      ['LCP-0002', 9000000, 'C$', 500],
      [],
      ['', '  '],
    ])
    expect(result.changes.map((change) => change.product.id)).toEqual(['p5'])
    expect(result.problems.map(({ line, reason }) => [line, reason])).toEqual([
      [2, 'No hay ningún perfume con el código «LCP-9999».'],
      [3, 'Falta el código o el nombre del perfume.'],
      [4, 'El precio de compra «diez» no es un número.'],
      [
        5,
        'El perfume ya aparece en la fila 4. Deja una sola fila por perfume.',
      ],
      [6, 'El precio de compra debe ser mayor que cero.'],
      [
        7,
        'No reconocemos la moneda «EUR»: escribe C$ o US$. El porcentaje de Emprendedor debe estar entre 0 y 1000. El porcentaje de VIP «x» no es un número.',
      ],
      [8, 'Para cambiar la moneda escribe también el precio de compra.'],
      [
        10,
        'El perfume ya aparece en la fila 9. Deja una sola fila por perfume.',
      ],
      [
        11,
        'El perfume ya aparece en la fila 8. Deja una sola fila por perfume.',
      ],
      [
        12,
        'El perfume ya aparece en la fila 4. Deja una sola fila por perfume.',
      ],
    ])
  })

  it('rejects purchase prices that are too high or would sell too high', () => {
    const result = plan([
      HEADER,
      ['LCP-0003', 20000000],
      ['LCP-0004', 9000000, 'C$', 500],
    ])
    expect(result.changes).toEqual([])
    expect(result.problems.map((problem) => problem.reason)).toEqual([
      'El precio de compra es demasiado alto.',
      'El precio de venta de Emprendedor saldría demasiado alto. Revisa el precio de compra y el porcentaje.',
    ])
  })

  it('counts the rows that change nothing', () => {
    const result = plan([
      HEADER,
      ['LCP-0001', 500, 'C$', 20, 15, 10],
      ['LCP-0001 ', '', '', '', '', ''],
    ])
    expect(result.changes).toEqual([])
    expect(result.unchanged).toBe(1)
    expect(result.problems).toHaveLength(1)
  })
})

describe('plantilla', () => {
  it('downloads the catalogue with what is saved and loads back without changes', async () => {
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
      'Moneda',
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
      500,
      'C$',
      20,
      15,
      10,
    ])
    const rows = await readSpreadsheet(buildWorkbook([sheet]))
    const result = plan(rows)
    expect(result.problems).toEqual([])
    expect(result.changes).toEqual([])
    // Las filas sin datos tampoco cambian nada.
    expect(result.unchanged).toBe(5)
    // Llenar la plantilla y volverla a cargar da los cambios.
    const edited = rows.map((row) =>
      row[0] === 'LCP-0004' ? [...row.slice(0, 4), 30, 'US$', 50, 40, 30] : row,
    )
    const [change] = plan(edited).changes
    expect(change.product.id).toBe('p4')
    expect(change.prices.after.emprendedor).toEqual({ USD: 45, NIO: 1647 })
  })
})

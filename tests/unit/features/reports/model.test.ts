import { describe, expect, it } from 'vitest'
import {
  change,
  concentration,
  currenciesWithSales,
  daysBetween,
  idleStock,
  inRange,
  lapsedCustomers,
  previousRange,
  proformaConversion,
  purchaseFrequency,
  salesByWeekday,
  shrinkage,
  stockCoverage,
  customerActivity,
  daysInRange,
  inventoryHealth,
  localDay,
  movementSummary,
  paymentBreakdown,
  presetRange,
  revenueByDay,
  summary,
  topProducts,
  type ReportDocument,
} from '@/features/reports/model'
import type { InventoryItem, Product } from '@/lib/domain'

function document(
  over: Partial<ReportDocument> & Pick<ReportDocument, 'id'>,
): ReportDocument {
  return {
    kind: 'invoice',
    number: `FAC-${over.id}`,
    createdAt: '2026-09-10T18:00:00Z',
    currency: 'NIO',
    total: 0,
    tier: 'emprendedor',
    paymentMethod: 'cash',
    location: 'store',
    customerId: 'c1',
    customerName: 'Cliente',
    items: [],
    ...over,
  }
}
function product(over: Partial<Product> & Pick<Product, 'id'>): Product {
  return {
    barcode: over.id,
    name: 'Perfume',
    brand: 'Marca',
    category: 'arabian',
    gender: 'unisex',
    size: 100,
    unit: 'ml',
    price: 1000,
    currency: 'NIO',
    minimumStock: 5,
    active: true,
    prices: {
      emprendedor: { NIO: 1000, USD: 28 },
      vip: { NIO: 950, USD: 26 },
      premium: { NIO: 900, USD: 24 },
    },
    ...over,
  }
}
const range = { from: '2026-09-08', to: '2026-09-10' }

describe('periodo', () => {
  it('cubre ambos extremos y respeta la zona horaria del negocio', () => {
    expect(daysInRange(range)).toEqual([
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
    ])
    expect(daysInRange({ from: '2026-09-10', to: '2026-09-08' })).toEqual([])
    // 03:00 UTC del día 11 es todavía el día 10 en Managua (UTC-6).
    expect(localDay('2026-09-11T03:00:00Z')).toBe('2026-09-10')
    expect(presetRange('7d', '2026-09-10')).toEqual({
      from: '2026-09-04',
      to: '2026-09-10',
    })
  })
})

describe('ingresos', () => {
  const documents = [
    document({ id: '1', total: 1000, createdAt: '2026-09-08T16:00:00Z' }),
    document({ id: '2', total: 500, createdAt: '2026-09-10T16:00:00Z' }),
    // Una proforma cotiza, no cobra: nunca entra en los ingresos.
    document({ id: '3', kind: 'proforma', total: 9999 }),
    // Otra moneda: se contabiliza aparte, jamás sumada a los córdobas.
    document({ id: '4', currency: 'USD', total: 40 }),
  ]

  it('sólo cuenta facturas de la moneda pedida', () => {
    expect(summary(documents, 'NIO')).toMatchObject({
      revenue: 1500,
      count: 2,
      average: 750,
    })
    expect(summary(documents, 'USD')).toMatchObject({ revenue: 40, count: 1 })
    expect(currenciesWithSales(documents)).toEqual(['NIO', 'USD'])
    expect(currenciesWithSales([documents[2]])).toEqual([])
  })

  it('deja en cero los días sin ventas en lugar de omitirlos', () => {
    expect(revenueByDay(documents, 'NIO', range)).toEqual([
      { day: '2026-09-08', revenue: 1000, count: 1 },
      { day: '2026-09-09', revenue: 0, count: 0 },
      { day: '2026-09-10', revenue: 500, count: 1 },
    ])
  })

  it('promedia sin dividir entre cero cuando no hubo ventas', () => {
    expect(summary([], 'NIO')).toEqual({
      revenue: 0,
      count: 0,
      average: 0,
      units: 0,
      customers: 0,
    })
  })
})

describe('productos y formas de pago', () => {
  const documents = [
    document({
      id: '1',
      total: 3000,
      items: [
        { productId: 'a', description: 'Ámbar', quantity: 2, lineTotal: 2000 },
        { productId: 'b', description: 'Cedro', quantity: 1, lineTotal: 1000 },
      ],
    }),
    document({
      id: '2',
      total: 1500,
      paymentMethod: 'bank_transfer',
      items: [
        { productId: 'b', description: 'Cedro', quantity: 1, lineTotal: 1500 },
      ],
    }),
  ]

  it('acumula cada producto por importe y unidades', () => {
    expect(topProducts(documents, 'NIO')).toEqual([
      { productId: 'b', description: 'Cedro', quantity: 2, revenue: 2500 },
      { productId: 'a', description: 'Ámbar', quantity: 2, revenue: 2000 },
    ])
    expect(topProducts(documents, 'NIO', 1)).toHaveLength(1)
  })

  it('agrupa las formas de pago en orden fijo y omite las no usadas', () => {
    expect(paymentBreakdown(documents, 'NIO')).toEqual([
      { key: 'cash', label: 'Efectivo', value: 3000, count: 1 },
      {
        key: 'bank_transfer',
        label: 'Transferencia',
        value: 1500,
        count: 1,
      },
    ])
  })
})

describe('clientes', () => {
  it('separa quien se registró en el periodo de quien ya volvía', () => {
    const documents = [
      document({ id: '1', customerId: 'nuevo', total: 500 }),
      document({ id: '2', customerId: 'viejo', total: 800 }),
      document({ id: '3', customerId: 'viejo', total: 200 }),
    ]
    const activity = customerActivity(
      documents,
      [
        { id: 'nuevo', name: 'Nuevo', createdAt: '2026-09-09T15:00:00Z' },
        { id: 'viejo', name: 'Viejo', createdAt: '2026-01-05T15:00:00Z' },
      ],
      'NIO',
      range,
    )
    expect(activity).toMatchObject({ newCustomers: 1, returning: 1 })
    expect(activity.top[0]).toMatchObject({
      id: 'viejo',
      revenue: 1000,
      count: 2,
    })
  })
})

describe('inventario y movimientos', () => {
  it('clasifica existencias y no valora lo que no se ha contado', () => {
    const items: InventoryItem[] = [
      {
        product: product({ id: 'a' }),
        quantities: { store: 10, warehouse: 5 },
      },
      { product: product({ id: 'b' }), quantities: { store: 1, warehouse: 1 } },
      { product: product({ id: 'c' }), quantities: { store: 0, warehouse: 0 } },
      {
        product: product({ id: 'd' }),
        quantities: { store: null, warehouse: 3 },
      },
    ]
    expect(inventoryHealth(items, 'emprendedor', 'NIO')).toEqual({
      available: 1,
      low: 1,
      out: 1,
      uncounted: 1,
      units: 17,
      listValue: 17000,
    })
  })

  it('resume los movimientos por tipo', () => {
    expect(
      movementSummary([
        { productId: 'a', type: 'ENTRY', quantity: 10, createdAt: '' },
        { productId: 'a', type: 'DAMAGED', quantity: 2, createdAt: '' },
        { productId: 'a', type: 'SALE', quantity: 3, createdAt: '' },
        { productId: 'a', type: 'ADJUSTMENT', quantity: 40, createdAt: '' },
      ]),
    ).toEqual({
      entries: 10,
      exits: 0,
      damaged: 2,
      adjustments: 1,
      sales: 3,
    })
  })
})

describe('fase 1 · comparación y ventana', () => {
  it('el periodo anterior tiene la misma duración y termina justo antes', () => {
    expect(previousRange({ from: '2026-09-01', to: '2026-09-30' })).toEqual({
      from: '2026-08-02',
      to: '2026-08-31',
    })
    expect(previousRange({ from: '2026-03-01', to: '2026-03-07' })).toEqual({
      from: '2026-02-22',
      to: '2026-02-28',
    })
  })

  it('sin base de comparación no inventa un porcentaje', () => {
    expect(change(150, 100)).toBeCloseTo(0.5)
    expect(change(50, 100)).toBeCloseTo(-0.5)
    // Partir de cero no es «subir 100 %»: es un periodo que no existía.
    expect(change(500, 0)).toBeNull()
  })

  it('separa los documentos del periodo de los de la ventana previa', () => {
    const documents = [
      document({ id: '1', createdAt: '2026-09-09T16:00:00Z' }),
      document({ id: '2', createdAt: '2026-08-20T16:00:00Z' }),
    ]
    expect(inRange(documents, range).map((d) => d.id)).toEqual(['1'])
  })

  it('cuenta días naturales sin arrastrar horas', () => {
    expect(daysBetween('2026-09-01', '2026-09-10')).toBe(9)
    // 2028 es bisiesto: del 28 de febrero al 1 de marzo hay dos días.
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2)
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1)
  })
})

describe('fase 1 · inventario', () => {
  const inventory: InventoryItem[] = [
    {
      product: product({ id: 'rapido' }),
      quantities: { store: 4, warehouse: 0 },
    },
    {
      product: product({ id: 'lento' }),
      quantities: { store: 40, warehouse: 0 },
    },
    {
      product: product({ id: 'parado' }),
      quantities: { store: 7, warehouse: 0 },
    },
    {
      product: product({ id: 'sincontar' }),
      quantities: { store: null, warehouse: null },
    },
  ]
  // Tres días de rango: 9 unidades vendidas del rápido son 3 por día.
  const documents = [
    document({
      id: '1',
      items: [
        {
          productId: 'rapido',
          description: 'Rápido',
          quantity: 9,
          lineTotal: 900,
        },
        {
          productId: 'lento',
          description: 'Lento',
          quantity: 3,
          lineTotal: 300,
        },
        {
          productId: 'sincontar',
          description: 'Sin contar',
          quantity: 1,
          lineTotal: 100,
        },
      ],
    }),
  ]

  it('ordena por urgencia de reposición y omite lo que no se puede proyectar', () => {
    const coverage = stockCoverage(documents, inventory, range, 'NIO')
    expect(coverage.map((row) => row.productId)).toEqual(['rapido', 'lento'])
    expect(coverage[0].days).toBeCloseTo(4 / 3)
    expect(coverage[1].days).toBeCloseTo(40)
  })

  it('lista el capital detenido y lo valora a precio de lista', () => {
    const idle = idleStock(documents, inventory, 'emprendedor', 'NIO')
    // «sincontar» sí se vendió y «rapido»/«lento» también: sólo queda «parado».
    expect(idle).toEqual([
      {
        productId: 'parado',
        description: 'Marca · Perfume',
        stock: 7,
        listValue: 7000,
      },
    ])
  })

  it('suma las mermas por producto con su valor', () => {
    const rows = shrinkage(
      [
        { productId: 'rapido', type: 'DAMAGED', quantity: 2, createdAt: '' },
        { productId: 'rapido', type: 'DAMAGED', quantity: 1, createdAt: '' },
        { productId: 'lento', type: 'EXIT', quantity: 5, createdAt: '' },
      ],
      inventory,
      'emprendedor',
      'NIO',
    )
    expect(rows).toEqual([
      {
        productId: 'rapido',
        description: 'Marca · Perfume',
        units: 3,
        listValue: 3000,
      },
    ])
  })
})

describe('fase 1 · clientes', () => {
  const documents = [
    // Periodo actual (08 al 10 de septiembre)
    document({
      id: 'a',
      customerId: 'fiel',
      total: 400,
      createdAt: '2026-09-09T16:00:00Z',
    }),
    // Periodo anterior (05 al 07 de septiembre)
    document({
      id: 'b',
      customerId: 'fiel',
      total: 300,
      createdAt: '2026-09-06T16:00:00Z',
    }),
    document({
      id: 'c',
      customerId: 'perdido',
      total: 900,
      createdAt: '2026-09-06T16:00:00Z',
    }),
    document({
      id: 'd',
      customerId: 'menor',
      total: 100,
      createdAt: '2026-09-05T16:00:00Z',
    }),
  ]

  it('encuentra a quien compraba antes y ya no, ordenado por lo que dejó de facturar', () => {
    const lapsed = lapsedCustomers(documents, range, 'NIO')
    expect(lapsed.map((row) => row.id)).toEqual(['perdido', 'menor'])
    expect(lapsed[0]).toMatchObject({
      previousRevenue: 900,
      lastPurchase: '2026-09-06',
      daysSince: 4,
    })
  })

  it('calcula el intervalo entre compras y deja en blanco al que sólo compró una vez', () => {
    const frequency = purchaseFrequency(documents, 'NIO', '2026-09-10')
    const fiel = frequency.find((row) => row.id === 'fiel')
    expect(fiel).toMatchObject({ orders: 2, averageDays: 3, daysSinceLast: 1 })
    expect(
      frequency.find((row) => row.id === 'perdido')?.averageDays,
    ).toBeNull()
  })

  it('mide qué parte del total depende de unos pocos', () => {
    expect(concentration([50, 30, 20], 1)).toBeCloseTo(0.5)
    expect(concentration([50, 30, 20], 2)).toBeCloseTo(0.8)
    expect(concentration([], 3)).toBeNull()
  })
})

describe('fase 1 · ritmo comercial', () => {
  it('reparte las ventas por día de la semana del negocio', () => {
    // 2026-09-09 es miércoles; la factura de las 03:00 UTC del 10 todavía es
    // del miércoles en Managua.
    const weekdays = salesByWeekday(
      [
        document({ id: '1', total: 100, createdAt: '2026-09-09T16:00:00Z' }),
        document({ id: '2', total: 50, createdAt: '2026-09-10T03:00:00Z' }),
      ],
      'NIO',
    )
    expect(weekdays).toHaveLength(7)
    expect(weekdays[3]).toEqual({
      weekday: 3,
      label: 'Miércoles',
      revenue: 150,
      count: 2,
    })
  })

  it('estima la conversión de proformas por cliente y fecha', () => {
    const conversion = proformaConversion(
      [
        document({
          id: 'p1',
          kind: 'proforma',
          customerId: 'c1',
          createdAt: '2026-09-01T16:00:00Z',
        }),
        document({
          id: 'f1',
          customerId: 'c1',
          createdAt: '2026-09-03T16:00:00Z',
        }),
        document({
          id: 'p2',
          kind: 'proforma',
          customerId: 'c2',
          createdAt: '2026-09-01T16:00:00Z',
        }),
      ],
      'NIO',
    )
    expect(conversion).toEqual({ proformas: 2, converted: 1, rate: 0.5 })
  })
})

describe('la ventana ampliada no infla el periodo', () => {
  it('el total del periodo es el de su serie diaria, no el de la ventana', () => {
    const documents = [
      // Dentro del periodo (08 al 10 de septiembre)
      document({ id: '1', total: 1000, createdAt: '2026-09-09T16:00:00Z' }),
      // En la ventana previa que el proveedor también carga
      document({ id: '2', total: 7777, createdAt: '2026-09-06T16:00:00Z' }),
    ]
    const current = inRange(documents, range)
    const totals = summary(current, 'NIO')
    const daily = revenueByDay(current, 'NIO', range)
    const sumOfDays = daily.reduce((sum, point) => sum + point.revenue, 0)

    expect(totals.revenue).toBe(1000)
    expect(sumOfDays).toBe(totals.revenue)
    // Y el descarte es deliberado: sin acotar, la cifra saldría inflada.
    expect(summary(documents, 'NIO').revenue).toBe(8777)
  })
})

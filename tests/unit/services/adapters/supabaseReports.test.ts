import { beforeEach, describe, expect, it, vi } from 'vitest'

const { tables, requests, rpc, legacyDocuments, filters } = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  requests: [] as {
    table: string
    select: string
    start: number
    end: number
  }[],
  rpc: vi.fn(),
  legacyDocuments: { value: false },
  filters: [] as { operator: string; column: string; value: unknown }[],
}))
vi.mock('@/lib/supabase', () => ({
  authConfigured: true,
  supabase: {
    auth: {
      getUser: async () => ({
        data: { user: { id: 'admin-id' } },
        error: null,
      }),
    },
    rpc,
    from: (table: string) => {
      let selection = ''
      const respond = (start: number, end: number) => {
        requests.push({ table, select: selection, start, end })
        if (
          legacyDocuments.value &&
          table === 'documents' &&
          selection.includes('exchange_rate')
        )
          return Promise.resolve({
            data: null,
            error: { code: '42703' },
            count: null,
          })
        const rows = tables[table] ?? []
        return Promise.resolve({
          data: rows.slice(start, Math.min(end + 1, start + 250)),
          count: rows.length,
          error: null,
        })
      }
      const chain = {
        select: (value: string) => {
          selection = value
          return chain
        },
        eq: (column: string, value: unknown) => {
          filters.push({ operator: 'eq', column, value })
          return chain
        },
        gte: (column: string, value: unknown) => {
          filters.push({ operator: 'gte', column, value })
          return chain
        },
        lt: (column: string, value: unknown) => {
          filters.push({ operator: 'lt', column, value })
          return chain
        },
        lte: () => chain,
        order: () => chain,
        maybeSingle: async () => ({
          data: { role: 'admin', active: true },
          error: null,
        }),
        range: respond,
        limit: (limit: number) => respond(0, limit - 1),
      }
      return chain
    },
  },
}))
import { supabaseAdapter } from '@/services/adapters/supabase'
import { DOCUMENT_EXPORT_LIMIT } from '@/features/sales/period'

const document = {
  id: 'document',
  kind: 'invoice',
  number: 'FAC-000001',
  customer_id: 'customer',
  customer_name: 'Cliente',
  customer_phone: null,
  issuer: { name: 'Negocio', address: '', phone: '' },
  tier_code: 'emprendedor',
  currency: 'USD',
  total: '100',
  exchange_rate: '36.62',
  tax_rate: '15',
  location: 'store',
  valid_until: null,
  payment_method: 'cash',
  notes: '',
  created_at: '2026-09-10T12:00:00Z',
  document_items: [
    {
      id: 'item',
      product_id: 'product',
      description: 'Producto',
      quantity: 1,
      unit_price: '100',
      line_total: '100',
    },
  ],
}
beforeEach(() => {
  for (const name of Object.keys(tables)) delete tables[name]
  requests.length = 0
  filters.length = 0
  legacyDocuments.value = false
  rpc.mockReset()
})

it('el resumen diario usa el día de Managua y suma todas las páginas sin truncar ventas', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-15T03:00:00Z'))
  try {
    tables.documents = [
      ...Array.from({ length: 1101 }, () => ({ currency: 'NIO', total: '10' })),
      { currency: 'USD', total: '25' },
    ]
    expect(await supabaseAdapter.getTodaySummary()).toEqual({
      count: 1102,
      totals: { NIO: 11010, USD: 25 },
    })
    expect(filters).toEqual(
      expect.arrayContaining([
        { operator: 'eq', column: 'kind', value: 'invoice' },
        {
          operator: 'gte',
          column: 'created_at',
          value: '2026-09-14T06:00:00.000Z',
        },
        {
          operator: 'lt',
          column: 'created_at',
          value: '2026-09-15T06:00:00.000Z',
        },
      ]),
    )
  } finally {
    vi.useRealTimers()
  }
})

it('loads report rows across server limits and includes archived stock and historical movement identity', async () => {
  tables.documents = Array.from({ length: 1101 }, (_, index) => ({
    ...document,
    id: `doc-${index}`,
  }))
  tables.inventory_movements = [
    {
      id: 'loss',
      product_id: 'product',
      type: 'ADJUSTMENT',
      quantity: 2,
      before_quantity: 5,
      after_quantity: 2,
      created_at: '2026-09-10T12:00:00Z',
    },
  ]
  tables.products = [
    {
      id: 'product',
      sku: 'LCP-0001',
      barcode: null,
      name: 'Producto',
      size: null,
      unit: 'ml',
      category: null,
      gender: null,
      catalog_availability: null,
      image_reference: null,
      image_path: null,
      minimum_stock: null,
      revision: 1,
      active: false,
      brands: { name: 'Marca' },
      product_prices: [
        { tier_code: 'emprendedor', currency: 'NIO', amount: '1000' },
      ],
      inventory_balances: [
        { location: 'warehouse', quantity: 0 },
        { location: 'store', quantity: 2 },
      ],
    },
  ]
  const result = await supabaseAdapter.getReportSource({
    from: '2026-09-01',
    to: '2026-09-13',
  })
  expect(result.documents).toHaveLength(1101)
  expect(
    requests.filter((request) => request.table === 'documents'),
  ).toHaveLength(5)
  expect(result.inventory[0].product.active).toBe(false)
  expect(result.movements[0]).toMatchObject({
    id: 'loss',
    beforeQuantity: 5,
    afterQuantity: 2,
  })
  expect(result.accounting?.available).toBe(true)
  expect(result.truncated).toBe(false)
})

it('reads legacy documents without claiming historic exchange rates or tax rates', async () => {
  legacyDocuments.value = true
  tables.documents = [
    { ...document, exchange_rate: undefined, tax_rate: undefined },
  ]
  const listed = await supabaseAdapter.listDocuments('invoice', {
    range: { from: '2026-09-01', to: '2026-09-13' },
  })
  expect(listed.documents[0]).toMatchObject({
    exchangeRate: null,
    taxRate: undefined,
  })
  const report = await supabaseAdapter.getReportSource({
    from: '2026-09-01',
    to: '2026-09-13',
  })
  expect(report.documents).toHaveLength(1)
  expect(
    requests.filter(
      (request) =>
        request.table === 'documents' &&
        request.select.includes('exchange_rate'),
    ),
  ).toHaveLength(2)
})

it('sends and reads the invoice exchange rate and included tax percentage', async () => {
  rpc.mockResolvedValue({ data: document, error: null })
  const result = await supabaseAdapter.createDocument({
    requestId: 'retry-key',
    kind: 'invoice',
    currency: 'USD',
    exchangeRate: 36.62,
    taxRate: 15,
    tier: 'emprendedor',
    notes: '',
    items: [{ productId: 'product', quantity: 1 }],
  })
  expect(rpc).toHaveBeenCalledWith('create_document', {
    p_payload: expect.objectContaining({
      exchangeRate: 36.62,
      taxRate: 15,
      requestId: 'retry-key',
    }),
  })
  expect(result).toMatchObject({ exchangeRate: 36.62, taxRate: 15, total: 100 })
})

it('el historial pide sólo el periodo elegido, en días de Managua, por páginas', async () => {
  tables.documents = Array.from({ length: 230 }, (_, index) => ({
    ...document,
    id: `doc-${index}`,
  }))
  const page = await supabaseAdapter.listDocuments('invoice', {
    range: { from: '2026-09-01', to: '2026-09-30' },
    offset: 100,
    limit: 100,
  })
  expect(page.total).toBe(230)
  expect(page.documents).toHaveLength(100)
  expect(page.documents[0].id).toBe('doc-100')
  expect(requests.at(-1)).toMatchObject({ table: 'documents', start: 100, end: 199 })
  expect(filters).toEqual(
    expect.arrayContaining([
      { operator: 'eq', column: 'kind', value: 'invoice' },
      { operator: 'gte', column: 'created_at', value: '2026-09-01T06:00:00.000Z' },
      { operator: 'lt', column: 'created_at', value: '2026-10-01T06:00:00.000Z' },
    ]),
  )
})

it('exporta todas las facturas del periodo, pasando el límite de filas del servidor', async () => {
  tables.documents = Array.from({ length: 600 }, (_, index) => ({
    ...document,
    id: `doc-${index}`,
  }))
  const documents = await supabaseAdapter.exportDocuments('invoice', {
    from: '2026-09-01',
    to: '2026-09-30',
  })
  expect(documents).toHaveLength(600)
  expect(new Set(documents.map((d) => d.id)).size).toBe(600)
  expect(filters).toEqual(
    expect.arrayContaining([
      { operator: 'gte', column: 'created_at', value: '2026-09-01T06:00:00.000Z' },
      { operator: 'lt', column: 'created_at', value: '2026-10-01T06:00:00.000Z' },
    ]),
  )
})

it('un periodo que pasa del tope no se descarga y pide un rango más corto', async () => {
  tables.documents = Array.from({ length: DOCUMENT_EXPORT_LIMIT + 1 }, (_, index) => ({
    ...document,
    id: `doc-${index}`,
  }))
  await expect(
    supabaseAdapter.exportDocuments('invoice', {
      from: '2026-01-01',
      to: '2026-12-31',
    }),
  ).rejects.toThrow(/admite hasta .*Elige un rango más corto/)
  // Sólo se contó: no se bajó ninguna página de facturas.
  expect(requests.filter((request) => request.table === 'documents')).toEqual([
    expect.objectContaining({ select: 'id', start: 0, end: 0 }),
  ])
})

it('un periodo vacío no hace más consultas', async () => {
  tables.documents = []
  expect(
    await supabaseAdapter.exportDocuments('proforma', {
      from: '2026-09-01',
      to: '2026-09-30',
    }),
  ).toEqual([])
  expect(requests).toHaveLength(1)
})

describe('reportes calculados en la base', () => {
  const range = { from: '2026-09-01', to: '2026-09-13' }
  const payload = {
    version: 1,
    sales: Object.fromEntries(
      ['NIO', 'USD'].map((code) => [
        code,
        {
          current: { revenue: code === 'USD' ? 100 : 0, count: code === 'USD' ? 1 : 0, units: 1, customers: 1 },
          previous: { revenue: 0, count: 0, units: 0, customers: 0 },
          proformas: 0, converted: 0, days: [], weekdays: [], payments: [], tiers: [],
          products: [], newCustomers: 0, returning: 0, topCustomers: [], lapsed: [], visits: [],
        },
      ]),
    ),
    movements: { entries: 0, exits: 0, damaged: 0, adjustments: 0, sales: 0, damagedByProduct: [] },
    ledger: null,
  }

  it('con la función instalada no descarga facturas, renglones ni movimientos', async () => {
    rpc.mockResolvedValue({ data: payload, error: null })
    tables.documents = [document]
    const report = await supabaseAdapter.getReport!(range)
    expect(rpc).toHaveBeenCalledWith('report_digest', { p_from: '2026-09-01', p_to: '2026-09-13' })
    expect(report.computedIn).toBe('database')
    expect(report.sales.USD.current.revenue).toBe(100)
    const read = new Set(requests.map((request) => request.table))
    for (const table of ['documents', 'inventory_movements', 'customers', 'document_item_costs', 'inventory_movement_costs'])
      expect(read.has(table), table).toBe(false)
    expect(read.has('products')).toBe(true)
  })

  it('sin la función instalada calcula en el navegador, como antes', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })
    tables.documents = [document]
    const report = await supabaseAdapter.getReport!(range)
    expect(report.computedIn).toBe('browser')
    expect(report.sales.USD.current).toMatchObject({ revenue: 100, count: 1 })
    expect(requests.some((request) => request.table === 'documents')).toBe(true)
  })

  it('un error de permisos no se disfraza de reporte vacío', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied' } })
    await expect(supabaseAdapter.getReport!(range)).rejects.toThrow(/permiso/)
    expect(requests.some((request) => request.table === 'documents')).toBe(false)
  })
})

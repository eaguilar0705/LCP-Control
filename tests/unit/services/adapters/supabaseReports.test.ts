import { beforeEach, expect, it, vi } from 'vitest'

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
  const listed = await supabaseAdapter.listDocuments('invoice')
  expect(listed[0]).toMatchObject({ exchangeRate: null, taxRate: undefined })
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

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Table = 'product_pricing' | 'product_costs'
const { state, rpc } = vi.hoisted(() => ({
  state: {
    tables: { product_pricing: [], product_costs: [] } as Record<
      string,
      unknown[]
    >,
    errors: {} as Record<string, { code: string; message?: string }>,
    ranges: [] as [string, number, number][],
    filters: [] as [string, string, unknown][],
    selections: [] as string[],
  },
  rpc: vi.fn(),
}))
vi.mock('@/lib/supabase', () => ({
  authConfigured: true,
  supabase: {
    rpc,
    from: (table: string) => {
      const chain = {
        select: (value: string) => {
          state.selections.push(`${table}:${value}`)
          return chain
        },
        eq: (column: string, value: unknown) => {
          state.filters.push([table, column, value])
          return chain
        },
        order: () => chain,
        range: async (start: number, end: number) => {
          state.ranges.push([table, start, end])
          const error = state.errors[table]
          if (error) return { data: null, error }
          return {
            data: (state.tables[table] ?? []).slice(start, end + 1),
            error: null,
          }
        },
      }
      return chain
    },
  },
}))
import { supabaseAdapter } from '@/services/adapters/supabase'

const markups = (index: number) => ({
  product_id: `p${index}`,
  markup_emprendedor: '20.00',
  markup_vip: null,
  markup_premium: '10.50',
  updated_at: '2026-09-26T18:00:00Z',
})
const set = (table: Table, rows: unknown[]) => {
  state.tables[table] = rows
}

beforeEach(() => {
  state.tables = { product_pricing: [], product_costs: [] }
  state.errors = {}
  state.ranges = []
  state.filters = []
  state.selections = []
  rpc.mockReset()
})

describe('porcentajes y costo promedio en Supabase', () => {
  it('reads every page of both tables and turns PostgreSQL numbers into numbers', async () => {
    set(
      'product_pricing',
      Array.from({ length: 1005 }, (_, index) => markups(index)),
    )
    set('product_costs', [
      { product_id: 'p0', average_cost_nio: '16.281061' },
      { product_id: 'sin-porcentajes', average_cost_nio: '100.000000' },
      { product_id: 'sin-costo', average_cost_nio: null },
    ])
    const result = await supabaseAdapter.listPricing()
    expect(result.available).toBe(true)
    expect(result.rows).toHaveLength(1006)
    expect(
      state.ranges.filter(([table]) => table === 'product_pricing'),
    ).toEqual([
      ['product_pricing', 0, 999],
      ['product_pricing', 1000, 1999],
    ])
    expect(result.rows[0]).toEqual({
      productId: 'p0',
      averageCost: 16.281061,
      markups: { emprendedor: 20, vip: null, premium: 10.5 },
      updatedAt: '2026-09-26T18:00:00Z',
    })
    expect(result.rows[1].averageCost).toBeNull()
    // Un perfume con costo y sin porcentajes también llega: se enseña su costo.
    expect(
      result.rows.find((row) => row.productId === 'sin-porcentajes'),
    ).toEqual({
      productId: 'sin-porcentajes',
      averageCost: 100,
      markups: { emprendedor: null, vip: null, premium: null },
      updatedAt: null,
    })
    expect(result.rows.some((row) => row.productId === 'sin-costo')).toBe(false)
    // Ya no se pide el precio de compra.
    expect(state.selections.join(' ')).not.toMatch(/purchase/)
  })

  it('asks only for one perfume when the editor opens it', async () => {
    set('product_pricing', [markups(7)])
    await supabaseAdapter.listPricing('p7')
    expect(state.filters).toEqual([
      ['product_pricing', 'product_id', 'p7'],
      ['product_costs', 'product_id', 'p7'],
    ])
  })

  it('reports that the update is missing instead of failing the screen', async () => {
    state.errors.product_pricing = {
      code: 'PGRST205',
      message: 'Could not find the table',
    }
    await expect(supabaseAdapter.listPricing()).resolves.toEqual({
      available: false,
      rows: [],
    })
    state.errors.product_pricing = {
      code: '42501',
      message: 'permission denied for table product_pricing',
    }
    await expect(supabaseAdapter.listPricing()).rejects.toThrow(
      'Tu cuenta no tiene permiso para esta operación.',
    )
  })

  it('saves percentages through the all-or-nothing function and relays its messages', async () => {
    const rows = [
      {
        productId: 'p1',
        revision: 3,
        pricing: { markups: { emprendedor: 20, vip: 15, premium: 10 } },
      },
    ]
    rpc.mockResolvedValueOnce({ data: 1, error: null })
    await expect(supabaseAdapter.savePricing(rows)).resolves.toBe(1)
    expect(rpc).toHaveBeenCalledWith('save_product_pricing', { p_rows: rows })

    rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: 'P0001',
        message:
          'Otro usuario cambió «Cedro» hace un momento. Vuelve a abrirlo antes de guardar.',
      },
    })
    await expect(supabaseAdapter.savePricing(rows)).rejects.toThrow(
      /Otro usuario cambió «Cedro»/,
    )

    rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202' } })
    await expect(supabaseAdapter.savePricing(rows)).rejects.toThrow(
      /Falta aplicar la actualización de precios/,
    )
  })

  it('reads the percentage, the cost base and the cause behind each price change', async () => {
    rpc.mockResolvedValueOnce({
      data: [
        {
          changed_at: '2026-09-27T18:00:00Z',
          actor: 'Dueña',
          tier: 'emprendedor',
          before_usd: '0.54',
          after_usd: '0.56',
          before_nio: '19.59',
          after_nio: '20.35',
          catalog_rate: '36.600000',
          purchase_price: null,
          purchase_currency: null,
          markup: '25.00',
          average_cost: '16.281061',
          automatic: true,
          cause: 'purchase',
          cause_reference: 'FAC-778',
        },
        {
          changed_at: '2026-09-26T18:00:00Z',
          actor: 'Dueña',
          tier: 'vip',
          before_usd: '34.00',
          after_usd: '15.71',
          before_nio: '1244.40',
          after_nio: '575.00',
          catalog_rate: '36.600000',
          purchase_price: '500.00',
          purchase_currency: 'NIO',
          markup: '15.00',
          average_cost: null,
          automatic: false,
          cause: null,
          cause_reference: null,
        },
        // Una base sin las migraciones no manda las columnas nuevas.
        {
          changed_at: '2026-09-01T18:00:00Z',
          actor: 'Carga inicial',
          tier: 'vip',
          before_usd: null,
          after_usd: '34.00',
          before_nio: null,
          after_nio: '1258.00',
          catalog_rate: '37',
        },
      ],
      error: null,
    })
    const [automatic, legacy, manual] =
      await supabaseAdapter.listPriceChanges('p1')
    expect(automatic).toMatchObject({
      afterNio: 20.35,
      markup: 25,
      averageCost: 16.281061,
      automatic: true,
      cause: 'purchase',
      causeReference: 'FAC-778',
    })
    expect(legacy).toMatchObject({
      markup: 15,
      averageCost: null,
      purchasePrice: 500,
      purchaseCurrency: 'NIO',
      automatic: false,
    })
    expect(manual).toMatchObject({
      afterUsd: 34,
      markup: null,
      averageCost: null,
      purchasePrice: null,
      automatic: false,
      cause: null,
    })
  })
})

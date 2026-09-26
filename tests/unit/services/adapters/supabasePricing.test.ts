import { beforeEach, describe, expect, it, vi } from 'vitest'

const { state, rpc } = vi.hoisted(() => ({
  state: {
    rows: [] as unknown[],
    error: null as { code: string; message?: string } | null,
    ranges: [] as [number, number][],
    filters: [] as [string, unknown][],
    selection: '',
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
          state.selection = `${table}:${value}`
          return chain
        },
        eq: (column: string, value: unknown) => {
          state.filters.push([column, value])
          return chain
        },
        order: () => chain,
        range: async (start: number, end: number) => {
          state.ranges.push([start, end])
          if (state.error) return { data: null, error: state.error }
          return { data: state.rows.slice(start, end + 1), error: null }
        },
      }
      return chain
    },
  },
}))
import { supabaseAdapter } from '@/services/adapters/supabase'

const row = (index: number) => ({
  product_id: `p${index}`,
  purchase_price: '500.00',
  purchase_currency: 'NIO',
  markup_emprendedor: '20.00',
  markup_vip: null,
  markup_premium: '10.50',
  updated_at: '2026-09-26T18:00:00Z',
})

beforeEach(() => {
  state.rows = []
  state.error = null
  state.ranges = []
  state.filters = []
  rpc.mockReset()
})

describe('precio de compra en Supabase', () => {
  it('reads every page and turns PostgreSQL numbers into numbers', async () => {
    state.rows = Array.from({ length: 1005 }, (_, index) => row(index))
    const result = await supabaseAdapter.listPricing()
    expect(result.available).toBe(true)
    expect(result.rows).toHaveLength(1005)
    expect(state.ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ])
    expect(result.rows[0]).toEqual({
      productId: 'p0',
      purchasePrice: 500,
      purchaseCurrency: 'NIO',
      markups: { emprendedor: 20, vip: null, premium: 10.5 },
      updatedAt: '2026-09-26T18:00:00Z',
    })
    expect(state.selection).toMatch(/^product_pricing:/)
  })

  it('asks only for one perfume when the editor opens it', async () => {
    state.rows = [row(7)]
    await supabaseAdapter.listPricing('p7')
    expect(state.filters).toEqual([['product_id', 'p7']])
  })

  it('reports that the update is missing instead of failing the screen', async () => {
    state.error = { code: 'PGRST205', message: 'Could not find the table' }
    await expect(supabaseAdapter.listPricing()).resolves.toEqual({
      available: false,
      rows: [],
    })
    state.error = {
      code: '42501',
      message: 'permission denied for table product_pricing',
    }
    await expect(supabaseAdapter.listPricing()).rejects.toThrow(
      'Tu cuenta no tiene permiso para esta operación.',
    )
  })

  it('saves through the all-or-nothing function and relays its messages', async () => {
    const rows = [
      {
        productId: 'p1',
        revision: 3,
        pricing: {
          purchasePrice: 500,
          purchaseCurrency: 'NIO' as const,
          markups: { emprendedor: 20, vip: 15, premium: 10 },
        },
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
      /Falta aplicar la actualización de precios de compra/,
    )
  })

  it('reads the percentage and purchase price behind each price change', async () => {
    rpc.mockResolvedValueOnce({
      data: [
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
        },
        // Una base sin la migración no manda las columnas nuevas.
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
    const [computed, manual] = await supabaseAdapter.listPriceChanges('p1')
    expect(computed).toMatchObject({
      afterNio: 575,
      markup: 15,
      purchasePrice: 500,
      purchaseCurrency: 'NIO',
    })
    expect(manual).toMatchObject({
      afterUsd: 34,
      markup: null,
      purchasePrice: null,
      purchaseCurrency: null,
    })
  })
})

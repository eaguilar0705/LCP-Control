import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@/lib/errors'
import type { ExpenseInput, ShipmentInput } from '@/features/reports/accounting'
import {
  createAccountingAdapter,
  readReportPages,
} from '@/services/adapters/accounting'
import { catalogAdapter } from '@/services/adapters/catalog'
import { demoAdapter } from '@/services/adapters/demo'

describe('complete report pagination', () => {
  it('reads beyond a server row cap smaller than the requested page', async () => {
    const source = Array.from({ length: 1151 }, (_, id) => ({ id }))
    const query = vi.fn(async (from: number, to: number) => ({
      data: source.slice(from, Math.min(to + 1, from + 200)),
      count: source.length,
      error: null,
    }))
    const result = await readReportPages(query)
    expect(result).toEqual({ rows: source, truncated: false })
    expect(query).toHaveBeenCalledTimes(6)
    expect(query).toHaveBeenLastCalledWith(1000, 1499)
  })
  it('distinguishes an exact final page from a capped report', async () => {
    const query = (count: number) => async (from: number, to: number) => ({
      data: Array.from(
        { length: Math.min(to + 1, count) - from },
        (_, id) => id + from,
      ),
      count,
      error: null,
    })
    expect((await readReportPages(query(500), 500)).truncated).toBe(false)
    expect((await readReportPages(query(501), 500)).truncated).toBe(true)
  })
  it('surfaces failed pages and marks incomplete reads instead of inventing zeros', async () => {
    await expect(
      readReportPages(async () => ({
        data: null,
        count: null,
        error: { code: '42501' },
      })),
    ).rejects.toEqual({ code: '42501' })
    expect(
      await readReportPages(async () => ({ data: [], count: 10, error: null })),
    ).toEqual({ rows: [], truncated: true })
  })
})

type Fixture = { data?: unknown[]; error?: { code: string }; count?: number }
function connection(
  fixtures: Record<string, Fixture> = {},
  role = 'admin',
  active = true,
) {
  const filters: unknown[][] = []
  const rpc = vi.fn().mockResolvedValue({ data: 'confirmed-id', error: null })
  const from = vi.fn((table: string) => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      gte: vi.fn((column: string, value: unknown) => {
        filters.push([table, 'gte', column, value])
        return chain
      }),
      lte: vi.fn((column: string, value: unknown) => {
        filters.push([table, 'lte', column, value])
        return chain
      }),
      lt: vi.fn((column: string, value: unknown) => {
        filters.push([table, 'lt', column, value])
        return chain
      }),
      maybeSingle: vi
        .fn()
        .mockResolvedValue({ data: { role, active }, error: null }),
      range: vi.fn(async (start: number, end: number) => ({
        data: (fixtures[table]?.data ?? []).slice(start, end + 1),
        error: fixtures[table]?.error ?? null,
        count: fixtures[table]?.count ?? fixtures[table]?.data?.length ?? 0,
      })),
    }
    return chain
  })
  const auth = {
    getUser: vi
      .fn()
      .mockResolvedValue({ data: { user: { id: 'staff-id' } }, error: null }),
  }
  const client = { from, rpc, auth } as unknown as SupabaseClient
  const adapter = createAccountingAdapter(
    () => client,
    (error) => new AppError('unexpected', error?.code ?? 'error'),
  )
  return { adapter, from, rpc, auth, filters }
}
const window = { from: '2026-09-01', to: '2026-09-13' }

describe('private accounting adapter', () => {
  it.each(['operator', 'warehouse', 'viewer'])(
    'never requests cost tables for %s',
    async (role) => {
      const { adapter, from } = connection({}, role)
      expect((await adapter.getSource(window)).available).toBe(false)
      expect(from.mock.calls.map(([table]) => table)).toEqual(['staff_members'])
    },
  )
  it('does not fetch confidential rows for an inactive administrator', async () => {
    const { adapter, from } = connection({}, 'admin', false)
    expect((await adapter.getSource(window)).available).toBe(false)
    expect(from).toHaveBeenCalledTimes(1)
  })
  it('keeps legacy reports readable only when accounting schema is missing', async () => {
    const { adapter } = connection({
      product_costs: { error: { code: '42P01' } },
    })
    expect(await adapter.getSource(window)).toMatchObject({
      available: false,
      costs: [],
      truncated: false,
    })
    const unavailable = connection({
      product_costs: { error: { code: '42P01' } },
      expense_records: { error: { code: '42501' } },
    })
    await expect(unavailable.adapter.getSource(window)).rejects.toThrow('42501')
  })
  it('maps stored accounting amounts and preserves unknown costs without consulting sale prices', async () => {
    const { adapter, filters } = connection({
      product_costs: {
        data: [
          {
            product_id: 'known',
            average_cost_nio: '750.25',
            updated_at: '2026-09-10',
          },
          {
            product_id: 'unknown',
            average_cost_nio: null,
            updated_at: '2026-09-10',
          },
        ],
      },
      purchase_shipments: {
        data: [
          {
            id: 'shipment',
            request_id: 'request',
            incurred_on: '2026-09-10',
            supplier: 'Proveedor',
            agency: 'Agencia',
            reference: 'F-1',
            note: '',
            currency: 'USD',
            exchange_rate: '36.62',
            shipping_amount: '10',
            goods_amount: '200',
            units: 10,
            shipping_per_unit: '1',
            created_at: '2026-09-10T12:00:00Z',
            purchase_shipment_lines: [
              {
                id: 'line',
                product_id: 'known',
                location: 'store',
                quantity: 10,
                unit_price: '20',
                goods_amount: '200',
                shipping_share: '10',
                landed_unit_cost_nio: '769.02',
              },
            ],
          },
        ],
      },
      expense_records: {
        data: [
          {
            id: 'expense',
            request_id: 'request-2',
            incurred_on: '2026-09-10',
            category: 'servicios',
            description: 'Luz',
            amount: '100',
            currency: 'NIO',
            exchange_rate: '1',
            reference: 'F-2',
            created_at: '2026-09-10T12:00:00Z',
            voided_at: null,
            void_reason: null,
          },
        ],
      },
      document_item_costs: {
        data: [
          {
            document_item_id: 'line-1',
            document_id: 'invoice-1',
            product_id: 'known',
            quantity: 2,
            unit_cost_nio: null,
            net_revenue_nio: '2000',
            tax_nio: '300',
          },
        ],
      },
      inventory_movement_costs: {
        data: [
          {
            movement_id: 'loss-1',
            product_id: 'known',
            type: 'DAMAGED',
            quantity: 1,
            unit_cost_nio: '750.25',
            created_at: '2026-09-10T12:00:00Z',
          },
        ],
      },
    })
    const result = await adapter.getSource(window)
    expect(result.available).toBe(true)
    expect(result.costs.map((cost) => cost.averageCostNio)).toEqual([
      750.25,
      null,
    ])
    expect(result.shipments[0]).toMatchObject({
      agency: 'Agencia',
      exchangeRate: 36.62,
      shippingAmount: 10,
      units: 10,
      shippingPerUnit: 1,
    })
    expect(result.shipments[0].lines[0]).toMatchObject({
      unitPrice: 20,
      shippingShare: 10,
      landedUnitCostNio: 769.02,
    })
    expect(result.expenses[0]).toMatchObject({
      amount: 100,
      voidedAt: null,
    })
    expect(result.saleCosts[0]).toEqual({
      documentId: 'invoice-1',
      productId: 'known',
      quantity: 2,
      unitCostNio: null,
      netRevenueNio: 2000,
      taxNio: 300,
    })
    expect(result.movementCosts?.[0]).toMatchObject({
      movementId: 'loss-1',
      unitCostNio: 750.25,
    })
    expect(filters).toContainEqual([
      'document_item_costs',
      'gte',
      'documents.created_at',
      '2026-09-01T06:00:00.000Z',
    ])
    expect(filters).toContainEqual([
      'document_item_costs',
      'lt',
      'documents.created_at',
      '2026-09-14T06:00:00.000Z',
    ])
  })
  it('fails on malformed numeric financial values instead of converting them to zero', async () => {
    const { adapter } = connection({
      product_costs: {
        data: [
          {
            product_id: 'broken',
            average_cost_nio: 'NaN',
            updated_at: '2026-09-10',
          },
        ],
      },
    })
    await expect(adapter.getSource(window)).rejects.toThrow('importe inválido')
  })
  it('passes idempotency keys and entered amounts unchanged to atomic RPCs', async () => {
    const { adapter, rpc } = connection()
    const shipment = {
      requestId: 'retry-key',
      shippingAmount: 100,
    } as ShipmentInput
    const expense = { requestId: 'expense-key', amount: 20 } as ExpenseInput
    expect(await adapter.recordShipment(shipment)).toBe('confirmed-id')
    await adapter.recordExpense(expense)
    await adapter.voidExpense('expense-id', 'Registro duplicado')
    expect(rpc).toHaveBeenNthCalledWith(1, 'record_shipment', {
      p_input: shipment,
    })
    expect(rpc).toHaveBeenNthCalledWith(2, 'record_expense', {
      p_input: expense,
    })
    expect(rpc).toHaveBeenNthCalledWith(3, 'void_expense', {
      p_id: 'expense-id',
      p_reason: 'Registro duplicado',
    })
  })
  it('reports a missing write migration explicitly and requires confirmation from the server', async () => {
    const { adapter, rpc } = connection()
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202' } })
    await expect(adapter.recordExpense({} as ExpenseInput)).rejects.toThrow(
      'actualización de contabilidad',
    )
    rpc.mockResolvedValueOnce({ data: null, error: null })
    await expect(adapter.recordExpense({} as ExpenseInput)).rejects.toThrow(
      'confirmación',
    )
  })
  // El catálogo local trae un libro de muestra para poder recorrer el módulo
  // sin base de datos; el adaptador sin configurar no inventa nada. Ninguno de
  // los dos acepta una escritura.
  it('gives the local catalogue a sample ledger and the unconfigured adapter none', async () => {
    const sample = (await catalogAdapter.getReportSource(window)).accounting
    expect(sample?.available).toBe(true)
    expect(sample?.costs.length).toBeGreaterThan(0)
    expect(sample?.saleCosts.length).toBeGreaterThan(0)
    expect(
      (await demoAdapter.getReportSource(window)).accounting?.available,
    ).toBe(false)
  })
  it.each([catalogAdapter, demoAdapter])(
    'blocks every accounting write outside Supabase',
    async (adapter) => {
      await expect(adapter.recordShipment({} as ShipmentInput)).rejects.toThrow(
        'vista local',
      )
      await expect(adapter.recordExpense({} as ExpenseInput)).rejects.toThrow(
        'vista local',
      )
      await expect(adapter.voidExpense('id', 'reason')).rejects.toThrow(
        'vista local',
      )
    },
  )
})

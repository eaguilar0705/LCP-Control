import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AppError } from '@/lib/errors'
import { createCashflowAdapter } from '@/services/adapters/cashflow'

const range = { from: '2026-09-01', to: '2026-09-30' }
function adapter(result: {
  data: unknown
  error: { code: string; message: string } | null
}) {
  const rpc = vi.fn().mockResolvedValue(result)
  const from = vi.fn()
  const client = { rpc, from } as unknown as SupabaseClient
  const service = createCashflowAdapter(
    () => client,
    (error) => new AppError('unexpected', error?.message ?? 'Error'),
  )
  return { service, rpc, from }
}

describe('resumen de caja en Supabase', () => {
  it('distingue una migración pendiente de un fallo real de permisos', async () => {
    const missing = adapter({
      data: null,
      error: { code: 'PGRST202', message: 'Function missing' },
    })
    expect(await missing.service.getCashflow(range)).toMatchObject({
      available: false,
      ...range,
    })
    await expect(
      missing.service.recordCashClosing({
        requestId: 'r',
        closedOn: range.to,
        countedNio: 0,
        countedUsd: 0,
        exchangeRate: null,
        note: '',
      }),
    ).rejects.toMatchObject({ kind: 'configuration' })
    const denied = adapter({
      data: null,
      error: { code: '42501', message: 'Sin permiso' },
    })
    await expect(denied.service.getCashflow(range)).rejects.toThrow(
      'Sin permiso',
    )
  })
  it('consulta un resumen agregado y conserva saldos desconocidos', async () => {
    const { service, rpc, from } = adapter({
      data: {
        available: true,
        ...range,
        startOn: '2026-09-01',
        opening: { caja: null, banco: null },
        closing: { caja: '1200.50', banco: null },
        missingSales: 0,
        rows: [
          {
            day: range.to,
            account: 'caja',
            category: 'sales',
            inflowNio: '200',
            outflowNio: '0',
            operations: 2,
            missingSales: 0,
          },
        ],
        totals: { inflowNio: 200, outflowNio: 0, netNio: 200 },
      },
      error: null,
    })
    expect((await service.getCashflow(range)).closing).toEqual({
      caja: 1200.5,
      banco: null,
    })
    expect(rpc).toHaveBeenCalledWith('finance_cashflow', {
      p_from: range.from,
      p_to: range.to,
    })
    expect(from).not.toHaveBeenCalled()
  })
  it('rechaza importes faltantes en un resumen que afirma estar completo', async () => {
    const { service } = adapter({
      data: {
        available: true,
        ...range,
        startOn: null,
        opening: { caja: null, banco: null },
        closing: { caja: null, banco: null },
        missingSales: 0,
        rows: [],
        totals: { inflowNio: null, outflowNio: 0, netNio: 0 },
      },
      error: null,
    })
    await expect(service.getCashflow(range)).rejects.toThrow(
      'importe incompleto',
    )
  })
})

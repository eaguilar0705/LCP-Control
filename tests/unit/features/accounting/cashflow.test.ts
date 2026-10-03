import { describe, expect, it } from 'vitest'
import {
  cashClosingDifference,
  cashflowTotals,
  countedTotalNio,
  type CashflowRow,
} from '@/features/accounting/cashflow'

describe('el efectivo contado', () => {
  it('convierte dólares únicamente con la tasa explícita del arqueo', () => {
    expect(
      countedTotalNio({ countedNio: 520, countedUsd: 20, exchangeRate: 35 }),
    ).toBe(1220)
    expect(
      countedTotalNio({ countedNio: 520, countedUsd: 20, exchangeRate: null }),
    ).toBeNull()
    expect(
      countedTotalNio({ countedNio: 520, countedUsd: 20, exchangeRate: 0 }),
    ).toBeNull()
    expect(
      countedTotalNio({ countedNio: 0, countedUsd: 0, exchangeRate: null }),
    ).toBe(0)
  })
  it('no inventa la diferencia cuando la caja esperada es desconocida', () => {
    const count = { countedNio: 1200, countedUsd: 0, exchangeRate: null }
    expect(cashClosingDifference(count, null)).toBeNull()
    expect(cashClosingDifference(count, 1220)).toBe(-20)
    expect(
      cashClosingDifference({ ...count, countedNio: Number.NaN }, 1220),
    ).toBeNull()
    expect(cashClosingDifference({ ...count, countedNio: -1 }, 1220)).toBeNull()
  })
})

describe('el flujo externo del negocio', () => {
  it('una apertura y transferir dinero entre caja/banco no inflan cobros y pagos', () => {
    const row = (changes: Partial<CashflowRow>): CashflowRow => ({
      day: '2026-10-01',
      account: 'caja',
      category: 'sales',
      inflowNio: 0,
      outflowNio: 0,
      operations: 1,
      missingSales: 0,
      ...changes,
    })
    expect(
      cashflowTotals([
        row({ category: 'opening', inflowNio: 1000 }),
        row({ category: 'transfer', outflowNio: 500 }),
        row({ category: 'transfer', account: 'banco', inflowNio: 500 }),
        row({ inflowNio: 100 }),
        row({ category: 'expense', outflowNio: 25 }),
        row({ category: 'loan', account: 'banco', inflowNio: 200 }),
      ]),
    ).toEqual({ inflowNio: 300, outflowNio: 25, netNio: 275 })
  })
})

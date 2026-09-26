import { describe, expect, it } from 'vitest'
import {
  historyRange,
  managuaBounds,
  periodFileName,
  periodLabel,
  shortDay,
} from '@/features/sales/period'

describe('periodo del historial', () => {
  it('los atajos usan días de Managua y el mes pasado sabe cuántos días tuvo', () => {
    expect(historyRange('today', '2026-09-26')).toEqual({
      from: '2026-09-26',
      to: '2026-09-26',
    })
    expect(historyRange('7d', '2026-09-03')).toEqual({
      from: '2026-08-28',
      to: '2026-09-03',
    })
    expect(historyRange('month', '2026-09-26')).toEqual({
      from: '2026-09-01',
      to: '2026-09-26',
    })
    expect(historyRange('lastMonth', '2026-03-15')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    })
    expect(historyRange('lastMonth', '2026-01-10')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    })
  })

  it('una factura de las 11:30 p. m. en Managua cae en su día, no en el siguiente', () => {
    const bounds = managuaBounds({ from: '2026-09-01', to: '2026-09-30' })
    expect(bounds).toEqual({
      from: '2026-09-01T06:00:00.000Z',
      until: '2026-10-01T06:00:00.000Z',
    })
    // 30 de septiembre, 11:30 p. m. en Managua = 1 de octubre 05:30 UTC.
    const late = '2026-10-01T05:30:00.000Z'
    expect(late >= bounds.from && late < bounds.until).toBe(true)
  })

  it('nombra el archivo y el periodo sin correrse de día', () => {
    expect(
      periodFileName('invoice', { from: '2026-09-01', to: '2026-09-30' }),
    ).toBe('facturas-2026-09-01-al-2026-09-30.pdf')
    expect(
      periodFileName('proforma', { from: '2026-09-26', to: '2026-09-26' }),
    ).toBe('proformas-2026-09-26.pdf')
    expect(shortDay('2026-09-01')).toBe('01/09/2026')
    expect(periodLabel({ from: '2026-09-01', to: '2026-09-26' })).toBe(
      'del 01/09/2026 al 26/09/2026',
    )
    expect(periodLabel({ from: '2026-09-26', to: '2026-09-26' })).toBe(
      'del 26/09/2026',
    )
  })
})

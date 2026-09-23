import { describe, expect, it } from 'vitest'
import { toAppError } from '@/services/adapters/supabase'

describe('errores de Supabase hacia la pantalla', () => {
  it('convierte el límite de operaciones en un aviso de espera', () => {
    const error = toAppError({
      code: 'LCP429',
      message:
        'Demasiadas operaciones seguidas. Espera 35 segundos e inténtalo de nuevo.',
    })
    expect(error.kind).toBe('rate_limited')
    expect(error.message).toContain('35 segundos')
  })
  it('niega el acceso sin revelar la tabla', () => {
    const error = toAppError({
      code: '42501',
      message: 'permission denied for table documents',
    })
    expect(error.kind).toBe('unauthorized')
    expect(error.message).not.toContain('documents')
  })
  it('no muestra mensajes internos largos', () => {
    const error = toAppError({ message: 'x'.repeat(301) })
    expect(error.kind).toBe('unexpected')
    expect(error.message).toBe(
      'No pudimos completar la operación. Inténtalo de nuevo.',
    )
  })
  it('oculta también errores internos cortos y conserva validaciones del negocio', () => {
    expect(
      toAppError({
        code: '42P01',
        message: 'relation private.staff does not exist',
      }).message,
    ).not.toContain('private.staff')
    expect(
      toAppError({ code: 'P0001', message: 'Existencias insuficientes.' })
        .message,
    ).toBe('Existencias insuficientes.')
  })
})

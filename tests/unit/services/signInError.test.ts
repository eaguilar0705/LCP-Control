import { describe, expect, it } from 'vitest'
import { signInError } from '@/services/auth'

describe('mensajes al iniciar sesión', () => {
  it('muestra el aviso del bloqueo por intentos fallidos, no «revisa tu conexión»', () => {
    const error = signInError({
      status: 429,
      code: 'unexpected_failure',
      message:
        'Demasiados intentos fallidos. Vuelve a intentarlo en 4 minuto(s).',
    })
    expect(error.kind).toBe('rate_limited')
    expect(error.message).toBe(
      'Demasiados intentos fallidos. Vuelve a intentarlo en 4 minuto(s).',
    )
  })

  it('traduce el límite general de Supabase, que llega en inglés', () => {
    const error = signInError({
      status: 429,
      code: 'over_request_rate_limit',
      message: 'Request rate limit reached',
    })
    expect(error.kind).toBe('rate_limited')
    expect(error.message).toMatch(/Espera unos minutos/)
    expect(error.message).not.toMatch(/conexión/)
  })

  it('conserva los casos que ya funcionaban', () => {
    expect(
      signInError({ status: 400, code: 'invalid_credentials' }).message,
    ).toMatch(/incorrectos/)
    expect(
      signInError({ status: 400, code: 'email_not_confirmed' }).message,
    ).toMatch(/no está confirmado/)
    expect(signInError({ status: 0 }).message).toMatch(/conexión/)
  })
})

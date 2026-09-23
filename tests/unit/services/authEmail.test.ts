import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  signUp: vi.fn(),
  resend: vi.fn(),
  setSession: vi.fn(),
  verifyOtp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
}))
vi.mock('@/lib/supabase', () => ({
  authConfigured: true,
  supabase: { auth },
}))

import {
  authRedirectUrl,
  confirmAuthLink,
  resendConfirmation,
  signUpStaff,
} from '@/services/auth'

beforeEach(() => {
  for (const fn of Object.values(auth)) fn.mockReset()
})

describe('correo de activación', () => {
  it('devuelve a /auth/callback del origen actual, no a la Site URL', () => {
    expect(authRedirectUrl('https://lcp.example')).toBe(
      'https://lcp.example/auth/callback',
    )
  })
  it('registra con emailRedirectTo y normaliza el correo', async () => {
    auth.signUp.mockResolvedValue({
      data: { user: { identities: [{}] }, session: null },
      error: null,
    })
    await expect(
      signUpStaff(' Ana@Example.test ', 'x'.repeat(12)),
    ).resolves.toBe('confirmation_sent')
    expect(auth.signUp).toHaveBeenCalledWith({
      email: 'ana@example.test',
      password: 'x'.repeat(12),
      options: { emailRedirectTo: `${location.origin}/auth/callback` },
    })
  })
  it('distingue un correo ya confirmado (usuario sin identidades)', async () => {
    auth.signUp.mockResolvedValue({
      data: { user: { identities: [] }, session: null },
      error: null,
    })
    await expect(signUpStaff('a@b.test', 'x'.repeat(12))).resolves.toBe(
      'already_registered',
    )
  })
  it('explica el límite de envíos', async () => {
    auth.resend.mockResolvedValue({
      error: { code: 'over_email_send_rate_limit', status: 429 },
    })
    await expect(resendConfirmation('a@b.test')).rejects.toThrow(
      'límite temporal de correos',
    )
    expect(auth.resend).toHaveBeenCalledWith({
      type: 'signup',
      email: 'a@b.test',
      options: { emailRedirectTo: `${location.origin}/auth/callback` },
    })
  })
})

describe('canje del enlace', () => {
  it('flujo implícito: guarda la sesión de los tokens del fragmento', async () => {
    auth.setSession.mockResolvedValue({ error: null })
    await confirmAuthLink({
      kind: 'tokens',
      accessToken: 'a',
      refreshToken: 'r',
      type: 'signup',
    })
    expect(auth.setSession).toHaveBeenCalledWith({
      access_token: 'a',
      refresh_token: 'r',
    })
  })
  it('plantilla con token_hash: verifica el OTP', async () => {
    auth.verifyOtp.mockResolvedValue({ error: null })
    await confirmAuthLink({ kind: 'token_hash', tokenHash: 'h', type: 'email' })
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      token_hash: 'h',
      type: 'email',
    })
  })
  it('PKCE: explica que se abra en el mismo navegador', async () => {
    auth.exchangeCodeForSession.mockResolvedValue({
      error: { code: 'bad_code_verifier' },
    })
    await expect(
      confirmAuthLink({ kind: 'code', code: 'c', type: null }),
    ).rejects.toThrow('mismo navegador')
  })
  it('enlace vencido: no llama a Supabase', async () => {
    await expect(
      confirmAuthLink({
        kind: 'error',
        code: 'otp_expired',
        description: null,
      }),
    ).rejects.toThrow('venció')
    expect(auth.setSession).not.toHaveBeenCalled()
  })
})

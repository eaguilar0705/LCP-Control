import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  signUp: vi.fn(),
  resend: vi.fn(),
  setSession: vi.fn(),
  verifyOtp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
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
  requestPasswordReset,
  replacePassword,
} from '@/services/auth'

beforeEach(() => {
  vi.unstubAllEnvs()
  for (const fn of Object.values(auth)) fn.mockReset()
})

describe('recuperación de contraseña', () => {
  it('sends the normalized email to the recovery callback', async () => {
    auth.resetPasswordForEmail.mockResolvedValue({ error: null })
    await requestPasswordReset(' Ana@Example.test ')
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith(
      'ana@example.test',
      {
        redirectTo: `${location.origin}/auth/callback?type=recovery`,
      },
    )
  })
  it('does not reveal whether the email exists', async () => {
    auth.resetPasswordForEmail.mockResolvedValue({
      error: { code: 'user_not_found' },
    })
    await expect(
      requestPasswordReset('nobody@example.test'),
    ).resolves.toBeUndefined()
  })
  it('reports rate limits without retrying', async () => {
    auth.resetPasswordForEmail.mockResolvedValue({ error: { status: 429 } })
    await expect(requestPasswordReset('a@example.test')).rejects.toThrow(
      'límite temporal',
    )
    expect(auth.resetPasswordForEmail).toHaveBeenCalledTimes(1)
  })
  it('never redirects production to a stale localhost configuration', () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
      vi.stubEnv(
        'VITE_AUTH_REDIRECT_URL',
        `http://${hostname}:5173/auth/callback`,
      )
      expect(authRedirectUrl('https://lcp-control.pages.dev')).toBe(
        'https://lcp-control.pages.dev/auth/callback',
      )
    }
    vi.stubEnv(
      'VITE_AUTH_REDIRECT_URL',
      'https://lcp-control.pages.dev/auth/callback',
    )
    expect(authRedirectUrl('https://preview.example')).toBe(
      'https://lcp-control.pages.dev/auth/callback',
    )
  })
  it('rejects weak input and uses Supabase to update the authenticated account', async () => {
    await expect(replacePassword('short')).rejects.toThrow('12 a 72')
    expect(auth.updateUser).not.toHaveBeenCalled()
    auth.updateUser.mockResolvedValue({ error: null })
    await replacePassword('A-new-password-123')
    expect(auth.updateUser).toHaveBeenCalledWith({
      password: 'A-new-password-123',
    })
  })
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

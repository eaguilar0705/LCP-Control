import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import {
  destinationAfterLink,
  hasAuthLink,
  parseAuthLink,
} from '@/features/auth/authLink'
import { AuthCallbackPage } from '@/features/auth/AuthCallbackPage'
import { AuthContext } from '@/features/auth/AuthContext'
import { ActivatePage } from '@/features/auth/ActivatePage'
import { PasswordInput } from '@/components/ui'
import type { AuthService } from '@/services/auth'
import type { UserProfile } from '@/lib/domain'
import { AppError } from '@/lib/errors'

vi.mock('@/lib/supabase', () => ({ supabase: null, authConfigured: true }))

describe('parseAuthLink', () => {
  it('reads implicit-flow tokens from the fragment', () => {
    expect(
      parseAuthLink('', '#access_token=a&refresh_token=r&type=signup'),
    ).toEqual({
      kind: 'tokens',
      accessToken: 'a',
      refreshToken: 'r',
      type: 'signup',
    })
  })
  it('reads a token hash from a custom email template', () => {
    expect(parseAuthLink('?token_hash=h&type=email', '')).toEqual({
      kind: 'token_hash',
      tokenHash: 'h',
      type: 'email',
    })
  })
  it('ignores unknown OTP types', () => {
    expect(parseAuthLink('?token_hash=h&type=sms', '')).toBeNull()
  })
  it('reads a PKCE code', () => {
    expect(parseAuthLink('?code=abc', '')).toEqual({
      kind: 'code',
      code: 'abc',
      type: null,
    })
  })
  it('prefers the specific error code over the generic error', () => {
    expect(
      parseAuthLink(
        '',
        '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid',
      ),
    ).toEqual({
      kind: 'error',
      code: 'otp_expired',
      description: 'Email link is invalid',
    })
  })
  it('only treats ?code= as an auth link on return routes', () => {
    expect(hasAuthLink('/login', '?code=1', '')).toBe(true)
    expect(hasAuthLink('/products/new', '?code=1', '')).toBe(false)
    expect(
      hasAuthLink('/inventory', '', '#access_token=a&refresh_token=b'),
    ).toBe(true)
    expect(hasAuthLink('/', '', '')).toBe(false)
  })
  it('sends password recovery to the account page', () => {
    expect(
      destinationAfterLink({
        kind: 'tokens',
        accessToken: 'a',
        refreshToken: 'r',
        type: 'recovery',
      }),
    ).toBe('/account')
  })
})

function authState(user: UserProfile | null) {
  const service: AuthService = {
    getSession: vi.fn(async () => user),
    subscribe: vi.fn(() => () => {}),
    signIn: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  }
  return { user, loading: false, error: null, service, retry: vi.fn() }
}

function Where() {
  const location = useLocation()
  return (
    <output data-testid="where">{location.pathname + location.hash}</output>
  )
}

function mountCallback(
  entry: string,
  confirm: Parameters<typeof AuthCallbackPage>[0]['confirm'],
  user: UserProfile | null = null,
) {
  return render(
    <AuthContext.Provider value={authState(user)}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="/auth/callback"
            element={
              <>
                <AuthCallbackPage confirm={confirm} />
                <Where />
              </>
            }
          />
          <Route path="/" element={<h1>Panel</h1>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

describe('AuthCallbackPage', () => {
  it('exchanges the link once and clears tokens from the address', async () => {
    const confirm = vi.fn(async () => {})
    mountCallback(
      '/auth/callback#access_token=a&refresh_token=r&type=signup',
      confirm,
    )
    expect(await screen.findByText('Correo confirmado')).toBeInTheDocument()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/auth\/callback$/)
  })
  it('opens the dashboard once the session exists', async () => {
    const profile = {
      id: 'u',
      email: 'u@example.test',
      role: 'operator' as const,
    }
    mountCallback(
      '/auth/callback#access_token=a&refresh_token=r',
      async () => {},
      profile,
    )
    expect(await screen.findByRole('heading', { name: 'Panel' })).toBeVisible()
  })
  it('explains an expired link without calling Supabase', async () => {
    const confirm = vi.fn(async () => {})
    mountCallback(
      '/auth/callback#error=access_denied&error_code=otp_expired',
      confirm,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El enlace venció o ya se usó',
    )
    expect(confirm).not.toHaveBeenCalled()
    expect(
      screen.getByRole('link', { name: 'Solicitar un correo nuevo' }),
    ).toHaveAttribute('href', '/activate')
  })
  it('reports a failed exchange', async () => {
    mountCallback('/auth/callback?code=x', async () => {
      throw new AppError('unauthorized', 'Abre el enlace en el mismo navegador')
    })
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Abre el enlace en el mismo navegador',
      ),
    )
  })
})

describe('ActivatePage', () => {
  it('tells an existing account to sign in instead of waiting for mail', async () => {
    const signUp = vi.fn(async () => 'already_registered' as const)
    render(
      <MemoryRouter>
        <ActivatePage signUp={signUp} resend={vi.fn()} />
      </MemoryRouter>,
    )
    await userEvent.type(screen.getByLabelText('Correo autorizado'), 'A@b.test')
    await userEvent.type(
      screen.getByLabelText('Contraseña'),
      'contraseña-segura',
    )
    await userEvent.type(
      screen.getByLabelText('Repetir contraseña'),
      'contraseña-segura',
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Crear mi acceso' }),
    )
    expect(await screen.findByRole('status')).toHaveTextContent(
      'ya tiene acceso confirmado',
    )
    expect(signUp).toHaveBeenCalledWith('a@b.test', 'contraseña-segura')
    expect(screen.queryByRole('button', { name: /Reenviar/ })).toBeNull()
  })
  it('offers a rate-limited resend after sending the confirmation', async () => {
    const resend = vi.fn(async () => {})
    render(
      <MemoryRouter>
        <ActivatePage
          signUp={async () => 'confirmation_sent'}
          resend={resend}
        />
      </MemoryRouter>,
    )
    await userEvent.type(screen.getByLabelText('Correo autorizado'), 'a@b.test')
    await userEvent.type(
      screen.getByLabelText('Contraseña'),
      'contraseña-segura',
    )
    await userEvent.type(
      screen.getByLabelText('Repetir contraseña'),
      'contraseña-segura',
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Crear mi acceso' }),
    )
    expect(
      await screen.findByRole('button', { name: /Reenviar correo \(\d+ s\)/ }),
    ).toBeDisabled()
  })
})

describe('PasswordInput', () => {
  it('toggles visibility without submitting the form', async () => {
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault())
    render(
      <form onSubmit={submit}>
        <PasswordInput label="Contraseña" name="password" />
      </form>,
    )
    const input = screen.getByLabelText('Contraseña')
    expect(input).toHaveAttribute('type', 'password')
    await userEvent.click(
      screen.getByRole('button', { name: 'Mostrar contraseña' }),
    )
    expect(input).toHaveAttribute('type', 'text')
    const hide = screen.getByRole('button', { name: 'Ocultar contraseña' })
    expect(hide).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(hide)
    expect(input).toHaveAttribute('type', 'password')
    expect(submit).not.toHaveBeenCalled()
  })
})

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { RecoveryPage } from '@/features/auth/RecoveryPage'
import { AuthContext } from '@/features/auth/AuthContext'

const reset = vi.hoisted(() => ({ request: vi.fn(), replace: vi.fn() }))
vi.mock('@/services/auth', () => ({
  requestPasswordReset: reset.request,
  replacePassword: reset.replace,
}))

function mount(authenticated = false, changing = false) {
  return render(
    <AuthContext.Provider
      value={{
        user: authenticated
          ? { id: 'u', email: 'user@example.test', role: 'operator' }
          : null,
        loading: false,
        error: null,
        retry: vi.fn(),
        service: {
          getSession: vi.fn(),
          signIn: vi.fn(),
          signOut: vi.fn(),
          subscribe: vi.fn(),
        },
      }}
    >
      <MemoryRouter>
        <RecoveryPage reset={changing} />
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  reset.request.mockResolvedValue(undefined)
  reset.replace.mockResolvedValue(undefined)
})
it('requests one email and prevents repeated submissions', async () => {
  mount()
  await userEvent.type(
    screen.getByLabelText('Correo electrónico'),
    'user@example.test',
  )
  await userEvent.click(screen.getByRole('button', { name: 'Enviar enlace' }))
  expect(reset.request).toHaveBeenCalledWith('user@example.test')
  expect(screen.getByRole('status')).toHaveTextContent(
    'Si el correo corresponde a una cuenta',
  )
  const resend = screen.getByRole('button', { name: /Reenviar en/ })
  expect(resend).toBeDisabled()
  await userEvent.click(resend)
  expect(reset.request).toHaveBeenCalledTimes(1)
})
it('requires an authenticated recovery session', () => {
  mount(false, true)
  expect(
    screen.getByRole('link', { name: 'Solicitar otro enlace' }),
  ).toHaveAttribute('href', '/forgot-password')
  expect(screen.queryByLabelText('Nueva contraseña')).not.toBeInTheDocument()
})
it('checks repeated passwords and completes the change', async () => {
  mount(true, true)
  await userEvent.type(
    screen.getByLabelText('Nueva contraseña'),
    'NewPassword123!',
  )
  await userEvent.type(
    screen.getByLabelText('Repetir contraseña'),
    'OtherPassword123!',
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Guardar contraseña' }),
  )
  expect(screen.getByRole('alert')).toHaveTextContent(
    'repite la misma contraseña',
  )
  expect(reset.replace).not.toHaveBeenCalled()
  await userEvent.clear(screen.getByLabelText('Repetir contraseña'))
  await userEvent.type(
    screen.getByLabelText('Repetir contraseña'),
    'NewPassword123!',
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Guardar contraseña' }),
  )
  expect(reset.replace).toHaveBeenCalledWith('NewPassword123!')
  expect(screen.getByRole('status')).toHaveTextContent(
    'Tu contraseña se actualizó',
  )
  expect(screen.queryByLabelText('Nueva contraseña')).not.toBeInTheDocument()
})

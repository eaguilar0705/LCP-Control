import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { ActivatePage } from '@/features/auth/ActivatePage'

vi.mock('@/lib/supabase', () => ({ supabase: null, authConfigured: false }))

it('sin Supabase configurado dice el motivo, no un error genérico', async () => {
  const signUp = vi.fn()
  const user = userEvent.setup()
  render(
    <MemoryRouter>
      <ActivatePage signUp={signUp} resend={vi.fn()} />
    </MemoryRouter>,
  )
  await user.type(screen.getByLabelText('Correo autorizado'), 'ana@tienda.test')
  await user.type(
    screen.getByLabelText('Contraseña', { exact: true }),
    'clave-segura-uno',
  )
  await user.type(
    screen.getByLabelText('Repetir contraseña'),
    'clave-segura-uno',
  )
  await user.click(screen.getByRole('button', { name: 'Crear mi acceso' }))
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Configura Supabase para activar cuentas.',
  )
  expect(signUp).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Contraseña', { exact: true })).toHaveAttribute(
    'maxlength',
    '72',
  )
})

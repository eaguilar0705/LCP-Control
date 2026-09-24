import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { AccessContext } from '@/app/AccessContext'
import { AccountPage } from '@/features/auth/AccountPage'

const { rpc, updateUser } = vi.hoisted(() => ({
  rpc: vi.fn(),
  updateUser: vi.fn(),
}))
vi.mock('@/lib/supabase', () => ({
  authConfigured: true,
  supabase: {
    rpc,
    auth: {
      getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }),
      updateUser,
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { display_name: 'Ana' },
            error: null,
          }),
        }),
      }),
    }),
  },
}))
vi.mock('@/features/auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'ana@tienda.test', role: 'operator' },
  }),
}))
beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ error: null })
  updateUser.mockReset().mockResolvedValue({ error: null })
})
async function mount() {
  render(
    <AccessContext.Provider value={{ base: '', demo: false, role: 'operator' }}>
      <AccountPage />
    </AccessContext.Provider>,
  )
  await screen.findByDisplayValue('Ana')
  return userEvent.setup()
}
const formOf = (button: string) =>
  screen.getByRole('button', { name: button }).closest('form')!

it('no envía un nombre en blanco y avisa dentro de su tarjeta', async () => {
  const user = await mount()
  const name = screen.getByLabelText('Nombre visible')
  await user.clear(name)
  await user.type(name, '   ')
  await user.click(screen.getByRole('button', { name: 'Guardar nombre' }))
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Escribe tu nombre.')
  expect(formOf('Guardar nombre')).toContainElement(alert)
  expect(rpc).not.toHaveBeenCalled()
})

it('confirma el cambio en la misma tarjeta que lo pidió', async () => {
  const user = await mount()
  await user.type(screen.getByLabelText('Nombre visible'), ' María')
  await user.click(screen.getByRole('button', { name: 'Guardar nombre' }))
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith('update_my_profile', {
      p_name: 'Ana María',
    }),
  )
  expect(formOf('Guardar nombre')).toContainElement(
    await screen.findByText('Nombre actualizado.'),
  )
})

it('avisa junto a la contraseña si no coinciden, sin llamar a Supabase', async () => {
  const user = await mount()
  await user.type(screen.getByLabelText('Nueva contraseña'), 'clave-segura-uno')
  await user.type(
    screen.getByLabelText('Repetir contraseña'),
    'clave-segura-dos',
  )
  await user.click(screen.getByRole('button', { name: 'Cambiar contraseña' }))
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('repite la misma contraseña')
  expect(formOf('Cambiar contraseña')).toContainElement(alert)
  expect(updateUser).not.toHaveBeenCalled()
  // Supabase no acepta más de 72 caracteres: el campo tampoco.
  expect(screen.getByLabelText('Nueva contraseña')).toHaveAttribute(
    'maxlength',
    '72',
  )
})

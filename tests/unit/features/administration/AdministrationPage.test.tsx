import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AccessContext } from '@/app/AccessContext'
import { AppError } from '@/lib/errors'
import type { UserRole } from '@/lib/domain'
import { StaffPage } from '@/features/administration/AdministrationPage'

const { listStaff, deleteStaff, saveStaff } = vi.hoisted(() => ({
  listStaff: vi.fn(),
  deleteStaff: vi.fn(),
  saveStaff: vi.fn(),
}))
vi.mock('@/services/workspace', () => ({
  listStaff,
  deleteStaff,
  saveStaff,
  rpc: vi.fn(),
}))
vi.mock('@/features/auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'self', email: 'me@example.test' } }),
}))
const target = {
  user_id: 'target',
  email: 'target@example.test',
  display_name: 'Vendedor',
  role: 'operator',
  active: true,
  registered: true,
}
beforeEach(() => {
  deleteStaff.mockReset().mockResolvedValue(undefined)
  saveStaff.mockReset().mockResolvedValue(undefined)
  listStaff.mockReset().mockResolvedValue([
    {
      user_id: 'self',
      email: 'me@example.test',
      display_name: 'Mi cuenta',
      role: 'admin',
      active: true,
      registered: true,
    },
    {
      user_id: 'owner',
      email: 'owner@example.test',
      display_name: 'Dueña',
      role: 'superadmin',
      active: true,
      registered: true,
    },
    target,
  ])
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
})
async function mount(role: UserRole = 'admin') {
  render(
    <AccessContext.Provider value={{ base: '', demo: false, role }}>
      <StaffPage />
    </AccessContext.Provider>,
  )
  await screen.findByRole('heading', { name: 'Vendedor' })
  return userEvent.setup()
}
const card = (name: string) =>
  within(screen.getByRole('heading', { name }).closest('section')!)
it('hides deletion of SuperAdmin from admin and disables self deletion', async () => {
  await mount()
  expect(
    card('Dueña').queryByRole('button', { name: 'Eliminar usuario' }),
  ).not.toBeInTheDocument()
  expect(
    card('Mi cuenta').getByRole('button', { name: 'Eliminar usuario' }),
  ).toBeDisabled()
})
it('requires the target email, allows cancellation and reloads only after successful deletion', async () => {
  const user = await mount()
  await user.click(
    card('Vendedor').getByRole('button', { name: 'Eliminar usuario' }),
  )
  expect(
    screen.getByRole('button', { name: 'Eliminar definitivamente' }),
  ).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Cancelar' }))
  expect(deleteStaff).not.toHaveBeenCalled()
  await user.click(
    card('Vendedor').getByRole('button', { name: 'Eliminar usuario' }),
  )
  await user.type(
    screen.getByLabelText('Escribe el correo para confirmar'),
    'target@example.test',
  )
  await user.click(
    screen.getByRole('button', { name: 'Eliminar definitivamente' }),
  )
  await waitFor(() => expect(deleteStaff).toHaveBeenCalledWith(target))
  await waitFor(() => expect(listStaff).toHaveBeenCalledTimes(2))
  expect(screen.getByRole('status')).toHaveTextContent(
    'Cuenta de Vendedor eliminada',
  )
})
it('leaves the account and confirmation visible if the database refuses deletion', async () => {
  deleteStaff.mockRejectedValue(
    new AppError('validation', 'La cuenta cambió. Actualiza la lista.'),
  )
  const user = await mount('superadmin')
  expect(
    card('Dueña').getByRole('button', { name: 'Eliminar usuario' }),
  ).toBeEnabled()
  await user.click(
    card('Vendedor').getByRole('button', { name: 'Eliminar usuario' }),
  )
  await user.type(
    screen.getByLabelText('Escribe el correo para confirmar'),
    'target@example.test',
  )
  await user.click(
    screen.getByRole('button', { name: 'Eliminar definitivamente' }),
  )
  expect(await screen.findByRole('alert')).toHaveTextContent('La cuenta cambió')
  expect(screen.getByRole('dialog')).toBeVisible()
  expect(screen.getByRole('heading', { name: 'Vendedor' })).toBeInTheDocument()
  expect(listStaff).toHaveBeenCalledTimes(1)
})

it('muestra el error de guardado dentro del formulario, como error y con sus datos', async () => {
  saveStaff.mockRejectedValue(
    new AppError('validation', 'Revisa los datos de la cuenta.'),
  )
  const user = await mount()
  await user.click(
    card('Vendedor').getByRole('button', { name: 'Editar permisos' }),
  )
  const nameField = screen.getByLabelText('Nombre')
  // El foco entra en el formulario (el correo de una cuenta existente no se edita).
  await waitFor(() => expect(nameField).toHaveFocus())
  await user.clear(nameField)
  await user.type(nameField, 'Vendedora')
  await user.click(screen.getByRole('button', { name: 'Guardar' }))
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Revisa los datos de la cuenta.')
  expect(alert.closest('form')).not.toBeNull()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Nombre')).toHaveValue('Vendedora')
})

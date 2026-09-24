import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { AppShell } from '@/app/AppShell'
import { AuthContext } from '@/features/auth/AuthContext'
import type { UserRole } from '@/lib/domain'

function mount(role: UserRole) {
  const service = {
    getSession: vi.fn(async () => null),
    subscribe: vi.fn(() => () => {}),
    signIn: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  }
  render(
    <MemoryRouter initialEntries={['/inventory']}>
      <AuthContext.Provider
        value={{
          user: { id: 'u1', email: 'persona@tienda.test', role },
          loading: false,
          error: null,
          service,
          retry: vi.fn(),
        }}
      >
        <Routes>
          <Route path="/" element={<AppShell />}>
            <Route
              path="inventory"
              element={<button type="button">Acción de la página</button>}
            />
          </Route>
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
  return userEvent.setup()
}
const sidebar = () => document.querySelector('.sidebar') as HTMLElement

it('la barra inferior del teléfono no ofrece pantallas sin permiso', () => {
  mount('warehouse')
  const bottom = screen.getByRole('navigation', { name: 'Navegación móvil' })
  for (const name of ['Facturación', 'Proformas'])
    expect(within(bottom).queryByRole('link', { name })).not.toBeInTheDocument()
  expect(
    within(bottom).getByRole('link', { name: 'Inventario' }),
  ).toBeInTheDocument()
  // El menú lateral aplica la misma regla.
  const side = screen.getByRole('navigation', { name: 'Navegación principal' })
  expect(
    within(side).queryByRole('link', { name: 'Facturación' }),
  ).not.toBeInTheDocument()
})

it('el menú del teléfono se cierra con Escape y devuelve el foco', async () => {
  const user = mount('operator')
  const more = screen.getByRole('button', { name: 'Más' })
  expect(more).toHaveAttribute('aria-expanded', 'false')
  more.focus()
  await user.click(more)
  expect(more).toHaveAttribute('aria-expanded', 'true')
  expect(sidebar()).toHaveClass('sidebar-open')
  expect(screen.getByRole('button', { name: 'Cerrar menú' })).toHaveFocus()
  // Lo que queda detrás del panel sale del recorrido del teclado.
  expect(document.querySelector('.workspace')).toHaveAttribute('inert')
  await user.keyboard('{Escape}')
  expect(sidebar()).not.toHaveClass('sidebar-open')
  expect(document.querySelector('.workspace')).not.toHaveAttribute('inert')
  expect(more).toHaveFocus()
})

it('tocar el velo cierra el menú y no pulsa lo que hay debajo', async () => {
  const user = mount('operator')
  const pageAction = vi.fn()
  screen
    .getByRole('button', { name: 'Acción de la página' })
    .addEventListener('click', pageAction)
  await user.click(screen.getByRole('button', { name: 'Abrir menú' }))
  const backdrop = document.querySelector('.sidebar-backdrop') as HTMLElement
  expect(backdrop).toBeInTheDocument()
  await user.click(backdrop)
  expect(sidebar()).not.toHaveClass('sidebar-open')
  expect(document.querySelector('.sidebar-backdrop')).not.toBeInTheDocument()
  expect(pageAction).not.toHaveBeenCalled()
})

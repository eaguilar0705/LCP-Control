import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { AccessContext } from '@/app/AccessContext'
import { BusinessPage } from '@/features/administration/AdministrationPage'

const { saveExchangeRate, rate } = vi.hoisted(() => ({
  saveExchangeRate: vi.fn(),
  rate: { usdToNio: 36.6, updatedAt: '2026-09-15T19:40:52Z' },
}))
const services = {
  salesService: {
    getBusiness: async () => ({
      name: 'La Casa del Perfume',
      address: 'Managua',
      phone: '5555 0100',
    }),
  },
  settingsService: {
    getExchangeRate: async () => rate,
    saveExchangeRate,
  },
}
vi.mock('@/services/useServices', () => ({ useServices: () => services }))
vi.mock('@/services/workspace', () => ({ rpc: vi.fn() }))
beforeEach(() => {
  saveExchangeRate.mockReset().mockResolvedValue(undefined)
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
})
async function mount() {
  render(
    <AccessContext.Provider value={{ base: '', demo: false, role: 'admin' }}>
      <BusinessPage />
    </AccessContext.Provider>,
  )
  await screen.findByText('36.6 C$')
  return userEvent.setup()
}

it('pide confirmar el tipo de cambio mostrando el cambio y avisa si es grande', async () => {
  const user = await mount()
  // 3.66 en lugar de 36.6: bajaría los precios en córdobas a la décima parte.
  await user.type(screen.getByLabelText('Córdobas por 1 dólar'), '3.66')
  await user.click(screen.getByRole('button', { name: 'Actualizar tasa' }))
  const dialog = screen.getByRole('dialog', {
    name: 'Cambiar el tipo de cambio',
  })
  expect(dialog).toHaveTextContent('De 36.6 C$ a 3.66 C$ por dólar (-90 %)')
  expect(dialog).toHaveTextContent('más del 10 %')
  expect(saveExchangeRate).not.toHaveBeenCalled()
  await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
  expect(saveExchangeRate).not.toHaveBeenCalled()

  const field = screen.getByLabelText('Córdobas por 1 dólar')
  await user.clear(field)
  await user.type(field, '36.8')
  await user.click(screen.getByRole('button', { name: 'Actualizar tasa' }))
  const second = screen.getByRole('dialog', {
    name: 'Cambiar el tipo de cambio',
  })
  expect(second).not.toHaveTextContent('más del 10 %')
  await user.click(
    within(second).getByRole('button', { name: 'Actualizar tasa' }),
  )
  await waitFor(() => expect(saveExchangeRate).toHaveBeenCalledWith(36.8))
  expect(
    await screen.findByText(/Tipo de cambio actualizado/),
  ).toBeInTheDocument()
})

it('deja el diálogo abierto con el error si la base rechaza la tasa', async () => {
  saveExchangeRate.mockRejectedValue(new Error('x'))
  const user = await mount()
  await user.type(screen.getByLabelText('Córdobas por 1 dólar'), '37')
  await user.click(screen.getByRole('button', { name: 'Actualizar tasa' }))
  const dialog = screen.getByRole('dialog', {
    name: 'Cambiar el tipo de cambio',
  })
  await user.click(
    within(dialog).getByRole('button', { name: 'Actualizar tasa' }),
  )
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'No pudimos completar la operación',
  )
})

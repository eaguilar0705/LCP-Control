import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AccessContext } from '@/app/AccessContext'
import { catalogAdapter } from '@/services/adapters/catalog'
import type { InventoryItem, UserRole } from '@/lib/domain'
import { ProductStockEditor } from '@/features/products/ProductStockEditor'

const { inventoryService } = vi.hoisted(() => ({
  inventoryService: { getInventory: vi.fn(), recordMovement: vi.fn() },
}))
vi.mock('@/services/useServices', () => ({
  useServices: () => ({ inventoryService }),
}))
let item: InventoryItem
beforeEach(async () => {
  item = (await catalogAdapter.getInventory())[0]
  item.quantities = { store: 10, warehouse: null }
  inventoryService.getInventory
    .mockReset()
    .mockImplementation(async () => [structuredClone(item)])
  inventoryService.recordMovement.mockReset().mockResolvedValue('movement-1')
})
async function mount(role: UserRole = 'admin', demo = false) {
  render(
    <AccessContext.Provider value={{ base: '', role, demo }}>
      <ProductStockEditor product={item.product} />
    </AccessContext.Provider>,
  )
  await screen.findByLabelText('Ubicación de las cantidades')
  return userEvent.setup()
}
async function fillAmount(
  user: ReturnType<typeof userEvent.setup>,
  value: string,
) {
  const input = screen.getByLabelText('Unidades a mover')
  await user.clear(input)
  await user.type(input, value)
  await user.type(
    screen.getByLabelText('Motivo del cambio de cantidad'),
    'Conteo revisado',
  )
}
it('adds a delta and reloads the authoritative stock after saving', async () => {
  inventoryService.recordMovement.mockImplementation(async () => {
    item.quantities.store = 13
    return 'movement-1'
  })
  const user = await mount()
  await fillAmount(user, '2')
  await user.click(
    screen.getByRole('button', { name: 'Aumentar cantidad en una unidad' }),
  )
  await user.click(screen.getByRole('button', { name: 'Guardar cantidades' }))
  await waitFor(() =>
    expect(inventoryService.getInventory).toHaveBeenCalledTimes(2),
  )
  expect(inventoryService.recordMovement).toHaveBeenCalledWith(
    expect.objectContaining({
      productId: item.product.id,
      location: 'store',
      type: 'ENTRY',
      quantity: 3,
      note: 'Conteo revisado',
    }),
  )
  expect(
    await screen.findByText('13', { selector: '.stock-location-cards strong' }),
  ).toBeVisible()
})
it('subtracts units, rejects a negative balance and reuses the request id after a lost response', async () => {
  const user = await mount()
  await user.selectOptions(
    screen.getByLabelText('Cómo cambiar las cantidades'),
    'EXIT',
  )
  await fillAmount(user, '11')
  await user.click(screen.getByRole('button', { name: 'Guardar cantidades' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('negativas')
  expect(inventoryService.recordMovement).not.toHaveBeenCalled()
  await user.clear(screen.getByLabelText('Unidades a mover'))
  await user.type(screen.getByLabelText('Unidades a mover'), '2')
  inventoryService.recordMovement.mockRejectedValueOnce(
    new Error('Conexión interrumpida'),
  )
  await user.click(screen.getByRole('button', { name: 'Guardar cantidades' }))
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(
      'No pudimos completar la operación',
    ),
  )
  await user.click(screen.getByRole('button', { name: 'Guardar cantidades' }))
  await waitFor(() =>
    expect(inventoryService.recordMovement).toHaveBeenCalledTimes(2),
  )
  const [first, second] = inventoryService.recordMovement.mock.calls
  expect(first[0]).toEqual(second[0])
  expect(second[0]).toMatchObject({
    type: 'EXIT',
    quantity: 2,
    location: 'store',
  })
})
it('records an explicit zero initial count in the selected warehouse', async () => {
  const user = await mount()
  await user.selectOptions(
    screen.getByLabelText('Ubicación de las cantidades'),
    'warehouse',
  )
  expect(screen.getByLabelText('Cómo cambiar las cantidades')).toBeDisabled()
  await user.clear(screen.getByLabelText('Conteo total del perfume'))
  await user.type(screen.getByLabelText('Conteo total del perfume'), '0')
  await user.type(
    screen.getByLabelText('Motivo del cambio de cantidad'),
    'Bodega vacía',
  )
  await user.click(screen.getByRole('button', { name: 'Guardar cantidades' }))
  await waitFor(() =>
    expect(inventoryService.recordMovement).toHaveBeenCalledOnce(),
  )
  expect(inventoryService.recordMovement).toHaveBeenCalledWith(
    expect.objectContaining({
      location: 'warehouse',
      type: 'ADJUSTMENT',
      quantity: 0,
    }),
  )
})
it('does not expose write actions for a viewer', async () => {
  render(
    <AccessContext.Provider value={{ base: '', role: 'viewer', demo: false }}>
      <ProductStockEditor product={item.product} />
    </AccessContext.Provider>,
  )
  await screen.findByText('10', { selector: '.stock-location-cards strong' })
  expect(
    screen.queryByRole('button', { name: 'Guardar cantidades' }),
  ).not.toBeInTheDocument()
  expect(inventoryService.recordMovement).not.toHaveBeenCalled()
})
it('does not write from demo', async () => {
  await mount('admin', true)
  expect(
    screen.getByRole('button', { name: 'Guardar cantidades' }),
  ).toBeDisabled()
  expect(inventoryService.recordMovement).not.toHaveBeenCalled()
})

import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AccessContext } from '@/app/AccessContext'
import type { Product, UserRole } from '@/lib/domain'
import { ProductCostDialog } from '@/features/products/ProductCostDialog'

const { inventoryService, productService, settingsService, accountingService } =
  vi.hoisted(() => ({
    inventoryService: { getInventory: vi.fn() },
    productService: { listPricing: vi.fn(), getProductCost: vi.fn() },
    settingsService: { getExchangeRate: vi.fn() },
    accountingService: { setOpeningCost: vi.fn(), recordShipment: vi.fn() },
  }))
vi.mock('@/services/useServices', () => ({
  useServices: () => ({
    inventoryService,
    productService,
    settingsService,
    accountingService,
  }),
}))
const product: Product = {
  id: '00000001-0000-4000-8000-000000000000',
  revision: 1,
  barcode: 'LCP-0001',
  name: 'Cedro',
  brand: 'Casa Ámbar',
  category: 'arabian',
  gender: 'unisex',
  size: 100,
  unit: 'ml',
  price: 1100,
  currency: 'NIO',
  minimumStock: 0,
  active: true,
  prices: {
    emprendedor: { USD: 30, NIO: 1100 },
    vip: { USD: 29, NIO: 1060 },
    premium: { USD: 28, NIO: 1025 },
  },
}
beforeEach(() => {
  vi.resetAllMocks()
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
  inventoryService.getInventory.mockResolvedValue([
    { product, quantities: { store: 2, warehouse: 3 } },
  ])
  productService.getProductCost.mockResolvedValue(null)
  productService.listPricing.mockResolvedValue({ available: true, rows: [] })
  settingsService.getExchangeRate.mockResolvedValue({ usdToNio: 36.6 })
  accountingService.setOpeningCost.mockResolvedValue('saved')
})
function setup(role: UserRole = 'admin', demo = false) {
  const onRecorded = vi.fn()
  const onClose = vi.fn()
  render(
    <AccessContext.Provider value={{ role, demo, base: '' }}>
      <ProductCostDialog
        productId={product.id}
        onClose={onClose}
        onRecorded={onRecorded}
      />
    </AccessContext.Provider>,
  )
  return { onRecorded, onClose, user: userEvent.setup() }
}

it('records the selected perfume cost in dollars without registering a purchase or changing quantities', async () => {
  const { user, onRecorded } = setup()
  await screen.findByRole('dialog', { name: 'Costo inicial · Cedro' })
  await user.selectOptions(screen.getByLabelText('Moneda'), 'USD')
  await user.type(screen.getByLabelText('Costo por unidad (US$)'), '12.5')
  await user.type(
    screen.getByLabelText('Origen del costo / comprobante'),
    'Factura proveedor 120',
  )
  expect(screen.getByLabelText('Tasa (C$ por dólar)')).toHaveValue(36.6)
  await user.click(
    screen.getByRole('button', { name: 'Guardar costo inicial' }),
  )
  await waitFor(() => expect(onRecorded).toHaveBeenCalledOnce())
  expect(accountingService.setOpeningCost).toHaveBeenCalledExactlyOnceWith({
    productId: product.id,
    unitCost: 12.5,
    currency: 'USD',
    exchangeRate: 36.6,
    note: 'Factura proveedor 120',
    requestId: expect.any(String),
  })
  expect(accountingService.recordShipment).not.toHaveBeenCalled()
  expect(inventoryService.getInventory).toHaveBeenCalledWith(true)
})

it('asks for both counts before opening the cost form and does not write data', async () => {
  inventoryService.getInventory.mockResolvedValue([
    { product, quantities: { store: 2, warehouse: null } },
  ])
  setup()
  expect(
    await screen.findByRole('button', { name: 'Registrar conteo' }),
  ).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Guardar costo inicial' }),
  ).toBeNull()
  expect(accountingService.setOpeningCost).not.toHaveBeenCalled()
})

it.each([null, 400])(
  'uses the purchase flow for zero stock with cost %s',
  async (cost) => {
    inventoryService.getInventory.mockResolvedValue([
      { product, quantities: { store: 0, warehouse: 0 } },
    ])
    productService.getProductCost.mockResolvedValue(cost)
    setup()
    expect(
      await screen.findByRole('dialog', { name: 'Registrar compra' }),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Guardar costo inicial' }),
    ).toBeNull()
    expect(accountingService.setOpeningCost).not.toHaveBeenCalled()
  },
)

it('does not allow replacing an existing cost as if it were an opening cost', async () => {
  productService.getProductCost.mockResolvedValue(400)
  setup()
  expect(
    await screen.findByRole('dialog', { name: 'Registrar compra' }),
  ).toBeVisible()
})

it.each<[UserRole, boolean]>([
  ['viewer', false],
  ['operator', false],
  ['admin', true],
])('blocks cost access for role %s and demo %s', (role, demo) => {
  setup(role, demo)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(inventoryService.getInventory).not.toHaveBeenCalled()
  expect(accountingService.setOpeningCost).not.toHaveBeenCalled()
})

it('shows a retry after a read failure without accepting a guessed cost', async () => {
  inventoryService.getInventory.mockRejectedValue(
    new Error('No se pudo consultar el inventario'),
  )
  setup()
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'No pudimos completar la operación.',
  )
  expect(screen.getByRole('button', { name: 'Reintentar' })).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Guardar costo inicial' }),
  ).toBeNull()
})

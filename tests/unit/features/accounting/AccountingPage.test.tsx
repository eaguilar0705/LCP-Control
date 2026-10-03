import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AccessContext } from '@/app/AccessContext'
import type { PriceChange, PricingList, Product } from '@/lib/domain'
import { AccountingPage } from '@/features/accounting/AccountingPage'

const { productService, settingsService } = vi.hoisted(() => ({
  productService: {
    listProducts: vi.fn(),
    listPricing: vi.fn<(id?: string) => Promise<PricingList>>(),
    savePricing: vi.fn(),
    listPriceChanges: vi.fn<(id: string) => Promise<PriceChange[]>>(
      async () => [],
    ),
  },
  settingsService: {
    getExchangeRate: vi.fn(async () => ({ usdToNio: 37, updatedAt: null })),
  },
}))
vi.mock('@/services/useServices', () => ({
  useServices: () => ({ productService, settingsService }),
}))

const ID = '0f3c2b6e-8d1a-4c5e-9b7f-2a1d3c4e5f60'
function perfume(): Product {
  return {
    id: ID,
    revision: 5,
    barcode: 'LCP-0002',
    name: 'Oud nocturno',
    brand: 'Marca',
    category: 'arabian',
    gender: 'unisex',
    size: 100,
    unit: 'ml',
    price: 1295,
    currency: 'NIO',
    minimumStock: 0,
    active: true,
    prices: {
      emprendedor: { USD: 35, NIO: 1295 },
      vip: { USD: 34, NIO: 1258 },
      premium: { USD: 32, NIO: 1184 },
    },
  }
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
  productService.listProducts.mockImplementation(async () => [perfume()])
  productService.listPricing.mockImplementation(async () => ({
    available: true,
    rows: [],
  }))
  productService.savePricing.mockReset()
  productService.savePricing.mockResolvedValue(1)
})

function renderPage() {
  render(
    <AccessContext.Provider value={{ base: '', demo: false, role: 'admin' }}>
      <MemoryRouter>
        <AccountingPage />
      </MemoryRouter>
    </AccessContext.Provider>,
  )
}

it('saves the purchase price and the percentage of each client type', async () => {
  renderPage()
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', {
      name: 'Editar precios de Oud nocturno',
    }),
  )
  const dialog = screen.getByRole('dialog')
  await user.type(within(dialog).getByLabelText('Precio de compra'), '20')
  await user.type(
    within(dialog).getByLabelText('% de ganancia · Emprendedor'),
    '25',
  )
  const row = within(dialog).getByRole('group', { name: 'Emprendedor' })
  // Compra 20 + 25 % = 25; el córdoba sale de la tasa (25 × 37).
  expect(row).toHaveTextContent('USD 20.00')
  expect(row).toHaveTextContent('USD 5.00')
  expect(row).toHaveTextContent('USD 25.00')
  expect(row).toHaveTextContent('NIO 925.00')
  await user.click(
    within(dialog).getByRole('button', { name: 'Guardar precios' }),
  )
  await waitFor(() => expect(productService.savePricing).toHaveBeenCalledOnce())
  expect(productService.savePricing.mock.calls[0][0]).toEqual([
    {
      productId: ID,
      revision: 5,
      pricing: {
        purchasePrice: 20,
        purchaseCurrency: 'USD',
        markups: { emprendedor: 25, vip: null, premium: null },
      },
    },
  ])
  expect(
    await screen.findByText('Precios de «Oud nocturno» guardados.'),
  ).toBeVisible()
})

it('marks an impossible percentage instead of saving it', async () => {
  renderPage()
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', {
      name: 'Editar precios de Oud nocturno',
    }),
  )
  const vip = screen.getByLabelText('% de ganancia · VIP')
  await user.type(vip, '1000.5')
  await user.click(screen.getByRole('button', { name: 'Guardar precios' }))
  expect(productService.savePricing).not.toHaveBeenCalled()
  expect(vip).toHaveAccessibleDescription('Usa un porcentaje de hasta 1000.')
})

it('shows the margin over the average cost and the price history', async () => {
  productService.listPricing.mockImplementation(async () => ({
    available: true,
    rows: [
      {
        productId: ID,
        averageCost: 500,
        purchasePrice: 500,
        purchaseCurrency: 'NIO' as const,
        markups: { emprendedor: 20, vip: null, premium: null },
        updatedAt: null,
      },
    ],
  }))
  productService.listPriceChanges.mockImplementation(async () => [
    {
      changedAt: '2026-09-27T15:00:00Z',
      actor: 'Dueña',
      tier: 'emprendedor',
      beforeUsd: 0.54,
      afterUsd: 0.56,
      beforeNio: 19.59,
      afterNio: 20.35,
      catalogRate: 36.6,
      markup: 25,
      averageCost: 16.281061,
      automatic: true,
      cause: 'purchase',
      causeReference: 'FAC-778',
    },
  ])
  renderPage()
  const user = userEvent.setup()
  // La tabla dice el precio de compra y el porcentaje de cada tipo de cliente.
  const table = await screen.findByRole('table')
  expect(table).toHaveTextContent('NIO 500.00')
  expect(table).toHaveTextContent('20 %')
  await user.click(
    screen.getByRole('button', { name: 'Editar precios de Oud nocturno' }),
  )
  // 600 con costo 500 deja 16,7 %.
  expect(
    screen.getByText('Margen sobre el costo promedio: 16.7%'),
  ).toBeVisible()
  expect(
    await screen.findByRole('heading', { name: 'Historial de precios' }),
  ).toBeVisible()
  expect(
    await screen.findByText(/Compra FAC-778 · registrada por Dueña/),
  ).toBeVisible()
})

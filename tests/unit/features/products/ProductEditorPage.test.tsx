import { expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AccessContext } from '@/app/AccessContext'
import type { PriceChange, Product } from '@/lib/domain'
import type { ProductInput } from '@/features/products/product'
import { ProductEditorPage } from '@/features/products/ProductEditorPage'

const { productService, inventoryService, settingsService } = vi.hoisted(
  () => ({
    productService: {
      listProducts: vi.fn(),
      saveProduct: vi.fn(),
      // Un perfume recién guardado no tiene costo ni cambios de precio todavía.
      listPriceChanges: vi.fn<(id: string) => Promise<PriceChange[]>>(
        async () => [],
      ),
      getProductCost: vi.fn<(id: string) => Promise<number | null>>(
        async () => null,
      ),
    },
    inventoryService: { getInventory: vi.fn(), recordMovement: vi.fn() },
    // El precio en córdobas sale de esta tasa: sin ella el editor no deja fijar
    // precios, así que la prueba trabaja con una registrada.
    settingsService: {
      getExchangeRate: vi.fn(async () => ({ usdToNio: 37, updatedAt: null })),
    },
  }),
)
vi.mock('@/services/useServices', () => ({
  useServices: () => ({ productService, inventoryService, settingsService }),
}))

it('reloads a newly saved perfume and opens its quantities without a page refresh', async () => {
  let products: Product[] = []
  productService.listProducts.mockImplementation(async () =>
    structuredClone(products),
  )
  inventoryService.getInventory.mockImplementation(async () =>
    products.map((product) => ({
      product,
      quantities: { store: null, warehouse: null },
    })),
  )
  productService.saveProduct.mockImplementation(async (input: ProductInput) => {
    products = [
      {
        ...input,
        revision: 1,
        barcode: 'LCP-0001',
        price: input.prices.emprendedor.NIO,
        currency: 'NIO',
      },
    ]
    return input.id
  })
  render(
    <AccessContext.Provider value={{ base: '', demo: false, role: 'admin' }}>
      <MemoryRouter initialEntries={['/products/new']}>
        <Routes>
          <Route path="products/new" element={<ProductEditorPage />} />
          <Route path="products/:id/edit" element={<ProductEditorPage />} />
        </Routes>
      </MemoryRouter>
    </AccessContext.Provider>,
  )
  const user = userEvent.setup()
  await user.type(
    await screen.findByLabelText('Nombre del perfume'),
    'Perfume nuevo',
  )
  await user.type(
    screen.getByLabelText('Marca', { exact: true }),
    'Marca nueva',
  )
  // Sólo se teclea el dólar; el córdoba lo calcula la tasa.
  for (const tier of ['Emprendedor', 'VIP', 'Premium']) {
    await user.clear(screen.getByLabelText(`${tier} USD`, { exact: true }))
    await user.type(screen.getByLabelText(`${tier} USD`, { exact: true }), '20')
  }
  // 20 × 37: las tres listas muestran su precio en córdobas ya calculado.
  expect(screen.getAllByText(/740\.00/)).toHaveLength(3)
  await user.click(screen.getByRole('button', { name: 'Guardar perfume' }))
  await waitFor(() => expect(productService.saveProduct).toHaveBeenCalledOnce())
  await expect(
    screen.findByRole('heading', { name: 'Editar perfume' }),
  ).resolves.toBeVisible()
  expect(await screen.findByLabelText('Conteo total del perfume')).toHaveValue(
    null,
  )
  expect(screen.getByLabelText('Nombre del perfume')).toHaveValue(
    'Perfume nuevo',
  )
  expect(inventoryService.recordMovement).not.toHaveBeenCalled()
})

it('marks the fields that block the save instead of one generic notice', async () => {
  productService.listProducts.mockImplementation(async () => [])
  productService.saveProduct.mockClear()
  render(
    <AccessContext.Provider value={{ base: '', demo: false, role: 'admin' }}>
      <MemoryRouter initialEntries={['/products/new']}>
        <Routes>
          <Route path="products/new" element={<ProductEditorPage />} />
        </Routes>
      </MemoryRouter>
    </AccessContext.Provider>,
  )
  const user = userEvent.setup()
  const name = await screen.findByLabelText('Nombre del perfume')
  // Sólo la marca y un código de fabricante inválido: faltan nombre y precios.
  await user.type(screen.getByLabelText('Marca', { exact: true }), 'Marca')
  await user.type(
    screen.getByLabelText('Código del fabricante (EAN / UPC)'),
    '123',
  )
  await user.click(screen.getByRole('button', { name: 'Guardar perfume' }))

  expect(productService.saveProduct).not.toHaveBeenCalled()
  expect(name).toHaveAccessibleDescription('Escribe el nombre del perfume.')
  expect(
    screen.getByLabelText('Código del fabricante (EAN / UPC)'),
  ).toHaveAccessibleDescription(/8, 12, 13 o 14 dígitos/)
  expect(screen.getByLabelText('Emprendedor USD')).toHaveAttribute(
    'aria-invalid',
    'true',
  )
  // El primer campo con problema recibe el foco: puede estar fuera de pantalla.
  await waitFor(() => expect(name).toHaveFocus())
})

it('shows what each price leaves over the cost and the perfume price history', async () => {
  const product: Product = {
    id: 'p1',
    revision: 3,
    barcode: 'LCP-0001',
    name: 'Erba pura',
    brand: 'Marca',
    category: 'arabian',
    gender: 'unisex',
    size: 100,
    unit: 'ml',
    price: 7844,
    currency: 'NIO',
    minimumStock: 2,
    active: true,
    prices: {
      emprendedor: { USD: 212, NIO: 7844 },
      vip: { USD: 200, NIO: 7400 },
      // Esta lista queda por debajo del costo: 3700 contra 4000.
      premium: { USD: 100, NIO: 3700 },
    },
  }
  productService.listProducts.mockImplementation(async () => [
    structuredClone(product),
  ])
  inventoryService.getInventory.mockImplementation(async () => [
    {
      product: structuredClone(product),
      quantities: { store: 2, warehouse: 1 },
    },
  ])
  productService.getProductCost.mockImplementation(async () => 4000)
  productService.listPriceChanges.mockImplementation(async () => [
    {
      changedAt: '2026-09-10T15:00:00Z',
      actor: 'Diego',
      tier: 'emprendedor',
      beforeUsd: 200,
      afterUsd: 212,
      beforeNio: 7400,
      afterNio: 7844,
      catalogRate: 37,
    },
    {
      changedAt: '2026-08-01T15:00:00Z',
      actor: 'Carga inicial',
      tier: 'premium',
      beforeUsd: null,
      afterUsd: 100,
      beforeNio: null,
      afterNio: 3700,
      catalogRate: 37,
    },
  ])
  render(
    <AccessContext.Provider value={{ base: '', demo: false, role: 'admin' }}>
      <MemoryRouter initialEntries={['/products/p1/edit']}>
        <Routes>
          <Route path="products/:id/edit" element={<ProductEditorPage />} />
        </Routes>
      </MemoryRouter>
    </AccessContext.Provider>,
  )
  // El costo se dice una vez, arriba de las tres listas.
  expect(await screen.findByText(/Costo promedio actual/)).toBeVisible()
  // 7844 con costo 4000 deja 49 %; 7400 deja 45,9 %.
  expect(screen.getByText('Margen 49%')).toBeVisible()
  expect(screen.getByText('Margen 45.9%')).toBeVisible()
  // Premium vende por debajo del costo y se dice sin rodeos.
  const loss = screen.getByText(/Bajo el costo/)
  expect(loss).toBeVisible()
  expect(loss).toHaveTextContent('Bajo el costo: pierde 8.1%')
  expect(loss).toHaveClass('product-price-margin-thin')
  // El historial enseña el antes y el después, y marca el precio de partida.
  expect(
    await screen.findByRole('heading', { name: 'Historial de precios' }),
  ).toBeVisible()
  expect(screen.getByText(/USD 200\.00 → USD 212\.00/)).toBeVisible()
  expect(screen.getByText('Precio inicial')).toBeVisible()
})

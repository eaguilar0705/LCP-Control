import { expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AccessContext } from '@/app/AccessContext'
import type { PriceChange, PricingList, Product } from '@/lib/domain'
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
      // La base ya guarda precios de compra; este perfume todavía no tiene.
      listPricing: vi.fn<(id?: string) => Promise<PricingList>>(async () => ({
        available: true,
        rows: [],
      })),
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
  expect(screen.getByText('Margen sobre el costo promedio: 49%')).toBeVisible()
  expect(
    screen.getByText('Margen sobre el costo promedio: 45.9%'),
  ).toBeVisible()
  // Premium vende por debajo del costo y se dice sin rodeos.
  const loss = screen.getByText(/Bajo el costo/)
  expect(loss).toBeVisible()
  expect(loss).toHaveTextContent('Bajo el costo promedio: pierde 8.1%')
  expect(loss).toHaveClass('product-price-margin-thin')
  // El historial enseña el antes y el después, y marca el precio de partida.
  expect(
    await screen.findByRole('heading', { name: 'Historial de precios' }),
  ).toBeVisible()
  expect(screen.getByText(/USD 200\.00 → USD 212\.00/)).toBeVisible()
  expect(screen.getByText('Precio inicial')).toBeVisible()
})

const PRICED = '0f3c2b6e-8d1a-4c5e-9b7f-2a1d3c4e5f60'
function pricedPerfume(): Product {
  return {
    id: PRICED,
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
function renderEditor(product: Product) {
  productService.listProducts.mockImplementation(async () => [
    structuredClone(product),
  ])
  inventoryService.getInventory.mockImplementation(async () => [
    {
      product: structuredClone(product),
      quantities: { store: 1, warehouse: 1 },
    },
  ])
  productService.saveProduct.mockReset()
  productService.saveProduct.mockImplementation(async () => product.id)
  render(
    <AccessContext.Provider value={{ base: '', demo: false, role: 'admin' }}>
      <MemoryRouter initialEntries={[`/products/${product.id}/edit`]}>
        <Routes>
          <Route path="products/:id/edit" element={<ProductEditorPage />} />
          <Route path="inventory" element={<p>Inventario</p>} />
        </Routes>
      </MemoryRouter>
    </AccessContext.Provider>,
  )
}

it('turns a C$ 500 purchase with 20 % into a C$ 600 sale and saves the purchase price', async () => {
  renderEditor(pricedPerfume())
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText('Precio de compra'), '500')
  await user.type(screen.getByLabelText('% de ganancia Emprendedor'), '20')
  // Precio de compra, porcentaje aplicado, ganancia y precio de venta.
  const row = screen.getByRole('group', { name: 'Emprendedor' })
  expect(row).toHaveTextContent('NIO 500.00')
  expect(row).toHaveTextContent('NIO 100.00')
  expect(row).toHaveTextContent('20 % de la compra')
  expect(row).toHaveTextContent('NIO 600.00')
  // 600 / 37 = 16.216…: el dólar sale de la tasa.
  expect(row).toHaveTextContent('USD 16.22 con la tasa vigente')
  expect(row).toHaveTextContent('Calculado')
  // VIP y Premium siguen a mano, con su dólar editable.
  expect(screen.getByLabelText('VIP USD', { exact: true })).toHaveValue(34)
  expect(screen.queryByLabelText('Emprendedor USD', { exact: true })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Guardar perfume' }))
  await waitFor(() => expect(productService.saveProduct).toHaveBeenCalledOnce())
  const [payload] = productService.saveProduct.mock.calls[0] as [ProductInput]
  expect(payload.pricing).toEqual({
    purchasePrice: 500,
    purchaseCurrency: 'NIO',
    markups: { emprendedor: 20, vip: null, premium: null },
  })
  expect(payload.prices).toEqual({
    emprendedor: { NIO: 600, USD: 16.22 },
    vip: { USD: 34, NIO: 1258 },
    premium: { USD: 32, NIO: 1184 },
  })
})

it('keeps the last computed price as the manual one when a percentage is removed', async () => {
  productService.listPricing.mockImplementation(async () => ({
    available: true,
    rows: [
      {
        productId: PRICED,
        purchasePrice: 500,
        purchaseCurrency: 'NIO',
        markups: { emprendedor: 20, vip: 15, premium: 10 },
        updatedAt: null,
      },
    ],
  }))
  renderEditor(pricedPerfume())
  const user = userEvent.setup()
  const vip = await screen.findByLabelText('% de ganancia VIP')
  expect(vip).toHaveValue(15)
  expect(screen.getByRole('group', { name: 'VIP' })).toHaveTextContent(
    'NIO 575.00',
  )
  await user.clear(vip)
  // 575 / 37 = 15.54 en dólares; a mano el córdoba vuelve a ser dólar × tasa.
  expect(screen.getByLabelText('VIP USD', { exact: true })).toHaveValue(15.54)
  expect(screen.getByRole('group', { name: 'VIP' })).toHaveTextContent(
    'NIO 574.98',
  )
  expect(screen.getByRole('group', { name: 'VIP' })).toHaveTextContent('A mano')
  await user.click(screen.getByRole('button', { name: 'Guardar perfume' }))
  await waitFor(() => expect(productService.saveProduct).toHaveBeenCalledOnce())
  const [payload] = productService.saveProduct.mock.calls[0] as [ProductInput]
  expect(payload.pricing?.markups).toEqual({
    emprendedor: 20,
    vip: null,
    premium: 10,
  })
  expect(payload.prices.vip).toEqual({ USD: 15.54, NIO: 574.98 })
  expect(payload.prices.premium).toEqual({ NIO: 550, USD: 14.86 })
})

it('marks an impossible percentage instead of saving it', async () => {
  renderEditor(pricedPerfume())
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText('Precio de compra'), '500')
  await user.type(screen.getByLabelText('% de ganancia VIP'), '1000.5')
  await user.click(screen.getByRole('button', { name: 'Guardar perfume' }))
  expect(productService.saveProduct).not.toHaveBeenCalled()
  expect(
    screen.getByLabelText('% de ganancia VIP'),
  ).toHaveAccessibleDescription('Usa un porcentaje de hasta 1000.')
  // Al corregirlo, el aviso se va sin tener que volver a guardar.
  await user.clear(screen.getByLabelText('% de ganancia VIP'))
  await user.type(screen.getByLabelText('% de ganancia VIP'), '15')
  expect(screen.getByLabelText('% de ganancia VIP')).not.toHaveAttribute(
    'aria-invalid',
  )
  expect(
    screen.queryByText(/Revisa (el campo marcado|los campos marcados)/),
  ).toBeNull()
})

it('without the database update keeps dollar prices and never sends a purchase price', async () => {
  productService.listPricing.mockImplementation(async () => ({
    available: false,
    rows: [],
  }))
  renderEditor(pricedPerfume())
  const user = userEvent.setup()
  expect(
    await screen.findByText(/falta aplicar la actualización de precios/),
  ).toBeVisible()
  expect(screen.queryByLabelText('Precio de compra')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Guardar perfume' }))
  await waitFor(() => expect(productService.saveProduct).toHaveBeenCalledOnce())
  const [payload] = productService.saveProduct.mock.calls[0] as [ProductInput]
  expect(payload).not.toHaveProperty('pricing')
  expect(payload.prices.vip).toEqual({ USD: 34, NIO: 1258 })
})

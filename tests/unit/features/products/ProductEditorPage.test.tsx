import { expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AccessContext } from '@/app/AccessContext'
import type { PriceChange, PricingList, Product } from '@/lib/domain'
import type { ProductInput } from '@/features/products/product'
import { ProductEditorPage } from '@/features/products/ProductEditorPage'

const { productService, inventoryService, settingsService, accountingService } =
  vi.hoisted(() => ({
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
      // La base ya guarda porcentajes; este perfume todavía no tiene.
      listPricing: vi.fn<(id?: string) => Promise<PricingList>>(async () => ({
        available: true,
        rows: [],
      })),
    },
    inventoryService: { getInventory: vi.fn(), recordMovement: vi.fn() },
    accountingService: { setOpeningCost: vi.fn(), recordShipment: vi.fn() },
    // El precio en córdobas sale de esta tasa: sin ella el editor no deja fijar
    // precios, así que la prueba trabaja con una registrada.
    settingsService: {
      getExchangeRate: vi.fn(async () => ({ usdToNio: 37, updatedAt: null })),
    },
  }))
vi.mock('@/services/useServices', () => ({
  useServices: () => ({
    productService,
    inventoryService,
    settingsService,
    accountingService,
  }),
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
  // El costo se dice una vez, arriba de las tres listas, y no se escribe.
  expect(await screen.findByText('Costo promedio vigente')).toBeVisible()
  expect(screen.getByText('NIO 4,000.00', { selector: 'output' })).toBeVisible()
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
function renderEditor(product: Product, averageCost: number | null = null) {
  productService.getProductCost.mockImplementation(async () => averageCost)
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
const percent = (tier: string) =>
  screen.getByLabelText(`% de ganancia sobre el costo · ${tier}`)

it('refreshes the cost and product revision after adding a cost from the editor', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
  const product = pricedPerfume()
  productService.listPricing.mockResolvedValue({ available: true, rows: [] })
  renderEditor(product)
  accountingService.setOpeningCost.mockImplementation(async () => {
    product.revision = 6
    productService.getProductCost.mockResolvedValue(500)
    return 'saved'
  })
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Agregar costo' }))
  const input = await screen.findByLabelText('Costo por unidad (C$)')
  // El formulario del costo es independiente del formulario del perfume.
  expect(input.closest('form')?.parentElement?.closest('form')).toBeNull()
  await user.type(input, '500')
  await user.type(
    screen.getByLabelText('Origen del costo / comprobante'),
    'Factura 123',
  )
  await user.click(
    screen.getByRole('button', { name: 'Guardar costo inicial' }),
  )
  expect(
    await screen.findByRole('button', { name: 'Registrar compra' }),
  ).toBeEnabled()
  expect(screen.getByText('NIO 500.00', { selector: 'output' })).toBeVisible()
  expect(
    screen.getByText('Costo inicial de «Oud nocturno» registrado.'),
  ).toBeVisible()
  await user.type(screen.getByLabelText('Nombre del perfume'), ' nuevo')
  await user.click(screen.getByRole('button', { name: 'Guardar perfume' }))
  await waitFor(() => expect(productService.saveProduct).toHaveBeenCalledOnce())
  expect(productService.saveProduct.mock.calls[0][0]).toMatchObject({
    revision: 6,
  })
})

it('computes a list from the read-only average cost and never sends a cost', async () => {
  productService.listPricing.mockImplementation(async () => ({
    available: true,
    rows: [],
  }))
  renderEditor(pricedPerfume(), 16.281061)
  const user = userEvent.setup()
  await screen.findByText('Costo promedio vigente')
  expect(screen.queryByLabelText('Precio de compra')).toBeNull()
  await user.type(percent('Emprendedor'), '25')
  // Costo promedio, porcentaje aplicado, ganancia y precio de venta.
  const row = screen.getByRole('group', { name: 'Emprendedor' })
  expect(row).toHaveTextContent('NIO 16.28')
  expect(row).toHaveTextContent('NIO 4.07')
  expect(row).toHaveTextContent('25 % sobre el costo')
  expect(row).toHaveTextContent('NIO 20.35')
  // 20.35 / 37 = 0.55: el dólar sale de la tasa.
  expect(row).toHaveTextContent('USD 0.55 con la tasa vigente')
  expect(row).toHaveTextContent('Calculado')
  // VIP y Premium siguen a mano, con su dólar editable.
  expect(screen.getByLabelText('VIP USD', { exact: true })).toHaveValue(34)
  expect(screen.queryByLabelText('Emprendedor USD', { exact: true })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Guardar perfume' }))
  await waitFor(() => expect(productService.saveProduct).toHaveBeenCalledOnce())
  const [payload] = productService.saveProduct.mock.calls[0] as [ProductInput]
  expect(payload.pricing).toEqual({
    markups: { emprendedor: 25, vip: null, premium: null },
  })
  expect(payload.prices).toEqual({
    emprendedor: { NIO: 20.35, USD: 0.55 },
    vip: { USD: 34, NIO: 1258 },
    premium: { USD: 32, NIO: 1184 },
  })
})

it('keeps a list with percentage and no cost pending, with its dollar price editable', async () => {
  productService.listPricing.mockImplementation(async () => ({
    available: true,
    rows: [],
  }))
  renderEditor(pricedPerfume(), null)
  const user = userEvent.setup()
  expect(await screen.findByText('Sin costo todavía')).toBeVisible()
  const addCost = screen.getByRole('button', { name: 'Agregar costo' })
  expect(addCost).toBeEnabled()
  await user.type(percent('VIP'), '20')
  expect(addCost).toBeDisabled()
  expect(
    screen.getByText(
      'Guarda los cambios del perfume antes de registrar su costo.',
    ),
  ).toBeVisible()
  const vip = screen.getByRole('group', { name: 'VIP' })
  expect(vip).toHaveTextContent('Pendiente de costo')
  expect(vip).toHaveTextContent('Se calculará con 20 % cuando haya costo.')
  expect(screen.getByLabelText('VIP USD', { exact: true })).toHaveValue(34)
  await user.click(screen.getByRole('button', { name: 'Guardar perfume' }))
  await waitFor(() => expect(productService.saveProduct).toHaveBeenCalledOnce())
  const [payload] = productService.saveProduct.mock.calls[0] as [ProductInput]
  expect(payload.pricing?.markups.vip).toBe(20)
  expect(payload.prices.vip).toEqual({ USD: 34, NIO: 1258 })
})

it('keeps the last computed price as the manual one when a percentage is removed', async () => {
  productService.listPricing.mockImplementation(async () => ({
    available: true,
    rows: [
      {
        productId: PRICED,
        averageCost: 500,
        markups: { emprendedor: 20, vip: 15, premium: 10 },
        updatedAt: null,
      },
    ],
  }))
  renderEditor(pricedPerfume(), 500)
  const user = userEvent.setup()
  await screen.findByText('Costo promedio vigente')
  const vip = percent('VIP')
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
  renderEditor(pricedPerfume(), 500)
  const user = userEvent.setup()
  await screen.findByText('Costo promedio vigente')
  await user.type(percent('VIP'), '1000.5')
  await user.click(screen.getByRole('button', { name: 'Guardar perfume' }))
  expect(productService.saveProduct).not.toHaveBeenCalled()
  expect(percent('VIP')).toHaveAccessibleDescription(
    'Usa un porcentaje de hasta 1000.',
  )
  // Al corregirlo, el aviso se va sin tener que volver a guardar.
  await user.clear(percent('VIP'))
  await user.type(percent('VIP'), '15')
  expect(percent('VIP')).not.toHaveAttribute('aria-invalid')
  expect(
    screen.queryByText(/Revisa (el campo marcado|los campos marcados)/),
  ).toBeNull()
})

it('tells an automatic change from a manual one in the price history', async () => {
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
    {
      changedAt: '2026-09-26T15:00:00Z',
      actor: 'Dueña',
      tier: 'vip',
      beforeUsd: 34,
      afterUsd: 15.71,
      beforeNio: 1244.4,
      afterNio: 575,
      catalogRate: 36.6,
      markup: 15,
      purchasePrice: 500,
      purchaseCurrency: 'NIO',
      automatic: false,
    },
  ])
  renderEditor(pricedPerfume(), 16.281061)
  const history = (
    await screen.findByRole('heading', { name: 'Historial de precios' })
  ).closest('section, div')!.parentElement!
  await screen.findByText(/Compra FAC-778 · registrada por Dueña/)
  expect(history).toHaveTextContent('Automático')
  expect(history).toHaveTextContent('25 % sobre el costo promedio de NIO 16.28')
  expect(history).toHaveTextContent('NIO 19.59 → NIO 20.35')
  // Un registro del modelo anterior se sigue explicando con su precio de compra.
  expect(history).toHaveTextContent('15 % sobre la compra de NIO 500.00')
})

it('without the database update keeps dollar prices and never sends percentages', async () => {
  productService.listPricing.mockImplementation(async () => ({
    available: false,
    rows: [],
  }))
  renderEditor(pricedPerfume())
  const user = userEvent.setup()
  expect(
    await screen.findByText(/falta aplicar la actualización de precios/),
  ).toBeVisible()
  expect(screen.queryByLabelText(/% de ganancia sobre el costo/)).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Guardar perfume' }))
  await waitFor(() => expect(productService.saveProduct).toHaveBeenCalledOnce())
  const [payload] = productService.saveProduct.mock.calls[0] as [ProductInput]
  expect(payload).not.toHaveProperty('pricing')
  expect(payload.prices.vip).toEqual({ USD: 34, NIO: 1258 })
})

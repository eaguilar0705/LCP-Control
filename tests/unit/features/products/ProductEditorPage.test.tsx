import { afterEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AccessContext } from '@/app/AccessContext'
import type { PriceChange, PricingList, Product } from '@/lib/domain'
import type { ProductInput } from '@/features/products/product'
import { ProductEditorPage } from '@/features/products/ProductEditorPage'
afterEach(() => vi.unstubAllGlobals())

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
it('shows an existing private photo through a temporary URL without caching the grant', async () => {
  const fetchPhoto = vi.fn(async () => ({
    ok: true,
    blob: async () => new Blob(['photo']),
  }))
  vi.stubGlobal('fetch', fetchPhoto)
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = () => 'blob:editor-photo'
      static revokeObjectURL = vi.fn()
    },
  )
  const product = {
    ...pricedPerfume(),
    imageUrl: 'https://photos.example?token=editor-grant',
  }
  renderEditor(product)
  await waitFor(() =>
    expect(screen.getByAltText('Vista previa del perfume')).toHaveAttribute(
      'src',
      'blob:editor-photo',
    ),
  )
  expect(fetchPhoto).toHaveBeenCalledWith(
    product.imageUrl,
    expect.objectContaining({ cache: 'no-store', credentials: 'omit' }),
  )
})

it('edits a perfume without price lists or price history and keeps its prices', async () => {
  productService.listPriceChanges.mockClear()
  renderEditor(pricedPerfume())
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText('Nombre del perfume'), ' nuevo')
  expect(
    screen.queryByRole('heading', { name: 'Listas de precios' }),
  ).toBeNull()
  expect(screen.queryByLabelText(/% de ganancia/)).toBeNull()
  expect(screen.queryByLabelText('Precio de compra')).toBeNull()
  expect(productService.listPriceChanges).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Guardar perfume' }))
  await waitFor(() => expect(productService.saveProduct).toHaveBeenCalledOnce())
  const [payload] = productService.saveProduct.mock.calls[0] as [ProductInput]
  // Sin `pricing`, la base conserva el precio de compra y los porcentajes.
  expect(payload).not.toHaveProperty('pricing')
  expect(payload.prices).toEqual(pricedPerfume().prices)
})

it('refreshes the product revision after adding a cost from the editor', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
  const product = pricedPerfume()
  productService.listPricing.mockResolvedValue({ available: true, rows: [] })
  productService.getProductCost.mockResolvedValue(null)
  renderEditor(product)
  accountingService.setOpeningCost.mockImplementation(async () => {
    product.revision = 6
    return 'saved'
  })
  const user = userEvent.setup()
  const inventoryCost = await screen.findByRole('button', {
    name: 'Costo de inventario',
  })
  await user.click(inventoryCost)
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
    await screen.findByText('Costo inicial de «Oud nocturno» registrado.'),
  ).toBeVisible()
  await user.type(await screen.findByLabelText('Nombre del perfume'), ' nuevo')
  // Con cambios sin guardar el costo espera.
  expect(
    screen.getByRole('button', { name: 'Costo de inventario' }),
  ).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Guardar perfume' }))
  await waitFor(() => expect(productService.saveProduct).toHaveBeenCalledOnce())
  expect(productService.saveProduct.mock.calls[0][0]).toMatchObject({
    revision: 6,
  })
})

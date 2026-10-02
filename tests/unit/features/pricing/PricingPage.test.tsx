import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AccessContext } from '@/app/AccessContext'
import type { PricingList, Product, UserRole } from '@/lib/domain'
import type { PricingSave } from '@/services/contracts'
import { PricingPage } from '@/features/pricing/PricingPage'

const { productService, settingsService, inventoryService, accountingService } =
  vi.hoisted(() => ({
    productService: {
      listProducts: vi.fn(),
      listPricing: vi.fn<(id?: string) => Promise<PricingList>>(),
      savePricing: vi.fn<(rows: PricingSave[]) => Promise<number>>(),
    },
    settingsService: {
      getExchangeRate: vi.fn(async () => ({
        usdToNio: 36.6,
        updatedAt: null,
      })),
    },
    inventoryService: { getInventory: vi.fn() },
    accountingService: {
      recordShipment: vi.fn(
        async (input: { requestId: string }) => input.requestId,
      ),
      setOpeningCost: vi.fn(
        async (input: { requestId: string }) => input.requestId,
      ),
    },
  }))
vi.mock('@/services/useServices', () => ({
  useServices: () => ({
    productService,
    settingsService,
    inventoryService,
    accountingService,
  }),
}))

function perfume(number: number, name: string, usd: number): Product {
  return {
    id: `0000000${number}-0000-4000-8000-000000000000`,
    revision: number * 10,
    barcode: `LCP-000${number}`,
    name,
    brand: 'Casa Ámbar',
    category: 'arabian',
    gender: 'unisex',
    size: 3.4,
    unit: 'oz',
    price: 0,
    currency: 'NIO',
    minimumStock: 0,
    active: true,
    prices: {
      emprendedor: { USD: usd, NIO: Math.round(usd * 3660) / 100 },
      vip: { USD: usd - 1, NIO: Math.round((usd - 1) * 3660) / 100 },
      premium: { USD: usd - 2, NIO: Math.round((usd - 2) * 3660) / 100 },
    },
  }
}
// jsdom no abre <dialog> modales: basta con marcarlos abiertos.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
})
const cedro = perfume(1, 'Cedro', 25)
const jazmin = perfume(2, 'Jazmín', 30)
const vainilla = perfume(3, 'Vainilla', 40)

function setup(role: UserRole = 'admin') {
  productService.listProducts.mockImplementation(async () =>
    structuredClone([cedro, jazmin, vainilla]),
  )
  // Cedro: comprado en US$ 20, con las tres listas calculadas y 13 unidades
  // al costo del Excel. Jazmín: comprado en C$ 700 y sin porcentajes.
  // Vainilla: sin precio de compra ni costo.
  inventoryService.getInventory.mockImplementation(async () => [
    { product: cedro, quantities: { store: 5, warehouse: 8 } },
    { product: jazmin, quantities: { store: 4, warehouse: 0 } },
    { product: vainilla, quantities: { store: 2, warehouse: 1 } },
  ])
  productService.listPricing.mockImplementation(async () => ({
    available: true,
    rows: [
      {
        productId: cedro.id,
        averageCost: 15.675,
        purchasePrice: 20,
        purchaseCurrency: 'USD' as const,
        markups: { emprendedor: 25, vip: 20, premium: 15 },
        updatedAt: null,
      },
      {
        productId: jazmin.id,
        averageCost: 650,
        purchasePrice: 700,
        purchaseCurrency: 'NIO' as const,
        markups: { emprendedor: null, vip: null, premium: null },
        updatedAt: null,
      },
    ],
  }))
  accountingService.recordShipment.mockClear()
  accountingService.setOpeningCost.mockClear()
  productService.savePricing.mockReset()
  productService.savePricing.mockImplementation(async (rows) => rows.length)
  render(
    <AccessContext.Provider value={{ base: '', demo: false, role }}>
      <MemoryRouter initialEntries={['/prices']}>
        <PricingPage />
      </MemoryRouter>
    </AccessContext.Provider>,
  )
  return userEvent.setup()
}

it('lists each perfume with its purchase price, percentage, profit and sale price', async () => {
  setup()
  const cedroRow = (
    await screen.findByRole('button', { name: 'Cedro' })
  ).closest('tr')!
  expect(cedroRow).toHaveTextContent('USD 20.00')
  expect(cedroRow).toHaveTextContent('25 % · gana USD 5.00')
  const jazminRow = screen
    .getByRole('button', { name: 'Jazmín' })
    .closest('tr')!
  expect(jazminRow).toHaveTextContent('NIO 700.00')
  expect(within(jazminRow).getAllByText('A mano')).toHaveLength(3)
  expect(screen.getByRole('button', { name: /Calculados\s*1/ })).toBeVisible()
  expect(
    screen.getByRole('button', { name: /Sin porcentajes\s*2/ }),
  ).toBeVisible()
  // En dólares: los precios guardados de cada lista.
  await userEvent
    .setup()
    .selectOptions(screen.getByLabelText('Precio de venta en'), 'USD')
  expect(cedroRow).toHaveTextContent('USD 25.00')
})

it('filters by what is still missing', async () => {
  const user = setup()
  await user.click(
    await screen.findByRole('button', { name: /Sin porcentajes\s*2/ }),
  )
  expect(screen.getByRole('button', { name: 'Vainilla' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Cedro' })).toBeNull()
  await user.type(screen.getByLabelText('Buscar perfume'), 'cedro')
  await user.type(screen.getByLabelText('Buscar perfume'), 'jazmin')
  expect(screen.getByText('No hay resultados')).toBeVisible()
})

it('keeps percentages without a purchase price pending, then computes them once it is written', async () => {
  const user = setup()
  await user.click(
    await screen.findByRole('button', { name: 'Editar precios de Vainilla' }),
  )
  const dialog = screen.getByRole('dialog', { name: 'Vainilla' })
  for (const [tier, value] of [
    ['Emprendedor', '20'],
    ['VIP', '15'],
    ['Premium', '10'],
  ])
    await user.type(
      within(dialog).getByLabelText(`% de ganancia · ${tier}`),
      value,
    )
  const emprendedor = within(dialog).getByRole('group', { name: 'Emprendedor' })
  expect(emprendedor).toHaveTextContent('Falta precio de compra')
  // Sin precio de compra no se inventa un precio: queda el publicado.
  expect(emprendedor).toHaveTextContent('NIO 1,464.00')
  await user.type(within(dialog).getByLabelText('Precio de compra'), '30')
  expect(emprendedor).toHaveTextContent('Calculado')
  expect(emprendedor).toHaveTextContent('USD 36.00')
  expect(emprendedor).toHaveTextContent('NIO 1,317.60')
  await user.click(
    within(dialog).getByRole('button', { name: 'Guardar precios' }),
  )
  await waitFor(() =>
    expect(productService.savePricing).toHaveBeenCalledWith([
      {
        productId: vainilla.id,
        revision: 30,
        pricing: {
          purchasePrice: 30,
          purchaseCurrency: 'USD',
          markups: { emprendedor: 20, vip: 15, premium: 10 },
        },
      },
    ]),
  )
  expect(
    await screen.findByText('Precios de «Vainilla» guardados.'),
  ).toBeVisible()
  await waitFor(() =>
    expect(productService.listPricing).toHaveBeenCalledTimes(2),
  )
})

it('computes each list from the editable purchase price', async () => {
  const user = setup()
  await user.click(
    await screen.findByRole('button', { name: 'Editar precios de Jazmín' }),
  )
  const dialog = screen.getByRole('dialog', { name: 'Jazmín' })
  const purchase = within(dialog).getByLabelText('Precio de compra')
  expect(purchase).toHaveValue(700)
  expect(within(dialog).getByLabelText('Moneda de compra')).toHaveValue('NIO')
  await user.type(within(dialog).getByLabelText('% de ganancia · VIP'), '20')
  const vip = within(dialog).getByRole('group', { name: 'VIP' })
  expect(vip).toHaveTextContent('Calculado')
  expect(vip).toHaveTextContent('NIO 840.00')
  expect(vip).toHaveTextContent('NIO 140.00')
  expect(vip).toHaveTextContent('USD 22.95')
  expect(
    within(dialog).getByRole('group', { name: 'Premium' }),
  ).toHaveTextContent('A mano')
  await user.clear(purchase)
  await user.type(purchase, '800')
  expect(vip).toHaveTextContent('NIO 960.00')
  await user.click(
    within(dialog).getByRole('button', { name: 'Guardar precios' }),
  )
  await waitFor(() =>
    expect(productService.savePricing).toHaveBeenCalledWith([
      {
        productId: jazmin.id,
        revision: 20,
        pricing: {
          purchasePrice: 800,
          purchaseCurrency: 'NIO',
          markups: { emprendedor: null, vip: 20, premium: null },
        },
      },
    ]),
  )
})

it('marks a wrong value on save and clears the mark as soon as it is fixed', async () => {
  const user = setup()
  await user.click(
    await screen.findByRole('button', { name: 'Editar precios de Vainilla' }),
  )
  const dialog = screen.getByRole('dialog', { name: 'Vainilla' })
  const vip = within(dialog).getByLabelText('% de ganancia · VIP')
  const premium = within(dialog).getByLabelText('% de ganancia · Premium')
  await user.type(vip, '1000.5')
  await user.type(premium, '-1')
  // Mientras no se intenta guardar, no se regaña a quien todavía escribe.
  expect(vip).not.toHaveAttribute('aria-invalid')
  await user.click(
    within(dialog).getByRole('button', { name: 'Guardar precios' }),
  )
  expect(productService.savePricing).not.toHaveBeenCalled()
  expect(vip).toHaveAccessibleDescription('Usa un porcentaje de hasta 1000.')
  expect(premium).toHaveAccessibleDescription(
    'El porcentaje no puede ser negativo.',
  )
  expect(within(dialog).getByRole('alert')).toHaveTextContent(
    'Revisa los campos marcados antes de guardar.',
  )
  await user.clear(vip)
  await user.type(vip, '15')
  expect(vip).not.toHaveAttribute('aria-invalid')
  expect(within(dialog).getByRole('alert')).toHaveTextContent(
    'Revisa el campo marcado antes de guardar.',
  )
  await user.clear(premium)
  expect(within(dialog).queryByRole('alert')).toBeNull()
  await user.click(
    within(dialog).getByRole('button', { name: 'Guardar precios' }),
  )
  await waitFor(() => expect(productService.savePricing).toHaveBeenCalledOnce())
})

it('registers a purchase with a preview of the new average, as in the Excel', async () => {
  const user = setup()
  await user.click(
    await screen.findByRole('button', { name: 'Costo de inventario' }),
  )
  const table = await screen.findByRole('region', {
    name: 'Costo promedio por perfume',
  })
  expect(within(table).getByText('C$ 15.675')).toBeVisible()
  await user.click(
    screen.getByRole('button', { name: 'Registrar compra de Cedro' }),
  )
  const dialog = screen.getByRole('dialog', { name: 'Registrar compra' })
  await user.type(within(dialog).getByLabelText('Unidades'), '20')
  await user.type(
    within(dialog).getByLabelText('Costo por unidad (C$)'),
    '16.675',
  )
  const outcome = within(dialog)
    .getByText(/costo promedio/)
    .closest('div')!
  expect(outcome).toHaveTextContent(
    '13 u. × C$ 15.675 + 20 u. × C$ 16.675 → costo promedio C$ 16.281061',
  )
  // El costo es contabilidad: no cambia precios.
  expect(outcome).not.toHaveTextContent('Emprendedor')
  await user.click(
    within(dialog).getByRole('button', { name: 'Registrar compra' }),
  )
  await waitFor(() =>
    expect(accountingService.recordShipment).toHaveBeenCalledOnce(),
  )
  expect(accountingService.recordShipment.mock.calls[0][0]).toMatchObject({
    currency: 'NIO',
    exchangeRate: 1,
    shippingAmount: 0,
    lines: [
      {
        productId: cedro.id,
        location: 'warehouse',
        quantity: 20,
        unitPrice: 16.675,
      },
    ],
  })
  expect(
    await screen.findByText(/Compra registrada: 20 unidades/),
  ).toBeVisible()
})

it('refuses a purchase that cannot be averaged and loads the opening cost first', async () => {
  const user = setup()
  await user.click(
    await screen.findByRole('button', { name: 'Costo de inventario' }),
  )
  await screen.findByRole('region', { name: 'Costo promedio por perfume' })
  expect(
    screen.queryByRole('button', { name: 'Registrar compra de Vainilla' }),
  ).toBeNull()
  await user.click(
    screen.getByRole('button', { name: 'Cargar costo inicial de Vainilla' }),
  )
  const dialog = screen.getByRole('dialog', {
    name: 'Costo inicial · Vainilla',
  })
  await user.click(
    within(dialog).getByRole('button', { name: 'Guardar costo inicial' }),
  )
  expect(accountingService.setOpeningCost).not.toHaveBeenCalled()
  await user.type(within(dialog).getByLabelText('Costo por unidad (C$)'), '100')
  await user.type(
    within(dialog).getByLabelText('Origen del costo / comprobante'),
    'Factura del proveedor',
  )
  expect(dialog).toHaveTextContent('3 u. contadas → costo promedio C$ 100')
  await user.click(
    within(dialog).getByRole('button', { name: 'Guardar costo inicial' }),
  )
  await waitFor(() =>
    expect(accountingService.setOpeningCost).toHaveBeenCalledOnce(),
  )
  expect(accountingService.setOpeningCost.mock.calls[0][0]).toMatchObject({
    productId: vainilla.id,
    unitCost: 100,
    currency: 'NIO',
    exchangeRate: 1,
    note: 'Factura del proveedor',
  })
})

it('loads a CSV, previews the changes and the rows it cannot use, then saves them together', async () => {
  const user = setup()
  await user.click(
    await screen.findByRole('button', { name: 'Cargar archivo' }),
  )
  const dialog = screen.getByRole('dialog', {
    name: 'Cargar precios desde un archivo',
  })
  const csv = [
    'Código;Costo promedio C$ (informativo, no se importa);% Emprendedor;% VIP;% Premium',
    'LCP-0002;999;5;15;10',
    'LCP-0003;;20;15;10',
    'LCP-0009;;1;1;1',
  ].join('\r\n')
  await user.upload(
    within(dialog).getByLabelText('Archivo con los precios'),
    new File([csv], 'precios.csv', { type: 'text/csv' }),
  )
  expect(
    await within(dialog).findByText(
      /2 perfumes cambian, 0 sin cambios y 1 fila no se puede usar/,
    ),
  ).toBeVisible()
  expect(
    within(dialog).getByText(/No hay ningún perfume con el código «LCP-0009»/),
  ).toBeVisible()
  expect(within(dialog).getByText(/no se importa\./)).toBeVisible()
  expect(
    within(dialog).getByText(/Un perfume no tiene precio de compra/),
  ).toBeVisible()
  // Jazmín Emprendedor pasa de C$ 1 098 a C$ 735: más de un 30 %, se avisa.
  expect(
    within(dialog).getByText(
      /Un perfume cambia su precio de venta más de un 30/,
    ),
  ).toBeVisible()
  await user.click(
    within(dialog).getByRole('button', { name: 'Guardar 2 perfumes' }),
  )
  await waitFor(() => expect(productService.savePricing).toHaveBeenCalledOnce())
  const [rows] = productService.savePricing.mock.calls[0]
  expect(rows).toEqual([
    {
      productId: jazmin.id,
      revision: 20,
      pricing: {
        purchasePrice: 700,
        purchaseCurrency: 'NIO',
        markups: { emprendedor: 5, vip: 15, premium: 10 },
      },
    },
    {
      productId: vainilla.id,
      revision: 30,
      pricing: {
        purchasePrice: null,
        purchaseCurrency: 'USD',
        markups: { emprendedor: 20, vip: 15, premium: 10 },
      },
    },
  ])
  expect(
    await screen.findByText('Precios cargados: 2 perfumes actualizados.'),
  ).toBeVisible()
})

it('explains a file it cannot read', async () => {
  const user = setup()
  await user.click(
    await screen.findByRole('button', { name: 'Cargar archivo' }),
  )
  const dialog = screen.getByRole('dialog', {
    name: 'Cargar precios desde un archivo',
  })
  await user.upload(
    within(dialog).getByLabelText('Archivo con los precios'),
    new File(['Nombre;Notas\nx;y'], 'otra.csv', { type: 'text/csv' }),
  )
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    /No encontramos los encabezados/,
  )
  expect(within(dialog).getByRole('button', { name: 'Guardar' })).toBeDisabled()
})

it('is only for the owners', async () => {
  setup('operator')
  expect(
    await screen.findByText('No tienes permiso para esta pantalla.'),
  ).toBeVisible()
  expect(productService.listPricing).not.toHaveBeenCalled()
})

it('says when the database does not have the update yet', async () => {
  setup()
  productService.listPricing.mockImplementation(async () => ({
    available: false,
    rows: [],
  }))
  // La primera lectura ya empezó con la otra respuesta: se vuelve a montar.
  document.body.innerHTML = ''
  render(
    <AccessContext.Provider
      value={{ base: '', demo: false, role: 'superadmin' }}
    >
      <MemoryRouter initialEntries={['/prices']}>
        <PricingPage />
      </MemoryRouter>
    </AccessContext.Provider>,
  )
  expect(
    await screen.findByText(
      /Falta la actualización de precios en la base de datos/,
    ),
  ).toBeVisible()
  expect(screen.getByRole('button', { name: /Cargar archivo/ })).toBeDisabled()
})

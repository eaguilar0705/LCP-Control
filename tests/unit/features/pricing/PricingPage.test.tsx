import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AccessContext } from '@/app/AccessContext'
import type { PricingList, Product, UserRole } from '@/lib/domain'
import type { PricingSave } from '@/services/contracts'
import { PricingPage } from '@/features/pricing/PricingPage'

const { productService, settingsService } = vi.hoisted(() => ({
  productService: {
    listProducts: vi.fn(),
    listPricing: vi.fn<(id?: string) => Promise<PricingList>>(),
    savePricing: vi.fn<(rows: PricingSave[]) => Promise<number>>(),
  },
  settingsService: {
    getExchangeRate: vi.fn(async () => ({ usdToNio: 36.6, updatedAt: null })),
  },
}))
vi.mock('@/services/useServices', () => ({
  useServices: () => ({ productService, settingsService }),
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
  productService.listPricing.mockImplementation(async () => ({
    available: true,
    rows: [
      {
        // Cedro: comprado en dólares, las tres listas calculadas y guardadas.
        productId: cedro.id,
        purchasePrice: 20,
        purchaseCurrency: 'USD',
        markups: { emprendedor: 25, vip: 20, premium: 15 },
        updatedAt: null,
      },
      {
        // Jazmín: precio de compra sin porcentajes todavía.
        productId: jazmin.id,
        purchasePrice: 700,
        purchaseCurrency: 'NIO',
        markups: { emprendedor: null, vip: null, premium: null },
        updatedAt: null,
      },
    ],
  }))
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
  expect(cedroRow).toHaveTextContent('NIO 915.00')
  expect(cedroRow).toHaveTextContent('25 % · gana USD 5.00')
  const jazminRow = screen
    .getByRole('button', { name: 'Jazmín' })
    .closest('tr')!
  expect(jazminRow).toHaveTextContent('NIO 700.00')
  expect(within(jazminRow).getAllByText('A mano')).toHaveLength(3)
  expect(screen.getByRole('button', { name: /Calculados\s*1/ })).toBeVisible()
  expect(screen.getByRole('button', { name: /Incompletos\s*1/ })).toBeVisible()
  expect(
    screen.getByRole('button', { name: /Sin precio de compra\s*1/ }),
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
    await screen.findByRole('button', { name: /Sin precio de compra\s*1/ }),
  )
  expect(screen.getByRole('button', { name: 'Vainilla' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Cedro' })).toBeNull()
  await user.type(screen.getByLabelText('Buscar perfume'), 'jazmin')
  expect(screen.getByText('No hay resultados')).toBeVisible()
})

it('saves one perfume with the revision it was read with', async () => {
  const user = setup()
  await user.click(
    await screen.findByRole('button', { name: 'Editar precios de Vainilla' }),
  )
  const dialog = screen.getByRole('dialog', { name: 'Vainilla' })
  await user.type(within(dialog).getByLabelText('Precio de compra'), '500')
  for (const [tier, value] of [
    ['Emprendedor', '20'],
    ['VIP', '15'],
    ['Premium', '10'],
  ])
    await user.type(
      within(dialog).getByLabelText(`% de ganancia ${tier}`),
      value,
    )
  expect(
    within(dialog).getByRole('group', { name: 'Emprendedor' }),
  ).toHaveTextContent('NIO 600.00')
  await user.click(
    within(dialog).getByRole('button', { name: 'Guardar precios' }),
  )
  await waitFor(() =>
    expect(productService.savePricing).toHaveBeenCalledWith([
      {
        productId: vainilla.id,
        revision: 30,
        pricing: {
          purchasePrice: 500,
          purchaseCurrency: 'NIO',
          markups: { emprendedor: 20, vip: 15, premium: 10 },
        },
      },
    ]),
  )
  expect(
    await screen.findByText('Precios de «Vainilla» guardados.'),
  ).toBeVisible()
  // La lista se vuelve a leer para enseñar lo que guardó la base.
  await waitFor(() =>
    expect(productService.listPricing).toHaveBeenCalledTimes(2),
  )
})

it('marks a wrong value on save and clears the mark as soon as it is fixed', async () => {
  const user = setup()
  await user.click(
    await screen.findByRole('button', { name: 'Editar precios de Vainilla' }),
  )
  const dialog = screen.getByRole('dialog', { name: 'Vainilla' })
  const purchase = within(dialog).getByLabelText('Precio de compra')
  const vip = within(dialog).getByLabelText('% de ganancia VIP')
  await user.type(purchase, '0')
  await user.type(vip, '1000.5')
  // Mientras no se intenta guardar, no se regaña a quien todavía escribe.
  expect(purchase).not.toHaveAttribute('aria-invalid')
  await user.click(
    within(dialog).getByRole('button', { name: 'Guardar precios' }),
  )
  expect(productService.savePricing).not.toHaveBeenCalled()
  expect(purchase).toHaveAccessibleDescription(
    'El precio de compra debe ser mayor que cero.',
  )
  expect(vip).toHaveAccessibleDescription('Usa un porcentaje de hasta 1000.')
  expect(within(dialog).getByRole('alert')).toHaveTextContent(
    'Revisa los campos marcados antes de guardar.',
  )
  await user.clear(purchase)
  await user.type(purchase, '500')
  expect(purchase).not.toHaveAttribute('aria-invalid')
  expect(within(dialog).getByRole('alert')).toHaveTextContent(
    'Revisa el campo marcado antes de guardar.',
  )
  await user.clear(vip)
  await user.type(vip, '15')
  expect(vip).not.toHaveAttribute('aria-invalid')
  expect(within(dialog).queryByRole('alert')).toBeNull()
  await user.click(
    within(dialog).getByRole('button', { name: 'Guardar precios' }),
  )
  await waitFor(() => expect(productService.savePricing).toHaveBeenCalledOnce())
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
    'Código;Precio de compra;Moneda;% Emprendedor;% VIP;% Premium',
    'LCP-0002;;;20;15;10',
    'LCP-0003;500;C$;20;15;10',
    'LCP-0009;10;C$;1;1;1',
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
  // Vainilla pasa de C$ 1 464 a C$ 600: más de un 30 %, se avisa.
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
        markups: { emprendedor: 20, vip: 15, premium: 10 },
      },
    },
    {
      productId: vainilla.id,
      revision: 30,
      pricing: {
        purchasePrice: 500,
        purchaseCurrency: 'NIO',
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

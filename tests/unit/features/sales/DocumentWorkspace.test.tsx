import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocumentWorkspace } from '@/features/sales/DocumentWorkspace'
import { AccessContext } from '@/app/AccessContext'
import { createServices } from '@/services'
import { catalogAdapter } from '@/services/adapters/catalog'
import { localBusiness } from '@/services/adapters/local'
import type { DocumentKind, DocumentRecord } from '@/lib/domain'
import type { DocumentDraft } from '@/features/sales/document'

const { createDocument, draftStore } = vi.hoisted(() => ({
  createDocument: vi.fn(),
  draftStore: {
    items: [] as DocumentDraft[],
    saved: null as DocumentDraft[] | null,
  },
}))
vi.mock('@/services/useServices', () => ({ useServices: () => services }))
vi.mock('@/services/workspace', () => ({ listContacts: async () => [] }))
vi.mock('@/lib/workspaceDrafts', () => ({
  useWorkspaceDrafts: () => ({
    items: draftStore.items,
    error: '',
    loading: false,
    save: async (items: DocumentDraft[]) => {
      draftStore.saved = items
      return true
    },
    retry: vi.fn(),
  }),
}))
const services = createServices(catalogAdapter)
services.salesService.createDocument = createDocument
const issued: DocumentRecord = {
  id: 'issued-1',
  kind: 'invoice',
  number: 'FAC-000001',
  customerId: 'c1',
  customerName: 'Cliente confirmado',
  customerPhone: null,
  issuer: localBusiness,
  tier: 'emprendedor',
  currency: 'NIO',
  total: 42,
  location: 'store',
  validUntil: null,
  paymentMethod: 'pending',
  notes: '',
  createdAt: '2026-09-13T03:00:00Z',
  items: [
    {
      id: 'line-1',
      productId: 'demo-0001',
      description: 'Producto confirmado',
      quantity: 1,
      unitPrice: 42,
      lineTotal: 42,
    },
  ],
}
beforeEach(() => {
  localStorage.clear()
  createDocument.mockReset()
  draftStore.items = []
  draftStore.saved = null
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
  services.inventoryService.getInventory = catalogAdapter.getInventory
})
async function prepare(demo = false, kind: DocumentKind = 'invoice') {
  const user = userEvent.setup()
  render(
    <MemoryRouter>
      <AccessContext.Provider value={{ demo, base: '', role: 'admin' }}>
        <DocumentWorkspace kind={kind} />
      </AccessContext.Provider>
    </MemoryRouter>,
  )
  await user.type(await screen.findByLabelText('Cliente'), 'Cliente de prueba')
  await user.click(
    screen.getByRole('button', { name: /^Agregar Aurora Norte Cedro 01/ }),
  )
  return user
}

function savedDraft(kind: DocumentKind): DocumentDraft {
  return {
    id: 'saved-draft',
    kind,
    reference: 'Borrador anterior',
    customer: 'Cliente',
    customerId: null,
    phone: '',
    taxId: '',
    currency: 'NIO',
    tier: 'emprendedor',
    payment: 'pending',
    location: 'store',
    validUntil: '2099-01-01',
    notes: '',
    createdAt: '2026-09-13T12:00:00Z',
    lines: [
      {
        productId: 'demo-0001',
        name: 'Aurora Norte Cedro 01',
        barcode: 'DEMO-0001',
        size: '3.4 oz',
        quantity: 2,
        prices: {
          emprendedor: { NIO: 1000, USD: 25 },
          vip: { NIO: 950, USD: 24 },
          premium: { NIO: 900, USD: 22 },
        },
      },
    ],
  }
}

it.each(['invoice', 'proforma'] as const)(
  'actualiza los precios al reabrir un borrador de %s y avisa antes de emitir',
  async (kind) => {
    draftStore.items = [savedDraft(kind)]
    const user = await prepare(false, kind)
    await user.click(
      document.querySelector('.saved-drafts button') as HTMLButtonElement,
    )
    expect(document.querySelector('.invoice-total')).toHaveTextContent(
      '1,830.00',
    )
    expect(
      screen.getByText(/Borrador abierto con los precios actuales/),
    ).toBeInTheDocument()
    await user.selectOptions(
      screen.getByLabelText('Lista de precios'),
      'premium',
    )
    expect(document.querySelector('.invoice-total')).toHaveTextContent(
      '1,610.40',
    )
    // Abrir no sobrescribe el borrador guardado ni emite una operación.
    expect(draftStore.items[0].lines[0].prices.emprendedor.NIO).toBe(1000)
    expect(createDocument).not.toHaveBeenCalled()
  },
)

it('impide emitir una proforma reabierta con un producto retirado del catálogo', async () => {
  const draft = savedDraft('proforma')
  draft.lines[0].productId = 'retired-product'
  draftStore.items = [draft]
  const user = await prepare(false, 'proforma')
  await user.click(
    document.querySelector('.saved-drafts button') as HTMLButtonElement,
  )
  expect(screen.getByLabelText(/^Cantidad de /)).toHaveAccessibleDescription(
    /ya no está disponible/,
  )
  expect(screen.getByRole('button', { name: 'Emitir proforma' })).toBeDisabled()
  expect(createDocument).not.toHaveBeenCalled()
})
it('reintenta con el mismo ID y muestra el precio confirmado, bloqueando la edición', async () => {
  createDocument
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValue(issued)
  const user = await prepare()
  await user.click(screen.getByRole('button', { name: 'Emitir factura' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('conexión')
  await user.click(screen.getByRole('button', { name: 'Emitir factura' }))
  await screen.findByText('Producto confirmado', { selector: 'strong' })
  expect(createDocument.mock.calls[0][0].requestId).toBe(
    createDocument.mock.calls[1][0].requestId,
  )
  expect(document.querySelector('.invoice-total')).toHaveTextContent('42.00')
  expect(screen.getByLabelText('Cliente')).toBeDisabled()
  expect(screen.getByLabelText('Moneda')).toBeDisabled()
  expect(
    screen.getByRole('button', { name: 'Guardar borrador' }),
  ).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Nueva factura' }))
  await waitFor(() => expect(screen.getByLabelText('Cliente')).toBeEnabled())
})
it('la demo permite preparar un borrador pero no emitirlo', async () => {
  await prepare(true)
  expect(screen.getByRole('button', { name: 'Emitir factura' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Guardar borrador' })).toBeEnabled()
  expect(createDocument).not.toHaveBeenCalled()
})

it('avisa en el renglón cuando la cantidad supera las existencias de la ubicación', async () => {
  const catalogue = await catalogAdapter.getInventory()
  // Conteo fijo para comparar contra la cantidad tecleada.
  services.inventoryService.getInventory = async () =>
    catalogue.map((item, index) =>
      index === 0 ? { ...item, quantities: { store: 2, warehouse: 0 } } : item,
    )
  const user = await prepare()
  const quantity = await screen.findByLabelText(/^Cantidad de /)

  expect(quantity).not.toHaveAttribute('aria-invalid')
  await user.clear(quantity)
  await user.type(quantity, '5')

  expect(quantity).toHaveAttribute('aria-invalid', 'true')
  expect(quantity).toHaveAccessibleDescription('Solo hay 2 en Tienda.')
  expect(screen.getByText(/renglón necesita revisión/)).toBeInTheDocument()
  // La base rechazaría la factura; el botón no deja llegar hasta ahí.
  expect(screen.getByRole('button', { name: 'Emitir factura' })).toBeDisabled()

  await user.clear(quantity)
  await user.type(quantity, '2')
  await waitFor(() => expect(quantity).not.toHaveAttribute('aria-invalid'))
  expect(screen.getByRole('button', { name: 'Emitir factura' })).toBeEnabled()
  expect(createDocument).not.toHaveBeenCalled()

  services.inventoryService.getInventory = catalogAdapter.getInventory
})

it('no deja facturar desde una ubicación sin conteo registrado', async () => {
  const catalogue = await catalogAdapter.getInventory()
  services.inventoryService.getInventory = async () =>
    catalogue.map((item, index) =>
      index === 0
        ? { ...item, quantities: { store: null, warehouse: 5 } }
        : item,
    )
  const user = await prepare()
  const quantity = await screen.findByLabelText(/^Cantidad de /)

  expect(quantity).toHaveAttribute('aria-invalid', 'true')
  expect(quantity).toHaveAccessibleDescription(/Sin conteo en Tienda/)
  expect(screen.getByRole('button', { name: 'Emitir factura' })).toBeDisabled()

  // La bodega sí está contada: al cambiar de ubicación el renglón queda listo.
  await user.selectOptions(screen.getByLabelText('Sale de'), 'warehouse')
  await waitFor(() => expect(quantity).not.toHaveAttribute('aria-invalid'))
  expect(screen.getByRole('button', { name: 'Emitir factura' })).toBeEnabled()

  services.inventoryService.getInventory = catalogAdapter.getInventory
})

it('muestra el mismo total en la otra moneda con la tasa del catálogo', async () => {
  const user = await prepare()
  // El perfume de muestra son 25 dólares y el catálogo se cotiza a 36.6, así
  // que su precio en córdobas es 915. La conversión tiene que devolver los 25.
  const onScreen = () => document.querySelector('.invoice-equivalent')
  await waitFor(() => expect(onScreen()).toBeInTheDocument())
  expect(onScreen()).toHaveTextContent(/25\.00/)
  expect(onScreen()).toHaveTextContent('A 36.6 C$ por dólar')
  expect(document.querySelector('.invoice-total')).toHaveTextContent(/915\.00/)

  // Al cobrar en dólares se invierte: el total pasa a 25 y el equivalente a 915.
  await user.selectOptions(screen.getByLabelText('Moneda'), 'USD')
  await waitFor(() => expect(onScreen()).toHaveTextContent(/915\.00/))
  expect(document.querySelector('.invoice-total')).toHaveTextContent(/25\.00/)

  // Y lo mismo bajo el TOTAL de la hoja que se imprime o se comparte.
  expect(document.querySelector('.letter-equivalent')).toHaveTextContent(
    /915\.00/,
  )
})

it('propone la tasa del negocio al pasar a dólares y respeta la que se teclee', async () => {
  createDocument.mockResolvedValue({ ...issued, currency: 'USD' })
  const user = await prepare()
  await user.selectOptions(screen.getByLabelText('Moneda'), 'USD')
  const rate = await screen.findByLabelText('Tipo de cambio (NIO por 1 USD)')
  expect(rate).toHaveValue(36.6)
  await user.clear(rate)
  await user.type(rate, '37.25')
  await user.click(screen.getByRole('button', { name: 'Emitir factura' }))
  await waitFor(() => expect(createDocument).toHaveBeenCalled())
  expect(createDocument.mock.calls[0][0].exchangeRate).toBe(37.25)
})

it('deja el campo vacío si se borra la tasa, en vez de reponerla sola', async () => {
  const user = await prepare()
  await user.selectOptions(screen.getByLabelText('Moneda'), 'USD')
  const rate = await screen.findByLabelText('Tipo de cambio (NIO por 1 USD)')
  await user.clear(rate)
  expect(rate).toHaveValue(null)
  expect(screen.getByRole('button', { name: 'Emitir factura' })).toBeDisabled()
})

it('marca la vigencia vacía o pasada de una proforma y no deja emitirla', async () => {
  await prepare(false, 'proforma')
  const validity = screen.getByLabelText('Válida hasta')
  const emit = screen.getByRole('button', { name: 'Emitir proforma' })
  expect(emit).toBeEnabled()
  // Borrada: antes llegaba a la base como '' y volvía un error genérico.
  fireEvent.change(validity, { target: { value: '' } })
  expect(validity).toHaveAccessibleDescription(
    'Elige hasta qué fecha es válida la proforma.',
  )
  expect(emit).toBeDisabled()
  // Un borrador de hace días puede traer una fecha ya vencida.
  fireEvent.change(validity, { target: { value: '2020-01-01' } })
  expect(validity).toHaveAccessibleDescription(
    'La vigencia no puede ser anterior a hoy.',
  )
  expect(emit).toBeDisabled()
  fireEvent.change(validity, { target: { value: '2099-01-01' } })
  expect(validity).not.toHaveAttribute('aria-invalid')
  expect(emit).toBeEnabled()
  expect(createDocument).not.toHaveBeenCalled()
})

it('exige el nombre del cliente y un WhatsApp válido antes de emitir', async () => {
  createDocument.mockResolvedValue(issued)
  const user = await prepare()
  const name = screen.getByLabelText('Cliente')
  const emit = screen.getByRole('button', { name: 'Emitir factura' })
  await user.clear(name)
  expect(name).toHaveAccessibleDescription(
    'Escribe el nombre del cliente o elige uno registrado.',
  )
  expect(emit).toBeDisabled()
  expect(screen.getByText(/revisa los datos marcados/)).toBeInTheDocument()
  await user.type(name, 'Ana')
  // Un número incompleto ya no se descarta en silencio al emitir.
  const phone = screen.getByLabelText('WhatsApp del cliente')
  await user.type(phone, '123')
  expect(phone).toHaveAccessibleDescription(/8 dígitos/)
  expect(emit).toBeDisabled()
  await user.clear(phone)
  await user.type(phone, '8888 0000')
  expect(emit).toBeEnabled()
  await user.click(emit)
  await waitFor(() => expect(createDocument).toHaveBeenCalledOnce())
  expect(createDocument.mock.calls[0][0]).toMatchObject({
    customerName: 'Ana',
    customerPhone: '50588880000',
  })
})

it('el nombre del cliente admite hasta 160 caracteres, el tope de la base', async () => {
  await prepare()
  expect(screen.getByLabelText('Cliente')).toHaveAttribute('maxlength', '160')
})

it('elimina el borrador abierto después de confirmarlo', async () => {
  draftStore.items = [
    savedDraft('invoice'),
    { ...savedDraft('invoice'), id: 'otro', reference: 'Otro borrador' },
  ]
  const user = await prepare()
  // Sin un borrador abierto no hay nada que eliminar.
  expect(
    screen.queryByRole('button', { name: 'Eliminar borrador' }),
  ).not.toBeInTheDocument()
  await user.click(
    document.querySelector('.saved-drafts button') as HTMLButtonElement,
  )
  await user.click(screen.getByRole('button', { name: 'Eliminar borrador' }))
  const dialog = screen.getByRole('dialog', { name: 'Eliminar borrador' })
  expect(within(dialog).getByText('Borrador anterior')).toBeInTheDocument()
  await user.click(
    within(dialog).getByRole('button', { name: 'Eliminar borrador' }),
  )
  await waitFor(() =>
    expect(draftStore.saved?.map((draft) => draft.id)).toEqual(['otro']),
  )
  expect(await screen.findByText('Borrador eliminado.')).toBeInTheDocument()
  expect(createDocument).not.toHaveBeenCalled()
})

import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocumentHistory } from '@/features/sales/DocumentHistory'
import { AccessContext } from '@/app/AccessContext'
import { createServices } from '@/services'
import { catalogAdapter } from '@/services/adapters/catalog'
import { exampleDocument } from '@/features/sales/example'
import type { DocumentKind, UserRole } from '@/lib/domain'
import { AppError } from '@/lib/errors'

vi.mock('@/services/useServices', () => ({ useServices: () => services }))
const { downloadPeriodPdf } = vi.hoisted(() => ({ downloadPeriodPdf: vi.fn() }))
vi.mock('@/features/sales/pdf', () => ({
  downloadDocumentPdf: vi.fn(),
  downloadPeriodPdf,
}))
const services = createServices(catalogAdapter)
const invoice = { ...exampleDocument('invoice'), id: 'doc-1', number: 'FAC-000007', location: 'store' as const }
const listDocuments = vi.fn()
const exportDocuments = vi.fn()
const deleteInvoice = vi.fn()
services.salesService.listDocuments = listDocuments
services.salesService.exportDocuments = exportDocuments
services.salesService.deleteInvoice = deleteInvoice
const page = (documents: (typeof invoice)[], total = documents.length) => ({
  documents,
  total,
})

beforeEach(() => {
  listDocuments.mockReset().mockResolvedValue(page([invoice]))
  exportDocuments.mockReset().mockResolvedValue([invoice])
  downloadPeriodPdf.mockReset().mockResolvedValue(undefined)
  deleteInvoice.mockReset().mockResolvedValue('FAC-000007')
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
})

function renderHistory(role: UserRole, kind: DocumentKind = 'invoice', demo = false) {
  return render(
    <AccessContext.Provider value={{ demo, base: '', role }}>
      <MemoryRouter>
        <DocumentHistory kind={kind} />
      </MemoryRouter>
    </AccessContext.Provider>,
  )
}

it('Administración elimina una factura tras confirmar, con motivo, y la lista se recarga', async () => {
  const user = userEvent.setup()
  renderHistory('admin')
  await user.click(await screen.findByRole('button', { name: 'Eliminar factura FAC-000007' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText(/vuelven al inventario de/)).toBeInTheDocument()
  await user.type(within(dialog).getByLabelText('Motivo (opcional)'), 'Venta duplicada')
  await user.click(within(dialog).getByRole('button', { name: 'Eliminar factura' }))
  await waitFor(() => expect(deleteInvoice).toHaveBeenCalledWith('doc-1', 'Venta duplicada'))
  expect(await screen.findByText(/Factura FAC-000007 eliminada/)).toBeInTheDocument()
  await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(2))
})

it('muestra el error dentro del diálogo y no lo cierra', async () => {
  deleteInvoice.mockRejectedValueOnce(new AppError('validation', 'Falta el conteo de Tienda.'))
  const user = userEvent.setup()
  renderHistory('admin')
  await user.click(await screen.findByRole('button', { name: 'Eliminar factura FAC-000007' }))
  const dialog = await screen.findByRole('dialog')
  await user.click(within(dialog).getByRole('button', { name: 'Eliminar factura' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Falta el conteo de Tienda.')
})

it('Ventas, las proformas y la demostración no ven el botón', async () => {
  const { unmount } = renderHistory('operator')
  await screen.findByText('FAC-000007')
  expect(screen.queryByRole('button', { name: /Eliminar/ })).toBeNull()
  unmount()
  const second = renderHistory('admin', 'proforma')
  await screen.findByText('FAC-000007')
  expect(screen.queryByRole('button', { name: /Eliminar/ })).toBeNull()
  second.unmount()
  renderHistory('admin', 'invoice', true)
  await screen.findByText('FAC-000007')
  expect(screen.queryByRole('button', { name: /Eliminar/ })).toBeNull()
})

it('al abrir un documento lleva la vista y el foco a sus acciones', async () => {
  const scroll = vi.fn()
  Element.prototype.scrollIntoView = scroll
  const user = userEvent.setup()
  renderHistory('operator')
  await user.click(await screen.findByRole('button', { name: /Ver documento/ }))
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Imprimir (carta o A4)' }),
    ).toHaveFocus(),
  )
  expect(scroll).toHaveBeenCalled()
  // La hoja desplazable del teléfono se puede recorrer con el teclado.
  expect(
    screen.getByRole('region', { name: 'Documento FAC-000007' }),
  ).toHaveAttribute('tabindex', '0')
})

it('busca sin distinguir tildes y cuenta las coincidencias', async () => {
  listDocuments.mockResolvedValue(
    page([
      { ...invoice, customerName: 'María López' },
      { ...invoice, id: 'doc-2', number: 'FAC-000008', customerName: 'José Pérez' },
    ]),
  )
  const user = userEvent.setup()
  renderHistory('operator')
  await screen.findByText('FAC-000008')
  await user.type(
    screen.getByLabelText('Buscar por número o cliente'),
    'maria lopez',
  )
  expect(screen.getByText('FAC-000007')).toBeInTheDocument()
  expect(screen.queryByText('FAC-000008')).not.toBeInTheDocument()
  expect(screen.getByText('Coinciden 1 de 2 facturas')).toBeInTheDocument()
})

describe('periodo del historial', () => {
  // Mediodía del 26 de septiembre en Managua. Sólo se finge la fecha: los
  // temporizadores reales siguen andando para userEvent y waitFor.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-26T18:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('abre en «Este mes» y los atajos y las fechas cambian la consulta', async () => {
    const user = userEvent.setup()
    renderHistory('operator')
    await screen.findByText('FAC-000007')
    expect(listDocuments).toHaveBeenLastCalledWith('invoice', {
      range: { from: '2026-09-01', to: '2026-09-26' },
    })
    expect(screen.getByRole('button', { name: 'Este mes' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByText('1 factura en el período')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Mes pasado' }))
    await waitFor(() =>
      expect(listDocuments).toHaveBeenLastCalledWith('invoice', {
        range: { from: '2026-08-01', to: '2026-08-31' },
      }),
    )
    fireEvent.change(screen.getByLabelText('Desde'), {
      target: { value: '2026-08-15' },
    })
    await waitFor(() =>
      expect(listDocuments).toHaveBeenLastCalledWith('invoice', {
        range: { from: '2026-08-15', to: '2026-08-31' },
      }),
    )
    // Con fechas a mano ningún atajo queda marcado.
    expect(screen.getByRole('button', { name: 'Mes pasado' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('un periodo sin documentos lo dice en lugar de mostrar una lista vacía', async () => {
    listDocuments.mockResolvedValue(page([]))
    renderHistory('operator')
    expect(
      await screen.findByText('Sin facturas en este período'),
    ).toBeInTheDocument()
  })

  it('«Cargar más» trae la siguiente página sin repetir documentos', async () => {
    const second = { ...invoice, id: 'doc-2', number: 'FAC-000006' }
    const third = { ...invoice, id: 'doc-3', number: 'FAC-000005' }
    listDocuments
      .mockResolvedValueOnce(page([invoice], 3))
      // Se emitió otra factura entre una página y otra: la paginación se
      // corre y FAC-000007 vuelve a llegar.
      .mockResolvedValueOnce(page([invoice, second, third], 4))
    const user = userEvent.setup()
    renderHistory('operator')
    expect(await screen.findByText('1 de 3 facturas del período')).toBeInTheDocument()
    await user.click(
      screen.getByRole('button', { name: 'Cargar más (2 restantes)' }),
    )
    expect(listDocuments).toHaveBeenLastCalledWith('invoice', {
      range: { from: '2026-09-01', to: '2026-09-26' },
      offset: 1,
    })
    expect(await screen.findByText('FAC-000005')).toBeInTheDocument()
    expect(screen.getAllByText('FAC-000007')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /Cargar más/ })).toBeNull()
  })

  it('exporta a PDF las facturas del periodo elegido', async () => {
    const user = userEvent.setup()
    renderHistory('operator')
    await screen.findByText('FAC-000007')
    await user.click(screen.getByRole('button', { name: 'Exportar PDF del período' }))
    await waitFor(() =>
      expect(downloadPeriodPdf).toHaveBeenCalledWith(
        'invoice',
        { from: '2026-09-01', to: '2026-09-26' },
        [invoice],
        expect.any(Function),
      ),
    )
    expect(exportDocuments).toHaveBeenCalledWith('invoice', {
      from: '2026-09-01',
      to: '2026-09-26',
    })
    expect(await screen.findByRole('status')).toHaveTextContent(
      'PDF listo: 1 factura del 01/09/2026 al 26/09/2026.',
    )
    expect(screen.queryByRole('button', { name: /Excel/ })).toBeNull()
  })

  it('avisa si no hay nada que exportar o si el periodo pasa del tope', async () => {
    exportDocuments.mockResolvedValueOnce([])
    const user = userEvent.setup()
    renderHistory('operator')
    await screen.findByText('FAC-000007')
    const button = screen.getByRole('button', { name: 'Exportar PDF del período' })
    await user.click(button)
    expect(await screen.findByRole('status')).toHaveTextContent(
      'No hay facturas emitidas del 01/09/2026 al 26/09/2026.',
    )
    exportDocuments.mockRejectedValueOnce(
      new AppError('validation', 'El período tiene 1.234 facturas y el PDF admite hasta 1.000.'),
    )
    await user.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent('admite hasta')
    expect(downloadPeriodPdf).not.toHaveBeenCalled()
  })

  it('la vista local no ofrece exportar', async () => {
    renderHistory('admin', 'invoice', true)
    await screen.findByText('FAC-000007')
    expect(
      screen.queryByRole('button', { name: 'Exportar PDF del período' }),
    ).toBeNull()
  })
})

import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocumentHistory } from '@/features/sales/DocumentHistory'
import { AccessContext } from '@/app/AccessContext'
import { createServices } from '@/services'
import { catalogAdapter } from '@/services/adapters/catalog'
import { exampleDocument } from '@/features/sales/example'
import type { DocumentKind, UserRole } from '@/lib/domain'
import { AppError } from '@/lib/errors'

vi.mock('@/services/useServices', () => ({ useServices: () => services }))
const services = createServices(catalogAdapter)
const invoice = { ...exampleDocument('invoice'), id: 'doc-1', number: 'FAC-000007', location: 'store' as const }
const listDocuments = vi.fn()
const deleteInvoice = vi.fn()
services.salesService.listDocuments = listDocuments
services.salesService.deleteInvoice = deleteInvoice

beforeEach(() => {
  listDocuments.mockReset().mockResolvedValue([invoice])
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
  listDocuments.mockResolvedValue([
    { ...invoice, customerName: 'María López' },
    { ...invoice, id: 'doc-2', number: 'FAC-000008', customerName: 'José Pérez' },
  ])
  const user = userEvent.setup()
  renderHistory('operator')
  await screen.findByText('FAC-000008')
  await user.type(
    screen.getByLabelText('Buscar por número o cliente'),
    'maria lopez',
  )
  expect(screen.getByText('FAC-000007')).toBeInTheDocument()
  expect(screen.queryByText('FAC-000008')).not.toBeInTheDocument()
  expect(screen.getByText('1 de 2 documentos recientes')).toBeInTheDocument()
})

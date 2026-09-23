import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { ContactsPage } from '@/features/contacts/ContactsPage'
import { AccessContext } from '@/app/AccessContext'
import type { ContactRecord } from '@/services/workspace'
import { AppError } from '@/lib/errors'
const { listContacts, saveContact, deleteContact } = vi.hoisted(() => ({
  listContacts: vi.fn(),
  saveContact: vi.fn(),
  deleteContact: vi.fn(),
}))
vi.mock('@/services/workspace', () => ({
  listContacts,
  saveContact,
  deleteContact,
}))
beforeEach(() => {
  listContacts.mockReset()
  saveContact.mockReset()
  deleteContact.mockReset()
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
})
it('registers a customer, normalizes the local phone and edits the returned database revision', async () => {
  let rows: ContactRecord[] = []
  listContacts.mockImplementation(async () => rows)
  saveContact.mockImplementation(async (_kind, record) => {
    rows = [{ ...record, revision: record.revision + 1 }]
    return record.id
  })
  render(
    <AccessContext.Provider value={{ demo: false, base: '', role: 'admin' }}>
      <ContactsPage kind="customers" />
    </AccessContext.Provider>,
  )
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Nuevo cliente' }))
  await user.type(screen.getByLabelText('Nombre'), 'Cliente de prueba')
  await user.type(screen.getByLabelText('Teléfono / WhatsApp'), '8888 1111')
  await user.type(screen.getByLabelText('RUC'), 'RUC-PRUEBA')
  await user.click(screen.getByRole('button', { name: 'Guardar' }))
  await screen.findByRole('heading', { name: 'Cliente de prueba' })
  expect(saveContact.mock.calls[0][1]).toMatchObject({
    phone: '50588881111',
    taxId: 'RUC-PRUEBA',
    revision: 0,
  })
  await user.click(
    screen.getByRole('button', { name: 'Editar Cliente de prueba' }),
  )
  expect(screen.getByRole('dialog', { name: 'Editar cliente' })).toBeVisible()
  expect(screen.getByLabelText('Nombre')).toHaveValue('Cliente de prueba')
  await user.type(screen.getByLabelText('Dirección'), 'Dirección de prueba')
  await user.click(screen.getByRole('button', { name: 'Guardar' }))
  await waitFor(() =>
    expect(saveContact.mock.calls[1][1]).toMatchObject({
      id: rows[0].id,
      revision: 1,
      address: 'Dirección de prueba',
    }),
  )
})
it('warehouse staff can read suppliers but cannot edit them or read customers', async () => {
  listContacts.mockResolvedValue([
    { id: '1', name: 'Proveedor de prueba', phone: '', active: true },
  ])
  const page = render(
    <AccessContext.Provider
      value={{ demo: false, base: '', role: 'warehouse' }}
    >
      <ContactsPage kind="suppliers" />
    </AccessContext.Provider>,
  )
  await screen.findByRole('heading', { name: 'Proveedor de prueba' })
  expect(
    screen.queryByRole('button', { name: 'Nuevo proveedor' }),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /^Editar/ }),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /^Eliminar/ }),
  ).not.toBeInTheDocument()
  page.rerender(
    <AccessContext.Provider
      value={{ demo: false, base: '', role: 'warehouse' }}
    >
      <ContactsPage kind="customers" />
    </AccessContext.Provider>,
  )
  expect(screen.getByRole('alert')).toHaveTextContent('no tiene acceso')
  expect(listContacts).toHaveBeenCalledTimes(1)
})

const customer: ContactRecord = {
  id: 'c1',
  revision: 3,
  name: 'Cliente con historial',
  phone: '',
  email: '',
  taxId: '',
  address: '',
  notes: '',
  active: true,
  priceTier: 'emprendedor',
}
function mountAs(role: 'admin' | 'operator', kind: 'customers' | 'suppliers') {
  return render(
    <AccessContext.Provider value={{ demo: false, base: '', role }}>
      <ContactsPage kind={kind} />
    </AccessContext.Provider>,
  )
}
it('asks for confirmation before deleting and can be cancelled', async () => {
  listContacts.mockResolvedValue([customer])
  mountAs('admin', 'customers')
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', {
      name: 'Eliminar Cliente con historial',
    }),
  )
  const dialog = screen.getByRole('dialog', { name: 'Eliminar cliente' })
  expect(dialog).toHaveTextContent('se archivará')
  await user.click(screen.getByRole('button', { name: 'Cancelar' }))
  expect(deleteContact).not.toHaveBeenCalled()
  expect(
    screen.queryByRole('dialog', { name: 'Eliminar cliente' }),
  ).not.toBeInTheDocument()
})
it('reports that a customer with documents was archived', async () => {
  listContacts.mockResolvedValue([customer])
  deleteContact.mockResolvedValue('archived')
  mountAs('admin', 'customers')
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', {
      name: 'Eliminar Cliente con historial',
    }),
  )
  await user.click(screen.getByRole('button', { name: 'Eliminar' }))
  expect(deleteContact).toHaveBeenCalledWith('customers', customer)
  expect(await screen.findByText(/se archivó para conservar/)).toBeVisible()
  expect(listContacts).toHaveBeenCalledTimes(2)
})
it('keeps the confirmation open with the server error', async () => {
  listContacts.mockResolvedValue([{ ...customer, name: 'Proveedor X' }])
  deleteContact.mockRejectedValue(
    new AppError('validation', 'Otro usuario modificó este proveedor.'),
  )
  mountAs('admin', 'suppliers')
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', { name: 'Eliminar Proveedor X' }),
  )
  await user.click(screen.getByRole('button', { name: 'Eliminar' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Otro usuario')
  expect(
    screen.getByRole('dialog', { name: 'Eliminar proveedor' }),
  ).toBeVisible()
})
it('sales staff can edit customers but not delete them', async () => {
  listContacts.mockResolvedValue([customer])
  mountAs('operator', 'customers')
  expect(
    await screen.findByRole('button', { name: 'Editar Cliente con historial' }),
  ).toBeVisible()
  expect(
    screen.queryByRole('button', { name: /^Eliminar/ }),
  ).not.toBeInTheDocument()
})

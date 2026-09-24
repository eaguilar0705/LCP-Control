import {
  Users,
  Truck,
  Plus,
  Phone,
  Mail,
  MapPin,
  Pencil,
  Trash2,
} from 'lucide-react'
import {
  WorkspaceHeading,
  WorkspaceEmpty,
} from '../../components/WorkspacePresentation'
import { priceTierLabels } from '../../lib/pricing'
import type { PriceTier } from '../../lib/domain'
import { useCallback, useState, type FormEvent } from 'react'
import {
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  Input,
  Select,
  LoadingState,
  ErrorState,
} from '../../components/ui'
import { useQuery } from '../../lib/useQuery'
import { useAccess } from '../../app/AccessContext'
import { can } from '../../lib/permissions'
import { AppError, errorMessage } from '../../lib/errors'
import {
  deleteContact,
  listContacts,
  saveContact,
  type ContactRecord,
} from '../../services/workspace'
import { whatsappNumber } from '../sales/whatsapp'
import { matchesSearch } from '../../lib/search'
const empty: ContactRecord = {
  id: '',
  revision: 0,
  name: '',
  phone: '',
  email: '',
  taxId: '',
  address: '',
  notes: '',
  active: true,
  contact: '',
  brands: '',
  terms: '',
  priceTier: 'emprendedor',
}
type Kind = 'customers' | 'suppliers'
export function ContactsPage({ kind }: { kind: Kind }) {
  const { demo, role } = useAccess()
  const supplier = kind === 'suppliers'
  const permitted = can(role, supplier ? 'supplier.read' : 'customer.read')
  const load = useCallback(
    () => (demo || !permitted ? Promise.resolve([]) : listContacts(kind)),
    [demo, kind, permitted],
  )
  const { data, loading, error, retry } = useQuery(load)
  const [form, setForm] = useState<ContactRecord | null>(null)
  const [formError, setFormError] = useState('')
  const [removing, setRemoving] = useState<ContactRecord | null>(null)
  const [removeError, setRemoveError] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('active')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  if (!permitted && !demo)
    return <ErrorState message="Tu cuenta no tiene acceso a este registro." />
  const noun = supplier ? 'proveedor' : 'cliente'
  const editable =
    !demo && can(role, supplier ? 'supplier.manage' : 'customer.manage')
  const removable =
    !demo && can(role, supplier ? 'supplier.delete' : 'customer.delete')
  function openForm(record: ContactRecord) {
    setForm({ ...empty, ...record })
    setFormError('')
    setMessage('')
  }
  function closeForm() {
    if (!busy) setForm(null)
  }
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!form || busy) return
    setBusy(true)
    setFormError('')
    try {
      const phone = supplier ? form.phone : whatsappNumber(form.phone)
      if (!supplier && form.phone && !phone)
        throw new AppError('validation', 'Revisa el teléfono del cliente.')
      await saveContact(kind, {
        ...form,
        name: form.name.trim(),
        email: form.email.trim(),
        id: form.id || crypto.randomUUID(),
        phone: phone ?? '',
      })
      setForm(null)
      retry()
      setMessage(
        form.id
          ? `Datos de ${form.name.trim()} actualizados.`
          : `${supplier ? 'Proveedor' : 'Cliente'} registrado.`,
      )
    } catch (e) {
      // El error se muestra dentro del formulario: sigue abierto con los datos.
      setFormError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  async function confirmRemove() {
    if (!removing || busy) return
    setBusy(true)
    setRemoveError('')
    try {
      const outcome = await deleteContact(kind, removing)
      setRemoving(null)
      retry()
      setMessage(
        outcome === 'archived'
          ? `${removing.name} tiene facturas o proformas: se archivó para conservar el historial.`
          : `${removing.name} se eliminó.`,
      )
    } catch (e) {
      setRemoveError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const visible = (data ?? []).filter(
    (r) =>
      (status === 'all' || r.active === (status === 'active')) &&
      matchesSearch(
        `${r.name} ${r.phone} ${r.email} ${r.taxId ?? ''} ${r.contact ?? ''} ${r.brands ?? ''}`,
        search,
      ),
  )
  return (
    <>
      <WorkspaceHeading
        eyebrow="RELACIONES DEL NEGOCIO"
        title={supplier ? 'Proveedores' : 'Clientes'}
        description={
          supplier
            ? 'Contactos, marcas y acuerdos, siempre a la mano.'
            : 'Conoce a tus clientes y ten sus datos listos para cada venta.'
        }
        icon={supplier ? Truck : Users}
      >
        {editable && (
          <Button type="button" onClick={() => openForm(empty)}>
            <Plus size={17} />
            Nuevo {noun}
          </Button>
        )}
      </WorkspaceHeading>
      {message && (
        <p role="status" className="workspace-feedback">
          {message}
        </p>
      )}
      {loading && <LoadingState />}
      {error && <ErrorState message={error} retry={retry} />}
      <Dialog
        open={!!form}
        className="record-dialog"
        title={
          form?.id
            ? `Editar ${noun}`
            : supplier
              ? 'Nuevo proveedor'
              : 'Nuevo cliente'
        }
        onClose={closeForm}
      >
        {form && (
          <ContactForm
            form={form}
            supplier={supplier}
            busy={busy}
            error={formError}
            canSetTier={can(role, 'product.manage')}
            canArchive={can(role, 'product.manage')}
            onChange={setForm}
            onSubmit={submit}
            onCancel={closeForm}
          />
        )}
      </Dialog>
      <ConfirmDialog
        open={!!removing}
        title={`Eliminar ${noun}`}
        confirmLabel="Eliminar"
        busyLabel="Eliminando…"
        busy={busy}
        error={removeError}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setRemoving(null)}
      >
        {removing && (
          <>
            <p>
              ¿Eliminar a <strong>{removing.name}</strong>? Esta acción no se
              puede deshacer.
            </p>
            <p className="muted">
              {supplier
                ? 'Las compras ya registradas conservan el nombre del proveedor.'
                : 'Si tiene facturas o proformas, se archivará en lugar de eliminarse para conservar esos documentos.'}
            </p>
          </>
        )}
      </ConfirmDialog>
      <div className="directory-toolbar">
        <Input
          label="Buscar"
          type="search"
          placeholder={
            supplier
              ? 'Nombre, contacto, marca o teléfono del proveedor'
              : 'Nombre, RUC, correo o teléfono del cliente'
          }
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          label="Mostrar"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="active">Activos</option>
          <option value="all">Todos</option>
          <option value="archived">Archivados</option>
        </Select>
        <span className="directory-count">
          {visible.length} {supplier ? 'proveedores' : 'clientes'}
        </span>
      </div>
      <div className="record-grid">
        {visible.map((r) => (
          <Card key={r.id} className="record-card contact-card">
            <div className="record-card-top">
              <span className="record-avatar">
                {r.name.trim().slice(0, 2).toLocaleUpperCase('es')}
              </span>
              <span className={`record-badge ${r.active ? '' : 'is-muted'}`}>
                {r.active ? 'Activo' : 'Archivado'}
              </span>
            </div>
            <h2>{r.name}</h2>
            {!supplier && (
              <span className="contact-tier">
                Lista {priceTierLabels[r.priceTier as PriceTier] ?? r.priceTier}
              </span>
            )}
            <div className="contact-details">
              <p>
                <Phone size={14} />
                {r.phone || 'Sin teléfono'}
              </p>
              {r.email && (
                <p>
                  <Mail size={14} />
                  {r.email}
                </p>
              )}
              {r.address && (
                <p>
                  <MapPin size={14} />
                  {r.address}
                </p>
              )}
            </div>
            {(r.taxId || r.contact || r.brands || r.terms || r.notes) && (
              <dl className="record-details">
                {[
                  ['RUC', r.taxId],
                  ['Contacto', r.contact],
                  ['Marcas', r.brands],
                  ['Condiciones', r.terms],
                  ['Notas', r.notes],
                ]
                  .filter(([, v]) => v)
                  .map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
              </dl>
            )}
            {(editable || removable) && (
              <div className="record-card-footer">
                {editable && (
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={`Editar ${r.name}`}
                    onClick={() => openForm(r)}
                  >
                    <Pencil size={14} />
                    Editar
                  </Button>
                )}
                {removable && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="record-delete"
                    aria-label={`Eliminar ${r.name}`}
                    onClick={() => {
                      setRemoveError('')
                      setMessage('')
                      setRemoving(r)
                    }}
                  >
                    <Trash2 size={14} />
                    Eliminar
                  </Button>
                )}
              </div>
            )}
          </Card>
        ))}
      </div>
      {!loading && !error && visible.length === 0 && (
        <WorkspaceEmpty
          icon={supplier ? Truck : Users}
          title={
            data?.length
              ? 'Sin coincidencias'
              : supplier
                ? 'Tus proveedores, en un solo lugar'
                : 'Aquí empieza la relación con tus clientes'
          }
          description={
            data?.length
              ? 'Prueba otra búsqueda o cambia el estado seleccionado.'
              : supplier
                ? 'Registra tu primer proveedor para guardar sus contactos y condiciones.'
                : 'Registra tu primer cliente y selecciónalo al preparar una factura o proforma.'
          }
        />
      )}
    </>
  )
}

const fields: [keyof ContactRecord, string, number, boolean][] = [
  ['name', 'Nombre', 160, false],
  ['phone', 'Teléfono / WhatsApp', 60, false],
  ['email', 'Correo', 254, false],
  ['taxId', 'RUC', 80, false],
  ['address', 'Dirección', 600, false],
  ['contact', 'Contacto', 160, true],
  ['brands', 'Marcas', 500, true],
  ['terms', 'Condiciones', 500, true],
  ['notes', 'Notas', 1500, false],
]

function ContactForm({
  form,
  supplier,
  busy,
  error,
  canSetTier,
  canArchive,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: ContactRecord
  supplier: boolean
  busy: boolean
  error: string
  canSetTier: boolean
  canArchive: boolean
  onChange: (next: ContactRecord) => void
  onSubmit: (event: FormEvent) => void
  onCancel: () => void
}) {
  return (
    <form onSubmit={onSubmit} className="record-form">
      <fieldset disabled={busy} className="form-grid">
        {fields
          .filter(([, , , supplierOnly]) => supplier || !supplierOnly)
          .map(([key, label, max]) => (
            <Input
              key={key}
              label={label}
              required={key === 'name'}
              autoFocus={key === 'name'}
              type={
                key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'
              }
              maxLength={max}
              value={String(form[key] ?? '')}
              onChange={(e) => onChange({ ...form, [key]: e.target.value })}
            />
          ))}
        {!supplier && (
          <Select
            label="Lista de precios"
            value={form.priceTier}
            disabled={!canSetTier}
            title={
              canSetTier ? undefined : 'Solo un administrador cambia la lista'
            }
            onChange={(e) => onChange({ ...form, priceTier: e.target.value })}
          >
            <option value="emprendedor">Emprendedor</option>
            <option value="vip">VIP</option>
            <option value="premium">Premium</option>
          </Select>
        )}
        {canArchive && (
          <Select
            label="Estado"
            value={String(form.active)}
            onChange={(e) =>
              onChange({ ...form, active: e.target.value === 'true' })
            }
          >
            <option value="true">Activo</option>
            <option value="false">Archivado</option>
          </Select>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <div className="form-actions">
        <Button disabled={busy} aria-busy={busy} type="submit">
          {busy ? 'Guardando…' : 'Guardar'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancelar
        </Button>
      </div>
    </form>
  )
}

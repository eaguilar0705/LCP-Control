import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Plus, Pencil, Trash2, Truck } from 'lucide-react'
import {
  Button,
  Card,
  ConfirmDialog,
  Input,
  EmptyState,
} from '../../components/ui'
import { useLocalDrafts } from '../../lib/localDrafts'
import { useAccess } from '../../app/AccessContext'
import { ContactsPage } from '../contacts/ContactsPage'
import { matchesSearch } from '../../lib/search'
const supplierSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(160),
  contact: z.string().max(160),
  phone: z.string().max(60),
  email: z.union([z.email(), z.literal('')]),
  taxId: z.string().max(80),
  address: z.string().max(600),
  brands: z.string().max(500),
  terms: z.string().max(500),
  notes: z.string().max(1500),
})
type SupplierDraft = z.infer<typeof supplierSchema>
const blank = {
  id: '',
  name: '',
  contact: '',
  phone: '',
  email: '',
  taxId: '',
  address: '',
  brands: '',
  terms: '',
  notes: '',
}
export function SuppliersPage() {
  return useAccess().demo ? (
    <LocalSuppliersPage />
  ) : (
    <ContactsPage kind="suppliers" />
  )
}
function LocalSuppliersPage() {
  const { items, save, error } = useLocalDrafts(
    'lcp.suppliers.v1',
    supplierSchema,
  )
  const [form, setForm] = useState<SupplierDraft>(blank)
  const [editing, setEditing] = useState(false)
  const [search, setSearch] = useState('')
  const [message, setMessage] = useState('')
  const [removing, setRemoving] = useState<SupplierDraft | null>(null)
  function remove() {
    if (!removing) return
    if (save(items.filter((item) => item.id !== removing.id))) {
      setMessage(`${removing.name} se eliminó de este navegador.`)
      if (form.id === removing.id) {
        setForm(blank)
        setEditing(false)
      }
      setRemoving(null)
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    const result = supplierSchema.safeParse({
      ...form,
      name: form.name.trim(),
      email: form.email.trim(),
      id: form.id || crypto.randomUUID(),
    })
    if (!result.success) {
      setMessage('Revisa el nombre y el correo del proveedor.')
      return
    }
    if (
      save([result.data, ...items.filter((item) => item.id !== result.data.id)])
    ) {
      setForm(blank)
      setEditing(false)
      setMessage('Proveedor guardado en este navegador.')
    }
  }
  const filtered = items.filter((item) =>
    matchesSearch(`${item.name} ${item.contact} ${item.brands}`, search),
  )
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Proveedores</h1>
          <p className="muted">Contactos, marcas y condiciones de compra.</p>
        </div>
        <Button
          type="button"
          onClick={() => {
            setForm(blank)
            setEditing(true)
            setMessage('')
          }}
        >
          <Plus size={18} />
          Nuevo proveedor
        </Button>
      </div>
      <p className="workspace-disclaimer">
        Este registro se guarda en este navegador. No se comparte con otros
        equipos.
      </p>
      {message && (
        <p className="page-feedback" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <Card className="form-card">
          <h2>{form.id ? 'Editar proveedor' : 'Datos del proveedor'}</h2>
          <form onSubmit={submit}>
            <div className="form-grid">
              {(
                [
                  ['name', 'Empresa o nombre', true],
                  ['contact', 'Persona de contacto', false],
                  ['phone', 'Teléfono / WhatsApp', false],
                  ['email', 'Correo electrónico', false],
                  ['taxId', 'RUC / Identificación fiscal', false],
                  ['address', 'Dirección', false],
                  ['brands', 'Marcas que distribuye', false],
                  ['terms', 'Condiciones de pago y entrega', false],
                ] as const
              ).map(([key, label, required]) => (
                <Input
                  key={key}
                  label={label}
                  required={required}
                  type={
                    key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'
                  }
                  maxLength={
                    key === 'address'
                      ? 600
                      : key === 'brands' || key === 'terms'
                        ? 500
                        : key === 'phone'
                          ? 60
                          : key === 'taxId'
                            ? 80
                            : 160
                  }
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                />
              ))}
              <label className="field full-width">
                <span>Notas</span>
                <textarea
                  rows={3}
                  maxLength={1500}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
              </label>
            </div>
            <div className="form-actions">
              <Button type="submit">Guardar proveedor</Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setEditing(false)}
              >
                Cancelar
              </Button>
            </div>
          </form>
        </Card>
      )}
      <div className="list-search">
        <Input
          label="Buscar proveedor"
          type="search"
          placeholder="Empresa, contacto o marca"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {filtered.length ? (
        <div className="supplier-grid">
          {filtered.map((item) => (
            <Card className="supplier-card" key={item.id}>
              <div className="section-heading">
                <Truck size={23} />
                <div className="record-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    className="supplier-edit"
                    aria-label={`Editar ${item.name}`}
                    onClick={() => {
                      setForm(item)
                      setEditing(true)
                      setMessage('')
                    }}
                  >
                    <Pencil size={16} />
                    Editar
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="record-delete"
                    aria-label={`Eliminar ${item.name}`}
                    onClick={() => {
                      setMessage('')
                      setRemoving(item)
                    }}
                  >
                    <Trash2 size={16} />
                    Eliminar
                  </Button>
                </div>
              </div>
              <h2>{item.name}</h2>
              <p>{item.contact || 'Contacto pendiente'}</p>
              <dl>
                {[
                  ['Teléfono', item.phone],
                  ['Correo', item.email],
                  ['RUC', item.taxId],
                  ['Dirección', item.address],
                  ['Marcas', item.brands],
                  ['Condiciones', item.terms],
                  ['Notas', item.notes],
                ].map(
                  ([label, value]) =>
                    value && (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ),
                )}
              </dl>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            title={search ? 'No hay coincidencias' : 'Aún no hay proveedores'}
            description="Registra el primer proveedor para tener sus datos a mano."
          />
        </Card>
      )}
      <ConfirmDialog
        open={!!removing}
        title="Eliminar proveedor"
        confirmLabel="Eliminar"
        onConfirm={remove}
        onCancel={() => setRemoving(null)}
      >
        <p>
          ¿Eliminar a <strong>{removing?.name}</strong> de este navegador? Esta
          acción no se puede deshacer.
        </p>
      </ConfirmDialog>
    </>
  )
}

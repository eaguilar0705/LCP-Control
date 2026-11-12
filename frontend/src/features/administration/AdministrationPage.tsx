import { useAuth } from '../auth/AuthContext'
import {
  UsersRound,
  ShieldCheck,
  Store,
  UserPlus,
  Pencil,
  Coins,
  Trash2,
} from 'lucide-react'
import {
  WorkspaceHeading,
  WorkspaceEmpty,
} from '../../components/WorkspacePresentation'
import { Brand } from '../../components/Brand'
import { useState, useCallback, useRef, type FormEvent } from 'react'
import {
  ConfirmDialog,
  Dialog,
  Button,
  Card,
  Input,
  Select,
  ErrorState,
  LoadingState,
} from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { can, roleLabels } from '../../lib/permissions'
import { useQuery } from '../../lib/useQuery'
import { errorMessage } from '../../lib/errors'
import { formatDate } from '../../lib/format'
import {
  accountingExchangeRate,
  inventoryExchangeRate,
} from '../../lib/exchangeRates'
import { refreshQueries } from '../../lib/queryRefresh'
import {
  listStaff,
  deleteStaff,
  saveStaff,
  rpc,
  type StaffAccount,
} from '../../services/workspace'
import { useServices } from '../../services/useServices'
import type { UserRole } from '../../lib/domain'
import { BusinessImport } from './BusinessImport'
export function StaffPage() {
  const { user } = useAuth()
  const [removing, setRemoving] = useState<StaffAccount | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const { demo, role } = useAccess()
  const permitted = !demo && can(role, 'staff.manage')
  const load = useCallback(
    () => (permitted ? listStaff() : Promise.resolve([])),
    [permitted],
  )
  const { data, error, loading, retry } = useQuery(load)
  const [form, setForm] = useState<StaffAccount | null>(null)
  const [originalStaff, setOriginalStaff] = useState<StaffAccount | null>(null)
  const [reloadStaff, setReloadStaff] = useState(false)
  const [editingEmail, setEditingEmail] = useState(false)
  const [message, setMessage] = useState('')
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  // El formulario se dibuja arriba de la lista: al abrirlo desde una tarjeta
  // de más abajo quedaba fuera de la pantalla. Se lleva a la vista y el foco
  // entra en el primer campo que se puede escribir.
  const formRef = useRef<HTMLDivElement>(null)
  function openStaffForm(record: StaffAccount, editing: boolean) {
    setEditingEmail(editing)
    setForm(record)
    setOriginalStaff(editing ? record : null)
    setFormError('')
    setMessage('')
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      formRef.current
        ?.querySelector<HTMLInputElement>('input:not(:disabled)')
        ?.focus({ preventScroll: true })
    })
  }
  if (!permitted && !demo)
    return (
      <ErrorState message="Solo los administradores pueden gestionar usuarios." />
    )
  async function removeAccount(e: FormEvent) {
    e.preventDefault()
    if (
      !removing ||
      busy ||
      confirmation.trim().toLowerCase() !== removing.email.toLowerCase()
    )
      return
    setBusy(true)
    setDeleteError('')
    try {
      await deleteStaff(removing)
      if (form?.email === removing.email) setForm(null)
      setMessage(`Cuenta de ${removing.display_name} eliminada.`)
      setRemoving(null)
      retry()
    } catch (error) {
      setDeleteError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!form || busy || !permitted) return
    setBusy(true)
    setFormError('')
    try {
      await saveStaff(form, originalStaff)
      setForm(null)
      retry()
      setMessage(
        'Acceso guardado. Las cuentas nuevas se activan desde la pantalla de acceso.',
      )
    } catch (e) {
      // El error queda dentro del formulario, con sus datos, y se anuncia
      // como error: antes salía arriba con el mismo aspecto que un «guardado».
      setFormError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  async function refreshStaffForm() {
    if (!form || busy) return
    setBusy(true)
    setFormError('')
    try {
      const latest = (await listStaff()).find(
        (record) => record.email.toLowerCase() === form.email.toLowerCase(),
      )
      if (latest) {
        setForm(latest)
        setOriginalStaff(latest)
        setEditingEmail(true)
      } else {
        setForm(null)
        setMessage(
          'La cuenta ya no existe. Puedes autorizarla de nuevo si corresponde.',
        )
      }
      setReloadStaff(false)
      retry()
    } catch (error) {
      setFormError(errorMessage(error))
      setReloadStaff(false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <WorkspaceHeading
        eyebrow="EQUIPO DE LA TIENDA"
        title="Usuarios y permisos"

        icon={UsersRound}
      >
        <Button
          type="button"
          disabled={demo || busy}
          onClick={() =>
            openStaffForm(
              {
                email: '',
                display_name: '',
                role: 'operator',
                active: true,
                registered: false,
              },
              false,
            )
          }
        >
          <UserPlus size={17} /> Autorizar correo
        </Button>
      </WorkspaceHeading>
      {message && (
        <p role="status" className="workspace-feedback">
          {message}
        </p>
      )}
      {loading && <LoadingState />}
      {error && <ErrorState message={error} retry={retry} />}
      <div ref={formRef}>
        {form && (
          <Card className="form-card record-form">
            <div className="section-heading">
              <div>
                <span className="section-kicker">ACCESO DEL PERSONAL</span>
                <h2>
                  {editingEmail ? 'Editar permisos' : 'Autorizar una cuenta'}
                </h2>
              </div>
            </div>
            <form onSubmit={submit}>
              <fieldset className="journal-entry-fields" disabled={busy}>
                <div className="form-grid">
                  <Input
                    label="Correo"
                    type="email"
                    required
                    value={form.email}
                    disabled={editingEmail}
                    onChange={(e) =>
                      setForm({ ...form, email: e.target.value })
                    }
                  />
                  <Input
                    label="Nombre"
                    required
                    maxLength={100}
                    value={form.display_name}
                    onChange={(e) =>
                      setForm({ ...form, display_name: e.target.value })
                    }
                  />
                  <Select
                    label="Permisos"
                    value={form.role}
                    onChange={(e) =>
                      setForm({ ...form, role: e.target.value as UserRole })
                    }
                  >
                    {Object.entries(roleLabels)
                      .filter(
                        ([r]) => r !== 'superadmin' || role === 'superadmin',
                      )
                      .map(([r, label]) => (
                        <option key={r} value={r}>
                          {label}
                        </option>
                      ))}
                  </Select>
                  <Select
                    label="Estado"
                    value={String(form.active)}
                    onChange={(e) =>
                      setForm({ ...form, active: e.target.value === 'true' })
                    }
                  >
                    <option value="true">Activo</option>
                    <option value="false">Deshabilitado</option>
                  </Select>
                </div>
              </fieldset>
              {formError && (
                <p role="alert" className="inline-error">
                  {formError}
                </p>
              )}
              <div className="form-actions">
                <Button type="submit" disabled={busy || demo} aria-busy={busy}>
                  {busy ? 'Guardando…' : 'Guardar'}
                </Button>
                {formError.startsWith('Otro administrador') && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setReloadStaff(true)}
                  >
                    Actualizar usuario
                  </Button>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setForm(null)
                    setFormError('')
                  }}
                >
                  Cancelar
                </Button>
              </div>
            </form>
          </Card>
        )}
      </div>
      <div className="record-grid">
        {data?.map((r) => (
          <Card key={r.email} className="record-card staff-card">
            <div className="record-card-top">
              <span className="record-avatar">
                <ShieldCheck size={22} />
              </span>
              <span
                className={`record-badge ${!r.active ? 'is-muted' : !r.registered ? 'is-pending' : ''}`}
              >
                {!r.active
                  ? 'Deshabilitado'
                  : r.registered
                    ? 'Activo'
                    : 'Por activar'}
              </span>
            </div>
            <h2>{r.display_name}</h2>
            <p className="record-email">{r.email}</p>
            <span className="role-pill">{roleLabels[r.role]}</span>
            {(r.role !== 'superadmin' || role === 'superadmin') && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => openStaffForm(r, true)}
              >
                <Pencil size={14} /> Editar permisos
              </Button>
            )}
            {(r.role !== 'superadmin' || role === 'superadmin') && (
              <Button
                type="button"
                variant="ghost"
                className="button-delete"
                disabled={
                  busy ||
                  demo ||
                  r.email.toLowerCase() === user?.email?.toLowerCase() ||
                  (r.registered && !r.user_id)
                }
                title={
                  r.email.toLowerCase() === user?.email?.toLowerCase()
                    ? 'No puedes eliminar tu propia cuenta'
                    : undefined
                }
                onClick={() => {
                  setRemoving(r)
                  setConfirmation('')
                  setDeleteError('')
                }}
              >
                <Trash2 size={15} /> Eliminar usuario
              </Button>
            )}
          </Card>
        ))}
      </div>
      <ConfirmDialog
        open={reloadStaff}
        title="Actualizar usuario"
        confirmLabel="Cargar datos actuales"
        busy={busy}
        onConfirm={() => void refreshStaffForm()}
        onCancel={() => setReloadStaff(false)}
      >
        <p>
          Se cargarán los permisos y datos actuales. Los cambios que escribiste
          sin guardar se descartarán.
        </p>
      </ConfirmDialog>
      {!loading && !error && !data?.length && (
        <WorkspaceEmpty icon={UsersRound} title="Tu equipo comienza aquí" />
      )}
      <Dialog
        open={!!removing}
        title="Eliminar usuario"
        onClose={() => {
          if (!busy) setRemoving(null)
        }}
      >
        {removing && (
          <form onSubmit={removeAccount}>
            <p>
              Se eliminará{' '}
              {removing.registered
                ? 'la cuenta y su acceso al sistema'
                : 'la autorización de acceso'}{' '}
              de <strong>{removing.display_name}</strong>. Esta acción no se
              puede deshacer.
            </p>
            <p className="muted">
              Sus facturas, movimientos y fotografías del catálogo se
              conservarán.
            </p>
            <Input
              label="Escribe el correo para confirmar"
              type="email"
              autoComplete="off"
              required
              disabled={busy}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={removing.email}
            />
            {deleteError && (
              <p role="alert" className="error">
                {deleteError}
              </p>
            )}
            <div className="form-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => setRemoving(null)}
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                disabled={
                  busy ||
                  confirmation.trim().toLowerCase() !==
                    removing.email.toLowerCase()
                }
              >
                {busy ? 'Eliminando…' : 'Eliminar definitivamente'}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
      <div className="role-guide">
        {[
          ['Administración', 'Catálogo, ventas, inventario y equipo.'],
          ['Caja', 'Facturación y consulta de sus propias ventas.'],
          [
            'Inventario',
            'Salidas, daños, conteos y traslados; compras por Administración.',
          ],
          ['Solo consulta', 'Catálogo, fotografías y existencias.'],
        ].map(([title, detail]) => (
          <div key={title}>
            <strong>{title}</strong>
            <p>{detail}</p>
          </div>
        ))}
      </div>
    </>
  )
}
const businessProfileFields = [
  'name',
  'legalName',
  'taxId',
  'address',
  'phone',
  'email',
  'branch',
  'billingDetails',
] as const

export function BusinessPage() {
  const { demo, role } = useAccess()
  const { salesService } = useServices()
  const { data, error, loading, retry } = useQuery(salesService.getBusiness)
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)
  const [reloadBusiness, setReloadBusiness] = useState(false)
  const [importVersion, setImportVersion] = useState(0)
  if (!demo && !can(role, 'settings.manage'))
    return (
      <ErrorState message="Solo los administradores pueden configurar el negocio." />
    )
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (demo || busy || !can(role, 'settings.manage')) return
    const f = new FormData(e.currentTarget)
    setBusy(true)
    setMessage('')
    setFailure('')
    try {
      await rpc('save_business_profile_checked', {
        p_expected: Object.fromEntries(
          businessProfileFields.map((field) => [field, data?.[field] ?? '']),
        ),
        p_payload: Object.fromEntries(
          businessProfileFields.map((field) => [
            field,
            String(f.get(field) ?? '').trim(),
          ]),
        ),
      })
      setMessage('Datos del negocio guardados.')
      retry()
    } catch (e) {
      setFailure(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <WorkspaceHeading
        eyebrow="IDENTIDAD COMERCIAL"
        title="Datos del negocio"

        icon={Store}
      >
        <BusinessImport
          onImported={() => {
            retry()
            setImportVersion((version) => version + 1)
          }}
        />
      </WorkspaceHeading>
      {loading && <LoadingState />}
      {error && <ErrorState message={error} retry={retry} />}
      <div className="business-settings-layout">
        <Card className="business-identity">
          <Brand wordmark />
          <span className="section-kicker">LA CASA DEL PERFUME</span>
          <h2>El sello de tu negocio</h2>
        </Card>
        <Card className="form-card record-form">
          <div className="section-heading">
            <div>
              <span className="section-kicker">INFORMACIÓN GENERAL</span>
              <h2>Identidad y datos de facturación</h2>
            </div>
          </div>
          {data && (
            <form onSubmit={submit} key={JSON.stringify(data)}>
              <fieldset className="journal-entry-fields" disabled={busy}>
                <Input
                  label="Nombre comercial"
                  name="name"
                  required
                  maxLength={160}
                  defaultValue={data.name}
                />
                <Input
                  label="Razón social / Nombre del titular"
                  name="legalName"
                  required
                  maxLength={160}
                  defaultValue={data.legalName ?? ''}
                />
                <Input
                  label="RUC del negocio"
                  name="taxId"
                  required
                  maxLength={40}
                  defaultValue={data.taxId ?? ''}
                />
                <Input
                  label="Sucursal"
                  name="branch"
                  maxLength={100}
                  defaultValue={data.branch ?? ''}
                />
                <Input
                  label="Dirección"
                  name="address"
                  required
                  maxLength={600}
                  defaultValue={data.address}
                />
                <Input
                  label="Teléfono"
                  name="phone"
                  required
                  maxLength={60}
                  defaultValue={data.phone}
                />
                <Input
                  label="Correo del negocio"
                  name="email"
                  type="email"
                  maxLength={160}
                  defaultValue={data.email ?? ''}
                />
                <Input
                  label="Datos adicionales de facturación"
                  name="billingDetails"
                  maxLength={240}
                  defaultValue={data.billingDetails ?? ''}
                  placeholder="Serie, autorización u otros datos que correspondan al negocio"
                />
              </fieldset>
              <div className="form-actions">
                <Button type="submit" disabled={busy || demo} aria-busy={busy}>
                  {busy ? 'Guardando…' : 'Guardar'}
                </Button>
                {failure.startsWith('Otro administrador') && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setReloadBusiness(true)}
                  >
                    Actualizar datos
                  </Button>
                )}
              </div>
            </form>
          )}
          {message && (
            <p role="status" className="workspace-feedback">
              {message}
            </p>
          )}
          {failure && (
            <p role="alert" className="inline-error">
              {failure}
            </p>
          )}
        </Card>
        <ExchangeRateCard key={`catalog:${importVersion}`} purpose="catalog" />
        <ExchangeRateCard
          key={`inventory:${importVersion}`}
          purpose="inventory"
        />
        <ExchangeRateCard
          key={`accounting:${importVersion}`}
          purpose="accounting"
        />
      </div>
      <ConfirmDialog
        open={reloadBusiness}
        title="Actualizar datos del negocio"
        confirmLabel="Cargar datos actuales"
        onConfirm={() => {
          setReloadBusiness(false)
          setFailure('')
          retry()
        }}
        onCancel={() => setReloadBusiness(false)}
      >
        <p>
          Se cargarán los datos actuales del negocio. Los cambios que escribiste
          sin guardar se descartarán.
        </p>
      </ConfirmDialog>
    </>
  )
}

/** Cada tasa se guarda por separado; las operaciones emitidas conservan la suya. */
const rateCardOptions = {
  catalog: {
    title: 'Tipo de cambio de precios de venta',
    label: 'Córdobas por 1 dólar en precios de venta',
    updateLabel: 'Actualizar tasa de precios',
    defaultValue: '37',
    description:
      'Convierte los precios de venta de los perfumes y sus listas entre dólares y córdobas. Es independiente de la tasa de costos de inventario y de la contable.',
    message:
      'Tipo de cambio de precios de venta actualizado. Los precios del catálogo se recalcularon con la nueva tasa.',
    confirmation:
      'Se recalcularán los precios del catálogo con esta tasa y el redondeo al dólar superior. Las tasas de costos de inventario y de contabilidad, y las operaciones ya registradas, se conservan.',
  },
  inventory: {
    title: 'Tipo de cambio de costos de inventario',
    label: 'Córdobas por 1 dólar en costos de inventario',
    updateLabel: 'Actualizar tasa de costos',
    defaultValue: '36.6243',
    description:
      'Se propone para valorar nuevas compras, recepciones y costos iniciales del inventario en dólares. Los precios de venta utilizan su propia tasa.',
    message:
      'Tipo de cambio de costos de inventario actualizado para nuevas operaciones. Los precios de venta se conservan.',
    confirmation:
      'Se propondrá en nuevas compras y costos de inventario. Las operaciones registradas conservan su tasa histórica y su valor. Los precios de venta y la tasa contable se conservan.',
  },
  accounting: {
    title: 'Tipo de cambio contable',
    label: 'Córdobas por 1 dólar en contabilidad',
    updateLabel: 'Actualizar tasa contable',
    defaultValue: '37',
    description:
      'Se propone para cobros, pagos y facturas en dólares, y convierte los estados contables a USD. Cada operación conserva su tasa registrada.',
    message:
      'Tipo de cambio contable actualizado para nuevas operaciones y consultas en dólares.',
    confirmation:
      'Los estados en dólares usarán esta tasa. Se propondrá en operaciones nuevas; las ya registradas conservan su tasa histórica. Los precios de venta y los costos de inventario utilizan sus propias tasas.',
  },
} as const

function ExchangeRateCard({
  purpose,
}: {
  purpose: keyof typeof rateCardOptions
}) {
  const { demo, role } = useAccess()
  const { settingsService } = useServices()
  const { data, error, loading } = useQuery(settingsService.getExchangeRate)
  const accounting = purpose === 'accounting'
  const inventory = purpose === 'inventory'
  const options = rateCardOptions[purpose]
  const [rate, setRate] = useState('')
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)
  // Comparar la tasa anterior y el cambio antes de recalcular precios o
  // equivalencias permite detectar errores de captura.
  const [pending, setPending] = useState<number | null>(null)
  const editable = !demo && can(role, 'settings.manage')
  const value = Number(rate)
  const valid = Number.isFinite(value) && value > 0 && value <= 1000000
  const current = accounting
    ? accountingExchangeRate(data)
    : inventory
      ? inventoryExchangeRate(data)
      : (data?.usdToNio ?? null)
  const updatedAt = accounting
    ? data?.accountingUpdatedAt
    : inventory
      ? data?.inventoryUpdatedAt
      : data?.updatedAt
  const updateLabel = options.updateLabel
  const change =
    pending !== null && current ? (pending - current) / current : null

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editable || busy || !valid) return
    setMessage('')
    setFailure('')
    setPending(Math.round(value * 1e6) / 1e6)
  }

  async function confirmRate() {
    if (!editable || busy || pending === null) return
    setBusy(true)
    setFailure('')
    try {
      await settingsService.saveExchangeRate(pending, purpose)
      setPending(null)
      setMessage(options.message)
      setRate('')
      refreshQueries()
    } catch (saveError) {
      setFailure(errorMessage(saveError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="form-card record-form exchange-rate-card">
      <div className="section-heading">
        <div>
          <span className="section-kicker">MONEDA</span>
          <h2>{options.title}</h2>
        </div>
        <Coins size={20} />
      </div>
      <p className="muted">{options.description}</p>
      {loading ? (
        <LoadingState />
      ) : (
        <>
          <p className="exchange-rate-current">
            {error ? (
              <span className="muted">{error}</span>
            ) : current !== null ? (
              <>
                <strong>{current} C$</strong>
                <span>
                  por 1 USD
                  {updatedAt
                    ? ` · actualizado el ${formatDate(updatedAt)}`
                    : ''}
                </span>
              </>
            ) : (
              <span className="muted">
                Todavía no hay una tasa registrada para este uso.
              </span>
            )}
          </p>
          {editable && (
            <form onSubmit={submit}>
              <Input
                label={options.label}
                type="number"
                min="0.000001"
                max={1000000}
                step="0.000001"
                required
                value={rate}
                placeholder={
                  current !== null ? String(current) : options.defaultValue
                }
                onChange={(event) => setRate(event.target.value)}
              />
              <div className="form-actions">
                <Button
                  type="submit"
                  disabled={busy || !valid}
                  aria-busy={busy}
                >
                  {busy ? 'Guardando…' : updateLabel}
                </Button>
              </div>
            </form>
          )}

          {message && (
            <p role="status" className="workspace-feedback">
              {message}
            </p>
          )}
        </>
      )}
      {pending !== null && (
        <ConfirmDialog
          open
          title={`Cambiar el ${options.title.toLowerCase()}`}
          confirmLabel={updateLabel}
          busyLabel="Guardando…"
          busy={busy}
          error={failure}
          onConfirm={() => void confirmRate()}
          onCancel={() => {
            setPending(null)
            setFailure('')
          }}
        >
          <p>
            {current
              ? `De ${current} C$ a ${pending} C$ por dólar`
              : `Primera tasa: ${pending} C$ por dólar`}
            {change !== null &&
              ` (${change > 0 ? '+' : ''}${(change * 100).toLocaleString('es-NI', { maximumFractionDigits: 1 })} %)`}
            .
          </p>
          <p className="muted">{options.confirmation}</p>
          {change !== null && Math.abs(change) >= 0.1 && (
            <p className="inline-error">
              Es un cambio de más del 10 %. Revisa que la tasa esté bien escrita
              antes de confirmar.
            </p>
          )}
        </ConfirmDialog>
      )}
    </Card>
  )
}

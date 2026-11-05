import { useCallback, useState, type FormEvent } from 'react'
import { Plus, Pencil, Archive, RotateCcw } from 'lucide-react'
import {
  Button,
  Dialog,
  Input,
  Select,
  LoadingState,
  ErrorState,
} from '../../components/ui'
import { useQuery } from '../../lib/useQuery'
import { useAccess } from '../../app/AccessContext'
import { AppError, errorMessage } from '../../lib/errors'
import { matchesSearch } from '../../lib/search'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { journalRpc } from './journalService'
import './ledger-accounts.css'

interface ManagedAccount {
  code: string
  display_code?: string | null
  displayCode?: string
  displayParent?: string
  name: string
  parent: string | null
  bucket: string
  nature: 'debit' | 'credit'
  postable: boolean
  active: boolean
  revision: number
  restriction: string | null
}
interface AccountChange {
  action: 'create' | 'rename' | 'activate' | 'deactivate'
  code: string
  name?: string
  newCode?: string
  parent?: string
  expectedRevision?: number
}
export function LedgerAccountsManager({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Administrar cuentas
      </Button>
      {open && (
        <AccountsDialog onClose={() => setOpen(false)} onSaved={onSaved} />
      )}
    </>
  )
}
function AccountsDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: () => void
}) {
  const { storageScope = 'anonymous' } = useAccess()
  const load = useCallback(async () => {
    const rows = await journalRpc<ManagedAccount[]>('ledger_accounts_list', {})
    if (
      !Array.isArray(rows) ||
      rows.some(
        (a) =>
          !a ||
          typeof a.code !== 'string' ||
          typeof a.name !== 'string' ||
          typeof a.active !== 'boolean' ||
          !Number.isInteger(a.revision),
      )
    )
      throw new AppError(
        'unexpected',
        'No se recibió la lista completa de cuentas. Vuelve a consultar.',
      )
    return rows
  }, [])
  const { data, error, loading, retry } = useQuery(load)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('active')
  const [form, setForm] = useState<ManagedAccount | 'create' | null>(null)
  const [code, setCode] = useState(''),
    [name, setName] = useState(''),
    [parent, setParent] = useState('')
  const [confirm, setConfirm] = useState<ManagedAccount | null>(null)
  const [failure, setFailure] = useState(''),
    [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false),
    [stale, setStale] = useState(false)
  const [operation] = useState(() =>
    createIdempotentOperation<AccountChange, ManagedAccount>(
      (input) => journalRpc('change_ledger_account', { p_input: input }),
      {
        scope: storageScope,
        key: 'ledger-account-change',
        label: 'Cuenta contable',
      },
    ),
  )
  const uncertain = operation.isUncertain()
  const disabled = busy || uncertain || stale
  const accounts = data ?? []
  const visible = accounts.filter(
    (a) =>
      (status === 'all' || a.active === (status === 'active')) &&
      matchesSearch(`${a.displayCode ?? a.code} ${a.name}`, query),
  )
  function edit(account: ManagedAccount | 'create') {
    setForm(account)
    setConfirm(null)
    setFailure('')
    setNotice('')
    setStale(false)
    setCode(account === 'create' ? '' : (account.displayCode ?? account.code))
    setName(account === 'create' ? '' : account.name)
    setParent(account === 'create' ? '' : (account.parent ?? ''))
  }
  function refresh() {
    setForm(null)
    setConfirm(null)
    setFailure('')
    setStale(false)
    retry()
  }
  async function change(input?: AccountChange) {
    if (busy || stale || (!input && !uncertain)) return
    setBusy(true)
    setFailure('')
    try {
      const result = uncertain
        ? await operation.retryPending()
        : await operation.execute(input!)
      setNotice(
        `${result.display_code ?? result.code} · ${result.active ? 'Cuenta guardada.' : 'Cuenta desactivada.'}`,
      )
      setForm(null)
      setConfirm(null)
      setStatus(result.active ? 'active' : 'inactive')
      setQuery(result.display_code ?? result.code)
      retry()
      onSaved()
    } catch (e) {
      setFailure(errorMessage(e))
      if (e instanceof AppError && /cuenta cambió/.test(e.message))
        setStale(true)
    } finally {
      setBusy(false)
    }
  }
  function save(event: FormEvent) {
    event.preventDefault()
    if (!form || disabled) return
    void change(
      form === 'create'
        ? { action: 'create', code: code.trim(), name: name.trim(), parent }
        : {
            action: 'rename',
            code: form.code,
            newCode: code.trim(),
            name: name.trim(),
            expectedRevision: form.revision,
          },
    )
  }
  return (
    <Dialog
      open
      title="Administrar cuentas"
      className="ledger-accounts-dialog"
      dismissible={!busy && !uncertain}
      onClose={() => {
        if (!busy && !uncertain) onClose()
      }}
    >
      {notice && (
        <p role="status" className="page-feedback">
          {notice}
        </p>
      )}
      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} retry={retry} />
      ) : (
        <>
          {form ? (
            <form className="day-form" onSubmit={save}>
              <h3>
                {form === 'create'
                  ? 'Agregar cuenta'
                  : `Editar ${form.displayCode ?? form.code}`}
              </h3>
              <fieldset disabled={disabled} className="ledger-account-fields">
                <Input
                  label="Código"
                  required
                  pattern="[1-6][0-9]{3}(-[0-9]{3}){0,3}"
                  maxLength={16}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <Input
                  label="Nombre de la cuenta"
                  required
                  maxLength={160}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                {form === 'create' ? (
                  <Select
                    label="Cuenta mayor"
                    required
                    value={parent}
                    onChange={(e) => setParent(e.target.value)}
                  >
                    <option value="">Seleccionar cuenta mayor</option>
                    {accounts
                      .filter((a) => a.active)
                      .map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.displayCode ?? a.code} · {a.name}
                        </option>
                      ))}
                  </Select>
                ) : (
                  <p className="muted">
                    Cuenta mayor:{' '}
                    {(form.displayParent ?? parent) || 'Cuenta principal'}
                  </p>
                )}
              </fieldset>
              <div className="form-actions">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || uncertain}
                  onClick={() => {
                    setForm(null)
                    setFailure('')
                    setStale(false)
                  }}
                >
                  Volver a cuentas
                </Button>
                <Button
                  disabled={
                    disabled ||
                    (form !== 'create' &&
                      name.trim() === form.name &&
                      code.trim() === (form.displayCode ?? form.code))
                  }
                >
                  {busy ? 'Guardando…' : 'Guardar cuenta'}
                </Button>
              </div>
            </form>
          ) : confirm ? (
            <div className="day-form">
              <h3>
                {confirm.active ? 'Desactivar' : 'Reactivar'}{' '}
                {confirm.displayCode ?? confirm.code} · {confirm.name}
              </h3>
              <p>
                {confirm.active
                  ? 'Dejará de estar disponible para nuevos comprobantes. Sus saldos y movimientos se conservan.'
                  : 'Volverá a estar disponible para registrar comprobantes.'}
              </p>
              <div className="form-actions">
                <Button
                  variant="secondary"
                  disabled={busy || uncertain}
                  onClick={() => {
                    setConfirm(null)
                    setFailure('')
                    setStale(false)
                  }}
                >
                  Cancelar
                </Button>
                <Button
                  variant={confirm.active ? 'danger' : 'primary'}
                  disabled={disabled}
                  onClick={() =>
                    void change({
                      action: confirm.active ? 'deactivate' : 'activate',
                      code: confirm.code,
                      expectedRevision: confirm.revision,
                    })
                  }
                >
                  {busy
                    ? 'Guardando…'
                    : confirm.active
                      ? 'Desactivar cuenta'
                      : 'Reactivar cuenta'}
                </Button>
              </div>
            </div>
          ) : (
            <fieldset disabled={disabled} className="ledger-account-fields">
              <div className="ledger-accounts-toolbar">
                <Input
                  label="Buscar cuenta"
                  type="search"
                  placeholder="Código o nombre"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <Select
                  label="Estado de las cuentas"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="active">Activas</option>
                  <option value="inactive">Inactivas</option>
                  <option value="all">Todas</option>
                </Select>
              </div>
              <div className="form-actions">
                <Button onClick={() => edit('create')}>
                  <Plus size={16} />
                  Agregar cuenta
                </Button>
                <Button variant="ghost" onClick={refresh}>
                  Actualizar lista
                </Button>
                <span className="muted">
                  {visible.length} {visible.length === 1 ? 'cuenta' : 'cuentas'}
                </span>
              </div>
              <div className="ledger-account-list">
                {visible.map((a) => (
                  <article
                    key={a.code}
                    className="ledger-account-row"
                    aria-label={`Cuenta ${a.code}`}
                  >
                    <div>
                      <strong>
                        {a.displayCode ?? a.code} · {a.name}
                      </strong>
                      <small>
                        {a.active ? 'Activa' : 'Inactiva'}
                        {a.parent
                          ? ` · Mayor: ${a.displayParent ?? a.parent}`
                          : ''}
                      </small>
                      {a.restriction && (
                        <small className="muted">{a.restriction}</small>
                      )}
                    </div>
                    <div className="form-actions">
                      <Button
                        variant="secondary"
                        onClick={() => edit(a)}
                        aria-label={`Editar cuenta ${a.displayCode ?? a.code}`}
                      >
                        <Pencil size={15} />
                        Editar
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={!!a.restriction}
                        title={a.restriction ?? undefined}
                        aria-label={`${a.active ? 'Desactivar' : 'Reactivar'} cuenta ${a.code}`}
                        onClick={() => {
                          setConfirm(a)
                          setFailure('')
                          setNotice('')
                        }}
                      >
                        {a.active ? (
                          <Archive size={15} />
                        ) : (
                          <RotateCcw size={15} />
                        )}{' '}
                        {a.active ? 'Desactivar' : 'Reactivar'}
                      </Button>
                    </div>
                  </article>
                ))}
                {!visible.length && <p>No hay cuentas que coincidan.</p>}
              </div>
            </fieldset>
          )}
        </>
      )}
      {failure && (
        <p className="inline-error" role="alert">
          {failure}
        </p>
      )}
      {uncertain && (
        <Button disabled={busy} onClick={() => void change()}>
          {busy ? 'Verificando…' : 'Verificar guardado'}
        </Button>
      )}
      {stale && (
        <Button variant="secondary" onClick={refresh}>
          Actualizar lista
        </Button>
      )}
    </Dialog>
  )
}

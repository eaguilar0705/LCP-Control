import { useState, type FormEvent } from 'react'
import { ArrowRightLeft } from 'lucide-react'
import { Button, Dialog, Input, Select } from '../../components/ui'
import { ProductSelect } from '../../components/ProductSelect'
import { useAccess } from '../../app/AccessContext'
import { can } from '../../lib/permissions'
import {
  labels,
  type InventoryItem,
  type InventoryLocation,
} from '../../lib/domain'
import { errorMessage } from '../../lib/errors'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import {
  listTransfers,
  transferInventory,
  type TransferInput,
  type TransferRecord,
} from './transferService'
import './transfers.css'

export function InventoryTransfers({
  items,
  onRecorded,
}: {
  items: InventoryItem[]
  onRecorded(): void
}) {
  const { demo, role, storageScope = 'anonymous' } = useAccess()
  const allowed = can(role, 'inventory.transfer')
  const [open, setOpen] = useState(false)
  const [productId, setProductId] = useState('')
  const [from, setFrom] = useState<InventoryLocation>('warehouse')
  const to = from === 'warehouse' ? 'store' : 'warehouse'
  const [quantity, setQuantity] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [history, setHistory] = useState<TransferRecord[]>([])
  const [historyError, setHistoryError] = useState('')
  const [loading, setLoading] = useState(false)
  const [operation] = useState(() =>
    createIdempotentOperation<TransferInput, string>(transferInventory, {
      scope: storageScope,
      key: 'inventory-transfer',
      label: 'Traslado de inventario',
    }),
  )
  const pending = operation.isUncertain()
  const item = items.find(({ product }) => product.id === productId)
  const available = item?.quantities[from]
  async function loadHistory() {
    setLoading(true)
    setHistoryError('')
    try {
      setHistory(await listTransfers())
    } catch (failure) {
      setHistoryError(errorMessage(failure))
    } finally {
      setLoading(false)
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !allowed) return
    if (!pending) {
      const units = Number(quantity)
      if (
        !item ||
        !Number.isInteger(units) ||
        units < 1 ||
        units > 1000000 ||
        !note.trim()
      ) {
        setError(
          'Selecciona un perfume, una cantidad entera y el motivo del traslado.',
        )
        return
      }
      if (available == null || item.quantities[to] == null) {
        setError(
          'Registra primero el conteo inicial en Bodega y Tienda, aunque sea cero. Solicítalo al administrador.',
        )
        return
      }
      if (units > available) {
        setError(
          `Solo hay ${available} unidades en ${labels.location[from]}. Revisa la cantidad.`,
        )
        return
      }
    }
    setBusy(true)
    setError('')
    setMessage('')
    try {
      if (pending) await operation.retryPending()
      else
        await operation.execute({
          productId,
          fromLocation: from,
          toLocation: to,
          quantity: Number(quantity),
          note: note.trim(),
        })
      operation.reset()
      setQuantity('')
      setNote('')
      setMessage('Traslado registrado. Inventario actualizado.')
      onRecorded()
      await loadHistory()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  if (demo || !can(role, 'inventory.read')) return null
  return (
    <>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => {
          setOpen(true)
          setMessage('')
          setError('')
          void loadHistory()
        }}
      >
        <ArrowRightLeft size={17} />
        Traslados
      </Button>
      {open && (
        <Dialog
          open
          title="Traslados de inventario"
          dismissible={!busy && !pending}
          onClose={() => {
            if (!busy && !pending) setOpen(false)
          }}
        >
          {allowed && (
            <form className="movement-form" onSubmit={submit}>
              <fieldset disabled={busy || pending} className="form-fields">
                <ProductSelect
                  label="Perfume del traslado"
                  products={items.map(({ product }) => product)}
                  value={productId}
                  onChange={setProductId}
                />
                <div className="transfer-locations">
                  <Select
                    label="Desde"
                    value={from}
                    onChange={(event) =>
                      setFrom(event.target.value as InventoryLocation)
                    }
                  >
                    {Object.entries(labels.location).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                  <p className="transfer-destination">
                    Hacia <strong>{labels.location[to]}</strong>
                  </p>
                </div>
                {item && (
                  <p>
                    Disponibles en {labels.location[from]}:{' '}
                    <strong>{available ?? 'Sin conteo'}</strong> · En{' '}
                    {labels.location[to]}: {item.quantities[to] ?? 'Sin conteo'}
                  </p>
                )}
                <Input
                  label="Unidades a trasladar"
                  type="number"
                  min={1}
                  max={1000000}
                  step={1}
                  required
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                />
                <Input
                  label="Motivo del traslado"
                  required
                  maxLength={2000}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Reposición de Tienda"
                />
              </fieldset>
              {error && (
                <p role="alert" className="inline-error">
                  {error}
                </p>
              )}
              {message && (
                <p role="status" className="page-feedback">
                  {message}
                </p>
              )}
              <div className="form-actions">
                <Button type="submit" disabled={busy}>
                  {busy
                    ? 'Registrando…'
                    : pending
                      ? 'Verificar traslado'
                      : 'Confirmar traslado'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || pending}
                  onClick={() => setOpen(false)}
                >
                  Cerrar
                </Button>
              </div>
            </form>
          )}
          <details className="transfer-history" open={!allowed}>
            <summary>Últimos 100 traslados</summary>
            {loading ? (
              <p role="status">Cargando traslados…</p>
            ) : historyError ? (
              <div>
                <p role="alert" className="inline-error">
                  {historyError}
                </p>
                <Button variant="secondary" onClick={() => void loadHistory()}>
                  Reintentar
                </Button>
              </div>
            ) : !history.length ? (
              <p>Sin traslados registrados.</p>
            ) : (
              <ul>
                {history.map((record) => (
                  <li key={record.id}>
                    <strong>
                      {record.product_sku} · {record.product_name} ·{' '}
                      {record.quantity} unidades
                    </strong>
                    <p>
                      {labels.location[record.from_location]}{' '}
                      {record.from_before} → {record.from_after} ·{' '}
                      {labels.location[record.to_location]} {record.to_before} →{' '}
                      {record.to_after}
                    </p>
                    <p>{record.note}</p>
                    <small>
                      {new Intl.DateTimeFormat('es-NI', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                        timeZone: 'America/Managua',
                      }).format(new Date(record.created_at))}{' '}
                      · {record.actor_name}
                    </small>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </Dialog>
      )}
    </>
  )
}

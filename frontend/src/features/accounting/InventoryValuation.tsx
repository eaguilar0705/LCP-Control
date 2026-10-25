import { useState, type FormEvent } from 'react'
import { Scale } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button, Dialog, Input } from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { errorMessage } from '../../lib/errors'
import { formatCurrency } from '../../lib/format'
import { journalRpc } from './journalService'

interface Valuation {
  token: string
  day: string
  bookNio: number
  valueNio: number
  differenceNio: number
  roundingLimitNio: number
  uncounted: number
  missingCosts: number
  missingOpening: boolean
  unknownHistoricalCosts: number
  history: {
    id: string
    occurred_on: string
    amount_nio: number
    note: string
    actor_name: string
    journal_number: number | null
  }[]
}
interface ReconcileInput {
  expectedToken: string
  note: string
}
export function InventoryValuation({ onChanged }: { onChanged(): void }) {
  const { storageScope = 'anonymous', base } = useAccess()
  const [open, setOpen] = useState(false),
    [data, setData] = useState<Valuation | null>(null)
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false)
  const [note, setNote] = useState(''),
    [error, setError] = useState(''),
    [message, setMessage] = useState('')
  const [operation] = useState(() =>
    createIdempotentOperation<ReconcileInput, string>(
      (input) =>
        journalRpc<string>('reconcile_inventory_value', { p_input: input }),
      {
        scope: storageScope,
        key: 'inventory-valuation',
        label: 'Conciliación de inventario',
      },
    ),
  )
  const pending = operation.isUncertain()
  const blocked =
    !!data &&
    (data.uncounted > 0 ||
      data.missingCosts > 0 ||
      data.missingOpening ||
      data.unknownHistoricalCosts > 0 ||
      Math.abs(data.differenceNio) > data.roundingLimitNio)
  async function refresh() {
    setLoading(true)
    setError('')
    try {
      setData(await journalRpc<Valuation>('inventory_valuation_preview', {}))
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setLoading(false)
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !data) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      if (pending) await operation.retryPending()
      else
        await operation.execute({
          expectedToken: data.token,
          note: note.trim(),
        })
      operation.reset()
      setNote('')
      setMessage('Revisión de inventario registrada.')
      onChanged()
      await refresh()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          setOpen(true)
          setMessage('')
          void refresh()
        }}
      >
        <Scale size={17} />
        Valorización de inventario
      </Button>
      {open && (
        <Dialog
          open
          title="Valorización actual de inventario"
          dismissible={!busy && !pending}
          onClose={() => {
            if (!busy && !pending) setOpen(false)
          }}
        >
          {loading && <p role="status">Consultando valorización…</p>}
          {data && (
            <>
              <dl className="valuation-totals">
                <div>
                  <dt>Saldo contable · 1130</dt>
                  <dd>{formatCurrency(data.bookNio, 'NIO')}</dd>
                </div>
                <div>
                  <dt>Valor de las existencias</dt>
                  <dd>{formatCurrency(data.valueNio, 'NIO')}</dd>
                </div>
                <div>
                  <dt>Diferencia</dt>
                  <dd>{formatCurrency(data.differenceNio, 'NIO')}</dd>
                </div>
              </dl>
              {data.uncounted > 0 && (
                <p role="alert">
                  {data.uncounted} perfumes sin conteo completo.{' '}
                  <Link to={`${base}/inventory`}>Completar en Inventario</Link>
                </p>
              )}
              {data.missingCosts > 0 && (
                <p role="alert">
                  {data.missingCosts} perfumes con existencias sin costo.{' '}
                  <Link to={`${base}/inventory`}>Registrar costos</Link>
                </p>
              )}
              {data.missingOpening && (
                <p role="alert">
                  Registra los saldos iniciales antes de conciliar.
                </p>
              )}
              {data.unknownHistoricalCosts > 0 && (
                <p role="alert">
                  Hay costos históricos pendientes de revisión.
                </p>
              )}
              {Math.abs(data.differenceNio) > data.roundingLimitNio && (
                <p role="alert">
                  La diferencia supera el límite de redondeo (
                  {formatCurrency(data.roundingLimitNio, 'NIO')}). Revisa
                  conteos, costos y los asientos de Inventario 1130.
                </p>
              )}
              {!blocked && (
                <form className="movement-form" onSubmit={submit}>
                  <fieldset
                    className="form-fields"
                    disabled={busy || pending || loading}
                  >
                    <Input
                      label="Motivo de la revisión"
                      required
                      maxLength={500}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                    />
                  </fieldset>
                  {data.differenceNio !== 0 && (
                    <p>
                      Se registrará{' '}
                      {formatCurrency(Math.abs(data.differenceNio), 'NIO')}{' '}
                      entre Inventario y Costo de venta en la jornada actual.
                    </p>
                  )}
                  <Button type="submit" disabled={busy || loading}>
                    {busy
                      ? 'Registrando…'
                      : pending
                        ? 'Verificar guardado'
                        : data.differenceNio === 0
                          ? 'Registrar revisión'
                          : 'Confirmar regularización'}
                  </Button>
                </form>
              )}
              {data.history.length > 0 && (
                <details className="transfer-history">
                  <summary>Historial de revisiones</summary>
                  <ul>
                    {data.history.map((row) => (
                      <li key={row.id}>
                        <strong>
                          {row.occurred_on} ·{' '}
                          {formatCurrency(row.amount_nio, 'NIO')}
                        </strong>
                        <p>{row.note}</p>
                        <small>
                          {row.actor_name}
                          {row.journal_number
                            ? ` · CP-${String(row.journal_number).padStart(6, '0')}`
                            : ''}
                        </small>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
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
            <Button
              variant="secondary"
              disabled={busy || pending}
              onClick={() => void refresh()}
            >
              Actualizar importes
            </Button>
            <Button
              variant="secondary"
              disabled={busy || pending}
              onClick={() => setOpen(false)}
            >
              Cerrar
            </Button>
          </div>
        </Dialog>
      )}
    </>
  )
}

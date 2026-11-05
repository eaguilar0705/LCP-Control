import { useCallback, useState, type FormEvent } from 'react'
import {
  Button,
  Dialog,
  Input,
  Select,
  LoadingState,
  ErrorState,
} from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { useQuery } from '../../lib/useQuery'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { errorMessage } from '../../lib/errors'
import { formatCurrency, formatDate } from '../../lib/format'
import { dayRpc, type BusinessDay } from './businessDay'
import { journalRpc } from './journalService'
import { accountAcceptsCurrency, type LedgerReport } from './journalModel'

const types = {
  expense: 'Pago o gasto de la tienda',
  owner_withdrawal: 'Retiro del propietario',
  deposit: 'Depósito de efectivo a banco',
  bank_withdrawal: 'Retiro de banco a caja',
  income: 'Otra entrada de dinero',
  other_out: 'Otra salida de dinero',
}
type MovementType = keyof typeof types
interface CashInput {
  day: string
  type: MovementType
  currency: 'NIO' | 'USD'
  exchangeRate: number
  amount: number
  counterpart: string
  description: string
  reference: string
  expectedRevision: number
  expectedStateToken: string
}
export function CashMovementDialog({
  day,
  onClose,
  onSaved,
}: {
  day: BusinessDay
  onClose: () => void
  onSaved: () => void
}) {
  const { storageScope = 'anonymous' } = useAccess()
  const load = useCallback(async () => {
    const [state, ledger] = await Promise.all([
      dayRpc('get_business_day', { p_day: day.day }),
      journalRpc<LedgerReport>('ledger_report', {
        p_from: day.day,
        p_to: day.day,
      }),
    ])
    return { state, ledger }
  }, [day.day])
  const { data, error: loadError, loading, retry } = useQuery(load)
  const [type, setType] = useState<MovementType>('expense')
  const [currency, setCurrency] = useState<'NIO' | 'USD'>('NIO')
  const [rate, setRate] = useState('')
  const [amount, setAmount] = useState('')
  const [counterpart, setCounterpart] = useState('')
  const [description, setDescription] = useState('')
  const [reference, setReference] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [operation] = useState(() =>
    createIdempotentOperation<CashInput, string>(
      (input) => journalRpc('record_cash_movement', { p_input: input }),
      { scope: storageScope, key: 'journal', label: 'Movimiento de caja' },
    ),
  )
  const uncertain = operation.isUncertain()
  const incoming = type === 'income' || type === 'bank_withdrawal'
  const accounts = (data?.ledger.accounts ?? []).filter(
    (a) =>
      a.postable &&
      a.active !== false &&
      !['1110-001', '1110-002'].includes(a.code) &&
      accountAcceptsCurrency(a.code, currency) &&
      (type !== 'expense' || ['expense', 'cost', 'tax'].includes(a.bucket)) &&
      (type !== 'owner_withdrawal' || a.bucket === 'equity') &&
      (!['deposit', 'bank_withdrawal'].includes(type) ||
        a.code.startsWith('1120-')),
  )
  const expected =
    currency === 'NIO'
      ? data?.state.report?.expectedNio
      : data?.state.report?.expectedUsd
  async function save(e: FormEvent) {
    e.preventDefault()
    if (busy || stale || !data) return
    setBusy(true)
    setError('')
    try {
      if (uncertain) await operation.retryPending()
      else
        await operation.execute({
          day: day.day,
          type,
          currency,
          exchangeRate: currency === 'NIO' ? 1 : Number(rate),
          amount: Number(amount),
          counterpart,
          description: description.trim(),
          reference: reference.trim(),
          expectedRevision: data.state.revision,
          expectedStateToken: data.state.stateToken,
        })
      onSaved()
    } catch (e) {
      const message = errorMessage(e)
      setError(message)
      if (/jornada cambió/.test(message)) setStale(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      title="Registrar movimiento de caja"
      className="day-dialog"
      dismissible={!busy && !uncertain}
      onClose={() => {
        if (!busy && !uncertain) onClose()
      }}
    >
      {loading ? (
        <LoadingState />
      ) : loadError ? (
        <ErrorState message={loadError} retry={retry} />
      ) : (
        <form className="day-form" onSubmit={save}>
          <strong>{formatDate(day.day)}</strong>
          {data?.state.status === 'closed' && (
            <p className="day-notice">
              Se actualizarán contabilidad y el reporte de esta jornada. El
              conteo físico y el cierre anterior se conservan.
            </p>
          )}
          <fieldset
            disabled={busy || uncertain || stale}
            className="ledger-account-fields"
          >
            <Select
              label="Tipo de movimiento"
              value={type}
              onChange={(e) => {
                setType(e.target.value as MovementType)
                setCounterpart('')
              }}
            >
              {Object.entries(types).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
            <div className="day-inputs">
              <Select
                label="Moneda del efectivo"
                value={currency}
                onChange={(e) => {
                  setCurrency(e.target.value as 'NIO' | 'USD')
                  setCounterpart('')
                }}
              >
                <option value="NIO">Córdobas C$</option>
                <option value="USD">Dólares US$</option>
              </Select>
              <Input
                label="Importe"
                type="number"
                min="0.01"
                max="100000000"
                step="0.01"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            {currency === 'USD' && (
              <Input
                label="Tipo de cambio C$ por US$"
                type="number"
                min="0.000001"
                max="100000"
                step="0.000001"
                required
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            )}
            <Select
              label={incoming ? 'Cuenta de origen' : 'Cuenta de destino'}
              required
              value={counterpart}
              onChange={(e) => setCounterpart(e.target.value)}
            >
              <option value="">Seleccionar cuenta</option>
              {accounts.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.displayCode ?? a.code} · {a.name}
                </option>
              ))}
            </Select>
            <Input
              label="Concepto"
              required
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <Input
              label="Referencia (opcional)"
              maxLength={200}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
            {expected !== undefined && (
              <div className="day-notice">
                <span>
                  Efectivo esperado:{' '}
                  <strong>{formatCurrency(expected, currency)}</strong>
                </span>
                <span>
                  Después del movimiento:{' '}
                  <strong>
                    {formatCurrency(
                      Math.round(
                        (expected + (incoming ? 1 : -1) * Number(amount)) * 100,
                      ) / 100,
                      currency,
                    )}
                  </strong>
                </span>
              </div>
            )}
          </fieldset>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {stale && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setStale(false)
                setError('')
                retry()
              }}
            >
              Actualizar importes
            </Button>
          )}
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={busy || uncertain}
              onClick={onClose}
            >
              Cancelar
            </Button>
            <Button
              disabled={
                busy ||
                stale ||
                (!uncertain && !accounts.some((a) => a.code === counterpart))
              }
            >
              {busy
                ? 'Guardando…'
                : uncertain
                  ? 'Verificar guardado'
                  : 'Guardar movimiento'}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}

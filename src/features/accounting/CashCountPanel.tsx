import { useCallback, useState, type FormEvent } from 'react'
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
} from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { formatCurrency, formatDate } from '../../lib/format'
import { errorMessage } from '../../lib/errors'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { can } from '../../lib/permissions'
import { localDay, type ReportRange } from '../reports/model'
import { roundMoney } from '../reports/accounting'
import type { CashClosingInput, CashClosingRecord } from './cashflow'

const nioNotes = [1000, 500, 200, 100, 50, 20, 10, 5, 1]
const usdNotes = [100, 50, 20, 10, 5, 1]
const money = (value: number | null) =>
  value === null ? 'Pendiente' : formatCurrency(value, 'NIO')
type Count = Record<string, string>
const countAmount = (counts: Count, values: number[]) =>
  roundMoney(
    values.reduce(
      (sum, denomination) =>
        sum + denomination * Number(counts[denomination] || 0),
      0,
    ),
  )
const validCounts = (counts: Count) =>
  Object.values(counts).every(
    (value) =>
      value === '' ||
      (Number.isSafeInteger(Number(value)) &&
        Number(value) >= 0 &&
        Number(value) <= 100000),
  )

export function CashCountPanel({
  range,
  onChanged,
}: {
  range: ReportRange
  onChanged: () => void
}) {
  const { financeService, settingsService } = useServices()
  const { role, demo } = useAccess()
  const today = localDay(new Date())
  const [day, setDay] = useState(range.to < today ? range.to : today)
  const shown = day < range.from ? range.from : day > range.to ? range.to : day
  const [nio, setNio] = useState<Count>({})
  const [usd, setUsd] = useState<Count>({})
  const [coins, setCoins] = useState('')
  const [usdCoins, setUsdCoins] = useState('')
  const [rate, setRate] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [voiding, setVoiding] = useState<CashClosingRecord | null>(null)
  const [reason, setReason] = useState('')
  const [operation] = useState(() =>
    createIdempotentOperation<Omit<CashClosingInput, 'requestId'>, string>(
      (input) => financeService.recordCashClosing(input),
    ),
  )
  const load = useCallback(async () => {
    const [flow, closings, exchange] = await Promise.all([
      financeService.getCashflow({ from: shown, to: shown }),
      financeService.getCashClosings(range),
      settingsService.getExchangeRate(),
    ])
    return { flow, closings, rate: exchange?.usdToNio ?? null }
  }, [financeService, settingsService, shown, range])
  const { data, loading, error: failure, retry, refresh } = useQuery(load)
  if (loading && !data) return <LoadingState />
  if (failure || !data)
    return (
      <ErrorState message={failure ?? 'Sin datos de caja.'} retry={retry} />
    )
  if (data.flow.to !== shown) return <LoadingState />
  const countedNio = roundMoney(countAmount(nio, nioNotes) + Number(coins || 0))
  const countedUsd = roundMoney(
    countAmount(usd, usdNotes) + Number(usdCoins || 0),
  )
  const exchangeRate =
    rate === null ? (data.rate ?? (countedUsd === 0 ? 1 : NaN)) : Number(rate)
  const countedTotal = roundMoney(countedNio + countedUsd * exchangeRate)
  const expected = data.flow.closing.caja
  const difference =
    expected === null ? null : roundMoney(countedTotal - expected)
  const existing = data.closings.find(
    (row) => row.closedOn === shown && !row.voidedAt,
  )
  const writable = !demo && can(role, 'finance.read') && data.flow.available
  const valid =
    validCounts(nio) &&
    validCounts(usd) &&
    Number.isFinite(Number(coins || 0)) &&
    Number(coins || 0) >= 0 &&
    Number.isFinite(Number(usdCoins || 0)) &&
    Number(usdCoins || 0) >= 0 &&
    Number.isFinite(countedNio) &&
    countedNio >= 0 &&
    Number.isFinite(countedUsd) &&
    countedUsd >= 0 &&
    Number.isFinite(exchangeRate) &&
    exchangeRate > 0 &&
    exchangeRate <= 1000000 &&
    countedTotal <= 1000000000 &&
    (!difference || note.trim().length > 0) &&
    note.length <= 500

  async function save(event: FormEvent) {
    event.preventDefault()
    if (
      !data ||
      busy ||
      !writable ||
      !valid ||
      expected === null ||
      existing ||
      shown > today
    )
      return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await operation.execute({
        closedOn: shown,
        countedNio,
        countedUsd,
        exchangeRate,
        note: note.trim(),
      })
      setMessage(
        'Arqueo guardado con el efectivo contado y el saldo esperado de ese momento.',
      )
      operation.reset()
      refresh()
      onChanged()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  async function voidClosing(event: FormEvent) {
    event.preventDefault()
    if (!voiding || busy || !reason.trim() || reason.length > 500 || !writable)
      return
    setBusy(true)
    setError('')
    try {
      await financeService.voidCashClosing(voiding.id, reason.trim())
      setVoiding(null)
      setMessage('Arqueo anulado. Se conserva su registro y el motivo.')
      refresh()
      onChanged()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const counter = (
    label: string,
    currency: 'NIO' | 'USD',
    values: number[],
    counts: Count,
    setCounts: (counts: Count) => void,
  ) => (
    <fieldset className="cash-count-denominations">
      <legend>{label}</legend>
      {values.map((value) => (
        <Input
          key={value}
          label={`${currency === 'NIO' ? 'C$' : 'US$'} ${value} · cantidad`}
          type="number"
          min="0"
          max="100000"
          step="1"
          inputMode="numeric"
          value={counts[value] ?? ''}
          onChange={(event) =>
            setCounts({ ...counts, [value]: event.target.value })
          }
        />
      ))}
    </fieldset>
  )
  return (
    <>
      {message && (
        <p className="workspace-feedback" role="status">
          {message}
        </p>
      )}
      <Card className="accounting-card">
        <div className="section-heading">
          <h2>Arqueo de efectivo</h2>
          <Input
            label="Fecha del arqueo"
            type="date"
            min={range.from}
            max={range.to < today ? range.to : today}
            value={shown}
            disabled={busy}
            onChange={(event) => {
              if (event.target.value) {
                setDay(event.target.value)
                setError('')
                setMessage('')
                setNio({})
                setUsd({})
                setCoins('')
                setUsdCoins('')
                setNote('')
                operation.reset()
              }
            }}
          />
        </div>
        {!data.flow.available && (
          <p className="accounting-callout">
            Falta activar el flujo de efectivo y los arqueos en la base de
            datos.
          </p>
        )}
        {expected === null && (
          <p className="accounting-callout" role="status">
            Registra el saldo inicial de caja para comparar el efectivo contado
            con el esperado. Las ventas sin importe contable también impiden
            confirmar el cierre.
          </p>
        )}
        {existing && (
          <p className="accounting-callout" role="status">
            Ya hay un arqueo vigente para este día. Puedes consultar el registro
            o anularlo con un motivo antes de volver a contar.
          </p>
        )}
        <form onSubmit={save}>
          <fieldset
            className="cash-count-fields"
            disabled={busy || !writable || !!existing}
          >
            <div className="accounting-two-columns">
              {counter('Efectivo en córdobas', 'NIO', nioNotes, nio, setNio)}
              {counter('Efectivo en dólares', 'USD', usdNotes, usd, setUsd)}
            </div>
            <div className="filter-grid">
              <Input
                label="Otras monedas C$"
                type="number"
                min="0"
                step="0.01"
                value={coins}
                onChange={(event) => setCoins(event.target.value)}
              />
              <Input
                label="Otras monedas US$"
                type="number"
                min="0"
                step="0.01"
                value={usdCoins}
                onChange={(event) => setUsdCoins(event.target.value)}
              />
              <Input
                label="Tasa del dólar para el arqueo"
                type="number"
                min="0.000001"
                max="1000000"
                step="0.000001"
                value={rate ?? (data.rate === null ? '' : String(data.rate))}
                onChange={(event) => setRate(event.target.value)}
              />
            </div>
            <dl className="accounting-breakdown">
              <div>
                <dt>Efectivo contado en córdobas</dt>
                <dd>{money(countedNio)}</dd>
              </div>
              <div>
                <dt>Efectivo contado en dólares</dt>
                <dd>{formatCurrency(countedUsd, 'USD')}</dd>
              </div>
              <div>
                <dt>Total contado, equivalente C$</dt>
                <dd>
                  {Number.isFinite(countedTotal)
                    ? money(countedTotal)
                    : 'Revisa la tasa'}
                </dd>
              </div>
              <div>
                <dt>Caja esperada al final del día</dt>
                <dd>{money(expected)}</dd>
              </div>
              <div>
                <dt>Diferencia: contado menos esperado</dt>
                <dd>
                  {difference === null || !Number.isFinite(difference)
                    ? 'Pendiente'
                    : money(difference)}
                </dd>
              </div>
            </dl>
            <Input
              label="Observación o motivo de diferencia"
              maxLength={500}
              required={difference !== null && difference !== 0}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <p className="accounting-note">
              El arqueo conserva una foto del saldo esperado al guardarse. Una
              diferencia requiere explicación y no cambia la caja
              automáticamente. Los dólares contados se convierten con la tasa
              indicada; una diferencia de cambio puede necesitar conciliación.
            </p>
            <Button
              type="submit"
              disabled={!valid || expected === null || shown > today}
              aria-busy={busy}
            >
              {busy ? 'Guardando…' : 'Guardar arqueo'}
            </Button>
          </fieldset>
        </form>
        {error && !voiding && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </Card>
      <Card className="accounting-card">
        <h3>Arqueos guardados</h3>
        {!data.closings.length ? (
          <EmptyState title="Sin arqueos guardados en este período" />
        ) : (
          <div
            className="accounting-table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Arqueos guardados"
          >
            <table className="accounting-table">
              <caption className="sr-only">Arqueos guardados</caption>
              <thead>
                <tr>
                  <th scope="col">Día</th>
                  <th scope="col" className="num">
                    Esperado C$
                  </th>
                  <th scope="col" className="num">
                    Contado C$
                  </th>
                  <th scope="col" className="num">
                    Diferencia C$
                  </th>
                  <th scope="col">Observación</th>
                  <th scope="col">Estado</th>
                </tr>
              </thead>
              <tbody>
                {data.closings.map((row) => (
                  <tr
                    key={row.id}
                    className={row.voidedAt ? 'accounting-voided' : undefined}
                  >
                    <th scope="row">
                      {formatDate(row.closedOn)}
                      <small>{formatDate(row.createdAt)}</small>
                    </th>
                    <td className="num">{money(row.expectedNio)}</td>
                    <td className="num">{money(row.countedTotalNio)}</td>
                    <td className="num">{money(row.differenceNio)}</td>
                    <td>
                      {row.note || 'Sin diferencia'}
                      {row.changed && !row.voidedAt && (
                        <small className="accounting-thin">
                          Los registros cambiaron después del arqueo. Caja
                          esperada actual: {money(row.currentExpectedNio)}.
                        </small>
                      )}
                    </td>
                    <td>
                      {row.voidedAt ? (
                        <>
                          <Badge>Anulado</Badge>
                          <small>{row.voidReason}</small>
                        </>
                      ) : (
                        <>
                          <Badge
                            tone={
                              row.differenceNio === 0 && !row.changed
                                ? 'success'
                                : 'warning'
                            }
                          >
                            {row.changed
                              ? 'Revisar'
                              : row.differenceNio === 0
                                ? 'Cuadra'
                                : 'Con diferencia'}
                          </Badge>
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={!writable || busy}
                            onClick={() => {
                              setVoiding(row)
                              setReason('')
                              setError('')
                            }}
                          >
                            Anular
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {voiding && (
        <Dialog
          open
          title="Anular arqueo"
          onClose={() => {
            if (!busy) setVoiding(null)
          }}
        >
          <form onSubmit={voidClosing}>
            <Input
              label="Motivo de anulación"
              required
              maxLength={500}
              disabled={busy}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <Button
                type="submit"
                variant="danger"
                disabled={busy || !reason.trim()}
              >
                Anular arqueo
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => setVoiding(null)}
              >
                Cancelar
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  )
}

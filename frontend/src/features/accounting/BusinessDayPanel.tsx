import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  DoorClosed,
  DoorOpen,
  FileDown,
  RefreshCw,
  RotateCcw,
} from 'lucide-react'
import { useAccess } from '../../app/AccessContext'
import { Button, Card, Dialog, Input } from '../../components/ui'
import { useQuery } from '../../lib/useQuery'
import { AppError, errorMessage } from '../../lib/errors'
import {
  forgetOperationReference,
  getOperationReferences,
  rememberOperationReference,
  type OperationKind,
} from '../../lib/operationRecovery'
import { formatCurrency, formatDate } from '../../lib/format'
import { labels, type PaymentMethod } from '../../lib/domain'
import {
  dayRpc,
  getBusinessDayHistory,
  type BusinessDay,
  type BusinessDayEvent,
} from './businessDay'
import '../../styles/business-day.css'

type DayAction = 'open' | 'close' | 'reopen'
const actionTitle: Record<DayAction, string> = {
  open: 'Abrir tienda',
  close: 'Cerrar tienda',
  reopen: 'Reabrir jornada',
}
const cashFormat = new Intl.NumberFormat('es-NI', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const timestamp = (value: string) =>
  new Intl.DateTimeFormat('es-NI', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Managua',
  }).format(new Date(value))

export function BusinessDayPanel() {
  const { demo, role } = useAccess()
  if (demo) return null
  return <DayPanel admin={role === 'admin' || role === 'superadmin'} />
}

function DayPanel({ admin }: { admin: boolean }) {
  const { base } = useAccess()
  const [date, setDate] = useState('')
  const load = useCallback(
    () => dayRpc('get_business_day', { p_day: date || null }),
    [date],
  )
  const { data, error, loading, refresh } = useQuery(load)
  const [action, setAction] = useState<{
    kind: DayAction
    day: BusinessDay
  } | null>(null)
  const [failure, setFailure] = useState('')
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const day = data?.day
  const revision = data?.revision
  const loadHistory = useCallback(
    () =>
      admin && day && revision !== undefined
        ? getBusinessDayHistory(day).then((events) => ({ day, events }))
        : Promise.resolve(null),
    [admin, day, revision],
  )
  const history = useQuery(loadHistory)
  const historyCurrent = history.data?.day === day
  const historyEvents = historyCurrent ? (history.data?.events ?? []) : []
  const refreshPanel = () => {
    refresh()
    history.refresh()
  }
  useEffect(() => {
    const update = () => refresh()
    const visible = () => {
      if (document.visibilityState === 'visible') update()
    }
    window.addEventListener('focus', update)
    window.addEventListener('online', update)
    document.addEventListener('visibilitychange', visible)
    const timer = window.setInterval(update, 60000)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('online', update)
      document.removeEventListener('visibilitychange', visible)
      window.clearInterval(timer)
    }
  }, [refresh])
  const current = !!data && (!date || data.day === date)
  const report = current ? data.report : null
  const label =
    data?.status === 'open'
      ? 'Tienda abierta'
      : data?.status === 'closed'
        ? 'Jornada cerrada'
        : 'Tienda sin abrir'
  const begin = (kind: DayAction) => {
    if (data) setAction({ kind, day: structuredClone(data) })
  }
  async function download(snapshot?: BusinessDayEvent) {
    if (!data?.report && !snapshot?.report) return
    setFailure('')
    try {
      const { downloadDailyReport } = await import('./dailyReportPdf')
      await downloadDailyReport(
        snapshot?.report && data
          ? {
              ...data,
              day: snapshot.day,
              status: 'closed',
              revision: snapshot.revision,
              openedAt: snapshot.report.openedAt ?? data.openedAt,
              closedAt: snapshot.report.closedAt ?? snapshot.createdAt,
              openingNio: snapshot.report.openingNio ?? data.openingNio,
              openingUsd: snapshot.report.openingUsd ?? data.openingUsd,
              report: snapshot.report,
            }
          : data!,
      )
    } catch (e) {
      setFailure(errorMessage(e))
    }
  }
  return (
    <Card className={`business-day-panel day-${data?.status ?? 'loading'}`}>
      <div className="day-heading">
        <div className="day-title">
          {data?.status === 'open' ? <DoorOpen /> : <DoorClosed />}
          <div>
            <h2>{loading || !current ? 'Jornada de tienda' : label}</h2>
            {current && <span>{formatDate(data.day)}</span>}
          </div>
        </div>
        <div className="day-actions">
          <Button
            variant="ghost"
            aria-label="Actualizar jornada"
            title="Actualizar jornada e historial"
            onClick={refreshPanel}
          >
            <RefreshCw size={17} />
          </Button>
          {admin &&
            current &&
            data?.status === 'not_opened' &&
            data.day === data.today &&
            !data.openDay && (
              <Button onClick={() => begin('open')}>Abrir tienda</Button>
            )}
          {admin && current && data?.status === 'open' && (
            <Button variant="secondary" onClick={() => begin('close')}>
              Cerrar tienda
            </Button>
          )}
          {admin &&
            current &&
            data?.status === 'closed' &&
            data.day === data.today &&
            !data.openDay && (
              <Button variant="secondary" onClick={() => begin('reopen')}>
                <RotateCcw size={17} />
                Reabrir jornada
              </Button>
            )}
          {admin && report && (
            <Button variant="secondary" onClick={() => void download()}>
              <FileDown size={17} />
              Reporte diario
            </Button>
          )}
        </div>
      </div>
      {(error || failure) && (
        <p role="alert" className="inline-error">
          {error || failure}
        </p>
      )}
      {current && data?.openDay && data.openDay !== data.today && (
        <div className="day-notice" role="status">
          <strong>Jornada pendiente del {formatDate(data.openDay)}</strong>
          <span>
            Hoy: {formatDate(data.today)}. Cierra la jornada pendiente antes de
            abrir la de hoy.
          </span>
          {admin && data.openDay !== data.day && (
            <Button variant="secondary" onClick={() => setDate(data.openDay!)}>
              Cerrar jornada pendiente del {formatDate(data.openDay)}
            </Button>
          )}
        </div>
      )}
      {admin && (
        <div className="day-date-filter">
          <Input
            label="Consultar jornada"
            type="date"
            value={date || data?.day || ''}
            max={data?.today}
            disabled={action !== null}
            onChange={(e) => setDate(e.target.value)}
          />
          {date && date !== data?.today && (
            <Button
              variant="ghost"
              disabled={action !== null}
              onClick={() => setDate('')}
            >
              Volver a hoy
            </Button>
          )}
        </div>
      )}
      {admin && data && report && (
        <>
          {data?.status === 'open' &&
            (report.expectedNio < 0 || report.expectedUsd < 0) && (
              <div className="day-notice" role="alert">
                <strong>El efectivo esperado es negativo.</strong>
                <p>
                  Revisa pagos, compras y retiros antes del arqueo. Si entró
                  dinero a caja, registra su origen real; no cambies el conteo
                  para ocultar la diferencia.
                </p>
                <Link
                  className="button button-secondary"
                  to={`${base}/accounting?section=credits`}
                >
                  Revisar cobros y pagos
                </Link>
              </div>
            )}
          <div className="day-metrics">
            <div className="day-net-sales">
              <span>Venta neta del día</span>
              <strong>
                {report.netSalesNio == null
                  ? 'Sin dato'
                  : formatCurrency(report.netSalesNio, 'NIO')}
              </strong>
            </div>
            <div>
              <span>Facturas</span>
              <strong>{report.invoices}</strong>
            </div>
            <div>
              <span>Unidades vendidas</span>
              <strong>{report.units}</strong>
            </div>
            <div>
              <span>Efectivo esperado C$</span>
              <strong>{formatCurrency(report.expectedNio, 'NIO')}</strong>
            </div>
            <div>
              <span>Efectivo esperado US$</span>
              <strong>{formatCurrency(report.expectedUsd, 'USD')}</strong>
            </div>
          </div>
          <nav className="day-review-links" aria-label="Consultar el día">
            <Link
              className="button button-secondary"
              to={`${base}/sales/history?day=${data.day}`}
            >
              Ventas del día
            </Link>
            <Link
              className="button button-secondary"
              to={`${base}/accounting?section=credits&day=${data.day}`}
            >
              Cobros y pagos
            </Link>
          </nav>
          <div className="day-payment-list">
            {(report.returnsCount ?? 0) > 0 && (
              <div>
                <span>
                  Notas de crédito: {report.returnsCount} ·{' '}
                  {report.returnedUnits ?? 0} unidades devueltas
                </span>
                <strong>
                  {report.returnedNio == null
                    ? 'Sin dato de importe'
                    : `${formatCurrency(report.returnedNio, 'NIO')} devueltos`}
                </strong>
              </div>
            )}
            {report.payments.map((p) => (
              <div key={`${p.method}-${p.currency}`}>
                <span>
                  {labels.payment[p.method as PaymentMethod] ??
                    (p.method === 'pending' ? 'Crédito' : p.method)}
                </span>
                <strong>{formatCurrency(p.amount, p.currency)}</strong>
              </div>
            ))}
          </div>
          {data?.status === 'closed' && (
            <div className="day-closing">
              <strong>
                Diferencia de caja:{' '}
                {report.differenceNio == null
                  ? 'Pendiente'
                  : formatCurrency(report.differenceNio, 'NIO')}{' '}
                ·{' '}
                {report.differenceUsd == null
                  ? 'Pendiente'
                  : formatCurrency(report.differenceUsd, 'USD')}
              </strong>
              {report.note && <p>{report.note}</p>}
            </div>
          )}
        </>
      )}
      {admin && current && (
        <details
          className="day-history"
          open={historyExpanded}
          onToggle={(event) => setHistoryExpanded(event.currentTarget.open)}
        >
          <summary>
            Historial de cierres y reaperturas
            {historyEvents.length ? ` (${historyEvents.length})` : ''}
          </summary>
          <p className="day-history-date">{formatDate(data.day)}</p>
          {history.error && (
            <p role="alert" className="inline-error">
              {history.error}
              <Button variant="ghost" onClick={history.retry}>
                Reintentar
              </Button>
            </p>
          )}
          {!history.error && !historyCurrent && (
            <p role="status">Cargando historial…</p>
          )}
          {!history.error && historyCurrent && !historyEvents.length && (
            <p>Sin cierres ni reaperturas para esta fecha.</p>
          )}
          {historyEvents.map((event) => (
            <article key={event.id} className="day-history-event">
              <div>
                <strong>
                  {event.event === 'close' ? 'Cierre' : 'Reapertura'} · revisión{' '}
                  {event.revision}
                </strong>
                <span>
                  {timestamp(event.createdAt)} · {event.actorName}
                </span>
                {event.reason && <p>{event.reason}</p>}
              </div>
              {event.report && (
                <div className="day-history-totals">
                  <span>
                    Contado:{' '}
                    {formatCurrency(event.report.countedNio ?? 0, 'NIO')} ·{' '}
                    {formatCurrency(event.report.countedUsd ?? 0, 'USD')}
                  </span>
                  <span>
                    Diferencia:{' '}
                    {formatCurrency(event.report.differenceNio ?? 0, 'NIO')} ·{' '}
                    {formatCurrency(event.report.differenceUsd ?? 0, 'USD')}
                  </span>
                  <Button
                    variant="secondary"
                    onClick={() => void download(event)}
                  >
                    <FileDown size={16} />
                    PDF del cierre · revisión {event.revision}
                  </Button>
                </div>
              )}
            </article>
          ))}
        </details>
      )}
      {action && (
        <DayDialog
          action={action.kind}
          day={action.day}
          latest={current ? data : null}
          onRefresh={refresh}
          onClose={() => setAction(null)}
          onSaved={() => {
            setAction(null)
            setDate('')
            refresh()
            history.refresh()
          }}
        />
      )}
    </Card>
  )
}

function DayDialog({
  action,
  day,
  latest,
  onRefresh,
  onClose,
  onSaved,
}: {
  action: DayAction
  day: BusinessDay
  latest: BusinessDay | null
  onRefresh: () => void
  onClose: () => void
  onSaved: () => void
}) {
  const { base, storageScope = 'anonymous' } = useAccess()
  const [preview, setPreview] = useState(day)
  const [nio, setNio] = useState('')
  const [usd, setUsd] = useState(action === 'open' ? '0' : '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState<{
    key: string
    requestId: string
  } | null>(null)
  const historical = preview.day !== (latest?.today ?? preview.today)
  const hasAmounts = nio !== '' && usd !== ''
  const differenceNio =
    Math.round((Number(nio) - (preview.report?.expectedNio ?? 0)) * 100) / 100
  const differenceUsd =
    Math.round((Number(usd) - (preview.report?.expectedUsd ?? 0)) * 100) / 100
  const discrepancy = hasAmounts && (differenceNio !== 0 || differenceUsd !== 0)
  const reasonRequired =
    action === 'reopen' || (action === 'close' && (historical || discrepancy))
  const minReason = action === 'reopen' || historical ? 10 : 1
  const changed =
    !!latest &&
    (action === 'open'
      ? latest.today !== preview.day || latest.status !== 'not_opened'
      : latest.day !== preview.day ||
        latest.stateToken !== preview.stateToken ||
        latest.revision !== preview.revision)
  const payload =
    action === 'open'
      ? {
          expectedDay: preview.day,
          openingNio: Number(nio),
          openingUsd: Number(usd),
        }
      : action === 'reopen'
        ? {
            day: preview.day,
            reason: note.trim(),
            expectedRevision: preview.revision,
          }
        : {
            day: preview.day,
            countedNio: Number(nio),
            countedUsd: Number(usd),
            note: note.trim(),
            expectedRevision: preview.revision,
            expectedStateToken: preview.stateToken,
          }
  const key = JSON.stringify(payload)
  // El mismo identificador permite recuperar un resultado que el servidor ya
  // guardó, incluso si otra pestaña cambió después el estado de la jornada.
  const retrying = attempt?.key === key
  const uncertain =
    !!attempt &&
    getOperationReferences(storageScope).some(
      (reference) =>
        reference.kind === `business-day-${action}` &&
        reference.requestId === attempt.requestId,
    )
  async function updatePreview() {
    setChecking(true)
    setError('')
    try {
      const fresh = await dayRpc('get_business_day', {
        p_day: action === 'open' ? null : preview.day,
      })
      setPreview(fresh)
      setAttempt(null)
      onRefresh()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setChecking(false)
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || checking || (changed && !retrying)) return
    if (reasonRequired && note.trim().length < minReason) {
      setError(`Escribe un motivo de al menos ${minReason} caracteres.`)
      return
    }
    if (
      action !== 'reopen' &&
      (!hasAmounts ||
        !Number.isFinite(Number(nio)) ||
        !Number.isFinite(Number(usd)))
    )
      return
    const requestId = retrying ? attempt.requestId : crypto.randomUUID()
    const operationKind: OperationKind = `business-day-${action}`
    if (
      getOperationReferences(storageScope).some(
        (reference) =>
          reference.kind === operationKind && reference.requestId !== requestId,
      )
    ) {
      setError(
        'Hay una solicitud anterior de jornada por verificar. Consulta el aviso de recuperación antes de continuar.',
      )
      return
    }
    setAttempt({ key, requestId })
    setBusy(true)
    setError('')
    try {
      rememberOperationReference(storageScope, operationKind, requestId)
      await dayRpc(`${action}_business_day`, {
        p_input: { ...payload, requestId },
      })
      forgetOperationReference(storageScope, operationKind, requestId)
      onSaved()
    } catch (e) {
      if (
        e instanceof AppError &&
        !retrying &&
        [
          'validation',
          'unauthorized',
          'configuration',
          'rate_limited',
        ].includes(e.kind)
      )
        forgetOperationReference(storageScope, operationKind, requestId)
      setError(errorMessage(e))
      onRefresh()
    } finally {
      setBusy(false)
    }
  }
  const canConfirm =
    action === 'open'
      ? preview.status === 'not_opened' && !preview.openDay
      : action === 'reopen'
        ? preview.status === 'closed' && !historical && !preview.openDay
        : preview.status === 'open'
  return (
    <Dialog
      open
      className="day-dialog"
      title={actionTitle[action]}
      onClose={() => {
        if (!busy && !checking) onClose()
      }}
    >
      <form onSubmit={submit} className="day-form">
        <p className="day-dialog-date">
          <strong>{formatDate(preview.day)}</strong>
        </p>
        {action === 'close' &&
          preview.report &&
          (preview.report.expectedNio < 0 ||
            preview.report.expectedUsd < 0) && (
            <div className="day-notice" role="alert">
              <strong>Revisa el efectivo esperado antes de cerrar.</strong>
              <p>
                Hay más salidas de caja que fondos registrados. Revisa los
                movimientos y registra el origen real de cualquier entrada de
                dinero que falte. El conteo físico debe ser cero o positivo.
              </p>
              <Link
                className="button button-secondary"
                to={`${base}/accounting?section=credits`}
              >
                Revisar cobros y pagos
              </Link>
            </div>
          )}
        {action !== 'reopen' ? (
          <>
            <p>
              {action === 'open'
                ? 'Efectivo inicial en caja'
                : 'Efectivo contado al cierre'}
            </p>
            {action === 'open' && (
              <div className="day-opening-shortcuts">
                {preview.openingSuggestion && (
                  <div className="day-previous-closing">
                    <div>
                      <strong>
                        Último cierre ·{' '}
                        {formatDate(preview.openingSuggestion.day)}
                      </strong>
                      <span>
                        {formatCurrency(
                          preview.openingSuggestion.countedNio,
                          'NIO',
                        )}{' '}
                        ·{' '}
                        {formatCurrency(
                          preview.openingSuggestion.countedUsd,
                          'USD',
                        )}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy || checking || uncertain}
                      onClick={() => {
                        const previous = preview.openingSuggestion!
                        setNio(String(previous.countedNio))
                        setUsd(String(previous.countedUsd))
                      }}
                    >
                      Usar último cierre
                    </Button>
                  </div>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy || checking || uncertain}
                  onClick={() => {
                    setNio('0')
                    setUsd('0')
                  }}
                >
                  Sin efectivo inicial
                </Button>
              </div>
            )}
            <div className="day-inputs">
              <Input
                label="Córdobas C$"
                type="number"
                min="0"
                max="100000000"
                step="0.01"
                required
                value={nio}
                onChange={(e) => setNio(e.target.value)}
                disabled={busy || checking}
              />
              <Input
                label="Dólares US$"
                type="number"
                min="0"
                max="100000000"
                step="0.01"
                required
                value={usd}
                onChange={(e) => setUsd(e.target.value)}
                disabled={busy || checking}
              />
            </div>
          </>
        ) : (
          <p>Se conservan la apertura, las ventas y el cierre anterior.</p>
        )}
        {action === 'close' && preview.report && (
          <>
            <div className="day-count-preview" aria-label="Resumen del cierre">
              <div>
                <span>Moneda</span>
                <strong>C$</strong>
                <strong>US$</strong>
              </div>
              <div>
                <span>Esperado</span>
                <strong>{cashFormat.format(preview.report.expectedNio)}</strong>
                <strong>{cashFormat.format(preview.report.expectedUsd)}</strong>
              </div>
              <div>
                <span>Contado</span>
                <strong>
                  {nio === '' ? 'Pendiente' : cashFormat.format(Number(nio))}
                </strong>
                <strong>
                  {usd === '' ? 'Pendiente' : cashFormat.format(Number(usd))}
                </strong>
              </div>
              <div className={discrepancy ? 'day-count-difference' : ''}>
                <span>Diferencia</span>
                <strong>
                  {nio === '' ? 'Pendiente' : cashFormat.format(differenceNio)}
                </strong>
                <strong>
                  {usd === '' ? 'Pendiente' : cashFormat.format(differenceUsd)}
                </strong>
              </div>
            </div>
            <p>
              El cierre guarda el reporte y detiene las ventas de esta jornada.
            </p>
            {historical && (
              <p className="day-notice">
                Cierre de una jornada anterior. Indica por qué quedó pendiente.
              </p>
            )}
          </>
        )}
        {action !== 'open' && (
          <Input
            label={
              action === 'reopen'
                ? 'Motivo de reapertura'
                : 'Observación / motivo de diferencia'
            }
            value={note}
            required={reasonRequired}
            minLength={reasonRequired ? minReason : undefined}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy || checking}
          />
        )}
        {changed && (
          <div role="alert" className="day-notice">
            <strong>
              {action === 'open'
                ? 'La fecha o el estado de la tienda cambió.'
                : 'La jornada cambió desde que abriste este formulario.'}
            </strong>
            <Button
              type="button"
              variant="secondary"
              disabled={busy || checking}
              onClick={() => void updatePreview()}
            >
              {checking
                ? 'Actualizando…'
                : action === 'close'
                  ? 'Actualizar importes del cierre'
                  : 'Actualizar jornada'}
            </Button>
          </div>
        )}
        {!canConfirm && !retrying && !changed && (
          <p role="alert" className="inline-error">
            Esta operación ya no está disponible. Cierra el formulario y revisa
            la jornada.
          </p>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <div className="form-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={busy || checking}
            onClick={onClose}
          >
            Cancelar
          </Button>
          <Button
            disabled={
              busy || checking || (!retrying && (changed || !canConfirm))
            }
          >
            {busy
              ? 'Guardando…'
              : action === 'open'
                ? 'Confirmar apertura'
                : action === 'reopen'
                  ? 'Confirmar reapertura'
                  : 'Confirmar cierre'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

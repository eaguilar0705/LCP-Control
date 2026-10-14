import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { DoorClosed, DoorOpen, FileDown, RefreshCw } from 'lucide-react'
import { useAccess } from '../../app/AccessContext'
import { Button, Card, Dialog, Input } from '../../components/ui'
import { useQuery } from '../../lib/useQuery'
import { errorMessage } from '../../lib/errors'
import { formatCurrency, formatDate } from '../../lib/format'
import { labels, type PaymentMethod } from '../../lib/domain'
import { dayRpc, type BusinessDay } from './businessDay'
import '../../styles/business-day.css'

export function BusinessDayPanel() {
  const { demo, role } = useAccess()
  if (demo) return null
  return <DayPanel admin={role === 'admin' || role === 'superadmin'} />
}

function DayPanel({ admin }: { admin: boolean }) {
  const [date, setDate] = useState('')
  const load = useCallback(
    () => dayRpc('get_business_day', { p_day: date || null }),
    [date],
  )
  const { data, error, loading, refresh } = useQuery(load)
  const [action, setAction] = useState<'open' | 'close' | null>(null)
  const [failure, setFailure] = useState('')
  // Refresh across midnight and after returning from a sale in another tab.
  useEffect(() => {
    const update = () => refresh()
    window.addEventListener('focus', update)
    const timer = window.setInterval(update, 60000)
    return () => {
      window.removeEventListener('focus', update)
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
  async function download() {
    if (!data?.report) return
    setFailure('')
    try {
      const { downloadDailyReport } = await import('./dailyReportPdf')
      await downloadDailyReport(data)
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
            onClick={refresh}
          >
            <RefreshCw size={17} />
          </Button>
          {admin &&
            current &&
            data &&
            data.status === 'not_opened' &&
            data.day === data.today &&
            !data.openDay && (
              <Button onClick={() => setAction('open')}>Abrir tienda</Button>
            )}
          {admin && current && data?.status === 'open' && (
            <Button variant="secondary" onClick={() => setAction('close')}>
              Cerrar tienda
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
      {admin && current && data?.openDay && data.openDay !== data.day && (
        <Button variant="secondary" onClick={() => setDate(data.openDay!)}>
          Cerrar jornada pendiente del {formatDate(data.openDay)}
        </Button>
      )}
      {admin && (
        <Input
          label="Consultar jornada"
          type="date"
          value={date || data?.day || ''}
          max={data?.today}
          disabled={action !== null}
          onChange={(e) => setDate(e.target.value)}
        />
      )}
      {admin && report && (
        <>
          <div className="day-metrics">
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
          <div className="day-payment-list">
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
      {action && current && data && (
        <DayDialog
          action={action}
          day={data}
          onClose={() => setAction(null)}
          onSaved={() => {
            setAction(null)
            refresh()
          }}
        />
      )}
    </Card>
  )
}

function DayDialog({
  action,
  day,
  onClose,
  onSaved,
}: {
  action: 'open' | 'close'
  day: BusinessDay
  onClose: () => void
  onSaved: () => void
}) {
  const [nio, setNio] = useState('')
  const [usd, setUsd] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState<{
    key: string
    requestId: string
  } | null>(null)
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const payload =
      action === 'open'
        ? { openingNio: Number(nio), openingUsd: Number(usd) }
        : {
            day: day.day,
            countedNio: Number(nio),
            countedUsd: Number(usd),
            note,
          }
    const key = JSON.stringify(payload)
    const requestId =
      attempt?.key === key ? attempt.requestId : crypto.randomUUID()
    setAttempt({ key, requestId })
    setBusy(true)
    setError('')
    try {
      await dayRpc(`${action}_business_day`, {
        p_input: { ...payload, requestId },
      })
      onSaved()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      title={action === 'open' ? 'Abrir tienda' : 'Cerrar tienda'}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form onSubmit={submit} className="day-form">
        <p>
          {action === 'open'
            ? 'Efectivo inicial en caja'
            : 'Efectivo contado al cierre'}{' '}
          · {formatDate(day.day)}
        </p>
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
            disabled={busy}
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
            disabled={busy}
          />
        </div>
        {action === 'close' && (
          <>
            <p>
              El cierre guarda el reporte y finaliza las ventas de esta jornada.
            </p>
            <Input
              label="Observación / motivo de diferencia"
              value={note}
              maxLength={1000}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
            />
          </>
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
            disabled={busy}
            onClick={onClose}
          >
            Cancelar
          </Button>
          <Button disabled={busy}>
            {busy
              ? 'Guardando…'
              : action === 'open'
                ? 'Confirmar apertura'
                : 'Confirmar cierre'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

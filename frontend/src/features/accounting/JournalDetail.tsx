import { useCallback, useState } from 'react'
import { Button, Dialog, ErrorState, LoadingState } from '../../components/ui'
import { useQuery } from '../../lib/useQuery'
import { errorMessage } from '../../lib/errors'
import { formatCurrency, formatDate } from '../../lib/format'
import { journalRpc } from './journalService'
import { journalNumber, type AutomaticJournalRecord } from './journalModel'
import { useServices } from '../../services/useServices'
import { useAccess } from '../../app/AccessContext'
import { OpeningJournalEditor } from './OpeningJournalEditor'
import type { JournalDetailRecord } from './journalModel'
export function JournalDetail({
  id,
  entry,
  onClose,
  onChanged,
  startEditing = false,
}: {
  id: string
  entry?: AutomaticJournalRecord
  onClose: () => void
  onChanged?: () => void
  startEditing?: boolean
}) {
  const load = useCallback(
    () =>
      entry
        ? Promise.resolve<JournalDetailRecord>(entry)
        : journalRpc<JournalDetailRecord>('get_journal_entry', { p_id: id }),
    [id, entry],
  )
  const { data: current, error, loading, retry, refresh } = useQuery(load)
  const [snapshot, setSnapshot] = useState<JournalDetailRecord | null>(null)
  const data = snapshot ?? current
  const [editing, setEditing] = useState(startEditing)
  const [pendingEdit, setPendingEdit] = useState(false)
  const { role, demo } = useAccess()
  const { salesService } = useServices()
  const [failure, setFailure] = useState(''),
    [busy, setBusy] = useState(false)
  const amount = (value: number | null, currency: 'NIO' | 'USD') =>
    value === null ? 'Pendiente' : formatCurrency(value, currency)
  const total = (key: 'debit' | 'credit') =>
    !data || data.lines.some((line) => line[key] === null)
      ? null
      : data.lines.reduce((sum, line) => sum + (line[key] ?? 0), 0)
  const warning = entry?.missingSales
    ? `Detalle contable pendiente en ${entry.missingSales} factura(s). Los importes del día están pendientes.`
    : entry?.missingCosts
      ? `Costo pendiente en ${entry.missingCosts} factura(s).`
      : ''
  async function download() {
    if (!data) return
    setBusy(true)
    setFailure('')
    try {
      const [{ jsPDF }, business] = await Promise.all([
        import('jspdf'),
        salesService.getBusiness(),
      ])
      const pdf = new jsPDF({ unit: 'mm', format: 'letter' })
      let y = 22
      pdf.setFont('helvetica', 'bold')
      pdf.setTextColor(88, 25, 30)
      pdf.setFontSize(16)
      pdf.text(business?.name ?? 'La Casa del Perfume', 18, y)
      y += 12
      pdf.setFontSize(12)
      pdf.text(`Comprobante ${journalNumber(data)}`, 18, y)
      y += 9
      pdf.setTextColor(45, 40, 37)
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(10)
      for (const text of [
        `Fecha: ${formatDate(data.occurred_on)}`,
        `Referencia: ${data.reference || '—'}`,
        `Moneda: ${data.currency} · Tipo de cambio: ${data.exchange_rate}`,
        ...(data.kind === 'opening' ? [`Revisión: ${data.revision ?? 0}`] : []),
        data.description,
        ...(warning ? [warning] : []),
        ...(data.voided_at ? [`ANULADO: ${data.void_reason}`] : []),
      ]) {
        for (const row of pdf.splitTextToSize(text, 178) as string[]) {
          pdf.text(row, 18, y)
          y += 6
        }
      }
      y += 7
      pdf.text('Cuenta', 18, y)
      pdf.text('Debe', 154, y, { align: 'right' })
      pdf.text('Haber', 198, y, { align: 'right' })
      y += 8
      for (const row of data.lines) {
        const names = pdf.splitTextToSize(
          `${row.displayAccount ?? row.account} · ${row.name}`,
          105,
        ) as string[]
        const height = names.length * 5 + 5
        if (y + height > 245) {
          pdf.addPage()
          y = 22
        }
        pdf.text(names, 18, y)
        pdf.text(amount(row.debit, data.currency), 154, y, {
          align: 'right',
        })
        pdf.text(amount(row.credit, data.currency), 198, y, {
          align: 'right',
        })
        y += height
      }
      if (y > 240) {
        pdf.addPage()
        y = 22
      }
      pdf.setFont('helvetica', 'bold')
      pdf.text('Totales', 18, y)
      pdf.text(amount(total('debit'), data.currency), 154, y, {
        align: 'right',
      })
      pdf.text(amount(total('credit'), data.currency), 198, y, {
        align: 'right',
      })
      pdf.save(`comprobante-${journalNumber(data)}.pdf`)
    } catch (e) {
      setFailure(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      title={
        editing
          ? `Editar apertura ${data ? journalNumber(data) : ''}`
          : data
            ? `Comprobante ${journalNumber(data)}`
            : 'Comprobante'
      }
      dismissible={!pendingEdit}
      onClose={() => {
        if (!pendingEdit) onClose()
      }}
      className="journal-dialog"
    >
      {loading ? (
        <LoadingState />
      ) : error || !data ? (
        <ErrorState message={error ?? 'Sin datos.'} retry={retry} />
      ) : editing ? (
        <OpeningJournalEditor
          entry={data}
          onPending={setPendingEdit}
          onCancel={() => {
            setEditing(false)
            refresh()
          }}
          onSaved={() => {
            setEditing(false)
            refresh()
            onChanged?.()
          }}
        />
      ) : (
        <>
          <p>
            {formatDate(data.occurred_on)} · {data.description}
          </p>
          <p>{data.reference}</p>
          {snapshot && (
            <div className="day-notice">
              <strong>
                Versión del historial · revisión {snapshot.revision ?? 0}
              </strong>
              <Button variant="secondary" onClick={() => setSnapshot(null)}>
                Volver a la versión actual
              </Button>
            </div>
          )}
          {warning && <p role="status">{warning}</p>}
          {data.voided_at && <p>ANULADO · {data.void_reason}</p>}
          <div className="accounting-table-scroll">
            <table className="accounting-table journal-detail-table">
              <thead>
                <tr>
                  <th>Cuenta</th>
                  <th>Debe {data.currency}</th>
                  <th>Haber {data.currency}</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l, i) => (
                  <tr key={i}>
                    <th scope="row">
                      {l.displayAccount ?? l.account} · {l.name}
                    </th>
                    <td data-label={`Debe ${data.currency}`}>
                      {amount(l.debit, data.currency)}
                    </td>
                    <td data-label={`Haber ${data.currency}`}>
                      {amount(l.credit, data.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {failure && (
            <p role="alert" className="inline-error">
              {failure}
            </p>
          )}
          <div className="form-actions">
            {!snapshot &&
              data.kind === 'opening' &&
              !data.voided_at &&
              !demo &&
              (role === 'admin' || role === 'superadmin') && (
                <Button onClick={() => setEditing(true)}>
                  Editar apertura
                </Button>
              )}
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void download()}
            >
              {busy ? 'Generando…' : 'Descargar PDF'}
            </Button>
          </div>
          {!!current?.openingHistory?.length && (
            <details className="day-history">
              <summary>
                Historial de ediciones ({current.openingHistory.length})
              </summary>
              {current.openingHistory.map((change) => (
                <article className="day-history-event" key={change.id}>
                  <div>
                    <strong>Edición · revisión {change.revision}</strong>
                    <span>
                      {new Intl.DateTimeFormat('es-NI', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                        timeZone: 'America/Managua',
                      }).format(new Date(change.createdAt))}{' '}
                      · {change.actorName}
                    </span>
                  </div>
                  <div className="form-actions">
                    <Button
                      variant="secondary"
                      onClick={() => setSnapshot(change.before)}
                    >
                      Ver versión anterior · revisión{' '}
                      {change.before.revision ?? 0}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setSnapshot(change.after)}
                    >
                      Ver versión guardada · revisión {change.revision}
                    </Button>
                  </div>
                </article>
              ))}
            </details>
          )}
        </>
      )}
    </Dialog>
  )
}

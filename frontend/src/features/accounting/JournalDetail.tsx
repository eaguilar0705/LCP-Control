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
import { MultiCurrencyJournal } from './MultiCurrencyJournal'
import { ReceiptEditor } from '../pricing/ReceiptEditor'
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
  const [editingReceipt, setEditingReceipt] = useState(false)
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
  const mixed =
    data?.lines.some(
      (l) =>
        l.currency &&
        (l.currency !== data.currency ||
          l.exchange_rate !== data.exchange_rate),
    ) ?? false
  const history = [
    ...(current?.openingHistory ?? []),
    ...(current?.editHistory ?? []),
  ]
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
        mixed
          ? 'Moneda y tipo de cambio por renglón · Totales en córdobas'
          : `Moneda: ${data.currency} · Tipo de cambio: ${data.exchange_rate}`,
        ...(data.revision !== undefined ? [`Revisión: ${data.revision}`] : []),
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
          `${row.displayAccount ?? row.account} · ${row.name}${mixed ? `\n${row.currency ?? data.currency} · tasa ${row.exchange_rate ?? data.exchange_rate} · ${formatCurrency((row.debit_nio ?? 0) || (row.credit_nio ?? 0), 'NIO')}` : ''}`,
          105,
        ) as string[]
        const height = names.length * 5 + 5
        if (y + height > 245) {
          pdf.addPage()
          y = 22
        }
        pdf.text(names, 18, y)
        pdf.text(amount(row.debit, row.currency ?? data.currency), 154, y, {
          align: 'right',
        })
        pdf.text(amount(row.credit, row.currency ?? data.currency), 198, y, {
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
      pdf.text(
        amount(
          mixed
            ? data.lines.reduce((s, l) => s + (l.debit_nio ?? 0), 0)
            : total('debit'),
          mixed ? 'NIO' : data.currency,
        ),
        154,
        y,
        {
          align: 'right',
        },
      )
      pdf.text(
        amount(
          mixed
            ? data.lines.reduce((s, l) => s + (l.credit_nio ?? 0), 0)
            : total('credit'),
          mixed ? 'NIO' : data.currency,
        ),
        198,
        y,
        {
          align: 'right',
        },
      )
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
          ? `Editar ${data?.kind === 'opening' ? 'apertura' : 'comprobante'} ${data ? journalNumber(data) : ''}`
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
      ) : editing && data.kind !== 'opening' ? (
        <MultiCurrencyJournal
          entry={data}
          accounts={data.editingAccounts ?? []}
          onPending={setPendingEdit}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            refresh()
            onChanged?.()
          }}
        />
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
          {data.inventoryCorrection && (
            <p className="accounting-note">
              Comprobante vinculado a una corrección de existencias. Conserva la
              cuenta de contrapartida elegida y el costo del movimiento.
            </p>
          )}
          <div className="accounting-table-scroll">
            <table className="accounting-table journal-detail-table">
              <thead>
                <tr>
                  <th>Cuenta</th>
                  <th>Debe {mixed ? '' : data.currency}</th>
                  <th>Haber {mixed ? '' : data.currency}</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l, i) => (
                  <tr key={i}>
                    <th scope="row">
                      {l.displayAccount ?? l.account} · {l.name}
                      {mixed && (
                        <small className="mixed-detail-rate">
                          {l.currency ?? data.currency} · tasa{' '}
                          {l.exchange_rate ?? data.exchange_rate} ·{' '}
                          {formatCurrency(
                            (l.debit_nio ?? 0) || (l.credit_nio ?? 0),
                            'NIO',
                          )}
                        </small>
                      )}
                    </th>
                    <td data-label={`Debe ${l.currency ?? data.currency}`}>
                      {amount(l.debit, l.currency ?? data.currency)}
                    </td>
                    <td data-label={`Haber ${l.currency ?? data.currency}`}>
                      {amount(l.credit, l.currency ?? data.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>Totales {mixed ? 'C$' : data.currency}</th>
                  <td>
                    {amount(
                      mixed
                        ? data.lines.reduce((s, l) => s + (l.debit_nio ?? 0), 0)
                        : total('debit'),
                      mixed ? 'NIO' : data.currency,
                    )}
                  </td>
                  <td>
                    {amount(
                      mixed
                        ? data.lines.reduce(
                            (s, l) => s + (l.credit_nio ?? 0),
                            0,
                          )
                        : total('credit'),
                      mixed ? 'NIO' : data.currency,
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          {failure && (
            <p role="alert" className="inline-error">
              {failure}
            </p>
          )}
          <div className="form-actions">
            {!snapshot && data.sourceReceiptId && role === 'superadmin' && (
              <Button onClick={() => setEditingReceipt(true)}>
                Editar recepción
              </Button>
            )}
            {!snapshot &&
              !data.receiptCorrection &&
              !data.inventoryCorrection &&
              !entry &&
              !data.voided_at &&
              !demo &&
              (role === 'superadmin' ||
                (data.kind === 'opening' && role === 'admin')) && (
                <Button onClick={() => setEditing(true)}>
                  {data.kind === 'opening'
                    ? 'Editar apertura'
                    : 'Editar comprobante'}
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
          {!!history.length && (
            <details className="day-history">
              <summary>Historial de ediciones ({history.length})</summary>
              {history.map((change) => (
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
      {editingReceipt && data?.sourceReceiptId && (
        <ReceiptEditor
          id={data.sourceReceiptId}
          onClose={() => setEditingReceipt(false)}
          onSaved={() => {
            setEditingReceipt(false)
            refresh()
            onChanged?.()
          }}
        />
      )}
    </Dialog>
  )
}

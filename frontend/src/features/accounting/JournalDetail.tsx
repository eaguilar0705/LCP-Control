import { useCallback, useState } from 'react'
import { Button, Dialog, ErrorState, LoadingState } from '../../components/ui'
import { useQuery } from '../../lib/useQuery'
import { errorMessage } from '../../lib/errors'
import { formatCurrency, formatDate } from '../../lib/format'
import { journalRpc } from './journalService'
import {
  journalNumber,
  type AutomaticJournalRecord,
  type JournalDetailLine,
  type JournalRecord,
} from './journalModel'
import { useServices } from '../../services/useServices'
interface Detail extends JournalRecord {
  lines: JournalDetailLine[]
}
export function JournalDetail({
  id,
  entry,
  onClose,
}: {
  id: string
  entry?: AutomaticJournalRecord
  onClose: () => void
}) {
  const load = useCallback(
    () =>
      entry
        ? Promise.resolve(entry)
        : journalRpc<Detail>('get_journal_entry', { p_id: id }),
    [id, entry],
  )
  const { data, error, loading, retry } = useQuery(load)
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
          `${row.account} · ${row.name}`,
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
      title={data ? `Comprobante ${journalNumber(data)}` : 'Comprobante'}
      onClose={onClose}
      className="journal-dialog"
    >
      {loading ? (
        <LoadingState />
      ) : error || !data ? (
        <ErrorState message={error ?? 'Sin datos.'} retry={retry} />
      ) : (
        <>
          <p>
            {formatDate(data.occurred_on)} · {data.description}
          </p>
          <p>{data.reference}</p>
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
                      {l.account} · {l.name}
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
          <Button disabled={busy} onClick={() => void download()}>
            {busy ? 'Generando…' : 'Descargar PDF'}
          </Button>
        </>
      )}
    </Dialog>
  )
}

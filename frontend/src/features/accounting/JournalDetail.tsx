import { useCallback, useState } from 'react'
import { Button, Dialog, ErrorState, LoadingState } from '../../components/ui'
import { useQuery } from '../../lib/useQuery'
import { errorMessage } from '../../lib/errors'
import { formatCurrency, formatDate } from '../../lib/format'
import { journalRpc } from './journalService'
import type { JournalRecord } from './journalModel'
import { useServices } from '../../services/useServices'
interface Detail extends JournalRecord {
  lines: {
    account: string
    name: string
    debit: number
    credit: number
    debit_nio: number
    credit_nio: number
  }[]
}
export function JournalDetail({
  id,
  onClose,
}: {
  id: string
  onClose: () => void
}) {
  const load = useCallback(
    () => journalRpc<Detail>('get_journal_entry', { p_id: id }),
    [id],
  )
  const { data, error, loading, retry } = useQuery(load)
  const { salesService } = useServices()
  const [failure, setFailure] = useState(''),
    [busy, setBusy] = useState(false)
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
      pdf.text(`Comprobante CP-${String(data.number).padStart(6, '0')}`, 18, y)
      y += 9
      pdf.setTextColor(45, 40, 37)
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(10)
      for (const text of [
        `Fecha: ${formatDate(data.occurred_on)}`,
        `Referencia: ${data.reference || '—'}`,
        `Moneda: ${data.currency} · Tipo de cambio: ${data.exchange_rate}`,
        data.description,
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
        pdf.text(formatCurrency(row.debit, data.currency), 154, y, {
          align: 'right',
        })
        pdf.text(formatCurrency(row.credit, data.currency), 198, y, {
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
        formatCurrency(
          data.lines.reduce((s, l) => s + l.debit, 0),
          data.currency,
        ),
        154,
        y,
        { align: 'right' },
      )
      pdf.text(
        formatCurrency(
          data.lines.reduce((s, l) => s + l.credit, 0),
          data.currency,
        ),
        198,
        y,
        { align: 'right' },
      )
      pdf.save(`comprobante-CP-${String(data.number).padStart(6, '0')}.pdf`)
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
        data
          ? `Comprobante CP-${String(data.number).padStart(6, '0')}`
          : 'Comprobante'
      }
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
          {data.voided_at && <p>ANULADO · {data.void_reason}</p>}
          <div className="accounting-table-scroll">
            <table className="accounting-table">
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
                    <td>{formatCurrency(l.debit, data.currency)}</td>
                    <td>{formatCurrency(l.credit, data.currency)}</td>
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

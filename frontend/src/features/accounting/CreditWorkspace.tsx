import { useCallback, useState } from 'react'
import { Button, Card, ErrorState, LoadingState } from '../../components/ui'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { formatCurrency, formatDate } from '../../lib/format'
import { RecordDialog, VoidDialog } from './FinanceMovements'
import { rowsOf, type Row } from './financeRows'
import type { CreditAccount } from './finance'
import type { ReportRange } from '../reports/model'

export function CreditWorkspace({
  range,
  bankAccounts,
  onChanged,
}: {
  range: ReportRange
  bankAccounts: { code: string; name: string }[]
  onChanged: () => void
}) {
  const { financeService } = useServices()
  const load = useCallback(async () => {
    const [credits, ledger] = await Promise.all([
      financeService.getCredits(range.to),
      financeService.getLedger(range),
    ])
    return { credits, ledger, range }
  }, [financeService, range])
  const { data, error, loading, retry, refresh } = useQuery(load)
  const [selected, setSelected] = useState<CreditAccount | null>(null)
  const [voiding, setVoiding] = useState<Row | null>(null)
  const [message, setMessage] = useState('')
  const changed = () => {
    refresh()
    onChanged()
  }
  if (error) return <ErrorState message={error} retry={retry} />
  if (
    loading ||
    !data ||
    data.range.from !== range.from ||
    data.range.to !== range.to
  )
    return <LoadingState />
  const payments = rowsOf(
    {
      ...data.ledger,
      expenses: [],
      entries: data.ledger.entries.filter(
        (e) => e.kind === 'collection' || e.kind === 'supplier_payment',
      ),
    },
    Object.fromEntries(bankAccounts.map((a) => [a.code, a.name])),
  )
  return (
    <>
      {message && (
        <p role="status" className="workspace-feedback">
          {message}
        </p>
      )}
      {(['receivable', 'payable'] as const).map((kind) => (
        <Card className="accounting-card" key={kind}>
          <h2>
            {kind === 'receivable' ? 'Cuentas por cobrar' : 'Cuentas por pagar'}
          </h2>
          <div
            className="accounting-table-scroll"
            tabIndex={0}
            role="region"
            aria-label={
              kind === 'receivable' ? 'Cuentas por cobrar' : 'Cuentas por pagar'
            }
          >
            <table className="accounting-table credit-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Documento</th>
                  <th>{kind === 'receivable' ? 'Cliente' : 'Proveedor'}</th>
                  <th>Importe C$</th>
                  <th>Abonado C$</th>
                  <th>Pendiente C$</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody>
                {data.credits.rows
                  .filter((r) => r.kind === kind)
                  .map((r) => (
                    <tr key={r.id}>
                      <td data-label="Fecha">{formatDate(r.occurredOn)}</td>
                      <th scope="row" data-label="Documento">
                        {r.reference}
                      </th>
                      <td
                        className="credit-party"
                        data-label={
                          kind === 'receivable' ? 'Cliente' : 'Proveedor'
                        }
                      >
                        {r.counterparty}
                      </td>
                      {[r.originalNio, r.paidNio, r.balanceNio].map((n, i) => (
                        <td
                          key={i}
                          data-label={['Importe', 'Abonado', 'Pendiente'][i]}
                        >
                          {n === null ? 'Pendiente' : formatCurrency(n, 'NIO')}
                        </td>
                      ))}
                      <td className="credit-action">
                        <Button
                          variant="secondary"
                          disabled={r.balanceNio === null || r.balanceNio <= 0}
                          onClick={() => setSelected(r)}
                        >
                          {kind === 'receivable' ? 'Cobrar' : 'Pagar'}
                        </Button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {!data.credits.rows.some((r) => r.kind === kind) && (
            <p>Sin cuentas registradas.</p>
          )}
        </Card>
      ))}
      <Card className="accounting-card">
        <h2>Abonos del período</h2>
        <div
          className="accounting-table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Abonos del período"
        >
          <table className="accounting-table credit-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Detalle</th>
                <th>Cuenta</th>
                <th>Importe C$</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((r) => (
                <tr key={r.id}>
                  <td data-label="Fecha">{formatDate(r.day)}</td>
                  <th
                    scope="row"
                    className="credit-detail"
                    data-label="Detalle"
                  >
                    {r.type}
                    <small>{r.detail}</small>
                  </th>
                  <td data-label="Cuenta">{r.account}</td>
                  <td data-label="Importe">
                    {formatCurrency(r.amountNio, 'NIO')}
                  </td>
                  <td className="credit-action">
                    {r.voidReason !== null ? (
                      'Anulado'
                    ) : (
                      <Button variant="ghost" onClick={() => setVoiding(r)}>
                        Anular abono
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!payments.length && <p>Sin abonos en este período.</p>}
      </Card>
      {selected && (
        <RecordDialog
          initialCredit={selected}
          bankAccounts={bankAccounts}
          onClose={() => setSelected(null)}
          onRecorded={(text) => {
            setSelected(null)
            setMessage(text)
            changed()
          }}
        />
      )}
      {voiding && (
        <VoidDialog
          row={voiding}
          onClose={() => setVoiding(null)}
          onVoided={() => {
            setVoiding(null)
            setMessage('Abono anulado.')
            changed()
          }}
        />
      )}
    </>
  )
}

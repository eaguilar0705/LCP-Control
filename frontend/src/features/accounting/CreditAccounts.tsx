import { useState } from 'react'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Select,
} from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { can } from '../../lib/permissions'
import { formatCurrency, formatDate } from '../../lib/format'
import { roundMoney } from '../reports/accounting'
import { RecordDialog } from './FinanceMovements'
import type { CreditAccount, CreditLedger } from './finance'

const money = (amount: number | null) =>
  amount === null ? 'Pendiente' : formatCurrency(amount, 'NIO')
const searchText = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')

/** Todas las deudas vigentes al corte, incluso las emitidas antes del período. */
export function CreditAccounts({
  ledger,
  onChanged,
}: {
  ledger: CreditLedger
  onChanged: () => void
}) {
  const { demo, role } = useAccess()
  const writable = !demo && can(role, 'finance.read') && ledger.available
  const [kind, setKind] = useState<'all' | CreditAccount['kind']>('all')
  const [status, setStatus] = useState<'pending' | 'settled' | 'all'>('pending')
  const [search, setSearch] = useState('')
  const [credit, setCredit] = useState<CreditAccount | null>(null)
  const [message, setMessage] = useState('')
  const rows = ledger.rows.filter((row) => {
    if (kind !== 'all' && kind !== row.kind) return false
    if (status === 'settled' && row.balanceNio !== 0) return false
    if (status === 'pending' && row.balanceNio === 0) return false
    return searchText(`${row.counterparty} ${row.reference}`).includes(
      searchText(search.trim()),
    )
  })
  const total = (type: CreditAccount['kind']) => {
    const accounts = ledger.rows.filter((row) => row.kind === type)
    const known = roundMoney(
      accounts.reduce((sum, row) => sum + (row.balanceNio ?? 0), 0),
    )
    const missing = accounts.filter((row) => row.balanceNio === null).length
    return { known, missing }
  }
  const receivables = total('receivable')
  const payables = total('payable')

  return (
    <>
      {message && (
        <p role="status" className="workspace-feedback">
          {message}
        </p>
      )}
      <Card className="accounting-card">
        <div className="section-heading">
          <div>
            <h2>Cuentas por cobrar y pagar</h2>
            <p className="accounting-note">
              Saldos al {formatDate(ledger.at)}. Los abonos se aplican a su
              factura o pedido.
            </p>
          </div>
        </div>
        {!ledger.available ? (
          <p className="inline-error" role="alert">
            Falta aplicar la actualización de cuentas por cobrar y pagar en la
            base de datos.
          </p>
        ) : (
          <>
            {!ledger.startOn && (
              <p className="accounting-callout" role="status">
                Puedes registrar abonos a estas cuentas. Registra el saldo
                inicial para que caja, bancos y el balance general reflejen los
                movimientos.
              </p>
            )}
            {ledger.legacyPayments > 0 && (
              <p className="accounting-callout" role="status">
                Hay {ledger.legacyPayments} cobro(s) o pago(s) histórico(s) sin
                factura o pedido asociado. Revísalos antes de cobrar o pagar
                estas cuentas: sus importes se conservan en los saldos generales
                y pueden requerir conciliación.
              </p>
            )}
            <div
              className="accounting-two-columns"
              aria-label="Saldos de crédito"
            >
              {[
                { label: 'Por cobrar a clientes', ...receivables },
                { label: 'Por pagar a proveedores', ...payables },
              ].map((summary) => (
                <div className="accounting-metric" key={summary.label}>
                  <span>{summary.label}</span>
                  <strong>{money(summary.known)}</strong>
                  {summary.missing > 0 && (
                    <small>
                      {summary.missing} documento(s) con importe pendiente,
                      excluidos de esta suma.
                    </small>
                  )}
                </div>
              ))}
            </div>
            <div className="filter-grid">
              <Select
                label="Tipo de cuenta"
                value={kind}
                onChange={(event) => setKind(event.target.value as typeof kind)}
              >
                <option value="all">Cobrar y pagar</option>
                <option value="receivable">Por cobrar</option>
                <option value="payable">Por pagar</option>
              </Select>
              <Select
                label="Estado de cuenta"
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as typeof status)
                }
              >
                <option value="pending">Pendientes</option>
                <option value="settled">Saldadas</option>
                <option value="all">Todas</option>
              </Select>
              <Input
                label="Cliente, proveedor o referencia"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <p className="accounting-note" role="status">
              {rows.length} cuenta(s) en la lista.
            </p>
            {rows.length === 0 ? (
              <EmptyState title="Sin cuentas para estos filtros" />
            ) : (
              <div
                className="accounting-table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Cuentas de crédito al corte"
              >
                <table className="accounting-table">
                  <caption className="sr-only">
                    Cuentas por cobrar y pagar al corte
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Fecha / documento</th>
                      <th scope="col">Cliente o proveedor</th>
                      <th scope="col">Tipo</th>
                      <th scope="col" className="num">
                        Original C$
                      </th>
                      <th scope="col" className="num">
                        Abonado C$
                      </th>
                      <th scope="col" className="num">
                        Saldo C$
                      </th>
                      <th scope="col">Estado</th>
                      <th scope="col">
                        <span className="sr-only">Acciones</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <th scope="row">
                          {row.reference ||
                            (row.documentId
                              ? 'Factura'
                              : row.shipmentId
                                ? 'Pedido'
                                : 'Saldo inicial')}
                          <small>{formatDate(row.occurredOn)}</small>
                        </th>
                        <td>{row.counterparty || 'Sin identificar'}</td>
                        <td>
                          {row.kind === 'receivable'
                            ? 'Por cobrar'
                            : 'Por pagar'}
                        </td>
                        <td className="num">{money(row.originalNio)}</td>
                        <td className="num">{money(row.paidNio)}</td>
                        <td className="num">{money(row.balanceNio)}</td>
                        <td>
                          <Badge
                            tone={row.balanceNio === 0 ? 'success' : 'warning'}
                          >
                            {row.balanceNio === null
                              ? 'Importe pendiente'
                              : row.balanceNio === 0
                                ? 'Saldada'
                                : row.balanceNio < 0
                                  ? 'Revisar saldo'
                                  : (row.paidNio ?? 0) > 0
                                    ? 'Abonada'
                                    : 'Pendiente'}
                          </Badge>
                        </td>
                        <td>
                          <Button
                            variant="ghost"
                            disabled={
                              !writable ||
                              row.balanceNio === null ||
                              row.balanceNio <= 0
                            }
                            aria-label={`Registrar abono a ${row.reference || row.counterparty}`}
                            onClick={() => {
                              setMessage('')
                              setCredit(row)
                            }}
                          >
                            Registrar abono
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>
      {credit && (
        <RecordDialog
          initialCredit={credit}
          onClose={() => setCredit(null)}
          onRecorded={() => {
            setCredit(null)
            setMessage('Abono registrado.')
            onChanged()
          }}
        />
      )}
    </>
  )
}

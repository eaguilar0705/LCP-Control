import { useState, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { Button, Card, Dialog, EmptyState } from '../../components/ui'
import { formatCurrency, formatDate } from '../../lib/format'
import {
  accountingViews,
  chartOfAccounts,
  type AccountingModel,
} from './accountingModel'
import type { FinanceLedger } from './finance'
import { RecordDialog, VoidDialog } from './FinanceMovements'
import { rowsOf, type Row } from './financeRows'
import { useWritable } from './financeAccess'

const amount = (value: number | null, negative = false) => {
  if (value === null) return 'Pendiente'
  if (negative) {
    const effect = -value
    const formatted = formatCurrency(Math.abs(effect), 'NIO')
    return effect < 0 ? `(${formatted})` : formatted
  }
  const formatted = formatCurrency(value, 'NIO')
  return formatted
}

function ScrollTable({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div
      className="accounting-table-scroll"
      tabIndex={0}
      role="region"
      aria-label={title}
    >
      {children}
    </div>
  )
}

export function AccountCatalog({
  accounts = chartOfAccounts,
}: {
  accounts?: AccountingModel['catalog']
}) {
  return (
    <Card className="accounting-card">
      <div className="statement-heading">
        <h2>{accountingViews.catalog}</h2>
        <p>
          Cuentas vinculadas a ventas, compras, inventario y gastos de la
          perfumería.
        </p>
      </div>
      <ScrollTable title={accountingViews.catalog}>
        <table className="statement-table accounting-template-table accounting-catalog">
          <caption className="sr-only">{accountingViews.catalog}</caption>
          <thead>
            <tr>
              <th scope="col">Código</th>
              <th scope="col">Descripción</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr
                key={account.code}
                className={
                  account.kind === 'group'
                    ? 'statement-group'
                    : 'statement-line'
                }
              >
                <td className="accounting-code">{account.code}</td>
                <th scope="row">{account.description}</th>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollTable>
    </Card>
  )
}

export function AccountingTables({
  view,
  model,
  ledger,
  onChanged,
  readOnly = false,
}: {
  view: 'trial' | 'income' | 'balance'
  model: AccountingModel
  ledger: FinanceLedger
  onChanged: () => void
  readOnly?: boolean
}) {
  const [recording, setRecording] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [voiding, setVoiding] = useState<Row | null>(null)
  const [message, setMessage] = useState('')
  const writable = useWritable(ledger)
  const records = rowsOf(ledger)
  const title = accountingViews[view]
  const hasPending =
    view === 'trial'
      ? model.trial.some((row) =>
          [
            row.openingNio,
            row.debitNio,
            row.creditNio,
            row.closingNio,
          ].includes(null),
        ) || Object.values(model.trialTotals).includes(null)
      : view === 'income'
        ? model.income.some(
            (row) =>
              row.kind !== 'heading' &&
              (row.periodNio === null || row.accumulatedNio === null),
          )
        : [...model.balance.left, ...model.balance.right].some(
            (row) => row.kind !== 'heading' && row.amount === null,
          )
  return (
    <>
      {message && (
        <p role="status" className="workspace-feedback">
          {message}
        </p>
      )}
      <Card className="accounting-card">
        <div className="section-heading">
          <div className="statement-heading">
            <h2>{title}</h2>
            <p>
              {model.businessName} ·{' '}
              {view === 'balance'
                ? `Al ${formatDate(model.range.to)}`
                : `Del ${formatDate(model.range.from)} al ${formatDate(model.range.to)}`}{' '}
              · C$
            </p>
          </div>
          {view === 'trial' && !readOnly && (
            <div className="accounting-register-actions">
              <Button variant="secondary" onClick={() => setReviewing(true)}>
                Registros
              </Button>
              <Button
                disabled={!writable}
                onClick={() => {
                  setMessage('')
                  setRecording(true)
                }}
              >
                <Plus size={17} />
                Registrar
              </Button>
            </div>
          )}
        </div>
        {model.warningsByView[view].length > 0 && (
          <div className="accounting-callout" role="status">
            {model.warningsByView[view].map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        )}
        {hasPending && (
          <p className="accounting-note">
            Pendiente indica información insuficiente; no equivale a cero.
            Revisa los avisos de este estado.
          </p>
        )}
        {view === 'trial' && (
          <ScrollTable title={title}>
            <table className="statement-table accounting-template-table accounting-trial">
              <caption className="sr-only">{title}</caption>
              <thead>
                <tr>
                  <th scope="col">Cuenta</th>
                  <th scope="col">Descripción</th>
                  {['Saldo inicial', 'Debe', 'Haber', 'Saldo final'].map(
                    (label) => (
                      <th key={label} scope="col" className="num">
                        {label}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {model.trial.map((row) => (
                  <tr key={row.code}>
                    <td className="accounting-code">{row.code}</td>
                    <th scope="row">{row.description}</th>
                    <td className="num">{amount(row.openingNio)}</td>
                    <td className="num">{amount(row.debitNio)}</td>
                    <td className="num">{amount(row.creditNio)}</td>
                    <td className="num">{amount(row.closingNio)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="statement-total">
                  <th colSpan={2} scope="row">
                    Totales
                  </th>
                  <td className="num">
                    {amount(model.trialTotals.openingNio)}
                  </td>
                  <td className="num">{amount(model.trialTotals.debitNio)}</td>
                  <td className="num">{amount(model.trialTotals.creditNio)}</td>
                  <td className="num">
                    {amount(model.trialTotals.closingNio)}
                  </td>
                </tr>
              </tfoot>
            </table>
            <p className="accounting-note">
              El saldo inicial corresponde al día anterior al inicio del
              período. Debe y Haber incluyen los movimientos del período. Saldo
              final: deudoras = inicial + Debe − Haber; acreedoras = inicial −
              Debe + Haber. Los totales de saldos muestran la diferencia entre
              deudores y acreedores.
            </p>
          </ScrollTable>
        )}
        {view === 'income' && (
          <>
            <p className="accounting-note">
              Acumulado desde el {formatDate(model.accumulatedFrom)} hasta el{' '}
              {formatDate(model.range.to)}.
            </p>
            <ScrollTable title={title}>
              <table className="statement-table accounting-template-table">
                <caption className="sr-only">{title}</caption>
                <thead>
                  <tr>
                    <th scope="col">Cuenta</th>
                    <th scope="col">Descripción</th>
                    <th scope="col" className="num">
                      Movimiento del período
                    </th>
                    <th scope="col" className="num">
                      Acumulado a fecha
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {model.income.map((row, index) => (
                    <tr
                      key={`${row.code}-${index}`}
                      className={`statement-${row.kind}`}
                    >
                      <td className="accounting-code">{row.code}</td>
                      <th scope="row">{row.description}</th>
                      <td className="num">
                        {row.kind === 'heading'
                          ? ''
                          : amount(row.periodNio, row.negative)}
                      </td>
                      <td className="num">
                        {row.kind === 'heading'
                          ? ''
                          : amount(row.accumulatedNio, row.negative)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTable>
          </>
        )}
        {view === 'balance' && (
          <div className="accounting-balance-columns">
            {(['left', 'right'] as const).map((side) => (
              <ScrollTable
                key={side}
                title={side === 'left' ? 'Activo' : 'Pasivo y capital'}
              >
                <table className="statement-table accounting-template-table">
                  <caption className="sr-only">
                    {side === 'left' ? 'Activo' : 'Pasivo y capital'}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Código</th>
                      <th scope="col">Descripción</th>
                      <th scope="col" className="num">
                        Saldo
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {model.balance[side].map((row, index) => (
                      <tr
                        key={`${row.code}-${index}`}
                        className={`statement-${row.kind}`}
                      >
                        <td className="accounting-code">{row.code}</td>
                        <th scope="row">{row.description}</th>
                        <td className="num">
                          {row.kind === 'heading' ? '' : amount(row.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollTable>
            ))}
          </div>
        )}
      </Card>
      {recording && (
        <RecordDialog
          onClose={() => setRecording(false)}
          onRecorded={(feedback) => {
            setRecording(false)
            setMessage(feedback)
            onChanged()
          }}
        />
      )}
      {reviewing && (
        <Dialog
          open
          title="Registros de la balanza"
          className="accounting-records-dialog"
          onClose={() => setReviewing(false)}
        >
          {records.length === 0 ? (
            <EmptyState />
          ) : (
            <ScrollTable title="Movimientos y gastos registrados">
              <table className="accounting-table">
                <thead>
                  <tr>
                    <th scope="col">Fecha</th>
                    <th scope="col">Movimiento</th>
                    <th scope="col">Cuenta</th>
                    <th scope="col" className="num">
                      Importe
                    </th>
                    <th scope="col">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((row) => (
                    <tr key={`${row.source}-${row.id}`}>
                      <td>{formatDate(row.day)}</td>
                      <th scope="row">
                        {row.type}
                        <small>{row.detail}</small>
                      </th>
                      <td>{row.account}</td>
                      <td className="num">{amount(row.amountNio)}</td>
                      <td>
                        {row.voidReason !== null ? (
                          'Anulado'
                        ) : (
                          <Button
                            variant="secondary"
                            disabled={!writable}
                            onClick={() => {
                              setReviewing(false)
                              setVoiding(row)
                            }}
                          >
                            Anular
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTable>
          )}
        </Dialog>
      )}
      {voiding && (
        <VoidDialog
          row={voiding}
          onClose={() => setVoiding(null)}
          onVoided={() => {
            setVoiding(null)
            setMessage('Registro anulado.')
            onChanged()
          }}
        />
      )}
    </>
  )
}

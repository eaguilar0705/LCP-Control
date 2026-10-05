import { useCallback, useState, type ReactNode } from 'react'
import { FileSpreadsheet, RefreshCw } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
} from '../../components/ui'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { formatCurrency, formatDate } from '../../lib/format'
import { errorMessage } from '../../lib/errors'
import { localDay } from '../reports/model'
import { HISTORY_PAGE_SIZE } from '../sales/period'
import {
  dailyActivities,
  dailyAccountRows,
  dailyMetrics,
  dailyNotices,
  dailyPaymentRows,
  dailyMoney as money,
  dailyPayment as payment,
  validClosingDay,
} from './dailyActivity'

const time = new Intl.DateTimeFormat('es-NI', {
  timeZone: 'America/Managua',
  hour: '2-digit',
  minute: '2-digit',
})
function ActivityTable({
  label,
  headings,
  numeric = [],
  rows,
}: {
  label: string
  headings: string[]
  numeric?: number[]
  rows: { id: string; cells: ReactNode[]; voided?: boolean }[]
}) {
  return (
    <div
      className="accounting-table-scroll"
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      <table className="accounting-table">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr>
            {headings.map((heading, index) => (
              <th
                key={heading}
                scope="col"
                className={numeric.includes(index) ? 'num' : undefined}
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={row.voided ? 'accounting-voided' : undefined}
            >
              {row.cells.map((cell, index) =>
                index === 0 ? (
                  <th key={index} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td
                    key={index}
                    className={numeric.includes(index) ? 'num' : undefined}
                  >
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function DailyActivityPanel() {
  const today = localDay(new Date())
  const [day, setDay] = useState(today)
  const [revision, setRevision] = useState(0)
  const valid = validClosingDay(day, today)
  return (
    <>
      <Card className="accounting-card">
        <div className="section-heading">
          <h2>Cierre diario</h2>
          <div className="daily-activity-filters">
            <Input
              label="Día del cierre"
              type="date"
              max={today}
              value={day}
              error={
                valid ? undefined : 'Selecciona una fecha válida hasta hoy.'
              }
              onChange={(event) => setDay(event.target.value)}
            />
            <Button
              variant="secondary"
              disabled={!valid}
              onClick={() => setRevision((value) => value + 1)}
            >
              <RefreshCw size={17} /> Actualizar
            </Button>
          </div>
        </div>
        <p className="accounting-note">
          Consulta las ventas y los movimientos registrados para el día en
          Managua. Los datos se actualizan al pulsar Actualizar.
        </p>
      </Card>
      {valid && (
        <DailyActivityData
          key={`${day}:${revision}`}
          day={day}
          revision={revision}
        />
      )}
    </>
  )
}

function DailyActivityData({
  day,
  revision,
}: {
  day: string
  revision: number
}) {
  const { reportService, financeService, salesService } = useServices()
  const [offset, setOffset] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const load = useCallback(async () => {
    const range = { from: day, to: day }
    const [report, ledger, flow] = await Promise.all([
      reportService.getSource(range),
      financeService.getLedger(range),
      financeService.getCashflow(range),
    ])
    return { day, revision, report, ledger, flow }
  }, [day, revision, reportService, financeService])
  const summary = useQuery(load)
  const loadInvoices = useCallback(
    async () => ({
      day,
      revision,
      offset,
      ...(await salesService.listDocuments('invoice', {
        range: { from: day, to: day },
        offset,
        limit: HISTORY_PAGE_SIZE,
      })),
    }),
    [day, revision, offset, salesService],
  )
  const invoices = useQuery(loadInvoices)
  const current =
    summary.data?.day === day && summary.data.revision === revision
      ? summary.data
      : null
  const page =
    invoices.data?.day === day &&
    invoices.data.revision === revision &&
    invoices.data.offset === offset
      ? invoices.data
      : null
  const movements = current
    ? dailyActivities(current.ledger, current.report.accounting.shipments, day)
    : []
  const payments = current ? dailyPaymentRows(current.report) : []

  async function exportExcel() {
    if (!current || exporting) return
    const snapshot = current
    const range = { ...snapshot.report.range }
    setExporting(true)
    setExportError('')
    try {
      const [{ accountingWorkbook }, business, credits, closings] =
        await Promise.all([
          import('./accountingWorkbook'),
          salesService.getBusiness().catch(() => null),
          financeService.getCredits(range.to),
          financeService.getCashClosings(range),
        ])
      accountingWorkbook(
        snapshot.report,
        snapshot.ledger.position,
        range,
        business?.name ?? 'La Casa del Perfume',
        { ledger: snapshot.ledger, credits, cashflow: snapshot.flow, closings },
      )
    } catch (cause) {
      setExportError(errorMessage(cause))
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      {summary.error ? (
        <ErrorState message={summary.error} retry={summary.retry} />
      ) : !current ? (
        <LoadingState />
      ) : (
        <>
          <Card className="accounting-card">
            <div className="section-heading">
              <h3>Resumen del {formatDate(day)}</h3>
              <Button
                variant="secondary"
                disabled={exporting}
                onClick={() => void exportExcel()}
              >
                <FileSpreadsheet size={17} />{' '}
                {exporting ? 'Generando…' : 'Descargar Excel'}
              </Button>
            </div>
            {exportError && (
              <p className="inline-error" role="alert">
                {exportError}
              </p>
            )}
          </Card>
          {dailyNotices(current.report, current.ledger, current.flow).map(
            (notice) => (
              <p key={notice} className="accounting-callout" role="status">
                {notice}
              </p>
            ),
          )}
          <div
            className="accounting-metrics"
            aria-label={`Resumen del ${formatDate(day)}`}
          >
            {dailyMetrics(current.report, current.flow).map(
              ([label, value]) => (
                <div className="accounting-metric" key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ),
            )}
          </div>
          <p className="accounting-note">
            Las ventas incluyen las facturas a crédito. Las entradas incluyen
            ventas cobradas, abonos y otros ingresos; las salidas incluyen pagos
            y gastos. El flujo neto excluye saldos iniciales y transferencias
            entre caja y banco.
          </p>
          <div className="daily-activity-summaries">
            <Card className="accounting-card">
              <h3>Caja y banco al cierre</h3>
              <ActivityTable
                label="Saldos del día por cuenta"
                headings={[
                  'Cuenta',
                  'Saldo anterior C$',
                  'Entradas C$',
                  'Salidas C$',
                  'Saldo final C$',
                ]}
                numeric={[1, 2, 3, 4]}
                rows={dailyAccountRows(current.flow)}
              />
              <p className="accounting-note">
                Los movimientos de cada cuenta incluyen aperturas y
                transferencias. Una cuenta sin saldo inicial queda pendiente.
              </p>
            </Card>
            <Card className="accounting-card">
              <h3>Ventas por forma de pago</h3>
              {!payments.length ? (
                <EmptyState title="Sin ventas en este día" />
              ) : (
                <ActivityTable
                  label="Ventas por forma de pago"
                  headings={['Forma de pago', 'Moneda', 'Facturas', 'Importe']}
                  numeric={[2, 3]}
                  rows={payments}
                />
              )}
              <p className="accounting-note">
                Importes de las facturas en su moneda original; los abonos se
                consultan en movimientos.
              </p>
            </Card>
          </div>
          <Card className="accounting-card">
            <h3>Movimientos del día</h3>
            <p className="accounting-note">
              Gastos, compras, abonos, aportes, retiros, préstamos y
              transferencias. Las compras incluyen mercadería y envío, con la
              tasa guardada al registrarlas.
            </p>
            {!movements.length ? (
              <EmptyState title="Sin movimientos contables en este día" />
            ) : (
              <ActivityTable
                label="Movimientos contables del día"
                headings={[
                  'Tipo / registro',
                  'Descripción',
                  'Cuenta',
                  'Importe original',
                  'Equivalente C$',
                  'Estado',
                ]}
                numeric={[3, 4]}
                rows={movements.map((row) => ({
                  id: row.id,
                  voided: row.voidReason !== null,
                  cells: [
                    <>
                      {row.type}
                      <small>
                        Registrado {formatDate(row.createdAt)} ·{' '}
                        {time.format(new Date(row.createdAt))}
                      </small>
                    </>,
                    row.detail || 'Sin descripción',
                    row.account,
                    formatCurrency(row.amount, row.currency),
                    money(row.amountNio),
                    row.voidReason === null ? (
                      <Badge>Registrado</Badge>
                    ) : (
                      <>
                        <Badge>Anulado</Badge>
                        <small>{row.voidReason || 'Sin motivo'}</small>
                      </>
                    ),
                  ],
                }))}
              />
            )}
            <p className="accounting-note">
              Los registros anulados se conservan en el detalle y no afectan los
              saldos ni el flujo de dinero.
            </p>
          </Card>
        </>
      )}
      <Card className="accounting-card">
        <h3>Facturas del día</h3>
        {invoices.error ? (
          <ErrorState message={invoices.error} retry={invoices.retry} />
        ) : !page ? (
          <LoadingState />
        ) : (
          <>
            {!page.documents.length ? (
              <EmptyState
                title={
                  page.total === 0
                    ? 'Sin facturas en este día'
                    : 'Sin facturas en esta página'
                }
              />
            ) : (
              <ActivityTable
                label="Facturas emitidas en el día"
                headings={[
                  'Factura',
                  'Hora',
                  'Cliente / productos',
                  'Forma de pago',
                  'Moneda',
                  'Importe',
                ]}
                numeric={[5]}
                rows={page.documents.map((document) => ({
                  id: document.id,
                  cells: [
                    document.number,
                    time.format(new Date(document.createdAt)),
                    <>
                      {document.customerName || 'Consumidor final'}
                      <details className="daily-activity-products">
                        <summary>
                          Ver productos ({document.items.length})
                        </summary>
                        <ul>
                          {document.items.map((item) => (
                            <li key={item.id}>
                              {item.quantity} × {item.description} ·{' '}
                              {formatCurrency(
                                item.lineTotal,
                                document.currency,
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </>,
                    payment(document.paymentMethod),
                    document.currency,
                    formatCurrency(document.total, document.currency),
                  ],
                }))}
              />
            )}
            <div className="form-actions">
              <Button
                variant="secondary"
                disabled={offset === 0}
                onClick={() =>
                  setOffset(Math.max(0, offset - HISTORY_PAGE_SIZE))
                }
              >
                Anterior
              </Button>
              <span role="status">
                Página {Math.floor(offset / HISTORY_PAGE_SIZE) + 1} ·{' '}
                {page.total} facturas
              </span>
              <Button
                variant="secondary"
                disabled={offset + HISTORY_PAGE_SIZE >= page.total}
                onClick={() => setOffset(offset + HISTORY_PAGE_SIZE)}
              >
                Siguiente
              </Button>
            </div>
          </>
        )}
      </Card>
    </>
  )
}

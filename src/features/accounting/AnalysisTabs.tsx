import { useMemo, useState, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Input } from '../../components/ui'
import { formatCurrency, formatDate } from '../../lib/format'
import { matchesSearch } from '../../lib/search'
import { priceTierLabels, productPrice, marginRate } from '../../lib/pricing'
import { totalStock } from '../inventory/model'
import {
  accountOf,
  accountingByMonth,
  accountingSummary,
  belowCostSummary,
  catalogMargins,
  expenseAccounts,
  expenseLabel,
  inventoryTurnover,
  roundMoney,
} from '../reports/accounting'
import { localDay, type ReportRange } from '../reports/model'
import {
  closeOf,
  dailyClose,
  dailyTotals,
  type DailyClose,
} from '../reports/statement'
import type { ReportData } from '../reports/digest'
import {
  moneyAccounts,
  type FinanceLedger,
  type FinancePosition,
} from './finance'
import { RecordDialog, VoidDialog } from './FinanceMovements'
import { rowsOf, useWritable, type Row } from './financeRows'
import { financialRatios, type Ratio } from './ratios'

const money = (amount: number) => formatCurrency(amount, 'NIO')
const percent = new Intl.NumberFormat('es-NI', {
  style: 'percent',
  maximumFractionDigits: 1,
})
const decimal = new Intl.NumberFormat('es-NI', { maximumFractionDigits: 2 })
const monthName = new Intl.DateTimeFormat('es-NI', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})
const share = (part: number, whole: number) =>
  whole > 0 ? percent.format(part / whole) : '—'

function Line({ label, amount }: { label: string; amount: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{amount}</dd>
    </div>
  )
}
/** `numeric`: índices de las columnas con cifras, alineadas a la derecha. */
function LedgerTable({
  label,
  headings,
  numeric = [],
  children,
  footer,
}: {
  label: string
  headings: string[]
  numeric?: number[]
  children: ReactNode
  footer?: ReactNode
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
                scope="col"
                className={numeric.includes(index) ? 'num' : undefined}
                key={index}
              >
                {heading || <span className="sr-only">Acciones</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  )
}
function Feedback({ message }: { message: string }) {
  return message ? (
    <p role="status" className="workspace-feedback">
      {message}
    </p>
  ) : null
}

/**
 * Gastos del período por cuenta y por categoría, con su peso sobre el total
 * de gastos y sobre las ventas, y el detalle de cada comprobante.
 */
export function ExpensesTab({
  report,
  ledger,
  range,
  onChanged,
}: {
  report: ReportData
  ledger: FinanceLedger
  range: ReportRange
  onChanged: () => void
}) {
  const summary = useMemo(
    () => accountingSummary(report, range),
    [report, range],
  )
  const writable = useWritable(ledger)
  const [recording, setRecording] = useState(false)
  const [voiding, setVoiding] = useState<Row | null>(null)
  const [message, setMessage] = useState('')
  const accounts = summary.expenseByAccount
  const total = roundMoney(
    accounts.reduce((sum, row) => sum + row.amountNio, 0),
  )
  const typed = roundMoney(
    summary.expenseGroups.reduce((sum, row) => sum + row.amountNio, 0),
  )
  const rows = rowsOf({ ...ledger, entries: [] })
  const expenseById = new Map(ledger.expenses.map((row) => [row.id, row]))
  return (
    <>
      <Feedback message={message} />
      <Card className="accounting-card">
        <div className="section-heading">
          <h2>Gastos por cuenta</h2>
          <Button
            disabled={!writable}
            onClick={() => {
              setMessage('')
              setRecording(true)
            }}
          >
            <Plus size={17} />
            Registrar gasto
          </Button>
        </div>
        <LedgerTable
          label="Gastos por cuenta"
          headings={['Cuenta', 'Importe C$', '% del total', '% de ventas']}
          numeric={[1, 2, 3]}
          footer={
            <tr className="statement-total">
              <th scope="row">Total</th>
              <td className="num">{money(total)}</td>
              <td className="num">{total > 0 ? '100 %' : '—'}</td>
              <td className="num">{share(total, summary.revenueNio)}</td>
            </tr>
          }
        >
          {accounts.map((row) => (
            <tr key={row.account}>
              <th scope="row">
                {expenseAccounts[row.account].label}
                {!row.deducts && <small>No resta del resultado</small>}
              </th>
              <td className="num">{money(row.amountNio)}</td>
              <td className="num">{share(row.amountNio, total)}</td>
              <td className="num">
                {share(row.amountNio, summary.revenueNio)}
              </td>
            </tr>
          ))}
        </LedgerTable>
      </Card>
      <Card className="accounting-card">
        <h3>Gasto ponderado por categoría</h3>
        {summary.expenseGroups.length === 0 ? (
          <EmptyState title="Sin gastos en este período" />
        ) : (
          <LedgerTable
            label="Gasto ponderado por categoría"
            headings={[
              'Categoría',
              'Cuenta',
              'Importe C$',
              'Peso',
              '% de ventas',
            ]}
            numeric={[2, 3, 4]}
          >
            {[...summary.expenseGroups]
              .sort((a, b) => b.amountNio - a.amountNio)
              .map((row) => (
                <tr key={row.category}>
                  <th scope="row">{expenseLabel(row.category)}</th>
                  <td>{expenseAccounts[accountOf(row.category)].label}</td>
                  <td className="num">{money(row.amountNio)}</td>
                  <td className="num">
                    <span className="expense-weight">
                      <span
                        style={{
                          width: `${typed > 0 ? Math.round((row.amountNio / typed) * 100) : 0}%`,
                        }}
                      />
                    </span>
                    {share(row.amountNio, typed)}
                  </td>
                  <td className="num">
                    {share(row.amountNio, summary.revenueNio)}
                  </td>
                </tr>
              ))}
          </LedgerTable>
        )}
      </Card>
      <Card className="accounting-card">
        <h3>Comprobantes del período</h3>
        {rows.length === 0 ? (
          <EmptyState title="Sin gastos en este período" />
        ) : (
          <LedgerTable
            label="Comprobantes de gasto"
            headings={[
              'Fecha / categoría',
              'Descripción',
              'Pagado desde',
              'Importe C$',
              '',
            ]}
            numeric={[3]}
          >
            {rows.map((row) => {
              const expense = expenseById.get(row.id)
              return (
                <tr
                  key={row.id}
                  className={
                    row.voidReason !== null ? 'accounting-voided' : undefined
                  }
                >
                  <th scope="row">
                    {formatDate(row.day)}
                    <small>{row.type}</small>
                  </th>
                  <td>
                    {row.detail}
                    {expense?.reference && <small>{expense.reference}</small>}
                  </td>
                  <td>
                    {expense ? moneyAccounts[expense.account] : row.account}
                  </td>
                  <td className="num">
                    {money(row.amountNio)}
                    {expense?.currency === 'USD' && (
                      <small>{formatCurrency(expense.amount, 'USD')}</small>
                    )}
                  </td>
                  <td>
                    {row.voidReason !== null ? (
                      <>
                        <Badge>Anulado</Badge>
                        <small>{row.voidReason}</small>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        disabled={!writable}
                        aria-label={`Anular gasto ${row.detail}`}
                        onClick={() => {
                          setMessage('')
                          setVoiding(row)
                        }}
                      >
                        Anular
                      </Button>
                    )}
                  </td>
                </tr>
              )
            })}
          </LedgerTable>
        )}
      </Card>
      {recording && (
        <RecordDialog
          onClose={() => setRecording(false)}
          onRecorded={(text) => {
            setRecording(false)
            setMessage(text)
            onChanged()
          }}
        />
      )}
      {voiding && (
        <VoidDialog
          row={voiding}
          onClose={() => setVoiding(null)}
          onVoided={() => {
            setVoiding(null)
            setMessage('Gasto anulado.')
            onChanged()
          }}
        />
      )}
    </>
  )
}

/**
 * Costos: el costo promedio ponderado de cada perfume, lo que costó traer la
 * mercadería, el margen y la rentabilidad del período.
 */
export function CostsTab({
  report,
  range,
}: {
  report: ReportData
  range: ReportRange
}) {
  const summary = useMemo(
    () => accountingSummary(report, range),
    [report, range],
  )
  const turnover = useMemo(
    () => inventoryTurnover(summary, range),
    [summary, range],
  )
  const losses = useMemo(() => belowCostSummary(report, range), [report, range])
  const margins = useMemo(() => catalogMargins(report), [report])
  const months = useMemo(
    () => accountingByMonth(report, range),
    [report, range],
  )
  const [query, setQuery] = useState('')
  const costs = new Map(
    (report.accounting?.costs ?? []).map((row) => [
      row.productId,
      row.averageCostNio,
    ]),
  )
  const perfumes = report.inventory
    .map((item) => {
      const stock = totalStock(item)
      const cost = costs.get(item.product.id) ?? null
      const price = productPrice(item.product, 'emprendedor', 'NIO')
      return {
        id: item.product.id,
        name: item.product.name,
        brand: item.product.brand,
        barcode: item.product.barcode,
        stock,
        cost,
        value:
          stock !== null && cost !== null ? roundMoney(stock * cost) : null,
        price,
        margin: marginRate(price, cost),
      }
    })
    .filter((row) =>
      matchesSearch(`${row.name} ${row.brand} ${row.barcode}`, query),
    )
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
  const valued = roundMoney(
    perfumes.reduce((sum, row) => sum + (row.value ?? 0), 0),
  )
  const units = perfumes.reduce(
    (sum, row) => sum + (row.value === null ? 0 : (row.stock ?? 0)),
    0,
  )
  const pending = (amount: number | null) =>
    amount === null ? <Badge tone="warning">Pendiente</Badge> : money(amount)
  return (
    <>
      <div className="accounting-two-columns">
        <Card className="accounting-card">
          <h3>Compras del período</h3>
          <dl className="accounting-breakdown">
            <Line
              label="Precio de los perfumes"
              amount={money(summary.purchaseGoodsNio)}
            />
            <Line label="Envío" amount={money(summary.purchaseShippingNio)} />
            <Line label="Total" amount={money(summary.purchasesNio)} />
            <Line
              label="Unidades recibidas"
              amount={String(summary.purchasedUnits)}
            />
            <Line
              label="Envío por unidad"
              amount={
                summary.purchasedUnits
                  ? money(
                      roundMoney(
                        summary.purchaseShippingNio / summary.purchasedUnits,
                      ),
                    )
                  : '—'
              }
            />
          </dl>
        </Card>
        <Card className="accounting-card">
          <h3>Inventario</h3>
          <dl className="accounting-breakdown">
            <Line
              label="Valor a costo promedio"
              amount={money(summary.inventoryCostNio)}
            />
            <Line
              label="Costo de ventas del período"
              amount={money(summary.costOfSalesNio)}
            />
            <Line
              label="Perfumes sin costo"
              amount={String(summary.unvaluedProducts)}
            />
            <Line
              label="Rotación anual"
              amount={
                turnover.turnoverPerYear === null
                  ? 'Pendiente'
                  : `${decimal.format(turnover.turnoverPerYear)} veces`
              }
            />
            <Line
              label="Días de inventario"
              amount={
                turnover.daysOnHand === null
                  ? 'Pendiente'
                  : `${decimal.format(turnover.daysOnHand)} días`
              }
            />
          </dl>
        </Card>
      </div>
      <Card className="accounting-card">
        <div className="section-heading">
          <h3>Costo promedio ponderado por perfume</h3>
          <Badge>
            {money(valued)} · {units} u.
          </Badge>
        </div>
        <Input
          label="Buscar perfume"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {perfumes.length === 0 ? (
          <EmptyState />
        ) : (
          <LedgerTable
            label="Costo promedio ponderado por perfume"
            headings={[
              'Perfume',
              'Existencias',
              'Costo promedio',
              'Valor a costo',
              'Precio Emprendedor',
              'Margen',
            ]}
            numeric={[1, 2, 3, 4, 5]}
          >
            {perfumes.map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  {row.name}
                  <small>
                    {row.brand} · {row.barcode}
                  </small>
                </th>
                <td className="num">{row.stock ?? '—'}</td>
                <td className="num">
                  {row.cost === null ? '—' : money(row.cost)}
                </td>
                <td className="num">
                  {row.value === null ? '—' : money(row.value)}
                </td>
                <td className="num">
                  {row.price === null ? '—' : money(row.price)}
                </td>
                <td className="num">
                  {row.margin === null ? '—' : percent.format(row.margin)}
                </td>
              </tr>
            ))}
          </LedgerTable>
        )}
      </Card>
      {losses.count > 0 && (
        <Card className="accounting-card accounting-alert">
          <div className="section-heading">
            <h3>Ventas por debajo del costo</h3>
            <Badge tone="danger">{money(losses.lossNio)} de pérdida</Badge>
          </div>
          <LedgerTable
            label="Ventas por debajo del costo"
            headings={[
              'Documento',
              'Producto',
              'Unidades',
              'Venta',
              'Costo',
              'Pérdida',
            ]}
            numeric={[2, 3, 4, 5]}
          >
            {losses.rows.slice(0, 25).map((row) => (
              <tr key={`${row.documentId}:${row.productId}`}>
                <th scope="row">
                  {row.number}
                  <small>{formatDate(row.createdAt)}</small>
                </th>
                <td>{row.description}</td>
                <td className="num">{row.quantity}</td>
                <td className="num">{money(row.netRevenueNio)}</td>
                <td className="num">{money(row.costNio)}</td>
                <td className="num">{money(row.lossNio)}</td>
              </tr>
            ))}
          </LedgerTable>
        </Card>
      )}
      <Card className="accounting-card">
        <div className="section-heading">
          <h3>Rentabilidad por perfume vendido</h3>
          <Badge tone={summary.complete ? 'success' : 'warning'}>
            {summary.coverage === null
              ? 'Sin ventas'
              : `${Math.round(summary.coverage * 100)} % con costo`}
          </Badge>
        </div>
        {summary.products.length ? (
          <LedgerTable
            label="Rentabilidad por perfume"
            headings={['Perfume', 'Unidades', 'Venta', 'Costo', 'Margen bruto']}
            numeric={[1, 2, 3, 4]}
          >
            {summary.products.map((item) => (
              <tr key={item.productId}>
                <th scope="row">
                  {item.description}
                  {item.missingUnits > 0 && (
                    <small>{item.missingUnits} u. sin costo</small>
                  )}
                </th>
                <td className="num">{item.quantity}</td>
                <td className="num">{money(item.netRevenueNio)}</td>
                <td className="num">{money(item.costNio)}</td>
                <td className="num">{pending(item.profitNio)}</td>
              </tr>
            ))}
          </LedgerTable>
        ) : (
          <EmptyState title="Sin ventas en este período" />
        )}
      </Card>
      <Card className="accounting-card">
        <h3>Rentabilidad por lista de precios</h3>
        <LedgerTable
          label="Rentabilidad por lista de precios"
          headings={[
            'Lista',
            'Venta del período',
            'Margen del período',
            'Margen hoy',
          ]}
          numeric={[1, 2, 3]}
        >
          {margins.map((catalog) => {
            const sold = summary.tiers.find((row) => row.tier === catalog.tier)
            return (
              <tr key={catalog.tier}>
                <th scope="row">
                  {priceTierLabels[catalog.tier]}
                  {catalog.belowCost > 0 && (
                    <small>{catalog.belowCost} bajo costo</small>
                  )}
                </th>
                <td className="num">
                  {sold ? money(sold.netRevenueNio) : '—'}
                </td>
                <td className="num">{sold ? pending(sold.profitNio) : '—'}</td>
                <td className="num">
                  {catalog.medianMargin === null
                    ? '—'
                    : percent.format(catalog.medianMargin)}
                </td>
              </tr>
            )
          })}
        </LedgerTable>
      </Card>
      <Card className="accounting-card">
        <h3>Evolución mes a mes</h3>
        <LedgerTable
          label="Evolución mensual"
          headings={[
            'Mes',
            'Ventas',
            'Costo de ventas',
            'Gastos y mermas',
            'Resultado',
          ]}
          numeric={[1, 2, 3, 4]}
        >
          {months.map(({ month, totals }) => (
            <tr key={month}>
              <th scope="row">
                {monthName.format(new Date(`${month}-01T12:00:00Z`))}
              </th>
              <td className="num">{money(totals.revenueNio)}</td>
              <td className="num">{money(totals.costOfSalesNio)}</td>
              <td className="num">
                {money(totals.expensesNio + totals.inventoryWriteOffNio)}
              </td>
              <td className="num">{pending(totals.netProfitNio)}</td>
            </tr>
          ))}
        </LedgerTable>
      </Card>
    </>
  )
}

/** El día elegido y, debajo, cada día del período con movimiento. */
export function DailyCloseTab({
  report,
  range,
}: {
  report: ReportData
  range: ReportRange
}) {
  const rows = useMemo(() => dailyClose(report, range), [report, range])
  const today = localDay(new Date())
  const [day, setDay] = useState(
    today >= range.from && today <= range.to ? today : range.to,
  )
  const shown = day >= range.from && day <= range.to ? day : range.to
  const close = closeOf(rows, shown)
  const totals = dailyTotals(rows)
  const cells = (row: Omit<DailyClose, 'day'>) => (
    <>
      <td className="num">{row.invoices}</td>
      <td className="num">{money(row.sales.NIO)}</td>
      <td className="num">{formatCurrency(row.sales.USD, 'USD')}</td>
      <td className="num">{money(row.purchasesNio)}</td>
      <td className="num">{money(row.expensesNio)}</td>
    </>
  )
  return (
    <>
      <Card className="accounting-card">
        <div className="section-heading">
          <h3>Cierre del día</h3>
          <Input
            label="Día"
            type="date"
            min={range.from}
            max={range.to}
            value={shown}
            onChange={(event) => {
              if (event.target.value) setDay(event.target.value)
            }}
          />
        </div>
        <dl className="accounting-breakdown">
          <Line label="Facturas" amount={String(close.invoices)} />
          <Line label="Ventas en córdobas" amount={money(close.sales.NIO)} />
          <Line
            label="Ventas en dólares"
            amount={formatCurrency(close.sales.USD, 'USD')}
          />
          <Line label="Compras" amount={money(close.purchasesNio)} />
          <Line label="Gastos" amount={money(close.expensesNio)} />
        </dl>
      </Card>
      <Card className="accounting-card">
        <h3>Por día</h3>
        {rows.length ? (
          <LedgerTable
            label="Cierre por día"
            headings={[
              'Día',
              'Facturas',
              'Ventas C$',
              'Ventas US$',
              'Compras',
              'Gastos',
            ]}
            numeric={[1, 2, 3, 4, 5]}
            footer={
              <tr className="statement-total">
                <th scope="row">Total</th>
                {cells(totals)}
              </tr>
            }
          >
            {rows.map((row) => (
              <tr
                key={row.day}
                aria-current={row.day === shown ? 'true' : undefined}
              >
                <th scope="row">
                  <button
                    type="button"
                    className="statement-day"
                    onClick={() => setDay(row.day)}
                  >
                    {formatDate(row.day)}
                  </button>
                </th>
                {cells(row)}
              </tr>
            ))}
          </LedgerTable>
        ) : (
          <EmptyState title="Sin movimiento en este período" />
        )}
      </Card>
    </>
  )
}

function ratioValue(ratio: Ratio) {
  const { value } = ratio
  if (value === null) return '—'
  switch (ratio.format) {
    case 'percent':
      return percent.format(value)
    case 'money':
      return money(value)
    case 'days':
      return `${decimal.format(value)} días`
    default:
      return `${decimal.format(value)} veces`
  }
}

/** Liquidez, endeudamiento, rentabilidad y actividad del período. */
export function RatiosTab({
  report,
  position,
  range,
}: {
  report: ReportData
  position: FinancePosition
  range: ReportRange
}) {
  const summary = useMemo(
    () => accountingSummary(report, range),
    [report, range],
  )
  const groups = financialRatios(summary, position, range)
  return (
    <>
      {!position.started && (
        <p className="accounting-callout" role="status">
          Registra el saldo inicial de caja y banco para ver liquidez y
          endeudamiento.
        </p>
      )}
      <div className="accounting-two-columns">
        {groups.map((group) => (
          <Card className="accounting-card" key={group.key}>
            <h3>{group.label}</h3>
            <dl className="accounting-breakdown ratio-list">
              {group.ratios.map((ratio) => (
                <div key={ratio.key}>
                  <dt>
                    {ratio.label}
                    <small>{ratio.formula}</small>
                  </dt>
                  <dd>{ratioValue(ratio)}</dd>
                </div>
              ))}
            </dl>
          </Card>
        ))}
      </div>
      <p className="accounting-note">
        Del {formatDate(range.from)} al {formatDate(range.to)}
        {summary.revenueNio > 0
          ? ` · Ventas ${money(summary.revenueNio)} · gastos ${share(summary.expensesNio, summary.revenueNio)} de las ventas`
          : ''}
      </p>
    </>
  )
}

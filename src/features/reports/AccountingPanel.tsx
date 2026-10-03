import { ProductSelect } from '../../components/ProductSelect'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Coins, Plus } from 'lucide-react'
import { Badge, Button, Card, Dialog, EmptyState, Input, Select } from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { can } from '../../lib/permissions'
import { errorMessage } from '../../lib/errors'
import { formatCurrency, formatDate } from '../../lib/format'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { type Currency } from '../../lib/domain'
import { priceTierLabels } from '../../lib/pricing'
import { totalStock } from '../inventory/model'
import { accountOf, accountingByMonth, accountingSummary, belowCostSummary, catalogMargins, categoriesOf, emptyAccounting, expenseAccountOrder, expenseAccounts, expenseLabel, inventoryTurnover, operatingLines, roundMoney, type ExpenseAccount, type ExpenseCategory, type ExpenseInput, type OpeningCostInput } from './accounting'
import { localDay, type ReportRange } from './model'
import { closeOf, dailyClose, dailyTotals, incomeStatement, shareOfRevenue, type DailyClose } from './statement'
import type { ReportData } from './digest'
import { moneyAccountOrder, moneyAccounts, type MoneyAccount } from '../accounting/finance'
import '../../styles/accounting.css'

const money = (amount: number) => formatCurrency(amount, 'NIO')
/**
 * PostgreSQL rechaza un número con más decimales de los que guarda: dos para
 * importes, seis para costos unitarios y tipos de cambio. Se redondea antes de
 * enviarlo para que un decimal de más no vuelva convertido en error.
 */
const roundCost = (value: number) => Math.round((value + Number.EPSILON) * 1e6) / 1e6
const percent = new Intl.NumberFormat('es-NI', { style: 'percent', maximumFractionDigits: 1 })
const ratio = new Intl.NumberFormat('es-NI', { maximumFractionDigits: 2 })
const monthName = new Intl.DateTimeFormat('es-NI', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const tabs = { summary: 'Estado de resultados', daily: 'Cierre diario', expenses: 'Gastos' } as const
type Section = keyof typeof tabs
type Action = { kind: 'opening' | 'expense'; productId?: string } | { kind: 'void'; expenseId: string }
const inPeriod = (day: string, range: ReportRange) => day >= range.from && day <= range.to

export function AccountingPanel({ source, range, onRecorded }: { source: ReportData; range: ReportRange; onRecorded: () => void }) {
  const { demo, role } = useAccess()
  const { settingsService } = useServices()
  const { data: savedRate } = useQuery(settingsService.getExchangeRate)
  const ledger = source.accounting ?? emptyAccounting
  const summary = useMemo(() => accountingSummary(source, range), [source, range])
  const turnover = useMemo(() => inventoryTurnover(summary, range), [summary, range])
  // La base manda las mayores y la cuenta completa; el total incluye todas.
  const losses = useMemo(() => belowCostSummary(source, range), [source, range])
  const margins = useMemo(() => catalogMargins(source), [source])
  const months = useMemo(() => accountingByMonth(source, range), [source, range])
  const statement = useMemo(() => incomeStatement(summary), [summary])
  const daily = useMemo(() => dailyClose(source, range), [source, range])
  const [section, setSection] = useState<Section>('summary')
  const [action, setAction] = useState<Action | null>(null)
  const [message, setMessage] = useState('')
  const writable = ledger.available && !demo && can(role, 'product.edit_cost')
  const expenses = ledger.expenses.filter((item) => inPeriod(item.incurredOn, range)).sort((a, b) => b.incurredOn.localeCompare(a.incurredOn))
  const value = (amount: number | null) => !ledger.available ? 'Sin activar' : amount === null ? 'Pendiente' : money(amount)

  return <section className="accounting-panel" aria-label="Contabilidad del negocio">
    <div className="accounting-heading">
      <div><span className="eyebrow">LA CASA DEL PERFUME · CONTROL DEL NEGOCIO</span><h2>Costos, margen y gastos</h2><p>{formatDate(range.from)} — {formatDate(range.to)} · C$</p></div>
      <div className="accounting-badges">
        {savedRate && <Badge tone="neutral"><Coins size={14} /> 1 USD = {savedRate.usdToNio} C$</Badge>}
      </div>
    </div>
    {(demo || !ledger.available) && <div className="accounting-callout" role="status"><strong>{demo ? 'Explora el módulo contable' : 'El registro contable está pendiente de activar'}</strong></div>}
    {ledger.available && !summary.complete && <div className="accounting-callout" role="status"><strong>El resultado del período está incompleto</strong></div>}
    {message && <p role="status" className="page-feedback">{message}</p>}
    <nav className="accounting-tabs" aria-label="Secciones contables">{Object.entries(tabs).map(([id, label]) => <button key={id} type="button" aria-pressed={section === id} aria-controls="accounting-content" onClick={() => setSection(id as Section)}>{label}</button>)}</nav>
    <div id="accounting-content">
      {section === 'summary' && <>
        <Card className="accounting-card"><div className="statement-heading"><h3>Estado de resultados</h3><p>Del {formatDate(range.from)} al {formatDate(range.to)} · Cifras en córdobas</p></div>
          <div className="accounting-table-scroll" tabIndex={0} role="region" aria-label="Estado de resultados"><table className="statement-table"><caption className="sr-only">Estado de resultados</caption>
            <thead><tr><th scope="col">Concepto</th><th scope="col" className="num">Importe</th><th scope="col" className="num">% de ventas</th></tr></thead>
            <tbody>{statement.map((row) => {
              const share = shareOfRevenue(row.amount, summary.revenueNio)
              return row.kind === 'heading'
                ? <tr key={row.key} className="statement-group"><th scope="rowgroup" colSpan={3}>{row.label}</th></tr>
                : <tr key={row.key} className={`statement-${row.kind}`}><th scope="row">{row.label}</th><td className="num">{row.negative && ledger.available && row.amount !== null ? `(${value(row.amount)})` : value(row.amount)}</td><td className="num">{row.kind === 'info' || share === null || !ledger.available ? '' : percent.format(share)}</td></tr>
            })}</tbody>
          </table></div>
        </Card>
        <div className="accounting-two-columns">
          <Card className="accounting-card"><h3>Lo que costó traer la mercadería</h3><dl className="accounting-breakdown"><Line label="Precio de los perfumes" amount={value(summary.purchaseGoodsNio)} /><Line label="Envío cobrado por peso" amount={value(summary.purchaseShippingNio)} /><Line label="Total invertido en pedidos" amount={value(summary.purchasesNio)} /><Line label="Unidades recibidas" amount={String(summary.purchasedUnits)} /><Line label="Envío por unidad" amount={summary.purchasedUnits ? money(roundMoney(summary.purchaseShippingNio / summary.purchasedUnits)) : '—'} /></dl></Card>
          <Card className="accounting-card"><h3>Capital en productos</h3><dl className="accounting-breakdown"><Line label="Inventario actual a costo conocido" amount={value(summary.inventoryCostNio)} /><Line label="Pedidos recibidos en el período" amount={value(summary.purchasesNio)} /><Line label="Productos sin valoración completa" amount={String(summary.unvaluedProducts)} /><Line label="Rotación anual del inventario" amount={turnover.turnoverPerYear === null ? 'Pendiente' : `${ratio.format(turnover.turnoverPerYear)} veces`} /><Line label="Días que dura el inventario" amount={turnover.daysOnHand === null ? 'Pendiente' : `${ratio.format(turnover.daysOnHand)} días`} /></dl></Card>
        </div>
        {losses.count > 0 && <Card className="accounting-card accounting-alert"><div className="section-heading"><div><h3>Ventas por debajo del costo</h3></div><Badge tone="danger">{money(losses.lossNio)} de pérdida</Badge></div>
          <LedgerTable label="Ventas por debajo del costo" headings={['Documento', 'Producto', 'Unidades', 'Venta neta', 'Costo', 'Pérdida']} numeric={[2, 3, 4, 5]}>
            {losses.rows.slice(0, 25).map((row) => <tr key={`${row.documentId}:${row.productId}`}><th scope="row">{row.number}<small>{formatDate(row.createdAt)}</small></th><td>{row.description}</td><td className="num">{row.quantity}</td><td className="num">{money(row.netRevenueNio)}</td><td className="num">{money(row.costNio)}</td><td className="num">{money(row.lossNio)}</td></tr>)}
          </LedgerTable>
          {losses.count > 25 && <p className="accounting-note">25 de {losses.count} resultados</p>}
        </Card>}
        <Card className="accounting-card"><div className="section-heading"><div><h3>Rentabilidad por producto vendido</h3></div><Badge tone={summary.complete ? 'success' : 'warning'}>{summary.coverage === null ? 'Sin ventas' : `${Math.round(summary.coverage * 100)} % con costo`}</Badge></div>
          {summary.products.length ? <LedgerTable label="Rentabilidad por producto" headings={['Producto', 'Unidades', 'Venta neta', 'Costo conocido', 'Margen bruto']} numeric={[1, 2, 3, 4]}>
            {summary.products.map((item) => <tr key={item.productId}><th scope="row">{item.description}{item.missingUnits > 0 && <small>{item.missingUnits} unidades sin costo</small>}</th><td className="num">{item.quantity}</td><td className="num">{money(item.netRevenueNio)}</td><td className="num">{money(item.costNio)}</td><td className="num">{item.profitNio === null ? <Badge tone="warning">Pendiente</Badge> : money(item.profitNio)}</td></tr>)}
          </LedgerTable> : <EmptyState title="Sin ventas en este período"  />}
        </Card>
        <div className="accounting-two-columns accounting-wide-left">
          <Card className="accounting-card"><h3>Rentabilidad por lista de precios</h3>
            <LedgerTable label="Rentabilidad por lista de precios" headings={['Lista', 'Venta neta del período', 'Margen del período', 'Margen hoy']} numeric={[1, 2, 3]}>
              {margins.map((catalog) => {
                const sold = summary.tiers.find((row) => row.tier === catalog.tier)
                return <tr key={catalog.tier}><th scope="row">{priceTierLabels[catalog.tier]}{catalog.belowCost > 0 && <small className="accounting-thin">{catalog.belowCost} producto(s) por debajo del costo</small>}</th><td className="num">{sold ? <>{money(sold.netRevenueNio)}<small>costo {money(sold.costNio)}</small></> : '—'}</td><td className="num">{!sold ? '—' : sold.profitNio === null ? <Badge tone="warning">Pendiente</Badge> : money(sold.profitNio)}</td><td className="num">{catalog.medianMargin === null ? <Badge tone="warning">Sin costos</Badge> : percent.format(catalog.medianMargin)}<small>mediana de {catalog.priced} producto(s)</small></td></tr>
              })}
            </LedgerTable>
          </Card>
          <Card className="accounting-card"><h3>Gastos por cuenta</h3>
            <dl className="accounting-breakdown">{summary.expenseByAccount.map((row) => <Line key={row.account} label={expenseAccounts[row.account].label + (row.deducts ? '' : ' · no resta')} amount={value(row.amountNio)} />)}<Line label="Total que resta del resultado" amount={value(summary.expensesNio)} /></dl>
            <Button variant="secondary" onClick={() => setSection('expenses')}>Ir a gastos</Button>
          </Card>
        </div>
        <Card className="accounting-card"><h3>Evolución mes a mes</h3>
          <LedgerTable label="Evolución mensual del resultado" headings={['Mes', 'Venta neta', 'Costo de ventas', 'Gastos y mermas', 'Resultado']} numeric={[1, 2, 3, 4]}>
            {months.map(({ month, totals }) => <tr key={month}><th scope="row">{monthName.format(new Date(`${month}-01T12:00:00Z`))}</th><td className="num">{money(totals.revenueNio)}</td><td className="num">{money(totals.costOfSalesNio)}</td><td className="num">{money(totals.expensesNio + totals.inventoryWriteOffNio)}</td><td className="num">{totals.netProfitNio === null ? <Badge tone="warning">Pendiente</Badge> : money(totals.netProfitNio)}</td></tr>)}
          </LedgerTable>
        </Card>

      </>}
      {section === 'daily' && <DailyClosePanel rows={daily} range={range} />}
      {section === 'expenses' && <Card className="accounting-card"><div className="section-heading"><div><h3>Gastos del negocio</h3></div><Button disabled={!writable} onClick={() => setAction({ kind: 'expense' })}><Plus size={17} />Registrar gasto</Button></div>
        {expenseAccountOrder.map((account) => {
          const total = summary.expenseByAccount.find((row) => row.account === account)
          const rows = expenses.filter((expense) => accountOf(expense.category) === account)
          return <section className="accounting-account" key={account}>
            <header><div><h4>{expenseAccounts[account].label}</h4></div><strong>{value(total?.amountNio ?? 0)}</strong></header>
            {account === 'operativos'
              ? <LedgerTable label="Gastos operativos del período" headings={['Concepto', 'Origen', 'Importe NIO']} numeric={[2]}>
                  <tr><th scope="row">{operatingLines.goods}</th><td>Precio de los perfumes de los pedidos recibidos</td><td className="num">{value(summary.purchaseGoodsNio)}</td></tr>
                  <tr><th scope="row">{operatingLines.shipping}</th><td>Peso cobrado por las agencias de envío</td><td className="num">{value(summary.purchaseShippingNio)}</td></tr>
                </LedgerTable>
              : rows.length ? <LedgerTable label={`Gastos de ${expenseAccounts[account].label} del período`} headings={['Fecha / categoría', 'Descripción', 'Importe original', 'Importe NIO', 'Estado', '']} numeric={[2, 3]} columns={expenseColumns}>
                  {rows.map((expense) => <tr key={expense.id} className={expense.voidedAt ? 'accounting-voided' : undefined}><th scope="row">{formatDate(expense.incurredOn)}<small>{expenseLabel(expense.category)}</small></th><td>{expense.description}<small>{expense.reference || 'Sin referencia'}</small></td><td className="num">{formatCurrency(expense.amount, expense.currency)}{expense.currency === 'USD' && <small>TC {expense.exchangeRate} NIO/USD</small>}</td><td className="num">{money(roundMoney(expense.amount * expense.exchangeRate))}</td><td><Badge tone={expense.voidedAt ? 'neutral' : 'success'}>{expense.voidedAt ? 'Anulado' : 'Registrado'}</Badge>{expense.voidedAt && <small>{expense.voidReason}</small>}</td><td>{!expense.voidedAt && <Button variant="ghost" disabled={!writable} onClick={() => setAction({ kind: 'void', expenseId: expense.id })} aria-label={`Anular gasto ${expense.description}`}>Anular</Button>}</td></tr>)}
                </LedgerTable>
              : <p className="accounting-note">Sin movimientos</p>}
          </section>
        })}
      </Card>}
    </div>
    {action && <AccountingAction key={JSON.stringify(action)} action={action} source={source} writable={writable} defaultRate={savedRate?.usdToNio ?? null} onClose={() => setAction(null)} onRecorded={(text) => { setAction(null); setMessage(text); onRecorded() }} />}
  </section>
}

function Line({ label, amount }: { label: string; amount: string }) { return <div><dt>{label}</dt><dd>{amount}</dd></div> }
/** `numeric` son los índices de columna que llevan cifras: encabezado y celdas
 *  se alinean a la derecha para que los dígitos queden uno debajo del otro. */
/**
 * `columns` fija el ancho de cada columna. Se usa cuando varias tablas con las
 * mismas columnas van una debajo de otra —las cinco cuentas de gasto—: sin un
 * ancho declarado cada tabla se mide por su propio contenido y las cifras de
 * una cuenta no caen sobre las de la siguiente.
 */
function LedgerTable({ label, headings, numeric = [], columns, children }: { label: string; headings: string[]; numeric?: number[]; columns?: string[]; children: ReactNode }) { return <div className="accounting-table-scroll" tabIndex={0} role="region" aria-label={label}><table className={columns ? 'accounting-table accounting-table-aligned' : 'accounting-table'}><caption className="sr-only">{label}</caption>{columns && <colgroup>{columns.map((width, index) => <col key={index} style={{ width }} />)}</colgroup>}<thead><tr>{headings.map((heading, index) => <th scope="col" className={numeric.includes(index) ? 'num' : undefined} key={index}>{heading || <span className="sr-only">Acciones</span>}</th>)}</tr></thead><tbody>{children}</tbody></table></div> }
/** Las seis columnas de las cuentas tecleadas, iguales en las cuatro tablas. */
const expenseColumns = ['21%', '25%', '15%', '14%', '13%', '12%']

/** El día elegido arriba y, debajo, cada día del período con movimiento. */
function DailyClosePanel({ rows, range }: { rows: DailyClose[]; range: ReportRange }) {
  const today = localDay(new Date())
  const [day, setDay] = useState(today >= range.from && today <= range.to ? today : range.to)
  // Si el período cambia y deja fuera el día elegido, se muestra su último día.
  const shown = day >= range.from && day <= range.to ? day : range.to
  const close = closeOf(rows, shown)
  const totals = dailyTotals(rows)
  const cells = (row: Omit<DailyClose, 'day'>) => <><td className="num">{row.invoices}</td><td className="num">{money(row.sales.NIO)}</td><td className="num">{formatCurrency(row.sales.USD, 'USD')}</td><td className="num">{money(row.purchasesNio)}</td><td className="num">{money(row.expensesNio)}</td></>
  return <>
    <Card className="accounting-card"><div className="section-heading"><div className="statement-heading"><h3>Cierre del día</h3><p>{formatDate(shown)}</p></div><Input label="Día" type="date" min={range.from} max={range.to} value={shown} onChange={(event) => { if (event.target.value) setDay(event.target.value) }} /></div>
      <div className="accounting-table-scroll" tabIndex={0} role="region" aria-label="Cierre del día"><table className="statement-table"><caption className="sr-only">Cierre del día</caption>
        <thead><tr><th scope="col">Concepto</th><th scope="col" className="num">Importe</th></tr></thead>
        <tbody>
          <tr className="statement-line"><th scope="row">Facturas emitidas</th><td className="num">{close.invoices}</td></tr>
          <tr className="statement-line"><th scope="row">Ventas en córdobas</th><td className="num">{money(close.sales.NIO)}</td></tr>
          <tr className="statement-line"><th scope="row">Ventas en dólares</th><td className="num">{formatCurrency(close.sales.USD, 'USD')}</td></tr>
          <tr className="statement-line"><th scope="row">Compras de mercadería</th><td className="num">{money(close.purchasesNio)}</td></tr>
          <tr className="statement-line"><th scope="row">Gastos</th><td className="num">{money(close.expensesNio)}</td></tr>
        </tbody>
      </table></div>
    </Card>
    <Card className="accounting-card"><div className="statement-heading"><h3>Desempeño por día</h3><p>Del {formatDate(range.from)} al {formatDate(range.to)}</p></div>
      {rows.length ? <div className="accounting-table-scroll" tabIndex={0} role="region" aria-label="Desempeño por día"><table className="statement-table statement-daily"><caption className="sr-only">Desempeño por día</caption>
        <thead><tr><th scope="col">Día</th><th scope="col" className="num">Facturas</th><th scope="col" className="num">Ventas C$</th><th scope="col" className="num">Ventas US$</th><th scope="col" className="num">Compras</th><th scope="col" className="num">Gastos</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.day} className="statement-line" aria-current={row.day === shown ? 'true' : undefined}><th scope="row"><button type="button" className="statement-day" onClick={() => setDay(row.day)}>{formatDate(row.day)}</button></th>{cells(row)}</tr>)}</tbody>
        <tfoot><tr className="statement-total"><th scope="row">Total del período</th>{cells(totals)}</tr></tfoot>
      </table></div> : <EmptyState title="Sin movimiento en este período" />}
    </Card>
  </>
}

function AccountingAction({ action, source, writable, defaultRate, onClose, onRecorded }: { action: Action; source: ReportData; writable: boolean; defaultRate: number | null; onClose: () => void; onRecorded: (message: string) => void }) {
  const { accountingService } = useServices()
  const [openingOperation] = useState(() => createIdempotentOperation<Omit<OpeningCostInput, 'requestId'>, unknown>(accountingService.setOpeningCost))
  const [expenseOperation] = useState(() => createIdempotentOperation<Omit<ExpenseInput, 'requestId'>, unknown>(accountingService.recordExpense))
  const [productId, setProductId] = useState('productId' in action ? action.productId ?? '' : '')
  const [currency, setCurrency] = useState<Currency>('NIO')
  const [incurredOn, setIncurredOn] = useState(localDay(new Date()))
  const [amount, setAmount] = useState('')
  const [exchange, setExchange] = useState(defaultRate ? String(defaultRate) : '')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  // La cuenta no se guarda: la deduce la categoría. Aquí sólo sirve para acortar
  // una lista de dieciséis a la media docena que toca.
  const [account, setAccount] = useState<ExpenseAccount>('ventas')
  const [category, setCategory] = useState<ExpenseCategory>('renta')
  const [paidFrom, setPaidFrom] = useState<MoneyAccount>('caja')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const isOpening = action.kind === 'opening'
  const isVoid = action.kind === 'void'
  const rate = currency === 'NIO' ? 1 : Number(exchange)
  const total = Number(amount)
  const selected = source.inventory.find((item) => item.product.id === productId)
  const stock = selected ? totalStock(selected) : null
  const titles = { opening: 'Registrar costo inicial', expense: 'Registrar gasto', void: 'Anular gasto' }
  const hasExistingCost = (source.accounting?.costs ?? []).some((item) => item.productId === productId && item.averageCostNio !== null)
  const products = source.inventory.filter((item) => !isOpening || (totalStock(item) !== null && (totalStock(item) ?? 0) > 0 && !(source.accounting?.costs ?? []).some((cost) => cost.productId === item.product.id && cost.averageCostNio !== null)))

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !writable) return
    setFailure('')
    if (isOpening && (stock === null || stock <= 0 || hasExistingCost)) { setFailure('El costo inicial requiere existencias contadas y un producto sin costo previo.'); return }
    if (!isVoid && (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(total) || total < 0)) { setFailure('Revisa los importes y el tipo de cambio.'); return }
    // La base exige un gasto mayor que cero: un cero llegaría hasta PostgreSQL
    // sólo para volver con un error. El costo inicial sí admite cero.
    if (action.kind === 'expense' && total <= 0) { setFailure('El importe del gasto debe ser mayor que cero.'); return }
    setBusy(true)
    try {
      if (action.kind === 'void') { await accountingService.voidExpense(action.expenseId, note.trim()); onRecorded('Gasto anulado. Se conserva su registro y el motivo de la anulación.'); return }
      if (action.kind === 'opening') {
        await openingOperation.execute({ productId, unitCost: roundCost(total), currency, exchangeRate: roundCost(rate), note: note.trim() })
        onRecorded('Costo inicial registrado para las existencias actuales. Las ventas anteriores conservan su información original.')
      } else {
        await expenseOperation.execute({ incurredOn, category, description: note.trim(), amount: roundMoney(total), currency, exchangeRate: roundCost(rate), reference: reference.trim(), account: paidFrom })
        onRecorded('Gasto registrado en el período correspondiente.')
      }
    } catch (error) { setFailure(errorMessage(error)) } finally { setBusy(false) }
  }

  return <Dialog open title={titles[action.kind]} onClose={() => { if (!busy) onClose() }}><form className="accounting-form" onSubmit={submit}><fieldset disabled={busy}>
    {isVoid ? <><p>La anulación excluye este gasto del resultado y conserva el comprobante en el historial.</p><Input label="Motivo de anulación" required minLength={5} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} /></> : <>
      {isOpening && <ProductSelect label="Producto" products={products.map(({ product }) => product)} value={productId} onChange={setProductId} />}

      {isOpening && <p className="accounting-callout">Existencias: {stock ?? '—'} unidades</p>}
      <div className="form-grid">
        {!isOpening && <Input label="Fecha del comprobante" type="date" required max={localDay(new Date())} value={incurredOn} onChange={(event) => setIncurredOn(event.target.value)} />}
        {!isOpening && <Select label="Cuenta" value={account} onChange={(event) => { const next = event.target.value as ExpenseAccount; setAccount(next); setCategory(categoriesOf(next)[0]) }}>{expenseAccountOrder.filter((id) => id !== 'operativos').map((id) => <option key={id} value={id}>{expenseAccounts[id].label}</option>)}</Select>}
        {!isOpening && <Select label="Categoría del gasto" value={category} onChange={(event) => setCategory(event.target.value as ExpenseCategory)}>{categoriesOf(account).map((id) => <option key={id} value={id}>{expenseLabel(id)}</option>)}</Select>}
        {!isOpening && <Select label="Pagado desde" value={paidFrom} onChange={(event) => setPaidFrom(event.target.value as MoneyAccount)}>{moneyAccountOrder.map((id) => <option key={id} value={id}>{moneyAccounts[id]}</option>)}</Select>}
        <Select label="Moneda del comprobante" value={currency} onChange={(event) => setCurrency(event.target.value as Currency)}><option value="NIO">NIO · Córdobas</option><option value="USD">USD · Dólares</option></Select>
        {currency === 'USD' && <Input label="Tipo de cambio (NIO por 1 USD)" type="number" min="0.000001" max={1000000} step="0.000001" required value={exchange} onChange={(event) => setExchange(event.target.value)} />}
        <Input label={isOpening ? `Costo inicial por unidad (${currency})` : `Importe del gasto (${currency})`} type="number" min={isOpening ? 0 : 0.01} max={10000000} step="0.01" required value={amount} onChange={(event) => setAmount(event.target.value)} />
        {!isOpening && <Input label="Número de comprobante / referencia" maxLength={200} value={reference} onChange={(event) => setReference(event.target.value)} />}
      </div>
      <Input label={isOpening ? 'Origen del costo / comprobante' : 'Descripción del gasto'} required minLength={3} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
      <div className="accounting-form-total"><span>{isOpening ? 'Costo inicial unitario en NIO' : 'Gasto reconocido en NIO'}</span><strong>{amount !== '' && rate > 0 && Number.isFinite(total) ? money(roundMoney(total * rate)) : 'Completa los importes'}</strong></div>
    </>}
    {failure && <p role="alert" className="inline-error">{failure}</p>}
    <div className="form-actions"><Button type="submit" disabled={!writable}>{busy ? 'Guardando…' : isVoid ? 'Anular gasto' : 'Guardar registro'}</Button><Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button></div>
  </fieldset></form></Dialog>
}

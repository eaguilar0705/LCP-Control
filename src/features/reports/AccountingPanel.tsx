import { ProductSelect } from '../../components/ProductSelect'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowDownToLine, BadgeDollarSign, Coins, Plus, ReceiptText, Wallet } from 'lucide-react'
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
import { accountOf, accountingByMonth, accountingSummary, belowCostSales, catalogMargins, categoriesOf, emptyAccounting, expenseAccountOrder, expenseAccounts, expenseLabel, inventoryTurnover, operatingLines, roundMoney, type ExpenseAccount, type ExpenseCategory, type ExpenseInput, type OpeningCostInput } from './accounting'
import { localDay, type ReportRange, type ReportSource } from './model'
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
const tabs = { summary: 'Resumen', expenses: 'Gastos' } as const
type Section = keyof typeof tabs
type Action = { kind: 'opening' | 'expense'; productId?: string } | { kind: 'void'; expenseId: string }
const inPeriod = (day: string, range: ReportRange) => day >= range.from && day <= range.to

export function AccountingPanel({ source, range, onRecorded }: { source: ReportSource; range: ReportRange; onRecorded: () => void }) {
  const { demo, role } = useAccess()
  const { settingsService } = useServices()
  const { data: savedRate } = useQuery(settingsService.getExchangeRate)
  const ledger = source.accounting ?? emptyAccounting
  const summary = useMemo(() => accountingSummary(source, range), [source, range])
  const turnover = useMemo(() => inventoryTurnover(summary, range), [summary, range])
  const losses = useMemo(() => belowCostSales(source, range), [source, range])
  const margins = useMemo(() => catalogMargins(source), [source])
  const months = useMemo(() => accountingByMonth(source, range), [source, range])
  const [section, setSection] = useState<Section>('summary')
  const [action, setAction] = useState<Action | null>(null)
  const [message, setMessage] = useState('')
  const writable = ledger.available && !demo && can(role, 'product.edit_cost')
  const expenses = ledger.expenses.filter((item) => inPeriod(item.incurredOn, range)).sort((a, b) => b.incurredOn.localeCompare(a.incurredOn))
  const value = (amount: number | null) => !ledger.available ? 'Sin activar' : amount === null ? 'Pendiente' : money(amount)

  return <section className="accounting-panel" aria-label="Contabilidad del negocio">
    <div className="accounting-heading">
      <div><span className="eyebrow">LA CASA DEL PERFUME · CONTROL DEL NEGOCIO</span><h2>Costos, margen y gastos</h2><p>Del {formatDate(range.from)} al {formatDate(range.to)} · Consolidado en córdobas con el tipo de cambio de cada operación.</p></div>
      <div className="accounting-badges">
        {savedRate && <Badge tone="neutral"><Coins size={14} /> 1 USD = {savedRate.usdToNio} C$</Badge>}
      </div>
    </div>
    {(demo || !ledger.available) && <div className="accounting-callout" role="status"><strong>{demo ? 'Explora el módulo contable' : 'El registro contable está pendiente de activar'}</strong><p>{demo ? 'Los pedidos, los costos y los gastos de esta vista son inventados, para poder recorrer las pantallas antes de conectar la base de datos. No se puede registrar nada aquí.' : 'La base de datos necesita la actualización de contabilidad para registrar pedidos, costos iniciales y gastos. Los reportes de ventas siguen disponibles.'} Los precios del catálogo son precios de venta; no se usan como costos de compra.</p></div>}
    {ledger.available && !summary.complete && <div className="accounting-callout" role="status"><strong>El resultado del período está incompleto</strong><p>{summary.missingCostUnits > 0 && `${summary.missingCostUnits} unidades vendidas sin costo registrado. `}{summary.missingRevenueLines > 0 && `${summary.missingRevenueLines} renglones sin desglose de venta o tipo de cambio. `}{summary.missingWriteOffUnits > 0 && `${summary.missingWriteOffUnits} unidades de salida o merma sin costo. `}{(source.truncated || ledger.truncated) && 'La consulta alcanzó su límite; selecciona un período más corto. '}Las cifras conocidas se muestran por separado; la utilidad queda pendiente hasta tener información completa.</p></div>}
    {message && <p role="status" className="page-feedback">{message}</p>}
    <nav className="accounting-tabs" aria-label="Secciones contables">{Object.entries(tabs).map(([id, label]) => <button key={id} type="button" aria-pressed={section === id} aria-controls="accounting-content" onClick={() => setSection(id as Section)}>{label}</button>)}</nav>
    <div id="accounting-content">
      {section === 'summary' && <>
        <div className="accounting-metrics">
          <Metric label="Ventas netas registradas" amount={value(summary.revenueNio)} note={ledger.available ? `Facturas sin el impuesto incluido (${money(summary.salesTaxNio)} de impuesto)` : 'Facturas sin el impuesto incluido'} icon={<BadgeDollarSign size={19} />} />
          <Metric label="Costo de lo vendido" amount={value(summary.costOfSalesNio)} note={summary.missingCostUnits ? `${summary.missingCostUnits} unidades pendientes de costo` : 'Costo guardado al emitir cada venta'} icon={<ArrowDownToLine size={19} />} />
          <Metric label="Margen bruto" amount={value(summary.grossProfitNio)} note="Ventas netas menos costo vendido" />
          <Metric label="Gastos del negocio" amount={value(summary.expensesNio)} note={summary.loanPaymentsNio > 0 ? `Ventas, impuestos e intereses · ${money(summary.loanPaymentsNio)} de préstamos aparte` : 'Gastos de ventas, impuestos y gastos financieros'} icon={<ReceiptText size={19} />} />
          <Metric label="Mermas y otras salidas" amount={value(summary.inventoryWriteOffNio)} note="Costo de daños, salidas y ajustes negativos" />
          <Metric label="Resultado operativo registrado" amount={value(summary.netProfitNio)} note="Margen menos gastos, mermas y salidas" icon={<Wallet size={19} />} highlight />
        </div>
        <div className="accounting-two-columns">
          <Card className="accounting-card"><h3>Lo que costó traer la mercadería</h3><dl className="accounting-breakdown"><Line label="Precio de los perfumes" amount={value(summary.purchaseGoodsNio)} /><Line label="Envío cobrado por peso" amount={value(summary.purchaseShippingNio)} /><Line label="Total invertido en pedidos" amount={value(summary.purchasesNio)} /><Line label="Unidades recibidas" amount={String(summary.purchasedUnits)} /><Line label="Envío por unidad" amount={summary.purchasedUnits ? money(roundMoney(summary.purchaseShippingNio / summary.purchasedUnits)) : '—'} /></dl><p className="accounting-note">La agencia cobra el peso del paquete y nada más. Ese cobro se reparte por igual entre las unidades del pedido, así que el costo de cada perfume es su precio de compra más lo que pesó traerlo.</p></Card>
          <Card className="accounting-card"><h3>Capital en productos</h3><dl className="accounting-breakdown"><Line label="Inventario actual a costo conocido" amount={value(summary.inventoryCostNio)} /><Line label="Pedidos recibidos en el período" amount={value(summary.purchasesNio)} /><Line label="Productos sin valoración completa" amount={String(summary.unvaluedProducts)} /><Line label="Rotación anual del inventario" amount={turnover.turnoverPerYear === null ? 'Pendiente' : `${ratio.format(turnover.turnoverPerYear)} veces`} /><Line label="Días que dura el inventario" amount={turnover.daysOnHand === null ? 'Pendiente' : `${ratio.format(turnover.daysOnHand)} días`} /></dl><p className="accounting-note">El inventario muestra las existencias actuales. La rotación proyecta a un año el costo vendido del período y queda pendiente mientras haya productos sin costo.</p></Card>
        </div>
        {losses.length > 0 && <Card className="accounting-card accounting-alert"><div className="section-heading"><div><h3>Ventas por debajo del costo</h3><p className="accounting-note">Renglones donde el costo congelado al emitir superó la venta neta. Sólo aparecen los que tienen ambas cifras registradas.</p></div><Badge tone="danger">{money(losses.reduce((total, row) => total + row.lossNio, 0))} de pérdida</Badge></div>
          <LedgerTable label="Ventas por debajo del costo" headings={['Documento', 'Producto', 'Unidades', 'Venta neta', 'Costo', 'Pérdida']} numeric={[2, 3, 4, 5]}>
            {losses.slice(0, 25).map((row) => <tr key={`${row.documentId}:${row.productId}`}><th scope="row">{row.number}<small>{formatDate(row.createdAt)}</small></th><td>{row.description}</td><td className="num">{row.quantity}</td><td className="num">{money(row.netRevenueNio)}</td><td className="num">{money(row.costNio)}</td><td className="num">{money(row.lossNio)}</td></tr>)}
          </LedgerTable>
          {losses.length > 25 && <p className="accounting-note">Se muestran las 25 mayores de {losses.length}. La exportación a Excel las incluye todas.</p>}
        </Card>}
        <Card className="accounting-card"><div className="section-heading"><div><h3>Rentabilidad por producto vendido</h3><p className="accounting-note">El costo histórico de una venta se conserva aunque cambie el precio de compra.</p></div><Badge tone={summary.complete ? 'success' : 'warning'}>{summary.coverage === null ? 'Sin ventas' : `${Math.round(summary.coverage * 100)} % con costo`}</Badge></div>
          {summary.products.length ? <LedgerTable label="Rentabilidad por producto" headings={['Producto', 'Unidades', 'Venta neta', 'Costo conocido', 'Margen bruto']} numeric={[1, 2, 3, 4]}>
            {summary.products.map((item) => <tr key={item.productId}><th scope="row">{item.description}{item.missingUnits > 0 && <small>{item.missingUnits} unidades sin costo</small>}</th><td className="num">{item.quantity}</td><td className="num">{money(item.netRevenueNio)}</td><td className="num">{money(item.costNio)}</td><td className="num">{item.profitNio === null ? <Badge tone="warning">Pendiente</Badge> : money(item.profitNio)}</td></tr>)}
          </LedgerTable> : <EmptyState title="Sin ventas en este período" description="Las facturas emitidas aparecerán aquí con el costo que tenían al venderse." />}
        </Card>
        <div className="accounting-two-columns accounting-wide-left">
          <Card className="accounting-card"><h3>Rentabilidad por lista de precios</h3><p className="accounting-note">Lo vendido en el período con cada lista, y el margen que la lista deja hoy sobre el costo promedio de todo el catálogo.</p>
            <LedgerTable label="Rentabilidad por lista de precios" headings={['Lista', 'Venta neta del período', 'Margen del período', 'Margen hoy']} numeric={[1, 2, 3]}>
              {margins.map((catalog) => {
                const sold = summary.tiers.find((row) => row.tier === catalog.tier)
                return <tr key={catalog.tier}><th scope="row">{priceTierLabels[catalog.tier]}{catalog.belowCost > 0 && <small className="accounting-thin">{catalog.belowCost} producto(s) por debajo del costo</small>}</th><td className="num">{sold ? <>{money(sold.netRevenueNio)}<small>costo {money(sold.costNio)}</small></> : '—'}</td><td className="num">{!sold ? '—' : sold.profitNio === null ? <Badge tone="warning">Pendiente</Badge> : money(sold.profitNio)}</td><td className="num">{catalog.medianMargin === null ? <Badge tone="warning">Sin costos</Badge> : percent.format(catalog.medianMargin)}<small>mediana de {catalog.priced} producto(s)</small></td></tr>
              })}
            </LedgerTable>
          </Card>
          <Card className="accounting-card"><h3>Gastos por cuenta</h3><p className="accounting-note">Las cinco cuentas del negocio en el período. Sólo las tres marcadas como gasto bajan el resultado.</p>
            <dl className="accounting-breakdown">{summary.expenseByAccount.map((row) => <Line key={row.account} label={expenseAccounts[row.account].label + (row.deducts ? '' : ' · no resta')} amount={value(row.amountNio)} />)}<Line label="Total que resta del resultado" amount={value(summary.expensesNio)} /></dl>
            <Button variant="secondary" onClick={() => setSection('expenses')}>Ir a gastos</Button>
          </Card>
        </div>
        <Card className="accounting-card"><h3>Evolución mes a mes</h3><p className="accounting-note">Cada mes calendario recortado al período elegido, con el mismo criterio de la contabilidad. Una utilidad pendiente indica meses con información incompleta.</p>
          <LedgerTable label="Evolución mensual del resultado" headings={['Mes', 'Venta neta', 'Costo de ventas', 'Gastos y mermas', 'Resultado']} numeric={[1, 2, 3, 4]}>
            {months.map(({ month, totals }) => <tr key={month}><th scope="row">{monthName.format(new Date(`${month}-01T12:00:00Z`))}</th><td className="num">{money(totals.revenueNio)}</td><td className="num">{money(totals.costOfSalesNio)}</td><td className="num">{money(totals.expensesNio + totals.inventoryWriteOffNio)}</td><td className="num">{totals.netProfitNio === null ? <Badge tone="warning">Pendiente</Badge> : money(totals.netProfitNio)}</td></tr>)}
          </LedgerTable>
        </Card>
        <p className="accounting-note">Control administrativo basado en operaciones registradas. El resultado incluye ventas pendientes de pago; no representa saldo de caja ni balance general.</p>
      </>}
      {section === 'expenses' && <Card className="accounting-card"><div className="section-heading"><div><h3>Gastos del negocio</h3><p className="accounting-note">Las cinco cuentas en las que el negocio lleva sus gastos. Cada renglón conserva su comprobante y se anula, nunca se borra.</p></div><Button disabled={!writable} onClick={() => setAction({ kind: 'expense' })}><Plus size={17} />Registrar gasto</Button></div>
        {expenseAccountOrder.map((account) => {
          const total = summary.expenseByAccount.find((row) => row.account === account)
          const rows = expenses.filter((expense) => accountOf(expense.category) === account)
          return <section className="accounting-account" key={account}>
            <header><div><h4>{expenseAccounts[account].label}</h4>{!total?.deducts && <small>{account === 'prestamos' ? 'Devuelve capital: no resta del resultado. Sus intereses sí, en gastos financieros.' : 'Sale de los pedidos registrados y pesa en el resultado cuando se vende la mercadería.'}</small>}</div><strong>{value(total?.amountNio ?? 0)}</strong></header>
            {account === 'operativos'
              ? <LedgerTable label="Gastos operativos del período" headings={['Concepto', 'Origen', 'Importe NIO']} numeric={[2]}>
                  <tr><th scope="row">{operatingLines.goods}</th><td>Precio de los perfumes de los pedidos recibidos</td><td className="num">{value(summary.purchaseGoodsNio)}</td></tr>
                  <tr><th scope="row">{operatingLines.shipping}</th><td>Peso cobrado por las agencias de envío</td><td className="num">{value(summary.purchaseShippingNio)}</td></tr>
                </LedgerTable>
              : rows.length ? <LedgerTable label={`Gastos de ${expenseAccounts[account].label} del período`} headings={['Fecha / categoría', 'Descripción', 'Importe original', 'Importe NIO', 'Estado', '']} numeric={[2, 3]} columns={expenseColumns}>
                  {rows.map((expense) => <tr key={expense.id} className={expense.voidedAt ? 'accounting-voided' : undefined}><th scope="row">{formatDate(expense.incurredOn)}<small>{expenseLabel(expense.category)}</small></th><td>{expense.description}<small>{expense.reference || 'Sin referencia'}</small></td><td className="num">{formatCurrency(expense.amount, expense.currency)}{expense.currency === 'USD' && <small>TC {expense.exchangeRate} NIO/USD</small>}</td><td className="num">{money(roundMoney(expense.amount * expense.exchangeRate))}</td><td><Badge tone={expense.voidedAt ? 'neutral' : 'success'}>{expense.voidedAt ? 'Anulado' : 'Registrado'}</Badge>{expense.voidedAt && <small>{expense.voidReason}</small>}</td><td>{!expense.voidedAt && <Button variant="ghost" disabled={!writable} onClick={() => setAction({ kind: 'void', expenseId: expense.id })} aria-label={`Anular gasto ${expense.description}`}>Anular</Button>}</td></tr>)}
                </LedgerTable>
              : <p className="accounting-note">Sin movimientos en esta cuenta durante el período. Categorías: {categoriesOf(account).map(expenseLabel).join(', ')}.</p>}
          </section>
        })}
      </Card>}
    </div>
    {action && <AccountingAction key={JSON.stringify(action)} action={action} source={source} writable={writable} defaultRate={savedRate?.usdToNio ?? null} onClose={() => setAction(null)} onRecorded={(text) => { setAction(null); setMessage(text); onRecorded() }} />}
  </section>
}

function Metric({ label, amount, note, icon, highlight = false }: { label: string; amount: string; note: string; icon?: ReactNode; highlight?: boolean }) {
  return <div className={`accounting-metric ${highlight ? 'accounting-metric-highlight' : ''}`}><span>{label}{icon}</span><strong>{amount}</strong><small>{note}</small></div>
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

function AccountingAction({ action, source, writable, defaultRate, onClose, onRecorded }: { action: Action; source: ReportSource; writable: boolean; defaultRate: number | null; onClose: () => void; onRecorded: (message: string) => void }) {
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
        await expenseOperation.execute({ incurredOn, category, description: note.trim(), amount: roundMoney(total), currency, exchangeRate: roundCost(rate), reference: reference.trim() })
        onRecorded('Gasto registrado en el período correspondiente.')
      }
    } catch (error) { setFailure(errorMessage(error)) } finally { setBusy(false) }
  }

  return <Dialog open title={titles[action.kind]} onClose={() => { if (!busy) onClose() }}><form className="accounting-form" onSubmit={submit}><fieldset disabled={busy}>
    {isVoid ? <><p>La anulación excluye este gasto del resultado y conserva el comprobante en el historial.</p><Input label="Motivo de anulación" required minLength={5} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} /></> : <>
      {isOpening && <ProductSelect label="Producto" products={products.map(({ product }) => product)} value={productId} onChange={setProductId} />}
      {!isOpening && !isVoid && account === 'prestamos' && <p className="accounting-callout">Una cuota de préstamo devuelve capital: se registra y se ve en su cuenta, pero no baja el resultado del período. Lo que sí cuesta es el interés, y ése se registra en <strong>Gastos financieros</strong>.</p>}
      {isOpening && <p className="accounting-callout">Asigna el costo de compra documentado a las {stock ?? '—'} unidades actuales. No modifica cantidades ni recalcula ventas pasadas. Incluye en este costo unitario la parte del envío que le tocó al perfume.</p>}
      <div className="form-grid">
        {!isOpening && <Input label="Fecha del comprobante" type="date" required max={localDay(new Date())} value={incurredOn} onChange={(event) => setIncurredOn(event.target.value)} />}
        {!isOpening && <Select label="Cuenta" value={account} onChange={(event) => { const next = event.target.value as ExpenseAccount; setAccount(next); setCategory(categoriesOf(next)[0]) }}>{expenseAccountOrder.filter((id) => id !== 'operativos').map((id) => <option key={id} value={id}>{expenseAccounts[id].label}</option>)}</Select>}
        {!isOpening && <Select label="Categoría del gasto" value={category} onChange={(event) => setCategory(event.target.value as ExpenseCategory)}>{categoriesOf(account).map((id) => <option key={id} value={id}>{expenseLabel(id)}</option>)}</Select>}
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

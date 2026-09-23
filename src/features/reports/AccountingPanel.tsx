import { ProductSelect } from '../../components/ProductSelect'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowDownToLine, BadgeDollarSign, BookOpen, Coins, PackagePlus, Plus, ReceiptText, Trash2, Upload, Wallet } from 'lucide-react'
import { Badge, Button, Card, Dialog, EmptyState, Input, Select } from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { can } from '../../lib/permissions'
import { errorMessage } from '../../lib/errors'
import { formatCurrency, formatDate } from '../../lib/format'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { labels, type Currency, type InventoryLocation } from '../../lib/domain'
import { priceTierLabels } from '../../lib/pricing'
import { totalStock } from '../inventory/model'
import { accountOf, accountingByMonth, accountingSummary, belowCostSales, catalogMargins, categoriesOf, emptyAccounting, expenseAccountOrder, expenseAccounts, expenseLabel, inventoryTurnover, marginRate, operatingLines, roundMoney, type ExpenseAccount, type ExpenseCategory, type ExpenseInput, type OpeningCostInput, type ShipmentInput, type ShipmentLineInput } from './accounting'
import { parseOpeningCosts, type OpeningCostParse } from './openingCostImport'
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
const tabs = { summary: 'Resumen', shipments: 'Pedidos', prices: 'Costos y precios', expenses: 'Gastos' } as const
type Section = keyof typeof tabs
type Action = { kind: 'opening' | 'expense'; productId?: string } | { kind: 'void'; expenseId: string } | { kind: 'bulk' } | { kind: 'shipment' }
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
  const [search, setSearch] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [page, setPage] = useState(0)
  const writable = ledger.available && !demo && can(role, 'product.edit_cost')
  const costs = new Map(ledger.costs.map((cost) => [cost.productId, cost.averageCostNio]))
  const shipments = ledger.shipments.filter((item) => inPeriod(item.incurredOn, range)).sort((a, b) => b.incurredOn.localeCompare(a.incurredOn))
  const expenses = ledger.expenses.filter((item) => inPeriod(item.incurredOn, range)).sort((a, b) => b.incurredOn.localeCompare(a.incurredOn))
  const products = source.inventory.filter((item) => {
    const product = item.product
    return (!onlyMissing || costs.get(product.id) == null) && `${product.brand} ${product.name} ${product.barcode}`.toLocaleLowerCase('es').includes(search.toLocaleLowerCase('es').trim())
  })
  const currentPage = Math.min(page, Math.max(0, Math.ceil(products.length / 30) - 1))
  const value = (amount: number | null) => !ledger.available ? 'Sin activar' : amount === null ? 'Pendiente' : money(amount)

  return <section className="accounting-panel" aria-label="Contabilidad del negocio">
    <div className="accounting-heading">
      <div><span className="eyebrow">LA CASA DEL PERFUME · CONTROL DEL NEGOCIO</span><h2>Costos, margen y gastos</h2><p>Del {formatDate(range.from)} al {formatDate(range.to)} · Consolidado en córdobas con el tipo de cambio de cada operación.</p></div>
      <div className="accounting-badges">
        <Badge tone="neutral"><BookOpen size={14} /> Precio del perfume + envío por peso</Badge>
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
          <Card className="accounting-card"><h3>Lo que costó traer la mercadería</h3><dl className="accounting-breakdown"><Line label="Precio de los perfumes" amount={value(summary.purchaseGoodsNio)} /><Line label="Envío cobrado por peso" amount={value(summary.purchaseShippingNio)} /><Line label="Total invertido en pedidos" amount={value(summary.purchasesNio)} /><Line label="Unidades recibidas" amount={String(summary.purchasedUnits)} /><Line label="Envío por unidad" amount={summary.purchasedUnits ? money(roundMoney(summary.purchaseShippingNio / summary.purchasedUnits)) : '—'} /></dl><p className="accounting-note">La agencia cobra el peso del paquete y nada más. Ese cobro se reparte por igual entre las unidades del pedido, así que el costo de cada perfume es su precio de compra más lo que pesó traerlo.</p><Button variant="secondary" onClick={() => setSection('shipments')}>Ver los pedidos</Button></Card>
          <Card className="accounting-card"><h3>Capital en productos</h3><dl className="accounting-breakdown"><Line label="Inventario actual a costo conocido" amount={value(summary.inventoryCostNio)} /><Line label="Pedidos recibidos en el período" amount={value(summary.purchasesNio)} /><Line label="Productos sin valoración completa" amount={String(summary.unvaluedProducts)} /><Line label="Rotación anual del inventario" amount={turnover.turnoverPerYear === null ? 'Pendiente' : `${ratio.format(turnover.turnoverPerYear)} veces`} /><Line label="Días que dura el inventario" amount={turnover.daysOnHand === null ? 'Pendiente' : `${ratio.format(turnover.daysOnHand)} días`} /></dl><p className="accounting-note">El inventario muestra las existencias actuales. La rotación proyecta a un año el costo vendido del período y queda pendiente mientras haya productos sin costo.</p><Button variant="secondary" onClick={() => setSection('prices')}>Revisar costos y precios</Button></Card>
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
      {section === 'shipments' && <Card className="accounting-card"><div className="section-heading"><div><h3>Pedidos de importación</h3><p className="accounting-note">Una caja con varios perfumes: el proveedor cobra cada perfume y la agencia cobra el peso del paquete. Al registrarlo se suman las existencias y se actualiza el costo de cada producto.</p></div><Button disabled={!writable} onClick={() => setAction({ kind: 'shipment' })}><PackagePlus size={17} />Registrar pedido</Button></div>
        <p className="accounting-formula">Costo de cada perfume = precio del proveedor + (envío del pedido ÷ unidades de la caja).</p>
        {shipments.length ? <div className="accounting-shipments">{shipments.map((shipment) => <article key={shipment.id} className="accounting-shipment">
          <header><div><strong>{formatDate(shipment.incurredOn)}</strong><small>{shipment.supplier || 'Sin proveedor'}{shipment.agency && ` · Agencia ${shipment.agency}`}{shipment.reference && ` · ${shipment.reference}`}</small></div>
            <dl className="accounting-breakdown"><Line label="Perfumes" amount={formatCurrency(shipment.goodsAmount, shipment.currency)} /><Line label="Envío por peso" amount={formatCurrency(shipment.shippingAmount, shipment.currency)} /><Line label="Unidades" amount={String(shipment.units)} /><Line label="Envío por unidad" amount={formatCurrency(shipment.shippingPerUnit, shipment.currency)} />{shipment.currency === 'USD' && <Line label="Tipo de cambio" amount={`${shipment.exchangeRate} NIO/USD`} />}</dl></header>
          <LedgerTable label={`Renglones del pedido del ${shipment.incurredOn}`} headings={['Producto / destino', 'Unidades', `Precio unitario ${shipment.currency}`, `Envío del renglón ${shipment.currency}`, 'Costo unitario NIO']} numeric={[1, 2, 3, 4]}>
            {shipment.lines.map((line) => <tr key={line.id}><th scope="row">{productName(source, line.productId)}<small>{labels.location[line.location]}</small></th><td className="num">{line.quantity}</td><td className="num">{formatCurrency(line.unitPrice, shipment.currency)}<small>{formatCurrency(line.goodsAmount, shipment.currency)} en total</small></td><td className="num">{formatCurrency(roundMoney(line.shippingShare), shipment.currency)}</td><td className="num">{money(line.landedUnitCostNio)}</td></tr>)}
          </LedgerTable>
          {shipment.note && <p className="accounting-note">{shipment.note}</p>}
        </article>)}</div> : <EmptyState title="Aún no hay pedidos registrados" description="Registra el precio que te cobró el proveedor por cada perfume y lo que cobró la agencia por el peso de la caja." />}
      </Card>}
      {section === 'prices' && <Card className="accounting-card"><div className="section-heading"><div><h3>Costos reales y precios de venta</h3><p className="accounting-note">El costo promedio es independiente de las listas Emprendedor, VIP y Premium. El porcentaje bajo cada precio es lo que queda de ese precio después del costo.</p></div><div className="accounting-actions"><Button variant="secondary" disabled={!writable} onClick={() => setAction({ kind: 'bulk' })}><Upload size={17} />Cargar costos desde lista</Button><Button disabled={!writable} onClick={() => setAction({ kind: 'opening' })}><Plus size={17} />Registrar costo inicial</Button></div></div>
        <div className="accounting-search"><Input label="Buscar producto" placeholder="Nombre, marca o código" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0) }} /><label className="accounting-checkbox"><input type="checkbox" checked={onlyMissing} onChange={(event) => { setOnlyMissing(event.target.checked); setPage(0) }} />Solo sin costo registrado</label></div>
        <p className="accounting-note">Precios de venta actuales, con el impuesto que corresponda. Los precios en USD se muestran en su moneda original; no se convierten sin una operación con tipo de cambio.</p>
        {products.length ? <LedgerTable label="Comparación de costos y precios actuales" headings={['Producto', 'Existencia actual', 'Costo promedio NIO', ...Object.values(priceTierLabels), '']} numeric={[2, 3, 4, 5]}>
          {products.slice(currentPage * 30, (currentPage + 1) * 30).map((item) => {
            const cost = costs.get(item.product.id)
            const stock = totalStock(item)
            return <tr key={item.product.id}><th scope="row">{item.product.brand} {item.product.name}<small>{item.product.barcode} · {item.product.size ?? '?'} {item.product.unit}</small></th><td>{stock === null ? 'Sin conteo completo' : `${stock} uds.`}</td><td className="num">{cost == null ? <Badge tone="warning">Sin costo</Badge> : money(cost)}</td>{(['emprendedor', 'vip', 'premium'] as const).map((tier) => {
              const rate = item.product.prices ? marginRate(item.product.prices[tier].NIO, cost) : null
              return <td className="num" key={tier}>{item.product.prices ? <>{money(item.product.prices[tier].NIO)}<small>{formatCurrency(item.product.prices[tier].USD, 'USD')}</small><small className={rate !== null && rate < 0.15 ? 'accounting-thin' : undefined}>{rate === null ? 'Margen pendiente' : `Margen ${percent.format(rate)}`}</small></> : 'Sin precio por lista'}</td>
            })}<td>{cost == null && <Button variant="ghost" disabled={!writable || stock === null || stock <= 0} aria-label={`Registrar costo inicial de ${item.product.name}`} onClick={() => setAction({ kind: 'opening', productId: item.product.id })}>Registrar costo</Button>}</td></tr>
          })}
        </LedgerTable> : <EmptyState title="Sin productos para este filtro" description="Prueba otro nombre o desmarca el filtro de costos pendientes." />}
        {products.length > 30 && <div className="accounting-pagination"><span>{currentPage * 30 + 1}–{Math.min((currentPage + 1) * 30, products.length)} de {products.length}</span><Button variant="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Anterior</Button><Button variant="secondary" disabled={(currentPage + 1) * 30 >= products.length} onClick={() => setPage(currentPage + 1)}>Siguiente</Button></div>}
      </Card>}
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
    {action?.kind === 'bulk'
      ? <BulkOpeningCosts source={source} writable={writable} defaultRate={savedRate?.usdToNio ?? null} onClose={() => setAction(null)} onRecorded={(text) => { setMessage(text); onRecorded() }} />
      : action?.kind === 'shipment'
      ? <ShipmentDialog source={source} writable={writable} defaultRate={savedRate?.usdToNio ?? null} onClose={() => setAction(null)} onRecorded={(text) => { setAction(null); setMessage(text); onRecorded() }} />
      : action && <AccountingAction key={JSON.stringify(action)} action={action} source={source} writable={writable} defaultRate={savedRate?.usdToNio ?? null} onClose={() => setAction(null)} onRecorded={(text) => { setAction(null); setMessage(text); onRecorded() }} />}
  </section>
}

/**
 * Loading 260 opening costs one dialog at a time is not a workflow anybody
 * finishes. The list is resolved against the catalogue before anything is
 * written, and each row is sent as its own operation so one rejected product
 * never discards the rest.
 */
function BulkOpeningCosts({ source, writable, defaultRate, onClose, onRecorded }: { source: ReportSource; writable: boolean; defaultRate: number | null; onClose: () => void; onRecorded: (message: string) => void }) {
  const { accountingService } = useServices()
  const [text, setText] = useState('')
  const [currency, setCurrency] = useState<Currency>('NIO')
  const [exchange, setExchange] = useState(defaultRate ? String(defaultRate) : '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(0)
  const [outcome, setOutcome] = useState<{ saved: number; failures: { label: string; reason: string }[] } | null>(null)
  const parsed: OpeningCostParse = useMemo(() => parseOpeningCosts(text, source), [text, source])
  const rate = currency === 'NIO' ? 1 : Number(exchange)
  const ready = writable && !busy && parsed.rows.length > 0 && note.trim().length >= 3 && Number.isFinite(rate) && rate > 0

  async function run() {
    if (!ready) return
    setBusy(true)
    setDone(0)
    const failures: { label: string; reason: string }[] = []
    let saved = 0
    // Sequential on purpose: each write locks the product and its balances, so
    // firing 260 at once would just queue them behind each other in Postgres.
    for (const row of parsed.rows) {
      try {
        await accountingService.setOpeningCost({ requestId: crypto.randomUUID(), productId: row.productId, unitCost: roundCost(row.unitCost), currency, exchangeRate: roundCost(rate), note: note.trim() })
        saved++
      } catch (error) {
        failures.push({ label: `${row.code} · ${row.description}`, reason: errorMessage(error) })
      }
      setDone((value) => value + 1)
    }
    setBusy(false)
    setOutcome({ saved, failures })
    onRecorded(`${saved} costo(s) inicial(es) registrado(s)${failures.length ? `; ${failures.length} producto(s) no se pudieron guardar.` : '.'}`)
  }

  return <Dialog open title="Cargar costos iniciales desde una lista" onClose={() => { if (!busy) onClose() }}><div className="accounting-form">
    {outcome ? <>
      <p><strong>{outcome.saved}</strong> producto(s) quedaron con su costo inicial registrado.</p>
      {outcome.failures.length > 0 && <><p className="accounting-note">Estos no se guardaron. Su costo sigue pendiente y puedes volver a intentarlo.</p>
        <ul className="accounting-problems">{outcome.failures.map((failure) => <li key={failure.label}><strong>{failure.label}</strong><span>{failure.reason}</span></li>)}</ul></>}
      <div className="form-actions"><Button onClick={onClose}>Cerrar</Button></div>
    </> : <>
      <p className="accounting-callout">Pega una columna con el código del producto y otra con su costo de compra por unidad, tal como sale de Excel. El costo debe incluir la parte del envío que le tocó a cada perfume. Se registra sobre las existencias contadas actuales y no modifica cantidades ni ventas pasadas.</p>
      <label className="field">
        <span>Lista de códigos y costos</span>
        <textarea rows={8} disabled={busy} value={text} placeholder={'7501234567890\t420.50\n7501234567891\t515'} onChange={(event) => setText(event.target.value)} />
      </label>
      <div className="form-grid">
        <Select label="Moneda de los costos" value={currency} disabled={busy} onChange={(event) => setCurrency(event.target.value as Currency)}><option value="NIO">NIO · Córdobas</option><option value="USD">USD · Dólares</option></Select>
        {currency === 'USD' && <Input label="Tipo de cambio (NIO por 1 USD)" type="number" min="0.000001" max={1000000} step="0.000001" required disabled={busy} value={exchange} onChange={(event) => setExchange(event.target.value)} />}
      </div>
      <Input label="Origen del costo / comprobante" required minLength={3} maxLength={500} disabled={busy} value={note} onChange={(event) => setNote(event.target.value)} />
      {text.trim() && <div className="accounting-form-total"><span>Listas para registrar</span><strong>{parsed.rows.length} producto(s)</strong>{parsed.problems.length > 0 && <small>{parsed.problems.length} fila(s) se omitirán.</small>}</div>}
      {parsed.rows.length > 0 && <LedgerTable label="Costos por registrar" headings={['Producto', 'Existencias', `Costo unitario ${currency}`, 'Inventario a costo NIO']} numeric={[1, 2, 3]}>
        {parsed.rows.slice(0, 12).map((row) => <tr key={row.productId}><th scope="row">{row.description}<small>{row.code}</small></th><td className="num">{row.stock} uds.</td><td className="num">{formatCurrency(row.unitCost, currency)}</td><td className="num">{rate > 0 ? money(row.unitCost * rate * row.stock) : '—'}</td></tr>)}
      </LedgerTable>}
      {parsed.rows.length > 12 && <p className="accounting-note">Se muestran las primeras 12 de {parsed.rows.length} filas.</p>}
      {parsed.problems.length > 0 && <ul className="accounting-problems">{parsed.problems.slice(0, 15).map((problem) => <li key={problem.line}><strong>Línea {problem.line}: {problem.text}</strong><span>{problem.reason}</span></li>)}{parsed.problems.length > 15 && <li><span>…y {parsed.problems.length - 15} fila(s) más con problemas.</span></li>}</ul>}
      {busy && <p role="status" className="accounting-note">Guardando {done} de {parsed.rows.length}…</p>}
      <div className="form-actions"><Button disabled={!ready} onClick={() => void run()}>{busy ? 'Guardando…' : `Registrar ${parsed.rows.length} costo(s)`}</Button><Button variant="secondary" disabled={busy} onClick={onClose}>Cancelar</Button></div>
    </>}
  </div></Dialog>
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
function productName(source: ReportSource, productId: string) { const product = source.inventory.find((item) => item.product.id === productId)?.product; return product ? `${product.brand} ${product.name}` : 'Producto fuera del catálogo actual' }

/**
 * Un pedido es una caja: varios perfumes con su precio original y un solo cobro
 * de la agencia por el peso del paquete. Ese cobro se reparte por igual entre
 * las unidades, así que el formulario enseña el costo puesto de cada renglón
 * mientras se teclea, antes de guardar nada.
 */
interface LineDraft { productId: string; location: InventoryLocation; quantity: string; unitPrice: string }
const blankLine: LineDraft = { productId: '', location: 'warehouse', quantity: '1', unitPrice: '' }

function ShipmentDialog({ source, writable, defaultRate, onClose, onRecorded }: { source: ReportSource; writable: boolean; defaultRate: number | null; onClose: () => void; onRecorded: (message: string) => void }) {
  const { accountingService } = useServices()
  const [operation] = useState(() => createIdempotentOperation<Omit<ShipmentInput, 'requestId'>, unknown>(accountingService.recordShipment))
  const [incurredOn, setIncurredOn] = useState(localDay(new Date()))
  const [supplier, setSupplier] = useState('')
  const [agency, setAgency] = useState('')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [currency, setCurrency] = useState<Currency>('NIO')
  const [exchange, setExchange] = useState(defaultRate ? String(defaultRate) : '')
  const [shipping, setShipping] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([{ ...blankLine }])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')

  const rate = currency === 'NIO' ? 1 : Number(exchange)
  // Un envío en blanco no es un envío de cero: mientras no se teclee, el costo
  // puesto de cada renglón queda sin calcular en lugar de mostrarse incompleto.
  const typedShipping = shipping.trim() === '' ? null : Number(shipping)
  const shippingAmount =
    typedShipping !== null && Number.isFinite(typedShipping) && typedShipping >= 0
      ? typedShipping
      : null
  const stocks = new Map(source.inventory.map((item) => [item.product.id, totalStock(item)]))
  const rows = lines.map((line) => {
    const quantity = Number(line.quantity)
    const unitPrice = Number(line.unitPrice)
    return {
      ...line, quantity, unitPrice,
      valid: !!line.productId && Number.isInteger(quantity) && quantity > 0 && quantity <= 999999 && Number.isFinite(unitPrice) && unitPrice >= 0,
      uncounted: !!line.productId && stocks.get(line.productId) === null,
    }
  })
  const units = rows.reduce((total, row) => total + (row.valid ? row.quantity : 0), 0)
  const goods = rows.reduce((total, row) => total + (row.valid ? row.quantity * row.unitPrice : 0), 0)
  const perUnit = units > 0 && shippingAmount !== null ? shippingAmount / units : null
  const repeated = new Set(rows.filter((row, index) => rows.findIndex((other) => other.productId && other.productId === row.productId) !== index).map((row) => row.productId))
  const uncounted = rows.some((row) => row.uncounted)
  const ready = writable && !busy && rows.every((row) => row.valid) && !repeated.size && !uncounted &&
    shippingAmount !== null && goods + shippingAmount > 0 &&
    Number.isFinite(rate) && rate > 0 && supplier.trim().length > 0

  function update(index: number, changes: Partial<LineDraft>) {
    setLines((current) => current.map((line, position) => position === index ? { ...line, ...changes } : line))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || shippingAmount === null) return
    setFailure('')
    setBusy(true)
    try {
      await operation.execute({
        incurredOn, supplier: supplier.trim(), agency: agency.trim(), reference: reference.trim(), note: note.trim(),
        currency, exchangeRate: roundCost(rate), shippingAmount: roundMoney(shippingAmount),
        lines: rows.map((row): ShipmentLineInput => ({ productId: row.productId, location: row.location, quantity: row.quantity, unitPrice: roundMoney(row.unitPrice) })),
      })
      onRecorded('Pedido registrado. Se sumaron las existencias y cada perfume quedó con su costo puesto en bodega.')
    } catch (error) { setFailure(errorMessage(error)) } finally { setBusy(false) }
  }

  return <Dialog open title="Registrar pedido de importación" onClose={() => { if (!busy) onClose() }}><form className="accounting-form accounting-form-wide" onSubmit={submit}><fieldset disabled={busy}>
    <p className="accounting-callout">Registra la caja completa tal como llegó: el precio que cobró el proveedor por cada perfume —ya con el descuento por cantidad, si lo hubo— y lo que cobró la agencia por el peso del paquete. Esta operación suma las unidades al inventario; no registres además una entrada manual.</p>
    <div className="form-grid">
      <Input label="Fecha del pedido" type="date" required max={localDay(new Date())} value={incurredOn} onChange={(event) => setIncurredOn(event.target.value)} />
      <Input label="Proveedor" maxLength={160} required value={supplier} onChange={(event) => setSupplier(event.target.value)} />
      <Input label="Agencia de envíos" maxLength={160} value={agency} onChange={(event) => setAgency(event.target.value)} />
      <Input label="Número de pedido / referencia" maxLength={200} value={reference} onChange={(event) => setReference(event.target.value)} />
      <Select label="Moneda del pedido" value={currency} onChange={(event) => setCurrency(event.target.value as Currency)}><option value="NIO">NIO · Córdobas</option><option value="USD">USD · Dólares</option></Select>
      {currency === 'USD' && <Input label="Tipo de cambio (NIO por 1 USD)" type="number" min="0.000001" max={1000000} step="0.000001" required value={exchange} onChange={(event) => setExchange(event.target.value)} />}
      <Input label={`Envío cobrado por la agencia (${currency})`} type="number" min={0} max={10000000} step="0.01" required value={shipping} onChange={(event) => setShipping(event.target.value)} />
    </div>
    <div className="accounting-lines">
      <div className="section-heading"><div><h4>Perfumes de la caja</h4><p className="accounting-note">El envío se reparte por igual entre todas las unidades del pedido.</p></div><Button type="button" variant="secondary" onClick={() => setLines((current) => [...current, { ...blankLine }])}><Plus size={17} />Agregar perfume</Button></div>
      {rows.map((row, index) => <div className="accounting-line" key={index}>
        <ProductSelect label="Perfume" products={source.inventory.map(({ product }) => product)} value={row.productId} onChange={(productId) => update(index, { productId })} />
        <Select label="Recibido en" value={row.location} onChange={(event) => update(index, { location: event.target.value as InventoryLocation })}>{Object.entries(labels.location).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</Select>
        <Input label="Unidades" type="number" min={1} max={999999} step={1} required value={row.quantity} onChange={(event) => update(index, { quantity: event.target.value })} />
        <Input label={`Precio unitario (${currency})`} type="number" min={0} max={10000000} step="0.01" required value={row.unitPrice} onChange={(event) => update(index, { unitPrice: event.target.value })} />
        <div className="accounting-line-cost"><span>Costo puesto</span><strong>{row.valid && perUnit !== null && rate > 0 ? money(roundMoney((row.unitPrice + perUnit) * rate)) : '—'}</strong>{row.uncounted && <small>Falta el conteo de tienda y bodega</small>}{repeated.has(row.productId) && <small>Este perfume ya está en otro renglón</small>}</div>
        <Button type="button" variant="ghost" aria-label={`Quitar el renglón ${index + 1}`} disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((_, position) => position !== index))}><Trash2 size={17} /></Button>
      </div>)}
    </div>
    <Input label="Nota del pedido" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
    <div className="accounting-form-total"><span>Costo del pedido en NIO</span><strong>{rate > 0 && shippingAmount !== null ? money(roundMoney((goods + shippingAmount) * rate)) : 'Completa los importes'}</strong>{perUnit !== null && rate > 0 && <small>{units} unidad(es) · {money(roundMoney(perUnit * rate))} de envío por unidad</small>}</div>
    {failure && <p role="alert" className="inline-error">{failure}</p>}
    <div className="form-actions"><Button type="submit" disabled={!ready}>{busy ? 'Guardando…' : 'Registrar pedido y recibir'}</Button><Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button></div>
  </fieldset></form></Dialog>
}

function AccountingAction({ action, source, writable, defaultRate, onClose, onRecorded }: { action: Exclude<Action, { kind: 'bulk' } | { kind: 'shipment' }>; source: ReportSource; writable: boolean; defaultRate: number | null; onClose: () => void; onRecorded: (message: string) => void }) {
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

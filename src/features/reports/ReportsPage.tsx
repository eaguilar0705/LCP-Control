import { useCallback, useMemo, useState } from 'react'
import {
  CalendarRange,
  FileDown,
  FileSpreadsheet,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from '../../components/ui'
import {
  ColumnChart,
  RankedBars,
  SplitBar,
  TrendChart,
} from '../../components/charts'
import { useAccess } from '../../app/AccessContext'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { can } from '../../lib/permissions'
import { formatCurrency, formatDate } from '../../lib/format'
import { errorMessage } from '../../lib/errors'
import type { Currency, PriceTier } from '../../lib/domain'
import { priceTierLabels } from '../../lib/pricing'
import { AccountingPanel } from './AccountingPanel'
import {
  change,
  concentration,
  currenciesWithSales,
  customerActivity,
  idleStock,
  inRange,
  inventoryHealth,
  lapsedCustomers,
  localDay,
  movementSummary,
  movementsInRange,
  paymentBreakdown,
  adjustRange,
  presetLabels,
  presetRange,
  previousRange,
  proformaConversion,
  proformaCount,
  purchaseFrequency,
  revenueByDay,
  salesByWeekday,
  shrinkage,
  stockCoverage,
  summary,
  tierBreakdown,
  topProducts,
  type Preset,
  type ReportRange,
  type ReportSource,
} from './model'

const compact = new Intl.NumberFormat('es-NI', {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const whole = new Intl.NumberFormat('es-NI', { maximumFractionDigits: 0 })
const oneDecimal = new Intl.NumberFormat('es-NI', {
  maximumFractionDigits: 1,
})
const percent = new Intl.NumberFormat('es-NI', {
  style: 'percent',
  maximumFractionDigits: 0,
})
const shortDay = new Intl.DateTimeFormat('es-NI', {
  day: 'numeric',
  month: 'short',
  timeZone: 'America/Managua',
})

export function ReportsPage() {
  const { role, demo } = useAccess()
  if (!can(role, 'finance.read') && !demo)
    return (
      <EmptyState
        title="No tienes permiso para ver los reportes."
        description="Los reportes del negocio son para las cuentas de administración."
      />
    )
  return <Reports />
}

function Reports() {
  const { reportService, salesService } = useServices()
  // `null`: fechas elegidas a mano, ningún botón de periodo queda marcado.
  const [preset, setPreset] = useState<Preset | null>('30d')
  const [range, setRange] = useState<ReportRange>(() => presetRange('30d'))
  const [tier, setTier] = useState<PriceTier>('emprendedor')
  const [exporting, setExporting] = useState('')
  const [failure, setFailure] = useState('')

  const load = useCallback(
    () => reportService.getSource(range),
    [reportService, range],
  )
  const { data, loading, error, retry } = useQuery(load)
  const { data: business } = useQuery(salesService.getBusiness)

  function choosePreset(next: Preset) {
    setPreset(next)
    setRange(presetRange(next))
  }
  function chooseDay(edge: 'from' | 'to', value: string) {
    if (!value) return
    // Antes una fecha a mano dejaba marcado «Últimos 30 días» aunque el
    // periodo fuera otro, y un «Desde» posterior al «Hasta» (tecleado, el
    // calendario no lo permite) mostraba todo en cero sin explicación.
    setPreset(null)
    setRange((current) => adjustRange(current, edge, value))
  }

  async function exportAs(format: 'pdf' | 'excel') {
    if (!data) return
    setExporting(format)
    setFailure('')
    try {
      const { exportReport } = await import('./export')
      await exportReport(format, {
        source: data,
        range,
        tier,
        business: business ?? {
          name: 'La Casa del Perfume',
          address: '',
          phone: '',
        },
      })
    } catch (e) {
      setFailure(errorMessage(e))
    } finally {
      setExporting('')
    }
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">ANÁLISIS DEL NEGOCIO</span>
          <h1>Reportes</h1>
          <p className="muted">
            {formatDate(range.from)} — {formatDate(range.to)}
          </p>
        </div>
        <div className="report-exports">
          <Button
            variant="secondary"
            disabled={!data || !!exporting}
            onClick={() => void exportAs('pdf')}
          >
            <FileDown size={17} />
            {exporting === 'pdf' ? 'Generando…' : 'Descargar PDF'}
          </Button>
          <Button
            variant="secondary"
            disabled={!data || !!exporting}
            onClick={() => void exportAs('excel')}
          >
            <FileSpreadsheet size={17} />
            {exporting === 'excel' ? 'Generando…' : 'Descargar Excel'}
          </Button>
        </div>
      </div>

      <Card className="report-filters">
        <div className="preset-row" role="group" aria-label="Periodo">
          <CalendarRange size={17} />
          {(Object.keys(presetLabels) as Preset[]).map((key) => (
            <button
              key={key}
              type="button"
              className={`preset ${preset === key ? 'preset-active' : ''}`}
              aria-pressed={preset === key}
              onClick={() => choosePreset(key)}
            >
              {presetLabels[key]}
            </button>
          ))}
        </div>
        <div className="filter-grid">
          <Input
            label="Desde"
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => chooseDay('from', e.target.value)}
          />
          <Input
            label="Hasta"
            type="date"
            value={range.to}
            min={range.from}
            onChange={(e) => chooseDay('to', e.target.value)}
          />
          <Select
            label="Lista para valorar inventario"
            value={tier}
            onChange={(e) => setTier(e.target.value as PriceTier)}
          >
            {(Object.keys(priceTierLabels) as PriceTier[]).map((key) => (
              <option key={key} value={key}>
                {priceTierLabels[key]}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      {failure && (
        <p className="inline-error" role="alert">
          {failure}
        </p>
      )}

      {loading ? (
        <LoadingState />
      ) : error || !data ? (
        <ErrorState message={error ?? 'Sin datos.'} retry={retry} />
      ) : (
        <>
          <AccountingPanel source={data} range={range} onRecorded={retry} />
          <ReportBody source={data} range={range} tier={tier} />
        </>
      )}
    </>
  )
}

/** Cifra con su variación frente al periodo anterior. */
function Stat({
  title,
  value,
  detail,
  variation,
}: {
  title: string
  value: string
  detail: string
  variation?: number | null
}) {
  const up = (variation ?? 0) >= 0
  return (
    <Card className="stat-card">
      <div>{title}</div>
      <strong>{value}</strong>
      {variation === undefined || variation === null ? (
        <small>{detail}</small>
      ) : (
        <small className="stat-delta">
          <span className={up ? 'delta-up' : 'delta-down'}>
            {up ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
            {percent.format(Math.abs(variation))}
          </span>
          {detail}
        </small>
      )}
    </Card>
  )
}

function ReportBody({
  source,
  range,
  tier,
}: {
  source: ReportSource
  range: ReportRange
  tier: PriceTier
}) {
  // La consulta trae también el periodo anterior: todo lo que mide «el
  // periodo» se calcula sobre este recorte, nunca sobre la ventana completa.
  const current = useMemo(
    () => inRange(source.documents, range),
    [source.documents, range],
  )
  const currencies = useMemo(() => currenciesWithSales(current), [current])
  const health = useMemo(
    () => inventoryHealth(source.inventory, tier, currencies[0] ?? 'NIO'),
    [source.inventory, tier, currencies],
  )
  const movements = useMemo(
    () => movementSummary(movementsInRange(source.movements, range)),
    [source.movements, range],
  )
  const coverage = useMemo(
    () =>
      stockCoverage(current, source.inventory, range, currencies[0] ?? 'NIO'),
    [current, source.inventory, range, currencies],
  )
  const idle = useMemo(
    () => idleStock(current, source.inventory, tier, currencies[0] ?? 'NIO'),
    [current, source.inventory, tier, currencies],
  )
  const damaged = useMemo(
    () =>
      shrinkage(
        movementsInRange(source.movements, range),
        source.inventory,
        tier,
        currencies[0] ?? 'NIO',
      ),
    [source.movements, source.inventory, tier, currencies, range],
  )
  const money = (value: number) => formatCurrency(value, currencies[0] ?? 'NIO')

  return (
    <>
      {source.truncated && (
        <p className="page-feedback" role="status">
          El periodo tiene más documentos de los que se consultan de una vez.
          Las cifras corresponden a las filas consultadas; acorta el rango para
          un total exacto.
        </p>
      )}

      {currencies.length === 0 ? (
        <Card>
          <EmptyState
            title="Sin ventas en este periodo"
            description="Cuando emitas facturas en este rango aparecerán aquí los ingresos, los productos más vendidos y los clientes."
          />
        </Card>
      ) : (
        currencies.map((currency) => (
          <CurrencyReport
            key={currency}
            currency={currency}
            source={source}
            current={current}
            range={range}
          />
        ))
      )}

      <div className="section-kicker">INVENTARIO Y REPOSICIÓN</div>
      <div className="report-columns">
        <Card className="report-card">
          <div className="section-heading">
            <h2>Qué reponer primero</h2>
          </div>
          <p className="muted report-note">
            Días que duran las existencias al ritmo de venta del periodo.
          </p>
          {coverage.length ? (
            /* La barra mide los días que aguantan las existencias y la lista
               va de menos a más: lo urgente queda arriba, con la barra corta.
               Invertir la escala para que «lo grave» se vea largo falsearía la
               única cosa que el gráfico dice. */
            <RankedBars
              label="Días de cobertura por producto"
              format={(value) => `${oneDecimal.format(value)} días`}
              bars={coverage.map((row) => ({
                label: row.description,
                value: row.days,
                detail: `${whole.format(row.stock)} en existencia · ${oneDecimal.format(row.perDay)} por día`,
              }))}
            />
          ) : (
            <EmptyState
              title="Sin ritmo que proyectar"
              description="Hacen falta ventas del periodo y conteos de inventario para estimar la cobertura."
            />
          )}
        </Card>

        <Card className="report-card">
          <div className="section-heading">
            <h2>Capital detenido</h2>
          </div>
          <p className="muted report-note">
            Con existencias y sin una sola venta en el periodo, valorado a
            precio de lista {priceTierLabels[tier]}.
          </p>
          {idle.length ? (
            <RankedBars
              label="Productos sin ventas por valor detenido"
              format={money}
              bars={idle.map((row) => ({
                label: row.description,
                value: row.listValue,
                detail: `${whole.format(row.stock)} unidades`,
              }))}
            />
          ) : (
            <EmptyState
              title="Todo se movió"
              description="Cada producto con existencias vendió al menos una unidad."
            />
          )}
        </Card>

        <Card className="report-card">
          <div className="section-heading">
            <h2>Estado de las existencias</h2>
            <span className="badge badge-neutral">{priceTierLabels[tier]}</span>
          </div>
          <p className="report-figure">{money(health.listValue)}</p>
          <p className="muted report-note">
            Valor a precio de lista de {whole.format(health.units)} unidades
            contadas. No es el costo de compra: ese está arriba, en el panel de
            contabilidad, calculado con el costo promedio de cada perfume.
          </p>
          <SplitBar
            label="Estado de las existencias"
            format={(value) => `${whole.format(value)}`}
            segments={[
              {
                key: 'available',
                label: 'Con existencias',
                value: health.available,
              },
              { key: 'low', label: 'Bajo el mínimo', value: health.low },
              { key: 'out', label: 'Agotados', value: health.out },
              {
                key: 'uncounted',
                label: 'Sin conteo',
                value: health.uncounted,
              },
            ].filter((segment) => segment.value > 0)}
          />
        </Card>

        <Card className="report-card">
          <div className="section-heading">
            <h2>Movimientos y mermas</h2>
          </div>
          <ColumnChart
            label="Unidades por tipo de movimiento"
            format={(value) => compact.format(value)}
            bars={[
              { label: 'Entradas', value: movements.entries },
              { label: 'Ventas', value: movements.sales },
              { label: 'Salidas', value: movements.exits },
              { label: 'Dañados', value: movements.damaged },
            ]}
          />
          <p className="muted report-note">
            {movements.adjustments
              ? `${movements.adjustments} ajuste(s) de conteo en el periodo.`
              : 'Sin ajustes de conteo en el periodo.'}
          </p>
          {damaged.length > 0 && (
            <>
              <h3 className="report-subhead">Mermas por producto</h3>
              <RankedBars
                label="Unidades dañadas por valor"
                format={money}
                bars={damaged.map((row) => ({
                  label: row.description,
                  value: row.listValue,
                  detail: `${whole.format(row.units)} unidades dañadas`,
                }))}
              />
            </>
          )}
        </Card>
      </div>
    </>
  )
}

function CurrencyReport({
  currency,
  source,
  current,
  range,
}: {
  currency: Currency
  source: ReportSource
  current: ReportSource['documents']
  range: ReportRange
}) {
  const previous = useMemo(
    () => inRange(source.documents, previousRange(range)),
    [source.documents, range],
  )
  const totals = summary(current, currency)
  const before = summary(previous, currency)
  const daily = revenueByDay(current, currency, range)
  const products = topProducts(current, currency, 8)
  const payments = paymentBreakdown(current, currency)
  const tiers = tierBreakdown(current, currency)
  const clients = customerActivity(current, source.customers, currency, range)
  const lapsed = lapsedCustomers(source.documents, range, currency)
  const frequency = purchaseFrequency(
    source.documents,
    currency,
    localDay(new Date()),
    6,
  )
  const weekdays = salesByWeekday(current, currency)
  const conversion = proformaConversion(current, currency)
  const productShare = concentration(
    topProducts(current, currency, 1000).map((product) => product.revenue),
    10,
  )
  const clientShare = concentration(
    clients.top.map((client) => client.revenue),
    5,
  )
  const money = (value: number) => formatCurrency(value, currency)
  const shortMoney = (value: number) =>
    `${currency === 'NIO' ? 'C$' : '$'}${compact.format(value)}`

  return (
    <section className="report-currency">
      <div className="section-kicker">
        {currency === 'NIO' ? 'CÓRDOBAS' : 'DÓLARES'}
      </div>
      <div className="stats-grid">
        <Stat
          title="Ingresos"
          value={money(totals.revenue)}
          detail={`${totals.count} facturas · antes ${money(before.revenue)}`}
          variation={change(totals.revenue, before.revenue)}
        />
        <Stat
          title="Ticket promedio"
          value={money(totals.average)}
          detail={`antes ${money(before.average)}`}
          variation={change(totals.average, before.average)}
        />
        <Stat
          title="Unidades vendidas"
          value={whole.format(totals.units)}
          detail={`${totals.customers} cliente(s) distintos`}
          variation={change(totals.units, before.units)}
        />
        <Stat
          title="Proformas"
          value={whole.format(proformaCount(current, currency))}
          detail={
            conversion.rate === null
              ? 'Cotizaciones emitidas'
              : `${percent.format(conversion.rate)} terminó en factura`
          }
        />
      </div>

      <Card className="report-card">
        <div className="section-heading">
          <h2>Ingresos por día</h2>
        </div>
        <TrendChart
          label={`Ingresos diarios en ${currency}`}
          format={shortMoney}
          points={daily.map((point) => ({
            label: shortDay.format(new Date(`${point.day}T12:00:00Z`)),
            value: point.revenue,
            detail: `${formatDate(point.day)} · ${point.count} factura(s)`,
          }))}
        />
      </Card>

      <div className="report-columns">
        <Card className="report-card">
          <div className="section-heading">
            <h2>Productos más vendidos</h2>
          </div>
          {products.length ? (
            <>
              <RankedBars
                label="Productos por importe vendido"
                format={money}
                bars={products.map((product) => ({
                  label: product.description,
                  value: product.revenue,
                  detail: `${whole.format(product.quantity)} unidades`,
                }))}
              />
              {productShare !== null && (
                <p className="muted report-note report-foot">
                  Los diez primeros concentran el{' '}
                  <strong>{percent.format(productShare)}</strong> de los
                  ingresos.
                </p>
              )}
            </>
          ) : (
            <EmptyState
              title="Sin renglones"
              description="Las facturas del periodo no tienen productos registrados."
            />
          )}
        </Card>

        <Card className="report-card">
          <div className="section-heading">
            <h2>Clientes</h2>
          </div>
          <div className="client-split">
            <div>
              <strong>{clients.newCustomers}</strong>
              <span>Nuevos en el periodo</span>
            </div>
            <div>
              <strong>{clients.returning}</strong>
              <span>Ya eran clientes</span>
            </div>
          </div>
          {clients.top.length > 0 && (
            <>
              <RankedBars
                label="Clientes por importe comprado"
                format={money}
                bars={clients.top.map((client) => ({
                  label: client.name,
                  value: client.revenue,
                  detail: `${client.count} factura(s)`,
                }))}
              />
              {clientShare !== null && (
                <p className="muted report-note report-foot">
                  Los cinco primeros concentran el{' '}
                  <strong>{percent.format(clientShare)}</strong> de los
                  ingresos.
                </p>
              )}
            </>
          )}
        </Card>

        <Card className="report-card">
          <div className="section-heading">
            <h2>Clientes que no volvieron</h2>
          </div>
          <p className="muted report-note">
            Compraron en el periodo anterior y no en éste.
          </p>
          {lapsed.length ? (
            <ul className="lapsed-list">
              {lapsed.map((client) => (
                <li key={client.id}>
                  <div>
                    <strong>{client.name}</strong>
                    <small>
                      Última compra hace {whole.format(client.daysSince)} días ·{' '}
                      {client.orders} factura(s)
                    </small>
                  </div>
                  <span>{money(client.previousRevenue)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="Ninguno se enfrió"
              description="Todos los que compraron el periodo anterior volvieron a comprar."
            />
          )}
        </Card>

        <Card className="report-card">
          <div className="section-heading">
            <h2>Con qué frecuencia vuelven</h2>
          </div>
          {frequency.length ? (
            <ul className="lapsed-list">
              {frequency.map((client) => (
                <li key={client.id}>
                  <div>
                    <strong>{client.name}</strong>
                    <small>
                      {client.orders} compra(s) ·{' '}
                      {client.averageDays === null
                        ? 'sin intervalo aún'
                        : `cada ${oneDecimal.format(client.averageDays)} días`}
                    </small>
                  </div>
                  <span>hace {whole.format(client.daysSinceLast)} d</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="Sin compras registradas"
              description="La frecuencia se calcula con el historial cargado."
            />
          )}
        </Card>

        <Card className="report-card">
          <div className="section-heading">
            <h2>Ventas por día de la semana</h2>
          </div>
          <ColumnChart
            label="Ingresos por día de la semana"
            format={shortMoney}
            bars={weekdays.map((day) => ({
              label: day.label.slice(0, 3),
              value: day.revenue,
              detail: `${day.label} · ${day.count} factura(s)`,
            }))}
          />
        </Card>

        <Card className="report-card">
          <div className="section-heading">
            <h2>Formas de pago</h2>
          </div>
          <SplitBar
            label="Ingresos por forma de pago"
            format={money}
            segments={payments}
          />
        </Card>

        <Card className="report-card">
          <div className="section-heading">
            <h2>Listas de precios</h2>
          </div>
          <SplitBar
            label="Ingresos por lista de precios"
            format={money}
            segments={tiers}
          />
        </Card>
      </div>
    </section>
  )
}

import { useCallback, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { Card, EmptyState, ErrorState, LoadingState } from '../../components/ui'
import { RankedBars, SplitBar, TrendChart } from '../../components/charts'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { useAccess } from '../../app/AccessContext'
import { formatCurrency, formatDate } from '../../lib/format'
import { accountingExchangeRate } from '../../lib/exchangeRates'
import { readLedgerBalances } from '../accounting/journalService'
import { periodSalesNio } from '../accounting/journalModel'
import { localDay } from '../reports/model'
import { reportView, type ReportData } from '../reports/digest'

const shortDay = new Intl.DateTimeFormat('es-NI', {
  day: 'numeric',
  month: 'short',
  timeZone: 'America/Managua',
})

export function HomeCharts() {
  const { reportService, settingsService } = useServices()
  const { base, demo } = useAccess()
  const to = localDay(new Date())
  const from = to.slice(0, 7) + '-01'
  const loadReport = useCallback(
    () => reportService.getSource({ from, to }),
    [reportService, from, to],
  )
  const loadSales = useCallback(async () => {
    const [ledger, rate] = await Promise.all([
      demo ? null : readLedgerBalances(from, to),
      settingsService.getExchangeRate(),
    ])
    return {
      to,
      total: ledger && periodSalesNio(ledger),
      rate: accountingExchangeRate(rate),
    }
  }, [demo, from, to, settingsService])

  const report = useQuery(loadReport)
  const sales = useQuery(loadSales)
  const { refresh: refreshSales } = sales
  const { refresh: refreshReport } = report
  useEffect(() => {
    function update() {
      if (document.visibilityState === 'visible') {
        refreshSales()
        refreshReport()
      }
    }
    window.addEventListener('focus', update)
    window.addEventListener('online', update)
    document.addEventListener('visibilitychange', update)
    const timer = window.setInterval(update, 60000)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('online', update)
      document.removeEventListener('visibilitychange', update)
      window.clearInterval(timer)
    }
  }, [refreshSales, refreshReport])

  const data =
    report.data?.range.to === to && report.data.range.from === from
      ? report.data
      : null
  const balances = sales.data?.to === to ? sales.data : null
  const total = demo ? data?.ledger?.revenueNio : balances?.total
  const count =
    data && !data.truncated
      ? data.sales.USD.current.count + data.sales.NIO.current.count
      : null
  return (
    <div className="home-charts">
      <Card className="report-card home-chart-wide">
        <div className="section-heading">
          <h2>Ventas del mes</h2>
          <Link
            to={demo ? base + '/reports' : base + '/accounting?section=income'}
          >
            {demo ? 'Ver reportes' : 'Estado de resultados'}{' '}
            <ArrowRight size={15} />
          </Link>
        </div>
        <p className="muted report-note">
          {formatDate(from)} al {formatDate(to)}
        </p>
        {sales.error ? (
          <ErrorState message={sales.error} retry={sales.retry} />
        ) : !balances || (demo && report.loading) ? (
          <LoadingState />
        ) : total == null ? (
          <p role="status" className="muted">
            {demo
              ? 'Sin ventas contables disponibles.'
              : 'Ventas pendientes de confirmar. Revisa la apertura y el detalle de ventas en Contabilidad.'}
          </p>
        ) : (
          <>
            <p className="report-figure">{formatCurrency(total, 'NIO')}</p>
            <p className="report-note">
              {balances.rate
                ? formatCurrency(total / balances.rate, 'USD') +
                  ' equivalentes · C$' +
                  balances.rate +
                  ' por US$1'
                : 'Configura la tasa contable en Negocio para ver el equivalente en dólares.'}
            </p>
          </>
        )}
        {count != null && (
          <p className="muted report-note">
            {count} {count === 1 ? 'factura' : 'facturas'}
          </p>
        )}
        {data && count != null && count > 0 && <InvoiceTrend data={data} />}
      </Card>
      {report.error ? (
        <Card>
          <ErrorState message={report.error} retry={report.retry} />
        </Card>
      ) : data ? (
        <InventoryCharts data={data} />
      ) : (
        <LoadingState />
      )}
    </div>
  )
}

function InvoiceTrend({ data }: { data: ReportData }) {
  const view = reportView(data)
  const dollars = view.revenueByDay('USD')
  return (
    <>
      <h3>Facturas por día</h3>
      <TrendChart
        label="Facturas por día en ambas monedas"
        format={String}
        points={view.revenueByDay('NIO').map((point, index) => ({
          label: shortDay.format(new Date(point.day + 'T12:00:00Z')),
          value: point.count + dollars[index].count,
          detail: formatDate(point.day),
        }))}
      />
    </>
  )
}

function InventoryCharts({ data }: { data: ReportData }) {
  const { base } = useAccess()
  const view = reportView(data)
  const currency =
    view.currencies
      .map((code) => ({ code, count: view.summary(code).count }))
      .sort((a, b) => b.count - a.count)[0]?.code ?? 'NIO'
  const products = view.topProducts(currency, 5)
  const health = view.inventoryHealth('emprendedor', currency)
  const money = (value: number) => formatCurrency(value, currency)

  return (
    <>
      <Card className="report-card">
        <div className="section-heading">
          <h2>Más vendidos del mes en {currency}</h2>
        </div>
        {products.length ? (
          <RankedBars
            label="Productos por importe vendido"
            format={money}
            bars={products.map((product) => ({
              key: product.productId,
              label: product.description,
              value: product.revenue,
              detail: `${product.quantity} unidades`,
            }))}
          />
        ) : (
          <EmptyState title="Sin ventas aún" />
        )}
      </Card>

      <Card className="report-card">
        <div className="section-heading">
          <h2>Estado del inventario</h2>
          <Link to={`${base}/inventory`}>
            Ver inventario <ArrowRight size={15} />
          </Link>
        </div>
        {health.uncounted === data.inventory.length ? (
          <EmptyState title="Ningún producto tiene conteo" />
        ) : (
          <SplitBar
            label="Productos por estado de existencias"
            format={(value) => `${value}`}
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
        )}
      </Card>
    </>
  )
}

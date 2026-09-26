import { useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { Card, EmptyState, ErrorState, LoadingState } from '../../components/ui'
import { RankedBars, SplitBar, TrendChart } from '../../components/charts'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { useAccess } from '../../app/AccessContext'
import { formatCurrency, formatDate } from '../../lib/format'
import { presetRange } from '../reports/model'
import { reportView } from '../reports/digest'

const compact = new Intl.NumberFormat('es-NI', {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const shortDay = new Intl.DateTimeFormat('es-NI', {
  day: 'numeric',
  month: 'short',
  timeZone: 'America/Managua',
})

/**
 * Resumen de los últimos 30 días en la portada. Es la misma lectura que hace la
 * pantalla de Reportes, recortada a lo que cabe de un vistazo; quien necesite el
 * detalle o el periodo completo entra ahí.
 */
export function HomeCharts() {
  const { reportService } = useServices()
  const { base } = useAccess()
  const range = useMemo(() => presetRange('30d'), [])
  const load = useCallback(
    () => reportService.getSource(range),
    [reportService, range],
  )
  const { data, loading, error, retry } = useQuery(load)

  if (loading)
    return (
      <Card className="report-card">
        <LoadingState />
      </Card>
    )
  if (error || !data)
    return (
      <Card className="report-card">
        <ErrorState message={error ?? 'Sin datos.'} retry={retry} />
      </Card>
    )

  // El resumen trae el mes en curso y el anterior, ya sumados por moneda.
  const view = reportView(data)
  // La moneda con más facturas manda en la portada; el resto se ve en Reportes.
  const currency =
    view.currencies
      .map((code) => ({ code, count: view.summary(code).count }))
      .sort((a, b) => b.count - a.count)[0]?.code ?? 'NIO'
  const totals = view.summary(currency)
  const variation = view.variation(currency)
  const daily = view.revenueByDay(currency)
  const products = view.topProducts(currency, 5)
  const health = view.inventoryHealth('emprendedor', currency)
  const money = (value: number) => formatCurrency(value, currency)

  return (
    <div className="home-charts">
      <Card className="report-card home-chart-wide">
        <div className="section-heading">
          <h2>Ingresos de los últimos 30 días</h2>
          <Link to={`${base}/reports`}>
            Ver reportes <ArrowRight size={15} />
          </Link>
        </div>
        {view.currencies.length ? (
          <>
            <p className="report-figure">{money(totals.revenue)}</p>
            <p className="muted report-note">
              {variation !== null && (
                <span className={variation >= 0 ? 'delta-up' : 'delta-down'}>
                  {variation >= 0 ? '▲' : '▼'}{' '}
                  {Math.abs(Math.round(variation * 100))}% frente a los 30 días
                  anteriores
                </span>
              )}
              {variation !== null && ' · '}
              {totals.count} facturas · ticket promedio {money(totals.average)}
            </p>
            <TrendChart
              label={`Ingresos diarios en ${currency}`}
              format={(value) =>
                `${currency === 'NIO' ? 'C$' : '$'}${compact.format(value)}`
              }
              points={daily.map((point) => ({
                label: shortDay.format(new Date(`${point.day}T12:00:00Z`)),
                value: point.revenue,
                detail: `${formatDate(point.day)} · ${point.count} factura(s)`,
              }))}
            />
          </>
        ) : (
          <EmptyState
            title="Todavía no hay ventas"
            description="Al emitir la primera factura aparecerá aquí el movimiento de los últimos 30 días."
          />
        )}
      </Card>

      <Card className="report-card">
        <div className="section-heading">
          <h2>Más vendidos del mes</h2>
        </div>
        {products.length ? (
          <RankedBars
            label="Productos por importe vendido"
            format={money}
            bars={products.map((product) => ({
              label: product.description,
              value: product.revenue,
              detail: `${product.quantity} unidades`,
            }))}
          />
        ) : (
          <EmptyState
            title="Sin ventas aún"
            description="El ranking se arma con las facturas emitidas."
          />
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
          <EmptyState
            title="Ningún producto tiene conteo"
            description="Registra las existencias con un ajuste desde Inventario para ver aquí el estado del catálogo."
          />
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
    </div>
  )
}

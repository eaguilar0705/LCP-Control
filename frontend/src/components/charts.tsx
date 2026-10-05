import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Gráficos dibujados a mano en SVG. El proyecto no arrastra una librería de
 * visualización: estas cuatro formas cubren lo que muestran los reportes y
 * pesan unos pocos kilobytes, frente a los cientos de una librería general.
 *
 * Reglas que comparten todas las formas: el texto nunca lleva el color de la
 * serie, la separación entre marcas la hace el fondo y no un borde, y ninguna
 * cifra se escribe sobre una marca donde no quepa.
 */

const SERIES = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
]

/** Ancho real del contenedor: el SVG se dibuja en píxeles, no escalado. */
function useWidth(fallback = 640) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width)
      if (next > 0) setWidth(next)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

function niceCeiling(value: number) {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 1.5, 2, 2.5, 5, 10])
    if (value <= step * magnitude) return step * magnitude
  return 10 * magnitude
}

function Tip({
  x,
  y,
  width,
  children,
}: {
  x: number
  y: number
  width: number
  children: ReactNode
}) {
  // La caja se mantiene dentro del gráfico en vez de salirse por el borde.
  const left = Math.min(Math.max(x, 8), Math.max(8, width - 8))
  return (
    <div
      className="chart-tip"
      style={{ left, top: y, transform: `translate(-50%, -100%)` }}
      role="presentation"
    >
      {children}
    </div>
  )
}

interface TrendPoint {
  label: string
  value: number
  detail?: string
}
/**
 * Tendencia de una sola serie: línea de 2 px sobre un relleno tenue del mismo
 * tono. Una sola serie no lleva leyenda; el título del panel ya la nombra.
 */
export function TrendChart({
  points,
  format,
  height = 190,
  label,
}: {
  points: TrendPoint[]
  format: (value: number) => string
  height?: number
  label: string
}) {
  const [ref, width] = useWidth()
  const [active, setActive] = useState<number | null>(null)
  const padding = { top: 16, right: 14, bottom: 26, left: 58 }
  const plotWidth = Math.max(10, width - padding.left - padding.right)
  const plotHeight = height - padding.top - padding.bottom
  const max = niceCeiling(Math.max(...points.map((point) => point.value), 0))
  const step = points.length > 1 ? plotWidth / (points.length - 1) : 0
  const at = (index: number) => padding.left + index * step
  const scale = (value: number) =>
    padding.top + plotHeight - (value / max) * plotHeight
  const line = points
    .map((point, index) => `${at(index)},${scale(point.value)}`)
    .join(' ')
  const area = points.length
    ? `M${padding.left},${padding.top + plotHeight} L${line.replaceAll(' ', ' L')} L${at(points.length - 1)},${padding.top + plotHeight} Z`
    : ''
  const ticks = [0, 0.5, 1].map((fraction) => max * fraction)
  // Con muchos días no cabe una fecha por punto: se rotulan cinco repartidas.
  const labelEvery = Math.max(1, Math.ceil(points.length / 5))
  const current = active === null ? null : points[active]

  return (
    <div className="chart" ref={ref}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={label}
        onMouseLeave={() => setActive(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={scale(tick)}
              y2={scale(tick)}
              className="chart-grid"
            />
            <text
              x={padding.left - 8}
              y={scale(tick) + 4}
              className="chart-axis"
              textAnchor="end"
            >
              {format(tick)}
            </text>
          </g>
        ))}
        {points.length > 1 && (
          <>
            <path d={area} className="chart-area" />
            <polyline points={line} className="chart-line" />
          </>
        )}
        {points.map((point, index) =>
          index % labelEvery === 0 || index === points.length - 1 ? (
            <text
              key={point.label}
              x={at(index)}
              y={height - 8}
              className="chart-axis"
              textAnchor={
                index === 0
                  ? 'start'
                  : index === points.length - 1
                    ? 'end'
                    : 'middle'
              }
            >
              {point.label}
            </text>
          ) : null,
        )}
        {active !== null && points[active] && (
          <>
            <line
              x1={at(active)}
              x2={at(active)}
              y1={padding.top}
              y2={padding.top + plotHeight}
              className="chart-crosshair"
            />
            <circle
              cx={at(active)}
              cy={scale(points[active].value)}
              r={5}
              className="chart-dot"
            />
          </>
        )}
        {/* Franjas invisibles: el objetivo del puntero es mucho mayor que el
            punto, que a este tamaño sería imposible de acertar. */}
        {points.map((point, index) => (
          <rect
            key={`hit-${point.label}`}
            x={at(index) - step / 2}
            y={padding.top}
            width={Math.max(step, 6)}
            height={plotHeight}
            fill="transparent"
            onMouseEnter={() => setActive(index)}
          />
        ))}
      </svg>
      {current && (
        <Tip x={at(active!)} y={scale(current.value) - 10} width={width}>
          <strong>{format(current.value)}</strong>
          <span>{current.detail ?? current.label}</span>
        </Tip>
      )}
    </div>
  )
}

interface RankedBar {
  label: string
  value: number
  detail?: string
}
/**
 * Magnitud ordenada. Un solo tono para todas las barras: teñir cada una según
 * su tamaño repetiría en color lo que la longitud ya dice.
 */
export function RankedBars({
  bars,
  format,
  label,
}: {
  bars: RankedBar[]
  format: (value: number) => string
  label: string
}) {
  const max = Math.max(...bars.map((bar) => bar.value), 0) || 1
  return (
    <ul className="ranked-bars" aria-label={label}>
      {bars.map((bar) => (
        <li key={bar.label}>
          <div className="ranked-head">
            <span title={bar.label}>{bar.label}</span>
            <strong>{format(bar.value)}</strong>
          </div>
          <div className="ranked-track">
            <div
              className="ranked-fill"
              style={{ width: `${Math.max(2, (bar.value / max) * 100)}%` }}
            />
          </div>
          {bar.detail && <small>{bar.detail}</small>}
        </li>
      ))}
    </ul>
  )
}

interface Segment {
  key: string
  label: string
  value: number
  detail?: string
}
/**
 * Parte a todo en una barra horizontal. Se queda en cuatro segmentos: más
 * clases dejan de distinguirse y el dato pasa a leerse mejor en la tabla.
 */
export function SplitBar({
  segments,
  format,
  label,
}: {
  segments: Segment[]
  format: (value: number) => string
  label: string
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  if (!total) return null
  return (
    <div className="split" aria-label={label}>
      <div className="split-bar">
        {segments.map((segment, index) => (
          <div
            key={segment.key}
            className="split-piece"
            style={{
              width: `${(segment.value / total) * 100}%`,
              background: SERIES[index % SERIES.length],
            }}
          />
        ))}
      </div>
      <ul className="split-legend">
        {segments.map((segment, index) => (
          <li key={segment.key}>
            <span
              className="split-chip"
              style={{ background: SERIES[index % SERIES.length] }}
              aria-hidden="true"
            />
            <span className="split-name">{segment.label}</span>
            <strong>{format(segment.value)}</strong>
            <small>{Math.round((segment.value / total) * 100)}%</small>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Columnas comparables entre sí; se usa para meses o categorías cortas. */
export function ColumnChart({
  bars,
  format,
  label,
  height = 170,
}: {
  bars: RankedBar[]
  format: (value: number) => string
  label: string
  height?: number
}) {
  const [ref, width] = useWidth()
  const [active, setActive] = useState<number | null>(null)
  const padding = { top: 18, right: 8, bottom: 28, left: 52 }
  const plotWidth = Math.max(10, width - padding.left - padding.right)
  const plotHeight = height - padding.top - padding.bottom
  const max = niceCeiling(Math.max(...bars.map((bar) => bar.value), 0))
  const band = plotWidth / Math.max(bars.length, 1)
  const barWidth = Math.min(24, band - 8)
  const scale = (value: number) => (value / max) * plotHeight
  return (
    <div className="chart" ref={ref}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={label}
        onMouseLeave={() => setActive(null)}
      >
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={padding.top + plotHeight - scale(max * fraction)}
              y2={padding.top + plotHeight - scale(max * fraction)}
              className="chart-grid"
            />
            <text
              x={padding.left - 8}
              y={padding.top + plotHeight - scale(max * fraction) + 4}
              className="chart-axis"
              textAnchor="end"
            >
              {format(max * fraction)}
            </text>
          </g>
        ))}
        {bars.map((bar, index) => {
          const x = padding.left + index * band + (band - barWidth) / 2
          const barHeight = Math.max(bar.value > 0 ? 2 : 0, scale(bar.value))
          return (
            <g key={bar.label} onMouseEnter={() => setActive(index)}>
              <rect
                x={padding.left + index * band}
                y={padding.top}
                width={band}
                height={plotHeight}
                fill="transparent"
              />
              <rect
                x={x}
                y={padding.top + plotHeight - barHeight}
                width={barWidth}
                height={barHeight}
                className="chart-column"
                rx={4}
              />
              <text
                x={x + barWidth / 2}
                y={height - 9}
                className="chart-axis"
                textAnchor="middle"
              >
                {bar.label}
              </text>
            </g>
          )
        })}
      </svg>
      {active !== null && bars[active] && (
        <Tip
          x={padding.left + active * band + band / 2}
          y={padding.top + plotHeight - scale(bars[active].value) - 8}
          width={width}
        >
          <strong>{format(bars[active].value)}</strong>
          <span>{bars[active].detail ?? bars[active].label}</span>
        </Tip>
      )}
    </div>
  )
}

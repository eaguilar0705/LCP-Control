import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import type {
  ProductSaleRecord,
  ProductSalesHistoryPage,
  ProductSaleStatus,
} from '@lcp/contracts/productSalesHistory'
import { Button, ErrorState } from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { can } from '../../lib/permissions'
import { errorMessage } from '../../lib/errors'
import { formatCurrency } from '../../lib/format'
import { labels } from '../../lib/domain'
import {
  PRODUCT_SALES_PAGE_SIZE,
  productSaleDay,
  readProductSalesHistory,
} from './productSalesHistoryService'
import './product-sales-history.css'

const dateTime = new Intl.DateTimeFormat('es-NI', {
  timeZone: 'America/Managua',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})
const unitFormats = {
  NIO: new Intl.NumberFormat('es-NI', {
    style: 'currency',
    currency: 'NIO',
    currencyDisplay: 'code',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }),
  USD: new Intl.NumberFormat('es-NI', {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'code',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }),
}
const statusLabels: Record<ProductSaleStatus, string> = {
  issued: 'Emitida',
  partially_returned: 'Devolución parcial',
  returned: 'Devuelta',
  cancelled: 'Anulada',
  removed: 'Retirado de la factura',
}

export function ProductSalesHistory({ productId }: { productId: string }) {
  const { role, demo } = useAccess()
  if (demo || !can(role, 'finance.read')) return null
  return <SalesHistory key={productId} productId={productId} />
}

function SalesHistory({ productId }: { productId: string }) {
  const [page, setPage] = useState({
    offset: 0,
    asOf: null as string | null,
    total: null as number | null,
    attempt: 0,
  })
  const requestKey = `${productId}:${page.offset}:${page.asOf ?? 'new'}:${page.total ?? 'new'}:${page.attempt}`
  const [state, setState] = useState<{
    requestKey: string
    data: ProductSalesHistoryPage | null
    error: string | null
  } | null>(null)
  const current = state?.requestKey === requestKey ? state : null
  const data = current?.data ?? null
  const error = current?.error ?? null
  const loading = current === null
  useEffect(() => {
    let active = true
    readProductSalesHistory(productId, page.offset, page.asOf, page.total)
      .then((data) => {
        if (active) setState({ requestKey, data, error: null })
      })
      .catch((failure) => {
        if (active)
          setState({ requestKey, data: null, error: errorMessage(failure) })
      })
    return () => {
      active = false
    }
  }, [productId, page.offset, page.asOf, page.total, requestKey])
  const refresh = () =>
    setPage((previous) => ({
      offset: 0,
      asOf: null,
      total: null,
      attempt: previous.attempt + 1,
    }))
  const retry = () =>
    setPage((previous) => ({ ...previous, attempt: previous.attempt + 1 }))
  const navigate = (offset: number) => {
    if (data)
      setPage({
        offset,
        asOf: data.asOf,
        total: data.total,
        attempt: page.attempt,
      })
  }
  return (
    <section
      className="product-sales-history"
      aria-label="Historial de ventas del perfume"
      aria-busy={loading}
    >
      <div className="product-sales-history-heading">
        <div>
          <h2>Historial de ventas</h2>
          <p className="muted">
            Fecha, cliente y precio vendido en la moneda de cada factura.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={loading}
          onClick={refresh}
        >
          <RefreshCw size={16} aria-hidden="true" /> Actualizar ventas
        </Button>
      </div>
      {loading && <p role="status">Cargando ventas…</p>}
      {error && <ErrorState message={error} retry={retry} />}
      {data && data.total === 0 && (
        <p className="page-feedback">
          Este perfume todavía no tiene ventas registradas.
        </p>
      )}
      {data && data.total > 0 && data.rows.length === 0 && (
        <p className="page-feedback">
          Esta página ya no tiene ventas. Actualiza el historial para volver al
          inicio.
        </p>
      )}
      {data && data.rows.length > 0 && (
        <>
          <div className="product-sales-history-list">
            {data.rows.map((row) => (
              <SaleRecord key={row.documentId} row={row} />
            ))}
          </div>
          <div className="product-sales-history-pagination">
            <span role="status">
              {data.offset + 1}–{data.offset + data.rows.length} de {data.total}{' '}
              facturas
            </span>
            <div>
              <Button
                type="button"
                variant="secondary"
                aria-label="Página anterior de ventas"
                disabled={data.offset === 0}
                onClick={() =>
                  navigate(Math.max(0, data.offset - PRODUCT_SALES_PAGE_SIZE))
                }
              >
                <ArrowLeft size={16} aria-hidden="true" /> Anterior
              </Button>
              <Button
                type="button"
                variant="secondary"
                aria-label="Página siguiente de ventas"
                disabled={data.offset + data.rows.length >= data.total}
                onClick={() => navigate(data.offset + PRODUCT_SALES_PAGE_SIZE)}
              >
                Siguiente <ArrowRight size={16} aria-hidden="true" />
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

function SaleRecord({ row }: { row: ProductSaleRecord }) {
  const { base } = useAccess()
  const historical = row.status === 'cancelled' || row.status === 'removed'
  return (
    <article
      className={`product-sales-history-record${historical ? ' is-historical' : ''}`}
      aria-label={`Factura ${row.number}`}
    >
      <header>
        <div>
          <h3>{row.number}</h3>
          <time dateTime={row.createdAt}>
            {dateTime.format(new Date(row.createdAt))}
          </time>
          <small>{labels.location[row.location]} · Hora de Managua</small>
        </div>
        <div className="product-sales-history-status">
          <span className="record-badge">{statusLabels[row.status]}</span>
          {row.revision > 0 && (
            <small>Factura corregida · revisión {row.revision}</small>
          )}
        </div>
      </header>
      <p className="product-sales-history-customer">
        <span>Cliente</span>
        <strong>{row.customerName}</strong>
      </p>
      <dl>
        <div>
          <dt>Cantidad facturada</dt>
          <dd>
            {row.quantity} {row.quantity === 1 ? 'unidad' : 'unidades'}
          </dd>
        </div>
        <div>
          <dt>Precio unitario neto</dt>
          <dd>{unitFormats[row.currency].format(row.unitPrice)}</dd>
        </div>
        <div>
          <dt>Total facturado</dt>
          <dd>{formatCurrency(row.lineTotal, row.currency)}</dd>
        </div>
        {row.invoiceDiscount > 0 && (
          <>
            <div>
              <dt>Precio original del renglón</dt>
              <dd>{unitFormats[row.currency].format(row.originalUnitPrice)}</dd>
            </div>
            <div>
              <dt>Descuento general asignado</dt>
              <dd>{formatCurrency(row.invoiceDiscount, row.currency)}</dd>
            </div>
          </>
        )}
      </dl>
      {(row.returnedQuantity > 0 || row.returnedAmount > 0) && (
        <p className="product-sales-history-return">
          Devuelto: {row.returnedQuantity}{' '}
          {row.returnedQuantity === 1 ? 'unidad' : 'unidades'} ·{' '}
          {formatCurrency(row.returnedAmount, row.currency)}
        </p>
      )}
      {historical && (
        <p className="product-sales-history-note">
          Registro histórico; no cuenta como venta vigente.
        </p>
      )}
      <Link
        className="text-link"
        to={`${base}/sales/history?day=${productSaleDay(row.createdAt)}`}
      >
        Ver facturas del día
      </Link>
    </article>
  )
}

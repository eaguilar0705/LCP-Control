import { Sigma, Store, Warehouse } from 'lucide-react'
import { Badge } from '../../components/ui'
import { ProductImage } from '../../components/ProductImage'
import type { InventoryItem, Currency, PriceTier } from '../../lib/domain'
import { labels } from '../../lib/domain'
import { formatCurrency } from '../../lib/format'
import { productPrice } from '../../lib/pricing'
import { stockStatus, totalStock } from './model'
export function StockBadge({ item }: { item: InventoryItem }) {
  const status = stockStatus(item)
  return (
    <Badge
      tone={
        status === 'unknown'
          ? 'neutral'
          : status === 'out'
            ? 'danger'
            : status === 'low'
              ? 'warning'
              : 'success'
      }
    >
      {status === 'unknown'
        ? 'Sin conteo'
        : status === 'out'
          ? 'Sin existencias'
          : status === 'low'
            ? 'Stock bajo'
            : 'Disponible'}
    </Badge>
  )
}
/**
 * Existencias por ubicación con la misma lectura en tarjetas, móvil y ficha:
 * Bodega y Tienda con su color e icono, y el total consolidado destacado.
 */
export function StockByLocation({
  item,
  compact = false,
}: {
  item: InventoryItem
  compact?: boolean
}) {
  const total = totalStock(item)
  return (
    <dl
      className={`stock-by-location ${compact ? 'stock-by-location-compact' : ''}`}
      aria-label="Existencias por ubicación"
    >
      <div className="stock-tile stock-tile-warehouse">
        <dt>
          <Warehouse size={14} aria-hidden="true" /> Bodega
        </dt>
        <dd>{item.quantities.warehouse ?? '—'}</dd>
      </div>
      <div className="stock-tile stock-tile-store">
        <dt>
          <Store size={14} aria-hidden="true" /> Tienda
        </dt>
        <dd>{item.quantities.store ?? '—'}</dd>
      </div>
      <div
        className="stock-tile stock-tile-total"
        title={
          total === null
            ? 'Falta registrar el conteo de una ubicación'
            : 'Bodega + Tienda'
        }
      >
        <dt>
          <Sigma size={14} aria-hidden="true" /> Total
        </dt>
        <dd>{total ?? '—'}</dd>
      </div>
    </dl>
  )
}
export function ProductIdentity({ item }: { item: InventoryItem }) {
  return (
    <div className="product-identity">
      <ProductImage key={item.product.id} product={item.product} />
      <div>
        <strong>{item.product.name}</strong>
        <small>
          {item.product.brand} ·{' '}
          {item.product.size === null
            ? 'Tamaño por confirmar'
            : `${item.product.size} ${item.product.unit}`}
        </small>
      </div>
    </div>
  )
}
export function ProductCard({
  item,
  currency = 'NIO',
  tier = 'emprendedor',
}: {
  item: InventoryItem
  currency?: Currency
  tier?: PriceTier
}) {
  const price = productPrice(item.product, tier, currency)
  return (
    <article className="inventory-mobile-card">
      <div className="section-heading">
        <ProductIdentity item={item} />
        <StockBadge item={item} />
      </div>
      <div className="mobile-product-meta">
        <span>
          {labels.category[item.product.category]} ·{' '}
          {labels.gender[item.product.gender]}
        </span>
        <strong>
          {price === null
            ? 'Precio pendiente'
            : formatCurrency(price, currency)}
        </strong>
      </div>
      <StockByLocation item={item} compact />
      <small className="internal-code">
        Código interno: {item.product.barcode}
      </small>
    </article>
  )
}

import { useCallback } from 'react'
import { Card, ErrorState, LoadingState } from '../../components/ui'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import type { PriceChange } from '../../lib/domain'
import { priceTierLabels } from '../../lib/pricing'
import { formatCurrency, formatDate } from '../../lib/format'

const causeLabels: Record<NonNullable<PriceChange['cause']>, string> = {
  purchase: 'Compra',
  opening_cost: 'Costo inicial',
  invoice_deleted: 'Factura eliminada',
  migration: 'Cambio a precios por costo promedio',
  cost: 'Cambio del costo promedio',
}
/** Cómo se calculó el precio de la lista, en una línea. */
function priceBasis(change: PriceChange): string | null {
  if (change.markup == null) return null
  if (change.averageCost != null)
    return `${change.markup} % sobre el costo promedio de ${formatCurrency(change.averageCost, 'NIO')}`
  if (change.purchasePrice != null && change.purchaseCurrency)
    return `${change.markup} % sobre la compra de ${formatCurrency(change.purchasePrice, change.purchaseCurrency)}`
  return `${change.markup} % configurado · falta precio de compra`
}
/**
 * Los cambios de precio del perfume, del más reciente al más antiguo. Un
 * cambio hecho por una persona dice quién fue; uno que hizo el sistema al
 * cambiar el costo promedio se marca «Automático» con su causa (la compra, el
 * costo inicial, la factura eliminada) y quién registró esa operación. Un
 * cambio sin «antes» es el precio con el que el perfume entró al catálogo.
 */
export function PriceHistory({ productId }: { productId: string }) {
  const { productService } = useServices()
  const load = useCallback(
    () => productService.listPriceChanges(productId),
    [productId, productService],
  )
  const { data, error, loading, retry } = useQuery(load)
  return (
    <Card className="form-card price-history">
      <h2>Historial de precios</h2>
      {loading && <LoadingState />}
      {error && <ErrorState message={error} retry={retry} />}
      {!loading && !error && data?.length === 0 && (
        <p className="page-feedback">Sin cambios de precio todavía.</p>
      )}
      <div className="price-history-list">
        {data?.map((change, index) => {
          const basis = priceBasis(change)
          // Un precio que sale de un costo en córdobas se lee primero en
          // córdobas: es el que queda fijo cuando cambia la tasa.
          const cordobasFirst =
            change.markup != null &&
            (change.averageCost != null || change.purchaseCurrency === 'NIO')
          return (
            <article
              className={`price-history-record ${change.automatic ? 'is-automatic' : ''}`}
              key={`${change.changedAt}:${change.tier}:${index}`}
            >
              <div>
                <h3>{priceTierLabels[change.tier]}</h3>
                <p>
                  {formatDate(change.changedAt)} ·{' '}
                  {change.automatic ? 'Automático' : change.actor}
                </p>
                {change.automatic && (
                  <small className="price-history-cause">
                    {causeLabels[change.cause ?? 'cost']}
                    {change.causeReference ? ` ${change.causeReference}` : ''}
                    {change.actor !== 'Sistema' &&
                      ` · registrada por ${change.actor}`}
                  </small>
                )}
              </div>
              <div className="price-history-amounts">
                {(cordobasFirst
                  ? (['NIO', 'USD'] as const)
                  : (['USD', 'NIO'] as const)
                ).map((currency, position) => {
                  const before =
                    currency === 'USD' ? change.beforeUsd : change.beforeNio
                  const after =
                    currency === 'USD' ? change.afterUsd : change.afterNio
                  const text =
                    before === null
                      ? formatCurrency(after, currency)
                      : `${formatCurrency(before, currency)} → ${formatCurrency(after, currency)}`
                  return position === 0 ? (
                    <strong key={currency}>{text}</strong>
                  ) : (
                    <small key={currency}>{text}</small>
                  )
                })}
                {basis && (
                  <small className="price-history-markup">{basis}</small>
                )}
                {change.automatic ? (
                  <span className="record-badge is-automatic">Automático</span>
                ) : (
                  change.beforeUsd === null && (
                    <span className="record-badge is-muted">
                      Precio inicial
                    </span>
                  )
                )}
              </div>
            </article>
          )
        })}
      </div>
    </Card>
  )
}

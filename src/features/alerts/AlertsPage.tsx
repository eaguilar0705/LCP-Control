import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { Card, EmptyState, ErrorState, LoadingState } from '../../components/ui'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { ProductCard } from '../inventory/ProductCard'
import { useAccess } from '../../app/AccessContext'
import type { InventoryItem } from '../../lib/domain'
import { lowStockItems, totalStock } from '../inventory/model'

/**
 * Por qué la lista está vacía. Antes siempre decía «Conteos pendientes», aunque
 * todo estuviera contado y simplemente nada bajara del mínimo; y no avisaba de
 * que, con los mínimos en cero, ninguna alerta puede aparecer nunca.
 */
function emptyReason(items: InventoryItem[]) {
  const uncounted = items.filter((item) => totalStock(item) === null).length
  const withMinimum = items.filter(
    (item) => (item.product.minimumStock ?? 0) > 0,
  ).length
  const notes: string[] = []
  if (uncounted)
    notes.push(
      `${uncounted} ${uncounted === 1 ? 'perfume no tiene' : 'perfumes no tienen'} conteo completo en Tienda y Bodega y no se pueden evaluar.`,
    )
  if (!withMinimum)
    notes.push(
      'Ningún perfume tiene un mínimo de inventario mayor que cero: defínelo al editar cada perfume para recibir alertas.',
    )
  if (!notes.length)
    return {
      title: 'Sin alertas',
      description: 'Ningún perfume está por debajo de su mínimo.',
    }
  return {
    title: uncounted ? 'Conteos pendientes' : 'Sin mínimos configurados',
    description: notes.join(' '),
  }
}

export function AlertsPage() {
  const { inventoryService } = useServices()
  const { data, error, loading, retry } = useQuery(
    inventoryService.getInventory,
  )
  const { base } = useAccess()
  const low = data ? lowStockItems(data) : []
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">EXISTENCIAS</span>
          <h1>Alertas de inventario</h1>
          <p className="muted">
            Productos cuyo total está por debajo del mínimo configurado.
          </p>
        </div>
        <Link className="button button-secondary" to={`${base}/inventory`}>
          Ver inventario <ArrowRight size={17} />
        </Link>
      </div>
      <Card>
        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState message={error} retry={retry} />
        ) : !low.length ? (
          <EmptyState {...emptyReason(data ?? [])} />
        ) : (
          low.map((item) => <ProductCard item={item} key={item.product.id} />)
        )}
      </Card>
    </>
  )
}

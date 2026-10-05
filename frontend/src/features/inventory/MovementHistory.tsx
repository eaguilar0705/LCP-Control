import {
  ArrowDownLeft,
  ArrowUpRight,
  ClipboardList,
  TriangleAlert,
} from 'lucide-react'
import {
  WorkspaceHeading,
  WorkspaceEmpty,
} from '../../components/WorkspacePresentation'
import { useCallback } from 'react'
import { useAccess } from '../../app/AccessContext'
import { useQuery } from '../../lib/useQuery'
import { listMovements } from '../../services/workspace'
import { ErrorState, LoadingState } from '../../components/ui'
import { formatDate } from '../../lib/format'
export function MovementHistory() {
  const { demo } = useAccess()
  const load = useCallback(
    () => (demo ? Promise.resolve([]) : listMovements()),
    [demo],
  )
  const { data, error, loading, retry } = useQuery(load)
  return (
    <>
      <WorkspaceHeading
        eyebrow="CONTROL DE EXISTENCIAS"
        title="Movimientos de inventario"

        icon={ClipboardList}
      />
      {loading && <LoadingState />}
      {error && <ErrorState message={error} retry={retry} />}
      <div className="movement-list">
        {data?.map((r) => {
          const product = Array.isArray(r.products) ? r.products[0] : r.products
          const Icon =
            r.type === 'ENTRY'
              ? ArrowDownLeft
              : r.type === 'DAMAGED'
                ? TriangleAlert
                : r.type === 'ADJUSTMENT'
                  ? ClipboardList
                  : ArrowUpRight
          return (
            <article className="movement-record" key={r.id}>
              <span className="record-avatar">
                <Icon size={21} />
              </span>
              <div>
                <h2>{product?.name ?? 'Producto'}</h2>
                <p>
                  {product?.sku} ·{' '}
                  {r.location === 'store' ? 'Tienda' : 'Bodega'} ·{' '}
                  {formatDate(r.created_at)}
                </p>
                <p>{r.note}</p>
              </div>
              <div className="movement-quantity">
                <strong>
                  {r.before_quantity ?? '—'} → {r.after_quantity}
                </strong>
                <span className="record-badge is-muted">
                  {{
                    ENTRY: 'Entrada',
                    EXIT: 'Salida',
                    DAMAGED: 'Dañado',
                    ADJUSTMENT: 'Ajuste',
                    SALE: 'Venta',
                  }[r.type] ?? r.type}
                </span>
              </div>
            </article>
          )
        })}
      </div>
      {!loading && !error && data?.length === 0 && (
        <WorkspaceEmpty icon={ClipboardList} title="Cada movimiento cuenta" />
      )}
    </>
  )
}

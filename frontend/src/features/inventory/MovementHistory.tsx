import {
  ArrowDownLeft,
  ArrowUpRight,
  ClipboardList,
  TriangleAlert,
  RefreshCw,
  Pencil,
} from 'lucide-react'
import {
  WorkspaceHeading,
  WorkspaceEmpty,
} from '../../components/WorkspacePresentation'
import { useCallback, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAccess } from '../../app/AccessContext'
import { useQuery } from '../../lib/useQuery'
import { listMovements } from '../../services/workspace'
import {
  Button,
  Card,
  ErrorState,
  Input,
  LoadingState,
} from '../../components/ui'
import { can } from '../../lib/permissions'
import { localDay } from '../reports/model'
import './movement-history.css'
import { CountPurchaseCorrection } from './CountPurchaseCorrection'

const movementDate = new Intl.DateTimeFormat('es-NI', {
  timeZone: 'America/Managua',
  dateStyle: 'medium',
  timeStyle: 'short',
})

export function MovementHistory() {
  const { demo, role, base } = useAccess()
  const [params, setParams] = useSearchParams()
  const day = params.has('day')
    ? (params.get('day') ?? '')
    : localDay(new Date())
  const [offset, setOffset] = useState(0)
  const [purchaseMovement, setPurchaseMovement] = useState<string>()
  const load = useCallback(
    async () => ({
      day,
      offset,
      rows: demo ? [] : await listMovements(day, offset),
    }),
    [demo, day, offset],
  )
  const query = useQuery(load)
  const data =
    query.data?.day === day && query.data.offset === offset
      ? query.data.rows
      : null
  const error = query.error
  const loading = query.loading || (!error && data === null)
  const retry = query.retry
  function changeDay(next: string) {
    setOffset(0)
    setParams({ day: next })
  }
  return (
    <>
      <WorkspaceHeading
        eyebrow="CONTROL DE EXISTENCIAS"
        title="Movimientos de inventario"

        icon={ClipboardList}
      >
        <Link className="button button-secondary" to={`${base}/inventory`}>
          Volver a inventario
        </Link>
      </WorkspaceHeading>
      <Card className="movement-history-filters">
        <Input
          label="Fecha de movimientos"
          type="date"
          value={day}
          max={localDay(new Date())}
          onChange={(e) => changeDay(e.target.value)}
        />
        <Button
          variant="secondary"
          onClick={() => changeDay(localDay(new Date()))}
        >
          Hoy
        </Button>
        <Button variant="secondary" onClick={() => changeDay('')}>
          Todas las fechas
        </Button>
        <Button variant="secondary" onClick={retry} disabled={loading}>
          <RefreshCw size={16} /> Actualizar
        </Button>
      </Card>
      {loading && <LoadingState />}
      {error && <ErrorState message={error} retry={retry} />}
      {!loading && !error && (
        <div className="movement-list">
          {data?.slice(0, 50).map((r) => {
            const product = Array.isArray(r.products)
              ? r.products[0]
              : r.products
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
                    {movementDate.format(new Date(r.created_at))}
                  </p>
                  <p>{r.note}</p>
                  {!demo &&
                    role === 'superadmin' &&
                    r.type === 'ADJUSTMENT' &&
                    r.after_quantity > (r.before_quantity ?? 0) && (
                      <Button
                        variant="secondary"
                        className="movement-edit-link"
                        onClick={() => setPurchaseMovement(r.id)}
                      >
                        Revisar ingreso como compra
                      </Button>
                    )}
                  {!demo &&
                    can(role, 'inventory.adjust') &&
                    r.type === 'ADJUSTMENT' && (
                      <Link
                        className="button button-secondary movement-edit-link"
                        to={`${base}/products/${r.product_id}/edit?countLocation=${r.location}`}
                      >
                        <Pencil size={15} /> Ajustar existencias actuales
                      </Link>
                    )}
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
      )}
      {!loading && !error && data?.length === 0 && (
        <WorkspaceEmpty
          icon={ClipboardList}
          title="No hay movimientos para esta fecha"
        />
      )}
      <div className="form-actions movement-history-pagination">
        <Button
          variant="secondary"
          disabled={loading || offset === 0}
          onClick={() => setOffset((value) => Math.max(0, value - 50))}
        >
          Anterior
        </Button>
        <span>Página {offset / 50 + 1}</span>
        <Button
          variant="secondary"
          disabled={loading || !data || data.length <= 50}
          onClick={() => setOffset((value) => value + 50)}
        >
          Siguiente
        </Button>
      </div>
      {purchaseMovement && (
        <CountPurchaseCorrection
          movementId={purchaseMovement}
          onClose={() => setPurchaseMovement(undefined)}
          onChanged={retry}
        />
      )}
    </>
  )
}

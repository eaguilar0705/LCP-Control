import { Link } from 'react-router-dom'
import {
  ArrowRight,
  Package,
  ReceiptText,
  Truck,
  Warehouse,
} from 'lucide-react'
import { Card, ErrorState, LoadingState } from '../../components/ui'
import { Brand } from '../../components/Brand'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { formatDate } from '../../lib/format'
import { useAccess } from '../../app/AccessContext'
import { Reflection } from './Reflection'
import { HomeCharts } from './HomeCharts'
import { can } from '../../lib/permissions'
const actions = [
  ['/products', 'Catálogo', Package],
  ['/sales', 'Facturación', ReceiptText],
  ['/inventory', 'Inventario', Warehouse],
  ['/suppliers', 'Proveedores', Truck],
] as const
export function DashboardPage() {
  const { inventoryService } = useServices()
  const { data, loading, error, retry } = useQuery(
    inventoryService.getInventory,
  )
  const { base, demo, role } = useAccess()
  if (loading) return <LoadingState />
  if (error || !data)
    return (
      <ErrorState
        message={error ?? 'No hay datos disponibles.'}
        retry={retry}
      />
    )
  const brands = new Set(data.map((item) => item.product.brand)).size
  const balances = data.flatMap((item) => [
    item.quantities.store,
    item.quantities.warehouse,
  ])
  const pending = balances.filter((q) => q == null).length
  const units = balances.reduce<number>((sum, q) => sum + (q ?? 0), 0)
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Inicio</h1>
          <p className="muted">{formatDate(new Date())}</p>
        </div>
      </div>
      <section className="welcome-panel">
        <Brand wordmark />
        <Reflection />
      </section>
      <div className="stats-grid">
        {[
          ['Referencias', data.length, 'Catálogo mayorista'],
          ['Marcas', brands, 'En las listas recibidas'],
          ['Listas de precios', 3, 'Emprendedor, VIP y Premium'],
          [
            'Existencias',
            pending === balances.length ? '—' : units,
            pending
              ? `${pending} saldos pendientes de conteo`
              : 'Unidades entre Bodega y Tienda',
          ],
        ].map(([title, value, detail]) => (
          <Card className="stat-card" key={title}>
            <div>
              {title}
              <Package size={18} />
            </div>
            <strong>{value}</strong>
            <small>{detail}</small>
          </Card>
        ))}
      </div>
      {can(role, 'finance.read') || demo ? <HomeCharts /> : null}
      <div className="home-actions">
        {actions
          .filter(
            ([path]) =>
              demo ||
              (path === '/sales'
                ? can(role, 'sale.create')
                : path === '/suppliers'
                  ? can(role, 'supplier.read')
                  : true),
          )
          .map(([path, title, Icon]) => (
            <Link className="home-action card" key={path} to={`${base}${path}`}>
              <Icon size={22} />
              <h2>{title}</h2>

              <ArrowRight size={18} />
            </Link>
          ))}
      </div>
      {pending > 0 && (
        <p className="workspace-disclaimer">{pending} saldos sin conteo.</p>
      )}
    </>
  )
}

import { useCallback, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  BadgePercent,
  Download,
  Upload,
} from 'lucide-react'
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from '../../components/ui'
import { WorkspaceHeading } from '../../components/WorkspacePresentation'
import { useAccess } from '../../app/AccessContext'
import { can } from '../../lib/permissions'
import { useQuery } from '../../lib/useQuery'
import { useServices } from '../../services/useServices'
import { matchesSearch } from '../../lib/search'
import { formatCurrency } from '../../lib/format'
import {
  computedTiers,
  exactCost,
  priceTierLabels,
  priceTiers,
  tierQuote,
  tierStatus,
} from '../../lib/pricing'
import type { Currency, Product, ProductPricing } from '../../lib/domain'
import { PricingDialog } from './PricingDialog'
import { CostPanel } from './CostPanel'
import { PricingImportDialog } from './PricingImportDialog'
import { downloadPricingTemplate } from './template'

type Status = 'computed' | 'partial' | 'pending' | 'manual'
const statusLabels: Record<Status, string> = {
  computed: 'Calculados',
  partial: 'Incompletos',
  pending: 'Pendientes de costo',
  manual: 'Sin porcentajes',
}
const statusNotes: Record<Status, string> = {
  computed: 'Las tres listas salen del costo promedio',
  partial: 'Con costo, pero alguna lista sin porcentaje',
  pending: 'Tienen porcentajes y todavía no tienen costo',
  manual: 'Conservan el precio de las listas',
}
/**
 * Calculado: las tres listas salen del costo promedio. Incompleto: hay costo y
 * algún porcentaje, pero alguna lista sigue a mano. Pendiente de costo: hay
 * porcentajes y el perfume todavía no tiene costo promedio. Sin porcentajes:
 * nada cargado todavía.
 */
function statusOf(pricing: ProductPricing | undefined): Status {
  if (!pricing) return 'manual'
  const withMarkup = priceTiers.filter((tier) => pricing.markups[tier] !== null)
  if (!withMarkup.length) return 'manual'
  if (pricing.averageCost === null) return 'pending'
  return computedTiers(pricing, pricing.averageCost) === priceTiers.length
    ? 'computed'
    : 'partial'
}
type Section = 'prices' | 'costs'
const PAGE_SIZE = 25
const counts = new Intl.NumberFormat('es-NI')

export function PricingPage() {
  const { role, demo } = useAccess()
  if (!demo && !can(role, 'product.edit_cost'))
    return (
      <EmptyState
        title="No tienes permiso para esta pantalla."
        description="El costo promedio y los porcentajes de ganancia sólo los ven Administración y SuperAdmin."
      />
    )
  return <PricingWorkspace />
}

function PricingWorkspace() {
  const { base, demo } = useAccess()
  const { state } = useLocation()
  const { productService, settingsService, inventoryService } = useServices()
  const load = useCallback(async () => {
    const [products, pricing, rate, inventory] = await Promise.all([
      productService.listProducts(),
      productService.listPricing(),
      settingsService.getExchangeRate(),
      inventoryService.getInventory(true),
    ])
    return { products, pricing, rate: rate?.usdToNio ?? null, inventory }
  }, [productService, settingsService, inventoryService])
  const { data, loading, error, retry, refresh } = useQuery(load)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<Status | ''>('')
  const [currency, setCurrency] = useState<Currency>('NIO')
  const [scope, setScope] = useState<'active' | 'all'>('active')
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<Product | null>(null)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState<string>(
    (state as { message?: string } | null)?.message ?? '',
  )
  // El apartado vive en la dirección para que «Costo de inventario» se pueda
  // enlazar desde otras pantallas (una entrada rechazada, un costo pendiente).
  const [params, setParams] = useSearchParams()
  const section: Section =
    params.get('apartado') === 'costo' ? 'costs' : 'prices'
  function openSection(next: Section) {
    if (next !== section) setMessage('')
    setParams(next === 'costs' ? { apartado: 'costo' } : {}, { replace: true })
  }
  const byProduct = useMemo(
    () =>
      new Map<string, ProductPricing>(
        (data?.pricing.rows ?? []).map((row) => [row.productId, row]),
      ),
    [data],
  )
  const products = useMemo(
    () =>
      (data?.products ?? [])
        .filter((product) => scope === 'all' || product.active)
        .sort(
          (a, b) =>
            a.brand.localeCompare(b.brand, 'es') ||
            a.name.localeCompare(b.name, 'es'),
        ),
    [data, scope],
  )
  const totals = useMemo(() => {
    const result: Record<Status, number> = {
      computed: 0,
      partial: 0,
      pending: 0,
      manual: 0,
    }
    for (const product of products)
      result[statusOf(byProduct.get(product.id))]++
    return result
  }, [products, byProduct])
  const filtered = products.filter(
    (product) =>
      (!status || statusOf(byProduct.get(product.id)) === status) &&
      matchesSearch(
        `${product.brand} ${product.name} ${product.barcode}`,
        search,
      ),
  )
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const current = Math.min(page, pages)
  const shown = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)
  function saved(text: string) {
    setEditing(null)
    setImporting(false)
    setMessage(text)
    refresh()
  }
  const available = data?.pricing.available ?? true
  return (
    <>
      <WorkspaceHeading
        title="Precios"
        eyebrow="COSTO Y GANANCIA"
        icon={BadgePercent}
        description="El precio de venta de cada lista sale del costo promedio del inventario más su porcentaje de ganancia sobre el costo. Sólo lo ven Administración y SuperAdmin."
      >
        <div
          className="inventory-actions pricing-actions"
          hidden={section !== 'prices'}
        >
          <Button
            variant="secondary"
            disabled={!data || !available}
            onClick={() =>
              data && downloadPricingTemplate(data.products, data.pricing.rows)
            }
          >
            <Download size={17} /> Descargar plantilla
          </Button>
          <Button
            disabled={!data || !available}
            onClick={() => {
              setMessage('')
              setImporting(true)
            }}
          >
            <Upload size={17} /> Cargar archivo
          </Button>
        </div>
      </WorkspaceHeading>
      <nav className="pricing-sections" aria-label="Apartados de precios">
        <button
          type="button"
          aria-pressed={section === 'prices'}
          onClick={() => openSection('prices')}
        >
          Porcentajes y precios
        </button>
        <button
          type="button"
          aria-pressed={section === 'costs'}
          onClick={() => openSection('costs')}
        >
          Costo de inventario
        </button>
      </nav>
      {message && (
        <p role="status" className="page-feedback">
          {message}
        </p>
      )}
      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} retry={retry} />
      ) : !available ? (
        <Card>
          <EmptyState
            title="Falta la actualización de precios en la base de datos."
            description="Los porcentajes de ganancia se guardan en Supabase. Aplica las migraciones de precios (instrucciones en docs/guides/database.md) y vuelve a abrir esta pantalla."
          />
        </Card>
      ) : section === 'costs' && data ? (
        <CostPanel
          inventory={data.inventory}
          pricing={data.pricing.rows}
          rate={data.rate}
          readOnly={demo}
          onRecorded={(text) => {
            setMessage(text)
            refresh()
          }}
        />
      ) : (
        <Card>
          {data?.rate === null && (
            <p className="inline-error" role="alert">
              Todavía no hay tipo de cambio registrado. Regístralo en Negocio
              antes de guardar precios.
            </p>
          )}
          <div className="pricing-summary" aria-label="Resumen de precios">
            {(Object.keys(statusLabels) as Status[]).map((key) => (
              <button
                type="button"
                key={key}
                className={`pricing-summary-item is-${key}`}
                aria-pressed={status === key}
                onClick={() => {
                  setStatus(status === key ? '' : key)
                  setPage(1)
                }}
              >
                <span>{statusLabels[key]}</span>
                <strong>{counts.format(totals[key])}</strong>
                <small>{statusNotes[key]}</small>
              </button>
            ))}
          </div>
          <div className="pricing-toolbar">
            <Input
              label="Buscar perfume"
              type="search"
              placeholder="Nombre, marca o código…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setPage(1)
              }}
            />
            <Select
              label="Mostrar"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as Status | '')
                setPage(1)
              }}
            >
              <option value="">Todos</option>
              {(Object.keys(statusLabels) as Status[]).map((key) => (
                <option key={key} value={key}>
                  {statusLabels[key]}
                </option>
              ))}
            </Select>
            <Select
              label="Perfumes"
              value={scope}
              onChange={(event) => {
                setScope(event.target.value as 'active' | 'all')
                setPage(1)
              }}
            >
              <option value="active">Activos</option>
              <option value="all">Activos e inactivos</option>
            </Select>
            <Select
              label="Precio de venta en"
              value={currency}
              onChange={(event) => setCurrency(event.target.value as Currency)}
            >
              <option value="NIO">C$ Córdobas</option>
              <option value="USD">US$ Dólares</option>
            </Select>
          </div>
          {!filtered.length ? (
            <EmptyState />
          ) : (
            <div
              className="pricing-table"
              role="region"
              aria-label="Precios por perfume"
              tabIndex={0}
            >
              <table>
                <thead>
                  <tr>
                    <th>Perfume</th>
                    <th>Costo promedio</th>
                    {priceTiers.map((tier) => (
                      <th key={tier}>{priceTierLabels[tier]}</th>
                    ))}
                    <th>
                      <span className="sr-only">Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((product) => {
                    const pricing = byProduct.get(product.id)
                    return (
                      <tr key={product.id}>
                        <td className="pricing-product">
                          <span className="product-brand">{product.brand}</span>
                          <button
                            type="button"
                            className="product-title"
                            onClick={() => setEditing(product)}
                          >
                            {product.name}
                          </button>
                          <small>
                            {product.barcode} ·{' '}
                            {product.size === null
                              ? 'Tamaño por confirmar'
                              : `${product.size} ${product.unit}`}
                            {!product.active && ' · Inactivo'}
                          </small>
                        </td>
                        <td data-label="Costo promedio">
                          {pricing?.averageCost != null ? (
                            <strong
                              title={`C$ ${exactCost(pricing.averageCost)}`}
                            >
                              {formatCurrency(pricing.averageCost, 'NIO')}
                            </strong>
                          ) : (
                            <span className="muted">Sin costo</span>
                          )}
                        </td>
                        {priceTiers.map((tier) => {
                          const quote = tierQuote(
                            pricing,
                            pricing?.averageCost,
                            tier,
                            data?.rate,
                          )
                          const status = tierStatus(
                            pricing,
                            pricing?.averageCost,
                            tier,
                          )
                          const price = product.prices?.[tier]?.[currency]
                          const markup = pricing?.markups[tier] ?? null
                          return (
                            <td key={tier} data-label={priceTierLabels[tier]}>
                              <strong>
                                {price == null || !Number.isFinite(price)
                                  ? '—'
                                  : formatCurrency(price, currency)}
                              </strong>
                              <small
                                className={
                                  quote
                                    ? 'pricing-computed'
                                    : status === 'pending'
                                      ? 'pricing-pending'
                                      : undefined
                                }
                              >
                                {quote
                                  ? `${quote.percent} % · gana ${formatCurrency(quote.profit, 'NIO')}`
                                  : status === 'pending'
                                    ? `${markup} % · pendiente de costo`
                                    : 'A mano'}
                              </small>
                            </td>
                          )
                        })}
                        <td className="pricing-row-actions">
                          <Button
                            variant="secondary"
                            aria-label={`Editar precios de ${product.name}`}
                            onClick={() => setEditing(product)}
                          >
                            Editar
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="table-footer">
            <span>
              {counts.format(filtered.length)} de{' '}
              {counts.format(products.length)} perfumes
            </span>
            <div className="pagination">
              <Button
                variant="ghost"
                aria-label="Página anterior"
                disabled={current === 1}
                onClick={() => setPage(current - 1)}
              >
                <ArrowLeft size={16} />
              </Button>
              <span>
                {current} / {pages}
              </span>
              <Button
                variant="ghost"
                aria-label="Página siguiente"
                disabled={current === pages}
                onClick={() => setPage(current + 1)}
              >
                <ArrowRight size={16} />
              </Button>
            </div>
          </div>
          <p className="muted pricing-footnote">
            Los precios de venta de esta lista son los guardados, los mismos que
            usan Facturación y Proformas. Cuando una compra cambia el costo
            promedio, las listas calculadas se actualizan solas; las facturas y
            proformas ya emitidas conservan su precio. Para cambiar datos del
            perfume o un precio fijado a mano, abre{' '}
            <Link className="text-link" to={`${base}/inventory`}>
              Inventario
            </Link>{' '}
            y elige Editar.
          </p>
        </Card>
      )}
      {editing && data && (
        <PricingDialog
          product={editing}
          saved={byProduct.get(editing.id) ?? null}
          rate={data.rate}
          base={base}
          onOpenCosts={() => {
            setEditing(null)
            openSection('costs')
          }}
          readOnly={demo}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}
      {importing && data && (
        <PricingImportDialog
          products={data.products}
          pricing={data.pricing.rows}
          rate={data.rate}
          readOnly={demo}
          onClose={() => setImporting(false)}
          onSaved={saved}
        />
      )}
    </>
  )
}

import { ScanButton } from '../scanner/ScanButton'
import { WorkspaceHeading } from '../../components/WorkspacePresentation'
import { can } from '../../lib/permissions'
import { useCallback, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  Package,
  Plus,
  Pencil,
  LayoutGrid,
  List,
} from 'lucide-react'
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from '../../components/ui'
import { PriceControls } from '../../components/PriceControls'
import { ProductImage } from '../../components/ProductImage'
import { ProductBarcode } from '../../components/ProductBarcode'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import {
  labels,
  type Product,
  type Currency,
  type PriceTier,
  type Category,
  type Gender,
} from '../../lib/domain'
import { formatCurrency } from '../../lib/format'
import { productPrice } from '../../lib/pricing'
import {
  emptyFilters,
  filterInventory,
  totalStock,
  type InventoryFilters,
  type StockFilter,
} from './model'
import { ProductCard, ProductIdentity, StockBadge } from './ProductCard'
import { useAccess } from '../../app/AccessContext'
import { MovementDrafts } from './MovementDrafts'
import { InventoryMovements } from './InventoryMovements'
export function InventoryPage() {
  const { base, demo, role } = useAccess()
  const { state } = useLocation()
  const manage = can(role, 'product.manage') || demo
  const [catalog, setCatalog] = useState(true)
  const [status, setStatus] = useState('active')
  const { inventoryService } = useServices()
  const load = useCallback(
    () => inventoryService.getInventory(manage),
    [inventoryService, manage],
  )
  const { data, loading, error, retry } = useQuery(load)
  const [filters, setFilters] = useState<InventoryFilters>(emptyFilters)
  const [currency, setCurrency] = useState<Currency>('NIO')
  const [tier, setTier] = useState<PriceTier>('emprendedor')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Product | null>(null)
  const items = filterInventory(
    (data ?? []).filter(
      ({ product }) =>
        status === 'all' || product.active === (status === 'active'),
    ),
    filters,
  )
  // El guion sólo necesita explicarse cuando aparece en pantalla.
  const uncounted = items.some(
    ({ quantities }) =>
      quantities.store === null || quantities.warehouse === null,
  )
  const perPage = 24
  const pages = Math.max(1, Math.ceil(items.length / perPage))
  const currentPage = Math.min(page, pages)
  const shown = items.slice((currentPage - 1) * perPage, currentPage * perPage)
  function change(next: Partial<InventoryFilters>) {
    setFilters({ ...filters, ...next })
    setPage(1)
  }
  const brands = [...new Set(data?.map((item) => item.product.brand))].sort(
    (a, b) => a.localeCompare(b, 'es'),
  )
  const sizes = [
    ...new Set(
      data?.map(({ product: p }) =>
        p.size === null ? 'unknown' : `${p.size} ${p.unit}`,
      ),
    ),
  ].sort(
    (a, b) =>
      (a === 'unknown' ? Infinity : parseFloat(a)) -
      (b === 'unknown' ? Infinity : parseFloat(b)),
  )
  function price(product: Product) {
    const value = productPrice(product, tier, currency)
    return value === null ? 'Precio pendiente' : formatCurrency(value, currency)
  }
  return (
    <>
      <WorkspaceHeading
        title="Inventario"
        eyebrow="PERFUMES Y EXISTENCIAS"
        icon={Package}
        description="Fotos, precios y cantidades de Tienda y Bodega, en un solo lugar."
      >
        <div className="inventory-actions">
          {manage && (
            <Link className="button button-primary" to={`${base}/products/new`}>
              <Plus size={18} /> Nuevo perfume
            </Link>
          )}
        </div>
      </WorkspaceHeading>
      {state?.message && (
        <p role="status" className="page-feedback">
          {state.message}
        </p>
      )}
      {demo ? (
        <MovementDrafts items={(data ?? []).filter((i) => i.product.active)} />
      ) : (
        <InventoryMovements
          items={(data ?? []).filter((i) => i.product.active)}
          onRecorded={retry}
        />
      )}
      <Card>
        <div className="inventory-toolbar">
          <div className="catalog-toolbar-heading">
            <h2>{data?.length ?? '—'} referencias</h2>
            <PriceControls
              currency={currency}
              tier={tier}
              onCurrency={setCurrency}
              onTier={setTier}
            />
          </div>
          <div className="filter-grid">
            <div className="search-with-scan">
              <Input
                label="Buscar producto"
                type="search"
                placeholder="Nombre, marca o código…"
                value={filters.search}
                onChange={(e) => change({ search: e.target.value })}
              />
              <ScanButton
                onCode={(code) => {
                  setFilters({ ...emptyFilters, search: code })
                  setStatus(manage ? 'all' : 'active')
                  setPage(1)
                }}
              />
            </div>
            <Select
              label="Categoría"
              value={filters.category}
              onChange={(e) =>
                change({ category: e.target.value as Category | '' })
              }
            >
              <option value="">Todas</option>
              {Object.entries(labels.category).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
            <Select
              label="Marca"
              value={filters.brand}
              onChange={(e) => change({ brand: e.target.value })}
            >
              <option value="">Todas las marcas</option>
              {brands.map((brand) => (
                <option key={brand}>{brand}</option>
              ))}
            </Select>
            <Select
              label="Género"
              value={filters.gender}
              onChange={(e) =>
                change({ gender: e.target.value as Gender | '' })
              }
            >
              <option value="">Todos</option>
              {Object.entries(labels.gender).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
            <Select
              label="Tamaño"
              value={filters.size}
              onChange={(e) => change({ size: e.target.value })}
            >
              <option value="">Todos</option>
              {sizes.map((size) => (
                <option value={size} key={size}>
                  {size === 'unknown' ? 'Por confirmar' : size}
                </option>
              ))}
            </Select>
            {manage && (
              <Select
                label="Mostrar perfumes"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value)
                  setPage(1)
                }}
              >
                <option value="active">Activos</option>
                <option value="inactive">Inactivos</option>
                <option value="all">Todos</option>
              </Select>
            )}
            <Select
              label="Existencias"
              value={filters.stock}
              onChange={(e) => change({ stock: e.target.value as StockFilter })}
            >
              <option value="">Todas</option>
              <option value="unknown">Sin conteo</option>
              <option value="available">Con existencias</option>
              <option value="low">Bajo el mínimo</option>
              <option value="out">Sin existencias</option>
            </Select>
          </div>
          <div className="filter-note">
            <span>
              {uncounted
                ? '— indica que el conteo aún no está registrado. Puedes registrarlo desde Editar.'
                : ''}
            </span>
            <Button
              variant="ghost"
              onClick={() => {
                setFilters(emptyFilters)
                setPage(1)
              }}
            >
              Limpiar filtros
            </Button>
          </div>
        </div>
        <div
          className="inventory-view-switch"
          role="group"
          aria-label="Vista de inventario"
        >
          <Button
            variant="ghost"
            aria-pressed={catalog}
            onClick={() => setCatalog(true)}
          >
            <LayoutGrid size={17} /> Tarjetas
          </Button>
          <Button
            variant="ghost"
            aria-pressed={!catalog}
            onClick={() => setCatalog(false)}
          >
            <List size={17} /> Tabla
          </Button>
        </div>
        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState message={error} retry={retry} />
        ) : !items.length ? (
          <EmptyState />
        ) : catalog ? (
          <div className="catalog-grid">
            {shown.map((item) => {
              const p = item.product
              return (
                <article className="catalog-product" key={p.id}>
                  <button
                    className="product-photo-button"
                    onClick={() => setSelected(p)}
                    aria-label={`Ver ${p.name}`}
                  >
                    <ProductImage product={p} large />
                  </button>
                  <div className="catalog-product-body">
                    <span className="product-brand">{p.brand}</span>
                    <button
                      className="product-title"
                      onClick={() => setSelected(p)}
                    >
                      {p.name}
                    </button>
                    <p>
                      {p.size === null
                        ? 'Tamaño por confirmar'
                        : `${p.size} ${p.unit}`}{' '}
                      · {labels.category[p.category]}
                    </p>
                    <strong className="catalog-price">{price(p)}</strong>
                    <div className="catalog-stock">
                      <span>
                        Bodega <b>{item.quantities.warehouse ?? '—'}</b>
                      </span>
                      <span>
                        Tienda <b>{item.quantities.store ?? '—'}</b>
                      </span>
                    </div>
                    {!p.active && (
                      <span className="record-badge">Inactivo</span>
                    )}
                    {manage && (
                      <Link
                        className="button button-secondary inventory-edit"
                        to={`${base}/products/${p.id}/edit`}
                      >
                        <Pencil size={15} /> Editar
                      </Link>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        ) : (
          <>
            <div className="inventory-table">
              <table>
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th>Bodega</th>
                    <th>Tienda</th>
                    <th>Total</th>
                    <th>Precio</th>
                    <th>Estado</th>
                    {manage && <th>Acciones</th>}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((item) => (
                    <tr key={item.product.id}>
                      <td>
                        <button
                          className="identity-button"
                          onClick={() => setSelected(item.product)}
                        >
                          <ProductIdentity item={item} />
                        </button>
                        <span className="barcode-label">
                          Interno: {item.product.barcode}
                        </span>
                      </td>
                      <td>{item.quantities.warehouse ?? '—'}</td>
                      <td>{item.quantities.store ?? '—'}</td>
                      <td>{totalStock(item) ?? '—'}</td>
                      <td>{price(item.product)}</td>
                      <td>
                        {item.product.active ? (
                          <StockBadge item={item} />
                        ) : (
                          <span className="record-badge">Inactivo</span>
                        )}
                      </td>
                      {manage && (
                        <td>
                          <Link
                            className="button button-secondary"
                            to={`${base}/products/${item.product.id}/edit`}
                          >
                            Editar
                          </Link>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="inventory-cards">
              {shown.map((item) => (
                <div key={item.product.id}>
                  <ProductCard item={item} currency={currency} tier={tier} />
                  <Button
                    variant="ghost"
                    onClick={() => setSelected(item.product)}
                  >
                    Ver ficha y código
                  </Button>
                  {manage && (
                    <Link
                      className="button button-secondary"
                      to={`${base}/products/${item.product.id}/edit`}
                    >
                      Editar
                    </Link>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
        <div className="table-footer">
          <span>
            {items.length} de {data?.length ?? 0} productos
          </span>
          <div className="pagination">
            <Button
              variant="ghost"
              aria-label="Página anterior"
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
            >
              <ArrowLeft size={16} />
            </Button>
            <span>
              {currentPage} / {pages}
            </span>
            <Button
              variant="ghost"
              aria-label="Página siguiente"
              disabled={currentPage === pages}
              onClick={() => setPage(currentPage + 1)}
            >
              <ArrowRight size={16} />
            </Button>
          </div>
        </div>
      </Card>
      {selected && (
        <Dialog open title={selected.name} onClose={() => setSelected(null)}>
          <div className="product-detail">
            <ProductImage key={selected.id} product={selected} large />
            <div>
              <p>{selected.brand}</p>
              <h3>{price(selected)}</h3>
              <p>
                {selected.size === null
                  ? 'Tamaño por confirmar'
                  : `${selected.size} ${selected.unit}`}{' '}
                · {labels.gender[selected.gender]}
              </p>
              <p>
                {labels.category[selected.category]} ·{' '}
                {selected.availabilityNote}
              </p>
              {selected.imageSource && (
                <a
                  className="text-link"
                  href={selected.imageSource}
                  target="_blank"
                  rel="noreferrer"
                >
                  Abrir foto original
                </a>
              )}
              <p className="workspace-disclaimer">
                Código de fabricante:{' '}
                {selected.manufacturerBarcode ?? 'pendiente de registrar'}
              </p>
            </div>
          </div>
          <ProductBarcode code={selected.barcode} />
          {(can(role, 'product.manage') || demo) && (
            <Link
              className="button button-primary"
              to={`${base}/products/${selected.id}/edit`}
            >
              Editar perfume
            </Link>
          )}
        </Dialog>
      )}
    </>
  )
}

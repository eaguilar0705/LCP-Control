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
  Sigma,
  SlidersHorizontal,
  Store,
  Warehouse,
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
import { ProductImage } from '../../components/ProductImage'
import { ProductBarcode } from '../../components/ProductBarcode'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import {
  labels,
  type Product,
  type Currency,
  type Category,
  type Gender,
  type InventoryLocation,
} from '../../lib/domain'
import {
  emptyFilters,
  filterInventory,
  locationTotals,
  totalStock,
  type InventoryFilters,
  type StockFilter,
} from './model'
import {
  ProductCard,
  ProductIdentity,
  StockBadge,
  StockByLocation,
} from './ProductCard'
import { useAccess } from '../../app/AccessContext'
import { MovementDrafts } from './MovementDrafts'
import { InventoryMovements } from './InventoryMovements'
import { ProductPrices, ProductPriceValue } from './ProductPrices'
import { inventoryPriceLists } from './inventory-price-lists'
import './inventory-prices.css'
import { PriceListsPanel } from '../pricing/PriceListsPanel'
import { PurchaseHistoryPanel } from '../pricing/PurchaseHistoryPanel'
import '../../styles/everyday-usability.css'
export function InventoryPage() {
  const { base, demo, role } = useAccess()
  const { state } = useLocation()
  const manage = can(role, 'product.manage') || demo
  const [catalog, setCatalog] = useState(true)
  const [status, setStatus] = useState('active')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const { inventoryService } = useServices()
  const load = useCallback(
    () => inventoryService.getInventory(manage),
    [inventoryService, manage],
  )
  const { data, loading, error, retry } = useQuery(load)
  const [filters, setFilters] = useState<InventoryFilters>(emptyFilters)
  const [currency, setCurrency] = useState<Currency>('NIO')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Product | null>(null)
  const activeFilterCount =
    [
      filters.category,
      filters.brand,
      filters.gender,
      filters.size,
      filters.location,
      filters.stock,
    ].filter(Boolean).length + (status === 'active' ? 0 : 1)
  const items = filterInventory(
    (data ?? []).filter(
      ({ product }) =>
        status === 'all' || product.active === (status === 'active'),
    ),
    filters,
  )
  items.sort(
    (a, b) =>
      a.product.brand.localeCompare(b.product.brand, 'es', {
        sensitivity: 'base',
      }) ||
      a.product.name.localeCompare(b.product.name, 'es', { numeric: true }) ||
      a.product.id.localeCompare(b.product.id),
  )
  // El guion sólo necesita explicarse cuando aparece en pantalla.
  const uncounted = items.some(
    ({ quantities }) =>
      quantities.store === null || quantities.warehouse === null,
  )
  const totals = locationTotals(items)
  const detail = selected
    ? data?.find((item) => item.product.id === selected.id)
    : undefined
  const perPage = 24
  const pages = Math.max(1, Math.ceil(items.length / perPage))
  const currentPage = Math.min(page, pages)
  const shown = items.slice((currentPage - 1) * perPage, currentPage * perPage)
  const groups = [...new Set(shown.map((item) => item.product.brand))].map(
    (brand) => ({
      brand,
      items: shown.filter((item) => item.product.brand === brand),
    }),
  )
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
  return (
    <>
      <WorkspaceHeading
        title="Inventario"
        eyebrow="PERFUMES Y EXISTENCIAS"
        icon={Package}
      >
        <div className="inventory-actions">
          <PriceListsPanel onSaved={retry} />
          <PurchaseHistoryPanel onChanged={retry} />
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
      <div className="inventory-movement-area">
        {demo ? (
          <MovementDrafts
            items={(data ?? []).filter((i) => i.product.active)}
          />
        ) : (
          <InventoryMovements
            items={(data ?? []).filter((i) => i.product.active)}
            onRecorded={retry}
          />
        )}
      </div>
      <Card className="inventory-workspace">
        <div className="inventory-toolbar">
          <div className="catalog-toolbar-heading">
            <h2>{data?.length ?? '—'} referencias</h2>
            <Select
              label="Moneda"
              value={currency}
              onChange={(e) => setCurrency(e.target.value as Currency)}
            >
              <option value="NIO">C$ Córdobas</option>
              <option value="USD">US$ Dólares</option>
            </Select>
          </div>
          <div className="inventory-primary-search">
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
          </div>
          <div className="inventory-results-heading">
            <Button
              type="button"
              variant="secondary"
              className="inventory-filter-toggle"
              aria-expanded={filtersOpen}
              aria-controls="inventory-secondary-filters"
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              <SlidersHorizontal size={17} aria-hidden="true" />
              Filtros
              {activeFilterCount > 0 && (
                <span className="inventory-filter-count">
                  {activeFilterCount}
                </span>
              )}
            </Button>
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
            <span className="inventory-results-count" role="status">
              {items.length} de {data?.length ?? 0} productos
            </span>
          </div>
          <div
            id="inventory-secondary-filters"
            className="filter-grid inventory-secondary-filters"
            hidden={!filtersOpen}
            role="group"
            aria-label="Filtros de inventario"
          >
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
              label="Ubicación"
              value={filters.location}
              onChange={(e) =>
                change({ location: e.target.value as InventoryLocation | '' })
              }
            >
              <option value="">Total consolidado</option>
              <option value="warehouse">Solo Bodega</option>
              <option value="store">Solo Tienda</option>
            </Select>
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
          {(uncounted || filters.search || activeFilterCount > 0) && (
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
                  setStatus('active')
                  setPage(1)
                }}
              >
                Limpiar filtros
              </Button>
            </div>
          )}
        </div>
        <InventoryTotals totals={totals} count={items.length} />
        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState message={error} retry={retry} />
        ) : !items.length ? (
          <EmptyState />
        ) : catalog ? (
          <div className="inventory-brand-groups">
            {groups.map((group) => (
              <section
                className="inventory-brand-group"
                key={group.brand}
                aria-label={`Marca ${group.brand}`}
              >
                <h3 className="inventory-brand-heading">
                  {group.brand}
                  <span>
                    {group.items.length}{' '}
                    {group.items.length === 1 ? 'perfume' : 'perfumes'}
                  </span>
                </h3>
                <div className="catalog-grid">
                  {group.items.map((item) => {
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
                          <ProductPrices product={p} currency={currency} />
                          <StockByLocation item={item} />
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
              </section>
            ))}
          </div>
        ) : (
          <>
            <div className="inventory-table">
              <table>
                <thead>
                  <tr>
                    <th rowSpan={2}>Producto</th>
                    <th colSpan={3} className="stock-group-heading">
                      Existencias
                    </th>
                    {inventoryPriceLists.map((t) => (
                      <th
                        key={t.code}
                        rowSpan={2}
                        className="inventory-price-col"
                      >
                        {t.name}
                      </th>
                    ))}
                    <th rowSpan={2}>Estado</th>
                    {manage && <th rowSpan={2}>Acciones</th>}
                  </tr>
                  <tr>
                    <th className="qty-col qty-warehouse">
                      <Warehouse size={14} aria-hidden="true" /> Bodega
                    </th>
                    <th className="qty-col qty-store">
                      <Store size={14} aria-hidden="true" /> Tienda
                    </th>
                    <th className="qty-col qty-total">
                      <Sigma size={14} aria-hidden="true" /> Total consolidado
                    </th>
                  </tr>
                </thead>
                {groups.map((group) => (
                  <tbody key={group.brand}>
                    <tr className="inventory-brand-row">
                      <th colSpan={manage ? 10 : 9} scope="rowgroup">
                        {group.brand}
                        <span>
                          {group.items.length}{' '}
                          {group.items.length === 1 ? 'perfume' : 'perfumes'}
                        </span>
                      </th>
                    </tr>
                    {group.items.map((item) => (
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
                        <td className="qty-col qty-warehouse">
                          {item.quantities.warehouse ?? '—'}
                        </td>
                        <td className="qty-col qty-store">
                          {item.quantities.store ?? '—'}
                        </td>
                        <td className="qty-col qty-total">
                          {totalStock(item) ?? '—'}
                        </td>
                        {inventoryPriceLists.map((t) => (
                          <td key={t.code} className="inventory-price-col">
                            <ProductPriceValue
                              product={item.product}
                              tier={t.code}
                              currency={currency}
                            />
                          </td>
                        ))}
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
                ))}
                <tfoot>
                  <tr>
                    <th scope="row">
                      Total de la lista ({items.length} productos)
                    </th>
                    <td className="qty-col qty-warehouse">
                      {totals.warehouse}
                    </td>
                    <td className="qty-col qty-store">{totals.store}</td>
                    <td className="qty-col qty-total">{totals.total}</td>
                    <td colSpan={manage ? 6 : 5} />
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="inventory-cards">
              {groups.map((group) => (
                <section
                  className="inventory-brand-group"
                  key={group.brand}
                  aria-label={`Marca ${group.brand}`}
                >
                  <h3 className="inventory-brand-heading">
                    {group.brand}
                    <span>
                      {group.items.length}{' '}
                      {group.items.length === 1 ? 'perfume' : 'perfumes'}
                    </span>
                  </h3>
                  {group.items.map((item) => (
                    <div key={item.product.id}>
                      <ProductCard item={item} currency={currency} allPrices />
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
                </section>
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
              <ProductPrices product={selected} currency={currency} />
              {detail && <StockByLocation item={detail} />}
              <p>
                {selected.size === null
                  ? 'Tamaño por confirmar'
                  : `${selected.size} ${selected.unit}`}{' '}
                · {labels.gender[selected.gender]}
              </p>
              <p>
                {/* Sin nota de disponibilidad no queda un «·» colgando. */}
                {[labels.category[selected.category], selected.availabilityNote]
                  .filter(Boolean)
                  .join(' · ')}
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

function InventoryTotals({
  totals,
  count,
}: {
  totals: ReturnType<typeof locationTotals>
  count: number
}) {
  return (
    <div className="inventory-totals" aria-label="Existencias de la lista">
      <div className="inventory-total inventory-total-warehouse">
        <Warehouse size={18} aria-hidden="true" />
        <span>En Bodega</span>
        <strong>{totals.warehouse.toLocaleString('es-NI')}</strong>
      </div>
      <div className="inventory-total inventory-total-store">
        <Store size={18} aria-hidden="true" />
        <span>En Tienda</span>
        <strong>{totals.store.toLocaleString('es-NI')}</strong>
      </div>
      <div className="inventory-total inventory-total-sum">
        <Sigma size={18} aria-hidden="true" />
        <span>Total consolidado</span>
        <strong>{totals.total.toLocaleString('es-NI')}</strong>
      </div>
      <p className="inventory-totals-note">
        {count} productos
        {totals.uncounted > 0 && ` · ${totals.uncounted} sin conteo completo`}
      </p>
    </div>
  )
}

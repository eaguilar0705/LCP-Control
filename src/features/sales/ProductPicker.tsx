import { ScanButton } from '../scanner/ScanButton'
import { useState } from 'react'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  PackageSearch,
} from 'lucide-react'
import { Button, Input } from '../../components/ui'
import { ProductImage } from '../../components/ProductImage'
import type {
  Currency,
  InventoryItem,
  InventoryLocation,
  PriceTier,
} from '../../lib/domain'
import { formatCurrency } from '../../lib/format'
const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .trim()
export function ProductPicker({
  items,
  currency,
  tier,
  location,
  added,
  onAdd,
}: {
  items: InventoryItem[]
  currency: Currency
  tier: PriceTier
  location: InventoryLocation
  added: string[]
  onAdd: (id: string) => void
}) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const terms = normalize(search).split(/\s+/).filter(Boolean)
  const matches = items.filter(
    ({ product: p }) =>
      p.active &&
      terms.every((term) =>
        normalize(
          `${p.brand} ${p.name} ${p.barcode} ${p.manufacturerBarcode ?? ''} ${p.size ?? ''} ${p.unit}`,
        ).includes(term),
      ),
  )
  const pages = Math.max(1, Math.ceil(matches.length / 6))
  const current = Math.min(page, pages - 1)
  return (
    <div className="product-picker">
      <div className="search-with-scan">
        <div className="picker-search">
          <Search size={19} />
          <Input
            label="Buscar en catálogo"
            type="search"
            placeholder="Nombre, marca o código del perfume…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(0)
            }}
          />
        </div>
        <ScanButton
          onCode={(code) => {
            setSearch(code)
            setPage(0)
          }}
        />
      </div>
      <div className="picker-caption">
        <span>
          {matches.length} {matches.length === 1 ? 'perfume' : 'perfumes'}
        </span>
      </div>
      <div className="picker-grid" aria-label="Productos disponibles">
        {matches
          .slice(current * 6, current * 6 + 6)
          .map(({ product: p, quantities }) => {
            const selected = added.includes(p.id)
            const stock = quantities[location]
            return (
              <article
                className={`picker-product ${selected ? 'is-added' : ''}`}
                key={p.id}
              >
                <div className="picker-photo">
                  <ProductImage
                    key={`${p.id}:${p.imageUrl}`}
                    product={p}
                    large
                  />
                  {selected && (
                    <span className="picker-selected">
                      <Check size={12} /> En el documento
                    </span>
                  )}
                </div>
                <div className="picker-product-body">
                  <span className="product-brand">{p.brand}</span>
                  <h3>{p.name}</h3>
                  <p>
                    {p.size == null
                      ? 'Tamaño por confirmar'
                      : `${p.size} ${p.unit}`}{' '}
                    <span>· {p.barcode}</span>
                  </p>
                  <span
                    className={`picker-stock ${stock === 0 ? 'stock-empty' : ''}`}
                  >
                    {stock == null
                      ? 'Existencias por contar'
                      : `${stock} disponibles`}{' '}
                    · {location === 'store' ? 'Tienda' : 'Bodega'}
                  </span>
                  <div className="picker-product-footer">
                    <strong>
                      {p.prices
                        ? formatCurrency(p.prices[tier][currency], currency)
                        : 'Sin precio'}
                    </strong>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={selected || !p.prices}
                      aria-label={`Agregar ${p.brand} ${p.name} ${p.size ?? ''} ${p.unit}`}
                      onClick={() => onAdd(p.id)}
                    >
                      {selected ? <Check size={16} /> : <Plus size={16} />}
                      <span>{selected ? 'Agregado' : 'Agregar'}</span>
                    </Button>
                  </div>
                </div>
              </article>
            )
          })}
      </div>
      {!matches.length && (
        <div className="workspace-empty">
          <PackageSearch size={30} />
          <h3>No encontramos ese perfume</h3>
          <p>Prueba con otra marca, nombre o código.</p>
          <Button
            variant="ghost"
            onClick={() => {
              setSearch('')
              setPage(0)
            }}
          >
            Limpiar búsqueda
          </Button>
        </div>
      )}
      {pages > 1 && (
        <div className="picker-pagination">
          <Button
            variant="ghost"
            aria-label="Perfumes anteriores"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            <ChevronLeft size={17} />
          </Button>
          <span>
            {current + 1} de {pages}
          </span>
          <Button
            variant="ghost"
            aria-label="Más perfumes"
            disabled={current === pages - 1}
            onClick={() => setPage(current + 1)}
          >
            <ChevronRight size={17} />
          </Button>
        </div>
      )}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ListPlus, Plus, Save } from 'lucide-react'
import type { Currency, Product } from '../../lib/domain'
import { useAccess } from '../../app/AccessContext'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { usePriceTiers } from '../../lib/usePriceTiers'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { can } from '../../lib/permissions'
import { AppError, errorMessage } from '../../lib/errors'
import { formatCurrency } from '../../lib/format'
import { matchesSearch } from '../../lib/search'
import { convertPrice, tierStatus } from '../../lib/pricing'
import { ProductImage } from '../../components/ProductImage'
import {
  Button,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from '../../components/ui'
import { ScanButton } from '../scanner/ScanButton'
import './price-lists.css'

export function PriceListsPanel({ onSaved }: { onSaved?: () => void }) {
  const { role, demo } = useAccess()
  const [open, setOpen] = useState(false)
  if (demo || !can(role, 'pricing.manage')) return null
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <ListPlus size={18} /> Listas de precios
      </Button>
      {open && (
        <PriceListEditor onClose={() => setOpen(false)} onSaved={onSaved} />
      )}
    </>
  )
}

function PriceListEditor({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved?: () => void
}) {
  const { productService, settingsService } = useServices()
  const { storageScope = 'anonymous' } = useAccess()
  const [creation] = useState(() =>
    createIdempotentOperation<{ name: string }, string>(
      productService.createPriceTier,
      {
        scope: storageScope,
        key: 'price-tier-create',
        label: 'Lista de precios',
      },
    ),
  )
  const tiers = usePriceTiers()
  const load = useCallback(async () => {
    const [products, pricing, rate] = await Promise.all([
      productService.listProducts(),
      productService.listPricing(),
      settingsService.getExchangeRate(),
      productService.listPriceTiers(),
    ])
    return { products, pricing, rate: rate?.usdToNio ?? null }
  }, [productService, settingsService])
  const { data, loading, error, retry } = useQuery(load)
  const [tier, setTier] = useState('emprendedor')
  const [currency, setCurrency] = useState<Currency>('USD')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [message, setMessage] = useState('')
  const [replace, setReplace] = useState<(() => void) | null>(null)
  const priceRequest = useRef<{ signature: string; requestId: string } | null>(
    null,
  )
  const working = useRef(false)
  const uncertain = creation.isUncertain()
  const dirty = Object.keys(edits).length > 0
  useEffect(() => {
    if (!dirty && !busy && !uncertain) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, busy, uncertain])
  const products = (data?.products ?? []).filter(
    (p) =>
      p.active &&
      matchesSearch(
        `${p.name} ${p.brand} ${p.barcode} ${p.manufacturerBarcode ?? ''}`,
        search,
      ),
  )
  const pages = Math.max(1, Math.ceil(products.length / 24))
  const currentPage = Math.min(page, pages - 1)
  const shown = products.slice(currentPage * 24, currentPage * 24 + 24)
  function finalPrices(amount: number) {
    const USD =
      currency === 'USD'
        ? amount
        : convertPrice(amount, 'NIO', 'USD', data?.rate)
    return { USD, NIO: convertPrice(USD, 'USD', 'NIO', data?.rate) }
  }
  function choose(action: () => void) {
    if (working.current || uncertain) return
    if (dirty) setReplace(() => action)
    else action()
  }
  function edit(product: Product, text: string) {
    const current = product.prices?.[tier]?.[currency]
    setEdits((old) => {
      const next = { ...old }
      if (text.trim() !== '' && Number(text) === current)
        delete next[product.id]
      else next[product.id] = text
      return next
    })
    setMessage('')
    setFailure('')
  }
  async function create(event: FormEvent) {
    event.preventDefault()
    if (working.current) return
    const trimmed = name.trim()
    if (!uncertain && !trimmed) {
      setFailure('Escribe el nombre de la lista.')
      return
    }
    working.current = true
    setBusy(true)
    setFailure('')
    try {
      const code = uncertain
        ? await creation.retryPending()
        : await creation.execute({ name: trimmed })
      creation.reset()
      setTier(code)
      setCurrency('USD')
      setPage(0)
      setCreating(false)
      setName('')
      setMessage('Lista creada. Agrega los precios de los perfumes.')
      onSaved?.()
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      working.current = false
      setBusy(false)
    }
  }
  async function save() {
    if (working.current || uncertain || !data || !dirty) return
    const rows = Object.entries(edits).map(([productId, text]) => ({
      productId,
      revision: data.products.find((p) => p.id === productId)?.revision ?? 0,
      amount: Number(text),
    }))
    if (
      Object.values(edits).some(
        (text) =>
          !text.trim() ||
          !Number.isFinite(Number(text)) ||
          Number(text) <= 0 ||
          Number(text) > 10000000 ||
          Math.abs(Number(text) * 100 - Math.round(Number(text) * 100)) >
            0.00001,
      )
    ) {
      setFailure(
        'Escribe precios mayores que cero y con hasta dos decimales en todos los campos modificados.',
      )
      return
    }
    working.current = true
    setBusy(true)
    setFailure('')
    const signature = JSON.stringify({ tier, currency, rows })
    if (priceRequest.current?.signature !== signature)
      priceRequest.current = { signature, requestId: crypto.randomUUID() }
    try {
      // Reintentar conserva el UUID: la base recupera el lote confirmado sin
      // depender de que otra persona haya puesto los mismos importes.
      await productService.saveListPrices({
        tier,
        currency,
        rows,
        requestId: priceRequest.current.requestId,
      })
      setEdits({})
      priceRequest.current = null
      setMessage(
        `${rows.length} ${rows.length === 1 ? 'precio guardado' : 'precios guardados'}.`,
      )
      retry()
      onSaved?.()
    } catch (error) {
      setFailure(
        error instanceof AppError && error.kind === 'network'
          ? 'No pudimos confirmar el guardado. Reintenta Guardar precios para recuperar el mismo lote.'
          : errorMessage(error),
      )
    } finally {
      working.current = false
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      title="Listas de precios"
      className="price-lists-dialog"
      dismissible={!busy && !uncertain}
      onClose={() => choose(onClose)}
    >
      <fieldset disabled={busy || uncertain} className="price-lists-fields">
        <div className="price-lists-toolbar">
          <Select
            label="Lista de precios"
            value={tier}
            onChange={(e) => {
              const next = e.target.value
              choose(() => {
                setTier(next)
                setEdits({})
                setPage(0)
                setFailure('')
                setMessage('')
              })
            }}
          >
            {tiers.map((list) => (
              <option key={list.code} value={list.code}>
                {list.name}
              </option>
            ))}
          </Select>
          <Select
            label="Moneda"
            value={currency}
            onChange={(e) => {
              const next = e.target.value as Currency
              choose(() => {
                setCurrency(next)
                setEdits({})
                setFailure('')
                setMessage('')
              })
            }}
          >
            <option value="USD">US$ Dólares</option>
            <option value="NIO">C$ Córdobas</option>
          </Select>
          <Button
            variant="secondary"
            disabled={loading || !!error}
            onClick={() =>
              choose(() => {
                setEdits({})
                setCreating(!creating)
                setFailure('')
              })
            }
          >
            <Plus size={17} /> Nueva lista
          </Button>
        </div>
      </fieldset>
      {creating && (
        <form className="price-list-create" onSubmit={create}>
          <Input
            label="Nombre de la nueva lista"
            value={name}
            maxLength={80}
            required
            autoFocus
            disabled={busy || uncertain}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" disabled={busy}>
            {busy
              ? 'Guardando…'
              : uncertain
                ? 'Verificar guardado'
                : 'Crear lista'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy || uncertain}
            onClick={() => setCreating(false)}
          >
            Cancelar
          </Button>
        </form>
      )}
      <fieldset disabled={busy || uncertain} className="price-lists-fields">
        <div className="search-with-scan price-lists-search">
          <Input
            label="Buscar perfume"
            type="search"
            placeholder="Nombre, marca o código…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(0)
            }}
          />
          <ScanButton
            onCode={(code) => {
              setSearch(code)
              setPage(0)
            }}
          />
        </div>
        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState message={error} retry={retry} />
        ) : (
          <>
            <div
              className="price-list-products"
              aria-label="Precios por perfume"
            >
              {shown.map((p) => {
                const pricing = data?.pricing.rows.find(
                  (row) => row.productId === p.id,
                )
                const calculated =
                  pricing && tierStatus(pricing, tier) !== 'manual'
                const published = p.prices?.[tier]?.[currency]
                const text = edits[p.id]
                const quote =
                  text != null &&
                  text.trim() &&
                  Number.isFinite(Number(text)) &&
                  Number(text) > 0
                    ? finalPrices(Number(text))
                    : null
                return (
                  <div className="price-list-product" key={p.id}>
                    <ProductImage product={p} />
                    <div className="price-list-identity">
                      <small>
                        {p.brand} · {p.barcode}
                      </small>
                      <strong>{p.name}</strong>
                      <span>
                        {p.size == null
                          ? 'Tamaño por confirmar'
                          : `${p.size} ${p.unit}`}
                      </span>
                    </div>
                    <div className="price-list-amount">
                      <Input
                        label={`Precio ${p.barcode} ${currency}`}
                        type="number"
                        inputMode="decimal"
                        min={0.01}
                        max={10000000}
                        step={0.01}
                        placeholder="Sin precio"
                        disabled={!!calculated}
                        value={
                          edits[p.id] ??
                          (published != null && published > 0
                            ? String(published)
                            : '')
                        }
                        onChange={(e) => edit(p, e.target.value)}
                      />
                      {calculated ? (
                        <small>Calculado en la ficha del perfume</small>
                      ) : quote &&
                        Number.isFinite(quote.USD) &&
                        Number.isFinite(quote.NIO) ? (
                        <small>
                          {formatCurrency(quote.USD, 'USD')} ·{' '}
                          {formatCurrency(quote.NIO, 'NIO')}
                        </small>
                      ) : (
                        <small>
                          {published != null && published > 0
                            ? `Actual: ${formatCurrency(published, currency)}`
                            : 'Sin precio registrado'}
                        </small>
                      )}
                    </div>
                  </div>
                )
              })}
              {!shown.length && (
                <p className="muted">No hay perfumes que coincidan.</p>
              )}
            </div>
            <div className="price-list-footer">
              <span>
                {products.length} perfumes · {Object.keys(edits).length} cambios
              </span>
              <div className="pagination">
                <Button
                  variant="ghost"
                  aria-label="Página anterior de precios"
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                >
                  Anterior
                </Button>
                <span>
                  {currentPage + 1} / {pages}
                </span>
                <Button
                  variant="ghost"
                  aria-label="Página siguiente de precios"
                  disabled={currentPage + 1 >= pages}
                  onClick={() => setPage(currentPage + 1)}
                >
                  Siguiente
                </Button>
              </div>
            </div>
          </>
        )}
        {failure && (
          <p role="alert" className="inline-error">
            {failure}
          </p>
        )}
        {data && data.rate === null && (
          <p role="alert" className="inline-error">
            Registra el tipo de cambio en Negocio antes de guardar precios.
          </p>
        )}
        {message && (
          <p role="status" className="workspace-feedback">
            {message}
          </p>
        )}
        <div className="form-actions">
          <Button
            disabled={
              busy || !dirty || loading || !!error || data?.rate == null
            }
            onClick={() => void save()}
          >
            <Save size={17} />
            {busy ? 'Guardando…' : 'Guardar precios'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => choose(onClose)}
            disabled={busy}
          >
            Cerrar
          </Button>
        </div>
      </fieldset>
      {replace && (
        <ConfirmDialog
          open
          title="Descartar cambios de precios"
          confirmLabel="Descartar cambios"
          onCancel={() => setReplace(null)}
          onConfirm={() => {
            const action = replace
            setReplace(null)
            setEdits({})
            action()
          }}
        >
          <p>Hay precios sin guardar.</p>
        </ConfirmDialog>
      )}
    </Dialog>
  )
}

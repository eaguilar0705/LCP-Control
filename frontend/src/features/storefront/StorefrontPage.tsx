import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowUpRight,
  Bell,
  Globe,
  Plus,
  RefreshCw,
  Eye,
  ImagePlus,
  Star,
  X,
} from 'lucide-react'
import {
  Button,
  Dialog,
  ConfirmDialog,
  Input,
  Select,
  ErrorState,
  LoadingState,
} from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { useAuth } from '../auth/AuthContext'
import { errorMessage } from '../../lib/errors'
import {
  act,
  rows,
  getDraft,
  blank,
  upload,
  photoBlob,
  price,
  statusNames,
  stockNames,
  catalogLinks,
  readOffers,
  type StorefrontOffer,
  type CatalogLink,
  availabilityNames,
  type Draft,
  type Publication,
  type Content,
  type Photo,
} from './storefront'
import { StorefrontPhoto } from './StorefrontPhoto'
import { CatalogLinks } from './CatalogLinks'
import { OfferEditor } from './OfferEditor'
import { inventoryPriceLists } from '../inventory/inventory-price-lists'
import './storefront.css'
type PendingPhoto = { file: File; url: string }
type SourcePrices = {
  id: string
  product_prices: { tier_code: string; currency: string; amount: number }[]
}
const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
export function StorefrontPage() {
  const { demo, base } = useAccess()
  const { user } = useAuth()
  const [drafts, setDrafts] = useState<Draft[]>([]),
    [publications, setPublications] = useState<Publication[]>([])
  const [links, setLinks] = useState<CatalogLink[]>([])
  const [selectedCatalog, setSelectedCatalog] = useState('')
  const [offers, setOffers] = useState<StorefrontOffer[]>([])
  const [sourcePrices, setSourcePrices] = useState<SourcePrices[]>([])
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [page, setPage] = useState(0)
  const [editing, setEditing] = useState<Draft | null>(null),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false)
  const [editError, setEditError] = useState(''),
    [review, setReview] = useState(false)
  const [confirmation, setConfirmation] = useState<{
    action: string
    title: string
    text: string
    label: string
  } | null>(null)
  const [pending, setPending] = useState<PendingPhoto[]>([])
  const [featurePicker, setFeaturePicker] = useState(false)
  const [featureId, setFeatureId] = useState('')
  const [featureSearch, setFeatureSearch] = useState('')
  const [featureLimit, setFeatureLimit] = useState(24)
  const [featureError, setFeatureError] = useState('')
  const [inventoryPicker, setInventoryPicker] = useState(false)
  const [inventorySearch, setInventorySearch] = useState('')
  const [inventoryLimit, setInventoryLimit] = useState(24)
  const pendingRef = useRef(pending)
  useEffect(() => {
    pendingRef.current = pending
  }, [pending])
  const form = useRef<HTMLFormElement>(null)
  const request = useRef(0)
  const refresh = useCallback(async () => {
    const ticket = ++request.current
    if (demo) {
      setLoading(false)
      return
    }
    setError('')
    try {
      const [d, p, l, prices, offers] = await Promise.all([
        rows<Draft>('storefront_drafts'),
        rows<Publication>(
          'storefront_publications',
          'id,content,visible,listed',
        ),
        catalogLinks(),
        rows<SourcePrices>(
          'products',
          'id,product_prices(tier_code,currency,amount)',
        ),
        readOffers(),
      ])
      if (ticket !== request.current) return
      setDrafts(d)
      setPublications(p)
      setLinks(l)
      setSourcePrices(prices)
      setOffers(offers)
    } catch (e) {
      if (ticket === request.current) setError(errorMessage(e))
    } finally {
      if (ticket === request.current) setLoading(false)
    }
  }, [demo])
  const cancelRefresh = useCallback(() => {
    request.current++
  }, [])
  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void refresh()
    })
    return () => {
      active = false
      cancelRefresh()
    }
  }, [refresh, cancelRefresh])
  useEffect(
    () => () => {
      pendingRef.current.forEach((p) => URL.revokeObjectURL(p.url))
    },
    [],
  )
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  function clearPending() {
    pendingRef.current.forEach((p) => URL.revokeObjectURL(p.url))
    setPending([])
  }
  function close() {
    if (busy) return
    if (dirty) {
      setConfirmation({
        action: 'close',
        title: '¿Cerrar sin guardar?',
        text: 'Los cambios de este borrador todavía no se guardaron.',
        label: 'Descartar cambios',
      })
      return
    }
    setEditing(null)
    clearPending()
  }
  async function open(id?: string) {
    setEditError('')
    setError('')
    try {
      setEditing(id ? await getDraft(id) : blank())
      setDirty(false)
      clearPending()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  function change<K extends keyof Content>(key: K, value: Content[K]) {
    setEditing((d) =>
      d ? { ...d, content: { ...d.content, [key]: value } } : null,
    )
    setDirty(true)
  }
  function option(
    key: 'inventory_managed' | 'hide_unavailable',
    value: boolean,
  ) {
    setEditing((d) => (d ? { ...d, [key]: value } : null))
    setDirty(true)
  }
  async function save(publish = false) {
    if (!editing || !user || busy) return
    setBusy(true)
    setEditError('')
    let current = editing
    try {
      const images: Photo[] = []
      for (const image of current.content.images)
        images.push(
          publish && image.kind === 'control'
            ? await upload(await photoBlob(image), user.id)
            : image,
        )
      for (const p of pending) images.push(await upload(p.file, user.id))
      // Keep successful uploads in the editor if the database rejects a stale revision.
      current = { ...current, content: { ...current.content, images } }
      setEditing(current)
      clearPending()
      current = await act('save', current)
      setEditing(current)
      setDirty(false)
      if (publish) {
        current = await act('publish', current)
        setEditing(null)
        setReview(false)
        setNotice(
          'Publicación actualizada. La disponibilidad seguirá el inventario según la opción elegida.',
        )
      } else
        setEditError('Borrador guardado. La publicación todavía no cambió.')
      await refresh()
    } catch (e) {
      setEditError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  async function confirmAction() {
    if (!editing || !confirmation || busy) return
    const action = confirmation.action
    if (action === 'close') {
      setConfirmation(null)
      setEditing(null)
      setDirty(false)
      clearPending()
      return
    }
    if (action === 'use_source') {
      const s = editing.source_snapshot
      setEditing({
        ...editing,
        content: {
          ...editing.content,
          name: s.name || editing.content.name,
          brand: s.brand || editing.content.brand,
          size: s.size || '',
          unit: s.unit || 'ml',
          category: s.category || 'other',
          gender: s.gender || 'unisex',
          images: s.image_path ? [{ kind: 'control', path: s.image_path }] : [],
        },
      })
      clearPending()
      setDirty(true)
      setConfirmation(null)
      return
    }
    setBusy(true)
    setEditError('')
    try {
      await act(action, editing)
      setConfirmation(null)
      setEditing(null)
      setDirty(false)
      clearPending()
      setNotice(
        action === 'keep_removed'
          ? 'Ficha conservada como no disponible.'
          : action === 'accept_removal'
            ? 'Baja aceptada. La publicación quedó archivada.'
            : 'Cambio guardado.',
      )
      await refresh()
    } catch (e) {
      setEditError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  function ask(action: string, title: string, text: string, label: string) {
    setEditError('')
    setConfirmation({
      action,
      title,
      text: dirty
        ? `${text} Los cambios sin guardar del editor se descartarán.`
        : text,
      label,
    })
  }
  const pubMap = new Map(publications.map((p) => [p.id, p]))
  function tierPrice(draft: Draft, code: string) {
    return draft.source_product_id
      ? sourcePrices
          .find((p) => p.id === draft.source_product_id)
          ?.product_prices.find(
            (p) => p.tier_code === code && p.currency === 'USD',
          )?.amount || 0
      : code === 'menudeo'
        ? draft.content.price
        : 0
  }
  function priceList(draft: Draft) {
    return (
      <dl
        className="sf-price-lists"
        aria-label={
          selectedCatalog
            ? `Precios de ${links.find((l) => l.code === selectedCatalog)?.name}`
            : 'Precios de los cuatro catálogos'
        }
      >
        {inventoryPriceLists
          .filter((t) => !selectedCatalog || t.code === selectedCatalog)
          .map((t) => (
            <div key={t.code}>
              <dt>{t.name}</dt>
              <dd>
                {publicPrice(draft, t.code) <
                  Math.ceil(tierPrice(draft, t.code)) && (
                  <del>{price(Math.ceil(tierPrice(draft, t.code)))}</del>
                )}{' '}
                {price(publicPrice(draft, t.code))}
              </dd>
            </div>
          ))}
      </dl>
    )
  }
  function publicPrice(draft: Draft, code: string) {
    const base = Math.ceil(tierPrice(draft, code))
    const offer = offers.find(
      (o) => o.draft_id === draft.id && o.tier_code === code,
    )?.final_price
    return offer != null && offer < base ? offer : base
  }
  const featured = publications.find((p) => p.visible && p.content.featured)
  const inventoryCandidates = drafts.filter(
    (d) =>
      d.source_product_id &&
      d.source_snapshot.active &&
      !d.source_missing &&
      norm(
        `${d.content.name} ${d.content.brand} ${d.source_snapshot.sku || ''}`,
      ).includes(norm(inventorySearch)),
  )
  const featureCandidates = drafts.filter((d) => {
    const p = pubMap.get(d.id)
    return (
      p?.visible &&
      p.content.images.length > 0 &&
      d.removal_state !== 'pending' &&
      norm(
        `${p.content.name} ${p.content.brand} ${d.source_snapshot.sku || ''}`,
      ).includes(norm(featureSearch))
    )
  })
  function chooseFeatured() {
    setFeatureId(featured?.id || '')
    setFeatureSearch('')
    setFeatureLimit(24)
    setFeatureError('')
    setFeaturePicker(true)
  }
  async function saveFeatured() {
    const draft = drafts.find((d) => d.id === featureId)
    if (!draft || busy) return
    setBusy(true)
    setFeatureError('')
    try {
      await act('feature', draft)
      setFeaturePicker(false)
      setNotice('Destacado actualizado.')
      await refresh()
    } catch (e) {
      setFeatureError(errorMessage(e))
      await refresh()
    } finally {
      setBusy(false)
    }
  }
  const pendingCount = drafts.filter(
    (d) => d.status === 'pending' || d.removal_state === 'pending',
  ).length
  const removals = drafts.filter((d) => d.removal_state === 'pending').length
  const filtered = drafts
    .filter((d) => {
      const p = pubMap.get(d.id)
      return (
        (filter === 'all' ||
          (filter === 'inventory' &&
            !!d.source_product_id &&
            d.source_snapshot.active &&
            !d.source_missing) ||
          (filter === 'pending' &&
            (d.status === 'pending' || d.removal_state === 'pending')) ||
          (filter === 'removals' && d.removal_state === 'pending') ||
          (filter === 'visible' && p?.visible) ||
          (filter === 'unavailable' &&
            d.inventory_managed &&
            d.inventory_state !== 'available') ||
          (filter === 'archived' && d.status === 'archived')) &&
        norm(
          `${d.content.name} ${d.content.brand} ${d.source_snapshot.sku || ''}`,
        ).includes(norm(search))
      )
    })
    .sort(
      (a, b) =>
        Number(b.removal_state === 'pending') -
          Number(a.removal_state === 'pending') ||
        Number(b.status === 'pending') - Number(a.status === 'pending') ||
        a.content.name.localeCompare(b.content.name),
    )
  const visiblePage = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / 24) - 1),
  )
  const original = editing ? pubMap.get(editing.id) : null
  const retired =
    !!editing &&
    (editing.source_missing ||
      (!!editing.source_product_id && !editing.source_snapshot.active))
  const effective = editing
    ? retired
      ? 'unavailable'
      : editing.inventory_managed
        ? editing.inventory_state === 'available'
          ? 'available'
          : 'unavailable'
        : editing.content.availability
    : 'on_request'
  const changedWhileOpen =
    editing &&
    editing.revision > 0 &&
    drafts.find((d) => d.id === editing.id)?.revision !== editing.revision
  if (demo)
    return (
      <div className="state">
        <h1>Tienda online</h1>
        <p>
          Entrá con una cuenta de administrador para gestionar el catálogo real.
        </p>
      </div>
    )
  return (
    <div className="sf-workspace">
      <div className="page-heading">
        <div>
          <span className="eyebrow">LA CASA DEL PERFUME · TIENDA ONLINE</span>
          <h1>Tienda online</h1>
          <p className="muted">
            Elegí perfumes del inventario, revisá su ficha y publicá los que
            verá el cliente.
          </p>
        </div>
        <div className="sf-actions">
          <Button
            variant="secondary"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw size={17} />
            Actualizar
          </Button>
          <Button variant="secondary" onClick={() => void open()}>
            <Plus size={18} />
            Crear ficha independiente
          </Button>
          <Button
            onClick={() => {
              setInventorySearch('')
              setInventoryLimit(24)
              setInventoryPicker(true)
            }}
            disabled={loading}
          >
            <Globe size={18} />
            Elegir del inventario
          </Button>
        </div>
      </div>
      {!loading && links.length > 0 && (
        <CatalogLinks
          links={links}
          onNotice={setNotice}
          selected={selectedCatalog}
          onSelect={setSelectedCatalog}
        />
      )}
      {!loading && (
        <section className="sf-featured-summary" aria-label="Destacado actual">
          {featured && (
            <StorefrontPhoto
              photo={featured.content.images[0]}
              name={featured.content.name}
            />
          )}
          <div>
            <span className="eyebrow">DESTACADO DE PORTADA</span>
            <h2>
              {featured ? featured.content.name : 'Sin destacado visible'}
            </h2>
            {featured && (
              <span className="muted">
                {featured.content.brand} ·{' '}
                {Number(featured.content.size) || featured.content.size}{' '}
                {featured.content.unit}
              </span>
            )}
          </div>
          <Button onClick={chooseFeatured}>
            <Star size={17} />{' '}
            {featured ? 'Cambiar destacado' : 'Elegir destacado'}
          </Button>
        </section>
      )}
      <div className="sf-overview">
        <div>
          <Globe size={26} />
          <p>
            Una sola tienda.<strong>Vos decidís qué se publica.</strong>
          </p>
          <span>
            La disponibilidad se actualiza automáticamente. Los precios públicos
            y las bajas tienen revisión.
          </span>
        </div>
        <div className="sf-stats">
          <button
            onClick={() => {
              setFilter('pending')
              setPage(0)
            }}
          >
            <strong>{pendingCount}</strong>Por revisar
          </button>
          <button
            onClick={() => {
              setFilter('visible')
              setPage(0)
            }}
          >
            <strong>{publications.filter((p) => p.visible).length}</strong>
            Visibles
          </button>
          <button
            onClick={() => {
              setFilter('all')
              setPage(0)
            }}
          >
            <strong>{drafts.length}</strong>Referencias
          </button>
        </div>
      </div>
      {removals > 0 && (
        <div className="sf-notification" role="status">
          <Bell size={22} />
          <div>
            <strong>
              {removals === 1
                ? 'Hay una baja por decidir'
                : `Hay ${removals} bajas por decidir`}
            </strong>
            <p>
              Control retiró estos perfumes. Podés aceptar la baja o conservar
              la ficha como no disponible.
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              setFilter('removals')
              setPage(0)
            }}
          >
            Revisar bajas
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="sf-notice">
          {notice}
        </p>
      )}
      <div className="sf-filters">
        <Input
          label="Buscar en tienda online"
          type="search"
          placeholder="Nombre, marca o código"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(0)
          }}
        />
        <Select
          label="Mostrar"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
            setPage(0)
          }}
        >
          <option value="all">Todos los perfumes</option>
          <option value="inventory">Perfumes del inventario</option>
          <option value="pending">Por revisar</option>
          <option value="removals">Bajas por decidir</option>
          <option value="visible">Visibles para clientes</option>
          <option value="unavailable">Sin disponibilidad confirmada</option>
          <option value="archived">Archivados</option>
        </Select>
      </div>
      {error && <ErrorState message={error} retry={() => void refresh()} />}
      {loading ? (
        <LoadingState />
      ) : (
        <>
          <div className="sf-grid">
            {filtered
              .slice(visiblePage * 24, visiblePage * 24 + 24)
              .map((d) => {
                const p = pubMap.get(d.id)
                return (
                  <button
                    className="sf-card"
                    key={d.id}
                    onClick={() => void open(d.id)}
                    aria-label={`Editar ${d.content.name}`}
                  >
                    <StorefrontPhoto
                      photo={d.content.images[0]}
                      name={d.content.name}
                    />
                    <div className="sf-card-body">
                      <span className="sf-brand">{d.content.brand}</span>
                      <h2>{d.content.name}</h2>
                      <small>
                        {d.source_snapshot.sku || 'Referencia independiente'} ·{' '}
                        {Number(d.content.size) || d.content.size}{' '}
                        {d.content.unit}
                      </small>
                      <div className="sf-card-price">
                        {priceList(d)}
                        <ArrowUpRight size={18} />
                      </div>
                      <div className="sf-tags">
                        {p?.content.featured && (
                          <span className="sf-tag sf-featured-tag">
                            <Star size={12} /> Destacado
                          </span>
                        )}
                        <span
                          className={
                            d.removal_state === 'pending' ||
                            d.status === 'pending'
                              ? 'sf-tag sf-attention'
                              : 'sf-tag'
                          }
                        >
                          {d.removal_state === 'pending'
                            ? 'Baja por decidir'
                            : statusNames[d.status]}
                        </span>
                        <span
                          className={`sf-tag ${p?.visible ? 'sf-live' : ''}`}
                        >
                          {p?.visible ? 'Visible' : 'No visible'}
                        </span>
                      </div>
                      <p className="sf-stock">
                        {d.inventory_managed
                          ? stockNames[d.inventory_state]
                          : `Manual · ${availabilityNames[d.content.availability]}`}
                      </p>
                    </div>
                  </button>
                )
              })}
          </div>
          {!filtered.length && (
            <p className="state">No hay perfumes con esos filtros.</p>
          )}
          <div className="sf-pagination">
            <span>
              {filtered.length} perfumes · Página {visiblePage + 1} de{' '}
              {Math.max(1, Math.ceil(filtered.length / 24))}
            </span>
            <Button
              variant="secondary"
              disabled={!visiblePage}
              onClick={() => setPage(visiblePage - 1)}
            >
              Anterior
            </Button>
            <Button
              variant="secondary"
              disabled={(visiblePage + 1) * 24 >= filtered.length}
              onClick={() => setPage(visiblePage + 1)}
            >
              Siguiente
            </Button>
          </div>
        </>
      )}
      <Dialog
        open={!!editing}
        title="Preparar publicación"
        onClose={close}
        dismissible={!busy}
        className="sf-editor"
      >
        {editing && (
          <>
            <p className="sf-editor-caption">
              {editing.content.name || 'Nuevo perfume'} ·{' '}
              {original?.visible
                ? 'Visible para clientes'
                : 'No visible para clientes'}
            </p>
            {changedWhileOpen && (
              <p role="alert" className="sf-notification">
                Llegaron cambios mientras editabas. Cerrá y abrí esta ficha para
                revisar la última versión.
              </p>
            )}
            <div className="sf-editor-layout">
              <aside className="sf-source">
                <span className="eyebrow">DESDE LCP-CONTROL</span>
                <h3>
                  {retired
                    ? 'Baja del producto'
                    : editing.source_product_id
                      ? 'Datos de origen'
                      : 'Referencia independiente'}
                </h3>
                {editing.source_product_id || editing.source_missing ? (
                  <>
                    <StorefrontPhoto
                      photo={
                        editing.source_snapshot.image_path &&
                        !editing.source_missing
                          ? {
                              kind: 'control',
                              path: editing.source_snapshot.image_path,
                            }
                          : original?.content.images[0]
                      }
                      name={editing.source_snapshot.name || ''}
                    />
                    <dl>
                      <dt>Nombre</dt>
                      <dd>{editing.source_snapshot.name}</dd>
                      <dt>Marca</dt>
                      <dd>{editing.source_snapshot.brand}</dd>
                      <dt>Presentación</dt>
                      <dd>
                        {Number(editing.source_snapshot.size) ||
                          editing.source_snapshot.size}{' '}
                        {editing.source_snapshot.unit}
                      </dd>
                      <dt>Código</dt>
                      <dd>{editing.source_snapshot.sku}</dd>
                    </dl>
                    {editing.source_product_id && (
                      <Link
                        to={`${base}/products/${editing.source_product_id}/edit`}
                        onClick={(event) => {
                          if (dirty) {
                            event.preventDefault()
                            setEditError(
                              'Guarda o descarta los cambios antes de abrir el producto en Control.',
                            )
                          }
                        }}
                      >
                        Abrir producto en Control ↗
                      </Link>
                    )}
                    {retired ? (
                      <div className="sf-removal">
                        <p>
                          El producto{' '}
                          {editing.source_missing
                            ? 'fue eliminado'
                            : 'está inactivo'}{' '}
                          en Control. Su ficha no puede anunciar disponibilidad.
                        </p>
                        {editing.removal_state === 'pending' ? (
                          <>
                            <Button
                              variant="danger"
                              onClick={() =>
                                ask(
                                  'accept_removal',
                                  '¿Aceptar la baja?',
                                  'La ficha se retirará del catálogo y quedará archivada.',
                                  'Aceptar y retirar',
                                )
                              }
                            >
                              Aceptar baja
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() =>
                                ask(
                                  'keep_removed',
                                  '¿Conservar la ficha?',
                                  'Se conserva la última publicación como no disponible. Esta decisión no recupera el producto de Control.',
                                  'Conservar ficha',
                                )
                              }
                            >
                              No aceptar: conservar ficha
                            </Button>
                          </>
                        ) : (
                          <p>
                            {editing.removal_state === 'kept'
                              ? 'Decidiste conservar la ficha como no disponible.'
                              : 'La baja fue aceptada.'}
                          </p>
                        )}
                      </div>
                    ) : (
                      <>
                        <Button
                          variant="secondary"
                          onClick={() =>
                            ask(
                              'use_source',
                              '¿Usar los datos de Control?',
                              'Se reemplazarán nombre, marca, presentación, categoría, género y fotos. Se conservan tu precio público y descripción.',
                              'Usar datos',
                            )
                          }
                        >
                          Usar datos y foto
                        </Button>
                        {editing.source_version >
                          editing.reviewed_source_version && (
                          <Button
                            variant="ghost"
                            onClick={() =>
                              ask(
                                'dismiss_source',
                                '¿Conservar la versión editorial?',
                                'Se marcarán estos cambios de origen como revisados sin reemplazar el contenido público.',
                                'Conservar versión',
                              )
                            }
                          >
                            No aceptar estos cambios
                          </Button>
                        )}
                      </>
                    )}
                  </>
                ) : (
                  <p>
                    Se administra solo en el catálogo. Su disponibilidad es
                    manual.
                  </p>
                )}
                {original && (
                  <div className="sf-current">
                    <h4>Última publicación</h4>
                    <p>{original.content.name}</p>
                    {priceList(editing)}
                    {!!editing.revision && (
                      <OfferEditor
                        onBusyChange={setBusy}
                        key={`${editing.id}:${selectedCatalog}`}
                        draftId={editing.id}
                        links={links}
                        selected={selectedCatalog}
                        basePrice={(code) => tierPrice(editing, code)}
                        onSaved={(message) => {
                          setNotice(message)
                          void refresh()
                        }}
                      />
                    )}
                    <p>{availabilityNames[original.content.availability]}</p>
                  </div>
                )}
              </aside>
              <form
                ref={form}
                onSubmit={(e) => {
                  e.preventDefault()
                  void save()
                }}
              >
                <fieldset disabled={busy} className="sf-fields">
                  <div className="sf-form-grid">
                    <Input
                      label="Nombre público"
                      required
                      maxLength={200}
                      value={editing.content.name}
                      onChange={(e) => change('name', e.target.value)}
                    />
                    <Input
                      label="Marca pública"
                      required
                      maxLength={100}
                      value={editing.content.brand}
                      onChange={(e) => change('brand', e.target.value)}
                    />
                    <Input
                      label={
                        selectedCatalog && selectedCatalog !== 'menudeo'
                          ? `${links.find((l) => l.code === selectedCatalog)?.name} desde inventario (USD)`
                          : editing.source_product_id
                            ? 'Menudeo desde inventario (USD)'
                            : 'Menudeo (USD)'
                      }
                      type="number"
                      min={0}
                      max={100000}
                      step="0.01"
                      required
                      readOnly={
                        !!editing.source_product_id ||
                        (!!selectedCatalog && selectedCatalog !== 'menudeo')
                      }
                      value={
                        editing.source_product_id ||
                        (selectedCatalog && selectedCatalog !== 'menudeo')
                          ? tierPrice(editing, selectedCatalog || 'menudeo')
                          : editing.content.price
                      }
                      onChange={(e) => change('price', Number(e.target.value))}
                    />
                    <Input
                      label="Presentación"
                      maxLength={30}
                      value={editing.content.size}
                      onChange={(e) => change('size', e.target.value)}
                    />
                    <Select
                      label="Unidad"
                      value={editing.content.unit}
                      onChange={(e) => change('unit', e.target.value)}
                    >
                      <option value="ml">ml</option>
                      <option value="oz">oz</option>
                      <option value="set">Set</option>
                    </Select>
                    <Select
                      label="Tipo"
                      value={editing.content.category}
                      onChange={(e) => change('category', e.target.value)}
                    >
                      <option value="arabian">Árabe</option>
                      <option value="designer">Diseñador</option>
                      <option value="niche">Nicho</option>
                      <option value="gourmand">Gourmand</option>
                      <option value="other">Otra fragancia</option>
                    </Select>
                    <Select
                      label="Dirigido a"
                      value={editing.content.gender}
                      onChange={(e) => change('gender', e.target.value)}
                    >
                      <option value="female">Para ella</option>
                      <option value="male">Para él</option>
                      <option value="unisex">Unisex</option>
                    </Select>
                  </div>
                  <section className="sf-availability">
                    <h3>Disponibilidad en la web</h3>
                    {editing.source_product_id && !retired && (
                      <label className="sf-check">
                        <input
                          type="checkbox"
                          checked={editing.inventory_managed}
                          onChange={(e) =>
                            option('inventory_managed', e.target.checked)
                          }
                        />
                        Actualizar automáticamente desde el inventario
                      </label>
                    )}
                    <p>
                      {editing.inventory_managed
                        ? `${stockNames[editing.inventory_state]}. Se consideran Tienda y Bodega; el cliente nunca recibe cantidades.`
                        : 'La disponibilidad se administra en esta ficha.'}
                    </p>
                    {!editing.inventory_managed && !retired && (
                      <Select
                        label="Disponibilidad manual"
                        value={editing.content.availability}
                        onChange={(e) => change('availability', e.target.value)}
                      >
                        <option value="available">Disponible</option>
                        <option value="unavailable">No disponible</option>
                        <option value="on_request">Por confirmar</option>
                      </Select>
                    )}
                    {editing.inventory_managed &&
                      editing.inventory_state === 'unknown' && (
                        <p>
                          Falta confirmar el conteo. La web no anunciará
                          disponibilidad hasta tener existencias confirmadas.
                        </p>
                      )}
                    {!retired && (
                      <label className="sf-check">
                        <input
                          type="checkbox"
                          checked={editing.hide_unavailable}
                          onChange={(e) =>
                            option('hide_unavailable', e.target.checked)
                          }
                        />
                        Ocultar cuando no esté disponible y volver a mostrar al
                        reponer
                      </label>
                    )}
                    <small>
                      Guardar prepara estas opciones. Publicar las aplica.
                      Ocultar o archivar manualmente impide que una reposición
                      lo publique por sí sola.
                    </small>
                  </section>
                  <label className="field">
                    <span>Descripción</span>
                    <textarea
                      rows={3}
                      maxLength={1500}
                      value={editing.content.description}
                      onChange={(e) => change('description', e.target.value)}
                    />
                  </label>
                  <section className="sf-photos">
                    <h3>Fotografías</h3>
                    <p>Hasta 4 fotos · JPG, PNG o WebP · 5 MB cada una</p>
                    <div className="sf-photo-grid">
                      {editing.content.images.map((photo, i) => (
                        <div key={`${photo.path}-${i}`}>
                          <StorefrontPhoto
                            photo={photo}
                            name={`Fotografía ${i + 1}`}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            aria-label={`Quitar fotografía ${i + 1}`}
                            onClick={() =>
                              change(
                                'images',
                                editing.content.images.filter(
                                  (_, index) => index !== i,
                                ),
                              )
                            }
                          >
                            <X size={14} />
                            Quitar
                          </Button>
                        </div>
                      ))}
                      {pending.map((p, i) => (
                        <div key={p.url}>
                          <StorefrontPhoto
                            name="Fotografía nueva"
                            preview={p.url}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => {
                              URL.revokeObjectURL(p.url)
                              setPending((items) =>
                                items.filter((_, index) => index !== i),
                              )
                              setDirty(true)
                            }}
                          >
                            Quitar nueva foto
                          </Button>
                        </div>
                      ))}
                    </div>
                    <label className="sf-upload">
                      <ImagePlus size={18} />
                      Agregar fotografía
                      <input
                        aria-label="Agregar fotografía"
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        multiple
                        disabled={
                          editing.content.images.length + pending.length >= 4
                        }
                        onChange={(e) => {
                          const files = Array.from(e.target.files || [])
                          e.target.value = ''
                          if (
                            files.length +
                              pending.length +
                              editing.content.images.length >
                            4
                          ) {
                            setEditError('Se admiten hasta cuatro fotografías.')
                            return
                          }
                          if (
                            files.some(
                              (f) =>
                                ![
                                  'image/jpeg',
                                  'image/png',
                                  'image/webp',
                                ].includes(f.type) || f.size > 5 * 1024 * 1024,
                            )
                          ) {
                            setEditError('Usa JPG, PNG o WebP de hasta 5 MB.')
                            return
                          }
                          setPending((items) => [
                            ...items,
                            ...files.map((file) => ({
                              file,
                              url: URL.createObjectURL(file),
                            })),
                          ])
                          setDirty(true)
                        }}
                      />
                    </label>
                  </section>
                </fieldset>
                {editError && (
                  <p role="alert" className="sf-notice">
                    {editError}
                  </p>
                )}
                <div className="sf-editor-footer">
                  <div>
                    {original?.listed && (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          ask(
                            'hide',
                            '¿Ocultar este perfume?',
                            'Dejará de aparecer aunque vuelva a tener existencias. Podés publicarlo nuevamente cuando quieras.',
                            'Ocultar',
                          )
                        }
                      >
                        Ocultar
                      </Button>
                    )}
                    {editing.revision > 0 && editing.status !== 'archived' && (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          ask(
                            'archive',
                            '¿Archivar este perfume?',
                            'Se retirará del público y quedará guardado en Archivados.',
                            'Archivar',
                          )
                        }
                      >
                        Archivar
                      </Button>
                    )}
                  </div>
                  <div>
                    <Button type="submit" variant="secondary" disabled={busy}>
                      Guardar borrador
                    </Button>
                    <Button
                      type="button"
                      disabled={
                        busy || (retired && editing.removal_state !== 'kept')
                      }
                      onClick={() => {
                        if (form.current?.reportValidity()) {
                          setEditError('')
                          setReview(true)
                        }
                      }}
                    >
                      <Eye size={17} />
                      Revisar publicación
                    </Button>
                  </div>
                </div>
              </form>
            </div>
          </>
        )}
      </Dialog>
      <Dialog
        open={review && !!editing}
        title="Así lo verá el cliente"
        onClose={() => {
          if (!busy) setReview(false)
        }}
        dismissible={!busy}
        className="sf-review"
      >
        {editing && (
          <>
            <StorefrontPhoto
              photo={editing.content.images[0]}
              preview={
                !editing.content.images.length ? pending[0]?.url : undefined
              }
              name={editing.content.name}
            />
            <p className="sf-brand">{editing.content.brand}</p>
            <h3>{editing.content.name}</h3>
            <p>
              {Number(editing.content.size) || editing.content.size}{' '}
              {editing.content.unit}
            </p>
            <strong className="sf-preview-price">
              {price(publicPrice(editing, selectedCatalog || 'menudeo'))}
            </strong>
            <p>{availabilityNames[effective]}</p>
            <p>{editing.content.description}</p>
            {editing.hide_unavailable &&
              effective !== 'available' &&
              !retired && (
                <p className="sf-notification">
                  Quedará publicado pero oculto hasta que tenga disponibilidad.
                </p>
              )}
            <p>
              Esta publicación reemplazará la versión anterior. El precio de
              Control no cambia.
            </p>
            {editError && <p role="alert">{editError}</p>}
            <div className="sf-actions">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setReview(false)}
              >
                Seguir editando
              </Button>
              <Button disabled={busy} onClick={() => void save(true)}>
                {busy ? 'Publicando…' : 'Publicar perfume'}
              </Button>
            </div>
          </>
        )}
      </Dialog>
      <Dialog
        open={inventoryPicker}
        title="Elegir del inventario"
        onClose={() => setInventoryPicker(false)}
        className="sf-feature-picker"
      >
        <Input
          label="Buscar perfume del inventario"
          type="search"
          placeholder="Nombre, marca o código"
          value={inventorySearch}
          onChange={(e) => {
            setInventorySearch(e.target.value)
            setInventoryLimit(24)
          }}
        />
        <div className="sf-feature-options">
          {inventoryCandidates.slice(0, inventoryLimit).map((d) => (
            <button
              type="button"
              className="sf-feature-option"
              key={d.id}
              onClick={() => {
                setInventoryPicker(false)
                void open(d.id)
              }}
              aria-label={`Elegir ${d.content.name}`}
            >
              <StorefrontPhoto
                photo={d.content.images[0]}
                name={d.content.name}
              />
              <span>
                <small>
                  {d.content.brand} · {d.source_snapshot.sku}
                </small>
                <strong>{d.content.name}</strong>
                <small>
                  {Number(d.content.size) || d.content.size} {d.content.unit} ·{' '}
                  {statusNames[d.status]}
                </small>
              </span>
              <ArrowUpRight size={18} />
            </button>
          ))}
        </div>
        {!inventoryCandidates.length && (
          <p className="state">
            No hay perfumes del inventario con esos filtros.
          </p>
        )}
        {inventoryCandidates.length > inventoryLimit && (
          <Button
            variant="secondary"
            onClick={() => setInventoryLimit(inventoryLimit + 24)}
          >
            Ver más perfumes
          </Button>
        )}
      </Dialog>
      <Dialog
        open={featurePicker}
        title="Elegir destacado"
        onClose={() => {
          if (!busy) setFeaturePicker(false)
        }}
        dismissible={!busy}
        className="sf-feature-picker"
      >
        <Input
          label="Buscar perfume para portada"
          type="search"
          placeholder="Nombre, marca o código"
          value={featureSearch}
          onChange={(e) => {
            setFeatureSearch(e.target.value)
            setFeatureLimit(24)
          }}
        />
        <div
          className="sf-feature-options"
          role="radiogroup"
          aria-label="Perfume destacado"
        >
          {featureCandidates.slice(0, featureLimit).map((d) => {
            const p = pubMap.get(d.id)!
            return (
              <label className="sf-feature-option" key={d.id}>
                <input
                  type="radio"
                  name="storefront-featured"
                  value={d.id}
                  checked={featureId === d.id}
                  disabled={busy}
                  onChange={() => setFeatureId(d.id)}
                  aria-label={`${p.content.brand} ${p.content.name}`}
                />
                <StorefrontPhoto
                  photo={p.content.images[0]}
                  name={p.content.name}
                />
                <span>
                  <small>{p.content.brand}</small>
                  <strong>{p.content.name}</strong>
                  <small>
                    {Number(p.content.size) || p.content.size} {p.content.unit}{' '}
                    · {d.source_snapshot.sku}
                  </small>
                </span>
                <Star
                  size={19}
                  aria-hidden="true"
                  fill={featureId === d.id ? 'currentColor' : 'none'}
                />
              </label>
            )
          })}
        </div>
        {!featureCandidates.length && (
          <p className="state">No hay perfumes publicados con esos filtros.</p>
        )}
        {featureCandidates.length > featureLimit && (
          <Button
            variant="secondary"
            onClick={() => setFeatureLimit(featureLimit + 24)}
          >
            Ver más perfumes
          </Button>
        )}
        {featureError && <p role="alert">{featureError}</p>}
        <div className="sf-feature-footer sf-actions">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setFeaturePicker(false)}
          >
            Cancelar
          </Button>
          <Button
            disabled={busy || !featureId || featureId === featured?.id}
            onClick={() => void saveFeatured()}
          >
            <Star size={17} />
            {busy ? 'Guardando…' : 'Guardar destacado'}
          </Button>
        </div>
      </Dialog>
      <ConfirmDialog
        open={!!confirmation}
        title={confirmation?.title || ''}
        confirmLabel={confirmation?.label || 'Confirmar'}
        busy={busy}
        error={editError}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void confirmAction()}
      >
        {confirmation?.text}
      </ConfirmDialog>
    </div>
  )
}

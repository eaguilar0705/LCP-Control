import { AlertCircle, Coins } from 'lucide-react'
import { ProductCostDialog } from './ProductCostDialog'
import { ScanButton } from '../scanner/ScanButton'
import { ProductStockEditor } from './ProductStockEditor'
import { can } from '../../lib/permissions'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Button,
  Card,
  Dialog,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { errorMessage, issuesByField } from '../../lib/errors'
import {
  labels,
  type PricingInput,
  type Product,
  type PriceTier,
} from '../../lib/domain'
import {
  applyPricing,
  priceTierLabels,
  priceTiers,
  tierQuote,
} from '../../lib/pricing'
import {
  nioFromUsd,
  optimizeProductImage,
  pricingInput,
  productInput,
  productInputSchema,
} from './product'
import { formatCurrency } from '../../lib/format'
import { PricingFields } from '../pricing/PricingFields'

export function ProductEditorPage() {
  const { role, demo } = useAccess()
  const { id } = useParams()
  if (!can(role, 'product.manage') && !demo)
    return (
      <ErrorState message="Solo los administradores pueden editar el catálogo." />
    )
  return <ProductLoader key={id ?? 'new'} />
}
// Un perfume nuevo todavía no tiene porcentajes; la consulta sólo dice si la
// base ya puede guardarlos.
const NEW_PRODUCT = '00000000-0000-0000-0000-000000000000'
/**
 * Una dirección escrita a mano o de un perfume que ya no existe: se dice así y
 * se ofrece volver, en vez de un «Reintentar» que nunca va a funcionar.
 */
function ProductNotFound() {
  const { base } = useAccess()
  return (
    <div className="state error" role="alert">
      <AlertCircle size={28} />
      <h1>Perfume no encontrado</h1>
      <p>La dirección no corresponde a ningún perfume del catálogo.</p>
      <Link className="button button-secondary" to={`${base}/inventory`}>
        Volver al inventario
      </Link>
    </div>
  )
}
function ProductLoader() {
  const { id } = useParams()
  const [costMessage, setCostMessage] = useState('')
  const { productService, settingsService } = useServices()
  // Los precios de un perfume existente se editan en Contabilidad; aquí sólo
  // un perfume nuevo necesita porcentajes y tasa para salir con precio.
  const load = useCallback(async () => {
    const products = await productService.listProducts()
    // Un perfume que no está en el catálogo (una dirección escrita a mano o
    // de un perfume borrado) no se sigue consultando: la base respondería con
    // un error técnico en lugar de «no encontrado».
    if (id) return { products, pricing: null, rate: null }
    const [pricing, rate] = await Promise.all([
      productService.listPricing(NEW_PRODUCT),
      settingsService.getExchangeRate(),
    ])
    return { products, pricing, rate: rate?.usdToNio ?? null }
  }, [id, productService, settingsService])
  const { data, loading, error, retry } = useQuery(load)
  if (loading) return <LoadingState />
  if (error) return <ErrorState message={error} retry={retry} />
  const product = data?.products.find((p) => p.id === id)
  if (id && !product) return <ProductNotFound />
  return (
    <>
      {costMessage && (
        <p role="status" className="workspace-feedback">
          {costMessage}
        </p>
      )}
      <ProductForm
        key={`${id ?? 'new'}:${product?.revision}`}
        product={product}
        brands={[...new Set(data?.products.map((p) => p.brand))]}
        pricing={data?.pricing?.available ? pricingInput() : null}
        rate={data?.rate ?? null}
        onCostRecorded={(message) => {
          setCostMessage(message)
          retry()
        }}
      />
    </>
  )
}
function ProductForm({
  product,
  brands,
  pricing,
  rate,
  onCostRecorded,
}: {
  product?: Product
  brands: string[]
  /**
   * Sólo en un perfume nuevo; `null` al editar (sus precios viven en
   * Contabilidad) o mientras la base no guarde porcentajes.
   */
  pricing: PricingInput | null
  /**
   * El precio en córdobas se calcula con esta tasa. Sin ella no se puede fijar
   * un precio, así que el formulario lo dice y no deja guardar a ciegas.
   */
  rate: number | null
  onCostRecorded: (message: string) => void
}) {
  const { base, demo, role } = useAccess()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { productService } = useServices()
  const [value, setValue] = useState(() => ({
    ...productInput(product),
    manufacturerBarcode:
      product?.manufacturerBarcode ?? params.get('barcode') ?? '',
    ...(pricing ? { pricing } : {}),
  }))
  const [initialValue] = useState(() => JSON.stringify(value))
  const [costOpen, setCostOpen] = useState(false)
  // Lo que se ve y lo que se guarda: las listas con porcentaje ya calculadas.
  const shownPrices = applyPricing(value.prices, value.pricing, rate)
  /**
   * Una lista que deja de tener porcentaje conserva el último precio
   * calculado como precio a mano, en lugar de volver a uno viejo.
   */
  function changePricing(next: PricingInput) {
    setValue((current) => {
      const prices = applyPricing(current.prices, current.pricing, rate)
      // A mano manda el dólar: el córdoba vuelve a salir de la tasa, igual
      // que lo guardará la base.
      for (const tier of priceTiers) {
        if (tierQuote(next, tier, rate)) continue
        // Sin tasa no hay dólar calculado: queda el que ya tenía la lista.
        const usd = Number.isFinite(prices[tier].USD)
          ? prices[tier].USD
          : current.prices[tier].USD
        prices[tier] = { USD: usd, NIO: nioFromUsd(usd, rate) }
      }
      return { ...current, prices, pricing: next }
    })
  }
  const [file, setFile] = useState<Blob | null>(null)
  const unsaved = file !== null || JSON.stringify(value) !== initialValue
  const [preview, setPreview] = useState(product?.imageUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Un aviso único no dice qué campo falta entre nueve datos y seis precios.
  // La clave es la ruta del dato («name», «prices.vip.USD»). Los avisos
  // aparecen al intentar guardar y desde entonces siguen a lo que se escribe:
  // se van en cuanto el dato se corrige, sin esperar a otro «Guardar».
  const [checked, setChecked] = useState(false)
  const parsed = productInputSchema.safeParse({
    ...value,
    prices: shownPrices,
  })
  const fieldErrors =
    checked && !parsed.success ? issuesByField(parsed.error.issues) : {}
  const invalid = Object.keys(fieldErrors).length
  const form = useRef<HTMLFormElement>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const back = `${base}/inventory`
  useEffect(() => {
    return () => {
      if (preview.startsWith('blob:')) URL.revokeObjectURL(preview)
    }
  }, [preview])
  function update<K extends keyof typeof value>(
    key: K,
    next: (typeof value)[K],
  ) {
    setValue((v) => ({ ...v, [key]: next }))
  }
  async function choose(file?: File) {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const optimized = await optimizeProductImage(file)
      setFile(optimized)
      setPreview(URL.createObjectURL(optimized))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos leer esa imagen.')
    } finally {
      setBusy(false)
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy || demo) return
    if (!parsed.success) {
      setChecked(true)
      setError('')
      // El primer campo con problema puede estar fuera de la pantalla.
      requestAnimationFrame(() =>
        form.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?.focus(),
      )
      return
    }
    setBusy(true)
    setError('')
    try {
      let imagePath = value.imagePath
      if (file) {
        imagePath = await productService.uploadProductImage(file)
        update('imagePath', imagePath)
        setFile(null) // Keep this path for a retry if the product save fails.
      }
      const savedId = await productService.saveProduct({
        ...parsed.data,
        imagePath,
      })
      navigate(product ? back : `${base}/products/${savedId}/edit`, {
        state: { message: 'Perfume guardado.' },
      })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  async function remove() {
    if (!product || busy || demo) return
    setBusy(true)
    setError('')
    try {
      const result = await productService.removeProduct(
        product.id,
        product.revision ?? 0,
      )
      navigate(`${base}/inventory`, {
        state: {
          message:
            result === 'archived'
              ? 'Perfume desactivado. Su historial se conserva.'
              : 'Perfume eliminado.',
        },
      })
    } catch (e) {
      setError(errorMessage(e))
      setConfirmRemove(false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{product ? 'Editar perfume' : 'Nuevo perfume'}</h1>
          <p className="muted">
            {product?.barcode ?? 'El código interno se asignará al guardar.'}
          </p>
        </div>
        <div className="form-actions">
          {product && (demo || can(role, 'product.edit_cost')) && (
            <Button
              type="button"
              variant="secondary"
              disabled={busy || demo || unsaved || !product.active}
              onClick={() => setCostOpen(true)}
            >
              <Coins size={18} />
              Costo de inventario
            </Button>
          )}
          <Link className="button button-secondary" to={back}>
            Volver al inventario
          </Link>
        </div>
      </div>
      {demo && (
        <p className="page-feedback">
          Vista de ejemplo. Inicia sesión como administrador para guardar
          cambios.
        </p>
      )}
      <form onSubmit={save} ref={form} noValidate>
        <fieldset disabled={busy} className="form-fields product-editor">
          <Card className="form-card">
            <h2>Foto del perfume</h2>
            <div className="editor-photo">
              {preview ? (
                <img src={preview} alt="Vista previa del perfume" />
              ) : (
                <p>Sin fotografía</p>
              )}
            </div>
            <Input
              label="Cambiar imagen"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => {
                void choose(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            <small className="muted">JPG, PNG o WebP</small>
            {file && (
              <p className="optimized-photo-note">
                WebP · {Math.max(1, Math.round(file.size / 1024))} KB
              </p>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setFile(null)
                setPreview('')
                update('imagePath', null)
              }}
            >
              Quitar foto
            </Button>
          </Card>
          <Card className="form-card">
            <h2>Datos del producto</h2>
            <div className="form-grid">
              <Input
                label="Nombre del perfume"
                required
                maxLength={200}
                error={fieldErrors.name}
                value={value.name}
                onChange={(e) => update('name', e.target.value)}
              />
              <Input
                label="Marca"
                required
                maxLength={100}
                error={fieldErrors.brand}
                list="product-brands"
                value={value.brand}
                onChange={(e) => update('brand', e.target.value)}
              />
              <datalist id="product-brands">
                {brands.map((brand) => (
                  <option key={brand} value={brand} />
                ))}
              </datalist>
              <Select
                label="Categoría"
                value={value.category}
                onChange={(e) =>
                  update('category', e.target.value as typeof value.category)
                }
              >
                {Object.entries(labels.category).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </Select>
              <Select
                label="Género"
                value={value.gender}
                onChange={(e) =>
                  update('gender', e.target.value as typeof value.gender)
                }
              >
                {Object.entries(labels.gender).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </Select>
              <Input
                label="Tamaño (vacío si falta confirmar)"
                error={fieldErrors.size}
                type="number"
                min={0.001}
                max={99999}
                step={0.001}
                value={value.size ?? ''}
                onChange={(e) =>
                  update(
                    'size',
                    e.target.value === '' ? null : e.target.valueAsNumber,
                  )
                }
              />
              <Select
                label="Unidad"
                value={value.unit}
                onChange={(e) => update('unit', e.target.value as 'oz' | 'ml')}
              >
                <option value="oz">Onzas (oz)</option>
                <option value="ml">Mililitros (ml)</option>
              </Select>
              <div className="search-with-scan">
                <Input
                  label="Código del fabricante (EAN / UPC)"
                  error={fieldErrors.manufacturerBarcode}
                  inputMode="numeric"
                  maxLength={14}
                  value={value.manufacturerBarcode}
                  onChange={(e) =>
                    update('manufacturerBarcode', e.target.value)
                  }
                />
                <ScanButton
                  manufacturer
                  onCode={(code) => update('manufacturerBarcode', code)}
                />
              </div>
              <Input
                label="Mínimo de inventario"
                error={fieldErrors.minimumStock}
                type="number"
                min={0}
                max={1000000}
                step={1}
                required
                value={
                  Number.isNaN(value.minimumStock) ? '' : value.minimumStock
                }
                onChange={(e) => update('minimumStock', e.target.valueAsNumber)}
              />
              <Select
                label="Estado"
                value={value.active ? 'active' : 'inactive'}
                onChange={(e) => update('active', e.target.value === 'active')}
              >
                <option value="active">Activo</option>
                <option value="inactive">Inactivo</option>
              </Select>
            </div>
          </Card>
          {!product && (
            <Card className="form-card product-prices">
              <h2>Listas de precios</h2>
              {rate === null && (
                <p className="inline-error" role="alert">
                  Falta el tipo de cambio. Regístralo en Negocio.
                </p>
              )}
              {!value.pricing && (
                <p className="muted pricing-unavailable">
                  Falta aplicar la actualización de precios en la base de datos.
                </p>
              )}
              {value.pricing ? (
                <PricingFields
                  pricing={value.pricing}
                  onChange={changePricing}
                  rate={rate}
                  prices={shownPrices}
                  errors={fieldErrors}
                  manual={(tier) => {
                    const nio = value.prices[tier].NIO
                    // Un dólar vacío ya deja su propio aviso en el campo;
                    // repetirlo bajo el córdoba sería marcar dos veces lo mismo.
                    const usdError = fieldErrors[`prices.${tier}.USD`]
                    const nioError = usdError
                      ? undefined
                      : fieldErrors[`prices.${tier}.NIO`]
                    return (
                      <div className="pricing-manual">
                        <Input
                          label={`${priceTierLabels[tier]} USD`}
                          error={usdError}
                          type="number"
                          min={0.01}
                          max={10000000}
                          step={0.01}
                          required
                          value={
                            Number.isNaN(value.prices[tier].USD)
                              ? ''
                              : value.prices[tier].USD
                          }
                          onChange={(e) => {
                            const usd = e.target.valueAsNumber
                            update('prices', {
                              ...value.prices,
                              [tier]: { USD: usd, NIO: nioFromUsd(usd, rate) },
                            })
                          }}
                        />
                        <small className={nioError ? 'field-error' : undefined}>
                          {nioError ??
                            (Number.isNaN(nio)
                              ? '—'
                              : formatCurrency(nio, 'NIO'))}
                        </small>
                      </div>
                    )
                  }}
                />
              ) : (
                (Object.keys(priceTierLabels) as PriceTier[]).map((tier) => {
                  const nio = value.prices[tier].NIO
                  // Un dólar vacío ya deja su propio aviso en el campo; repetirlo
                  // bajo el córdoba sería marcar dos veces el mismo descuido.
                  const usdError = fieldErrors[`prices.${tier}.USD`]
                  const nioError = usdError
                    ? undefined
                    : fieldErrors[`prices.${tier}.NIO`]
                  return (
                    <div className="product-price-row" key={tier}>
                      <h3>{priceTierLabels[tier]}</h3>
                      <Input
                        label={`${priceTierLabels[tier]} USD`}
                        error={usdError}
                        type="number"
                        min={0.01}
                        max={10000000}
                        step={0.01}
                        required
                        value={
                          Number.isNaN(value.prices[tier].USD)
                            ? ''
                            : value.prices[tier].USD
                        }
                        onChange={(e) => {
                          const usd = e.target.valueAsNumber
                          update('prices', {
                            ...value.prices,
                            [tier]: { USD: usd, NIO: nioFromUsd(usd, rate) },
                          })
                        }}
                      />
                      <div
                        className={`product-price-derived ${nioError ? 'field-invalid' : ''}`}
                      >
                        <span>{priceTierLabels[tier]} NIO</span>
                        <strong>
                          {Number.isNaN(nio) ? '—' : formatCurrency(nio, 'NIO')}
                        </strong>
                        {nioError && (
                          <small className="field-error">{nioError}</small>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </Card>
          )}
        </fieldset>
        {(invalid > 0 || error) && (
          <p role="alert" className="inline-error">
            {invalid > 0
              ? `Revisa ${invalid === 1 ? 'el campo marcado' : 'los campos marcados'} antes de guardar.`
              : error}
          </p>
        )}
        <div className="form-actions">
          <Button type="submit" disabled={busy || demo} aria-busy={busy}>
            {busy ? 'Guardando…' : 'Guardar perfume'}
          </Button>
          {product && (
            <Button
              type="button"
              variant="secondary"
              disabled={busy || demo}
              onClick={() => setConfirmRemove(true)}
            >
              Retirar perfume
            </Button>
          )}
        </div>
      </form>
      {costOpen && product && (
        <ProductCostDialog
          productId={product.id}
          onClose={() => setCostOpen(false)}
          onRecorded={(message) => {
            setCostOpen(false)
            onCostRecorded(message)
          }}
        />
      )}
      {product ? (
        <section id="cantidades-perfume" tabIndex={-1}>
          <ProductStockEditor product={product} disabled={busy} />
        </section>
      ) : (
        <p className="page-feedback">
          Guarda el perfume para registrar sus cantidades en Tienda y Bodega.
        </p>
      )}
      {confirmRemove && (
        <Dialog
          open
          title="Retirar perfume"
          onClose={() => {
            if (!busy) setConfirmRemove(false)
          }}
        >
          <p>
            Se eliminará si fue creado por error y no tiene historial. Si
            aparece en documentos, movimientos o en la importación inicial,
            quedará inactivo y podrás reactivarlo.
          </p>
          <p>Un perfume con existencias debe registrar primero su salida.</p>
          <div className="form-actions">
            <Button disabled={busy} onClick={() => void remove()}>
              Confirmar retiro
            </Button>
            <Button
              disabled={busy}
              variant="secondary"
              onClick={() => setConfirmRemove(false)}
            >
              Cancelar
            </Button>
          </div>
        </Dialog>
      )}
    </>
  )
}

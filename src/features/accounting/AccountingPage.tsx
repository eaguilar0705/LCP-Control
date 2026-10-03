import { useCallback, useState, type FormEvent } from 'react'
import { Pencil } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
} from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { errorMessage, issuesByField } from '../../lib/errors'
import { matchesSearch } from '../../lib/search'
import { formatCurrency } from '../../lib/format'
import type { PricingInput, Product, ProductPricing } from '../../lib/domain'
import {
  applyPricing,
  priceTierLabels,
  priceTiers,
  samePricing,
} from '../../lib/pricing'
import { pricingInput, pricingInputSchema } from '../products/product'
import { PricingFields } from '../pricing/PricingFields'
import { PriceMargin } from '../pricing/PriceMargin'
import { PriceHistory } from '../pricing/PriceHistory'
import '../../styles/accounting.css'

interface PricedProduct {
  product: Product
  pricing: ProductPricing | undefined
}

/**
 * Contabilidad: el precio de compra de cada perfume y el porcentaje de
 * ganancia de cada tipo de cliente. Precio de venta = compra + porcentaje.
 */
export function AccountingPage() {
  const { demo } = useAccess()
  const { productService, settingsService } = useServices()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<PricedProduct | null>(null)
  const [message, setMessage] = useState('')
  const load = useCallback(async () => {
    const [products, pricing, rate] = await Promise.all([
      productService.listProducts(),
      productService.listPricing(),
      settingsService.getExchangeRate(),
    ])
    return { products, pricing, rate: rate?.usdToNio ?? null }
  }, [productService, settingsService])
  const { data, loading, error, retry } = useQuery(load)
  if (loading) return <LoadingState />
  if (error || !data)
    return <ErrorState message={error ?? 'Sin datos.'} retry={retry} />
  const byProduct = new Map(
    data.pricing.rows.map((row) => [row.productId, row]),
  )
  const rows: PricedProduct[] = data.products
    .filter((product) =>
      matchesSearch(
        `${product.name} ${product.brand} ${product.barcode}`,
        query,
      ),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'es'))
    .map((product) => ({ product, pricing: byProduct.get(product.id) }))
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Contabilidad</h1>
        </div>
      </div>
      {message && (
        <p role="status" className="workspace-feedback">
          {message}
        </p>
      )}
      <Card className="accounting-card">
        <div className="section-heading">
          <h2>Precios por perfume</h2>
        </div>
        {data.rate === null && (
          <p className="inline-error" role="alert">
            Falta el tipo de cambio. Regístralo en Negocio.
          </p>
        )}
        {!data.pricing.available && (
          <p className="inline-error" role="alert">
            Falta aplicar la actualización de precios en la base de datos.
          </p>
        )}
        <Input
          label="Buscar perfume"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {rows.length === 0 ? (
          <EmptyState />
        ) : (
          <div
            className="accounting-table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Precios por perfume"
          >
            <table className="accounting-table">
              <caption className="sr-only">Precios por perfume</caption>
              <thead>
                <tr>
                  <th scope="col">Perfume</th>
                  <th scope="col" className="num">
                    Precio de compra
                  </th>
                  {priceTiers.map((tier) => (
                    <th scope="col" className="num" key={tier}>
                      {priceTierLabels[tier]}
                    </th>
                  ))}
                  <th scope="col">
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <PriceRow
                    key={row.product.id}
                    row={row}
                    disabled={!data.pricing.available}
                    onEdit={() => {
                      setMessage('')
                      setEditing(row)
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && (
        <PricingDialog
          row={editing}
          rate={data.rate}
          readOnly={demo}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setMessage(`Precios de «${editing.product.name}» guardados.`)
            setEditing(null)
            retry()
          }}
        />
      )}
    </>
  )
}

function PriceRow({
  row,
  disabled,
  onEdit,
}: {
  row: PricedProduct
  disabled: boolean
  onEdit: () => void
}) {
  const { product, pricing } = row
  const purchase = pricing?.purchasePrice
  return (
    <tr>
      <th scope="row">
        {product.name}
        <small>
          {product.brand} · {product.barcode}
        </small>
        {!product.active && <Badge>Inactivo</Badge>}
      </th>
      <td className="num">
        {purchase == null
          ? '—'
          : formatCurrency(purchase, pricing!.purchaseCurrency)}
      </td>
      {priceTiers.map((tier) => {
        const markup = pricing?.markups[tier]
        const price = product.prices?.[tier]
        return (
          <td className="num" key={tier}>
            {price ? formatCurrency(price.USD, 'USD') : '—'}
            {price && <small>{formatCurrency(price.NIO, 'NIO')}</small>}
            <small>{markup == null ? 'A mano' : `${markup} %`}</small>
          </td>
        )
      })}
      <td>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          aria-label={`Editar precios de ${product.name}`}
          onClick={onEdit}
        >
          <Pencil size={16} />
          Editar
        </Button>
      </td>
    </tr>
  )
}

function PricingDialog({
  row,
  rate,
  readOnly,
  onClose,
  onSaved,
}: {
  row: PricedProduct
  rate: number | null
  readOnly: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const { productService } = useServices()
  const { product } = row
  const [initial] = useState(() => pricingInput(row.pricing))
  const [pricing, setPricing] = useState<PricingInput>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [checked, setChecked] = useState(false)
  const prices = product.prices ?? {
    emprendedor: { USD: NaN, NIO: NaN },
    vip: { USD: NaN, NIO: NaN },
    premium: { USD: NaN, NIO: NaN },
  }
  const parsed = pricingInputSchema.safeParse(pricing)
  const errors =
    checked && !parsed.success
      ? Object.fromEntries(
          Object.entries(issuesByField(parsed.error.issues)).map(
            ([key, value]) => [`pricing.${key}`, value],
          ),
        )
      : {}
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy || readOnly) return
    if (!parsed.success) {
      setChecked(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      await productService.savePricing([
        {
          productId: product.id,
          revision: product.revision ?? 0,
          pricing: parsed.data,
        },
      ])
      onSaved()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      title={product.name}
      className="pricing-dialog"
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form onSubmit={save} noValidate>
        <fieldset disabled={busy} className="form-fields">
          <PricingFields
            pricing={pricing}
            onChange={setPricing}
            rate={rate}
            prices={applyPricing(prices, pricing, rate)}
            errors={errors}
            after={(_tier, priceNio) => (
              <PriceMargin
                priceNio={priceNio}
                costNio={row.pricing?.averageCost}
                show
              />
            )}
          />
        </fieldset>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <div className="form-actions">
          <Button
            type="submit"
            disabled={
              busy || readOnly || rate === null || samePricing(pricing, initial)
            }
            aria-busy={busy}
          >
            {busy ? 'Guardando…' : 'Guardar precios'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancelar
          </Button>
        </div>
      </form>
      <PriceHistory productId={product.id} />
    </Dialog>
  )
}

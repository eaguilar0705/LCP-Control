import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Dialog } from '../../components/ui'
import type { Product, ProductPricing } from '../../lib/domain'
import { errorMessage, issuesByField } from '../../lib/errors'
import { samePricing, type TierPrices } from '../../lib/pricing'
import { pricingInput, pricingInputSchema } from '../products/product'
import { useServices } from '../../services/useServices'
import { PricingFields } from './PricingFields'

const MISSING_PRICES: TierPrices = {
  emprendedor: { NIO: Number.NaN, USD: Number.NaN },
  vip: { NIO: Number.NaN, USD: Number.NaN },
  premium: { NIO: Number.NaN, USD: Number.NaN },
}

/**
 * La ficha de precios de un perfume: su precio de compra y el porcentaje de
 * ganancia de cada lista, con el desglose calculado mientras se escribe. Los
 * precios a mano y el resto de los datos se cambian en «Editar perfume».
 */
export function PricingDialog({
  product,
  saved,
  rate,
  base,
  readOnly,
  onClose,
  onSaved,
}: {
  product: Product
  saved: ProductPricing | null
  rate: number | null
  base: string
  /** Vista local: se puede probar el cálculo, pero no guardar. */
  readOnly: boolean
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const { productService } = useServices()
  const [draft, setDraft] = useState(() => pricingInput(saved))
  // Los avisos aparecen al intentar guardar y desde entonces siguen a lo que
  // se escribe: se van en cuanto el dato se corrige, sin otro «Guardar».
  const [checked, setChecked] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const unchanged = samePricing(draft, pricingInput(saved))
  const parsed = pricingInputSchema.safeParse(draft)
  const errors =
    checked && !parsed.success
      ? issuesByField(parsed.error.issues, 'pricing.')
      : {}
  const invalid = Object.keys(errors).length
  async function save() {
    if (busy || readOnly) return
    if (!parsed.success) {
      setChecked(true)
      setError('')
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
      onSaved(`Precios de «${product.name}» guardados.`)
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
      <p className="muted pricing-dialog-meta">
        {[
          product.brand,
          product.size === null
            ? 'Tamaño por confirmar'
            : `${product.size} ${product.unit}`,
          product.barcode,
        ].join(' · ')}
      </p>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <fieldset disabled={busy} className="pricing-dialog-fields">
          <PricingFields
            pricing={draft}
            onChange={setDraft}
            rate={rate}
            prices={product.prices ?? MISSING_PRICES}
            errors={errors}
          />
        </fieldset>
        {readOnly && <p className="page-feedback">Vista de ejemplo.</p>}
        {(invalid > 0 || error) && (
          <p role="alert" className="inline-error">
            {invalid > 0
              ? `Revisa ${invalid === 1 ? 'el campo marcado' : 'los campos marcados'} antes de guardar.`
              : error}
          </p>
        )}
        <div className="form-actions">
          <Button
            type="submit"
            disabled={busy || readOnly || unchanged}
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
          <Link
            className="button button-ghost"
            to={`${base}/products/${product.id}/edit?volver=precios#precios`}
          >
            Editar perfume
          </Link>
        </div>
      </form>
    </Dialog>
  )
}

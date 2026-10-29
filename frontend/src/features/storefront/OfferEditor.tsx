import { useCallback, useState } from 'react'
import {
  Button,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from '../../components/ui'
import { useQuery } from '../../lib/useQuery'
import { errorMessage } from '../../lib/errors'
import { supabase } from '../../lib/supabase'
import { type CatalogLink, price } from './storefront'
type Offer = {
  draft_id: string
  tier_code: string
  final_price: number | null
  revision: number
}
export function OfferEditor({
  draftId,
  links,
  selected,
  basePrice,
  onSaved,
  onBusyChange,
}: {
  draftId: string
  links: CatalogLink[]
  selected: string
  basePrice: (tier: string) => number
  onSaved: (message: string) => void
  onBusyChange: (busy: boolean) => void
}) {
  const [tier, setTier] = useState(selected || 'menudeo')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    const { data, error } = await supabase!.rpc('storefront_offers')
    if (error) throw error
    return data as Offer[]
  }, [])
  const query = useQuery(load)
  const offer = query.data?.find(
    (o) => o.draft_id === draftId && o.tier_code === tier,
  )
  const original = Math.ceil(basePrice(tier))
  const final = Number(text)
  async function save(remove = false) {
    if (busy || query.loading || query.error) return
    if (
      !remove &&
      (!text.trim() ||
        !Number.isInteger(final) ||
        final <= 0 ||
        final >= original)
    ) {
      setError(
        'Escribe un precio entero mayor que cero y menor al precio publicado.',
      )
      return
    }
    setBusy(true)
    onBusyChange(true)
    setError('')
    try {
      const { error } = await supabase!.rpc('save_storefront_offer', {
        p_payload: {
          draftId,
          tier,
          finalPrice: remove ? null : final,
          revision: offer?.revision ?? 0,
          expectedBase: original,
        },
      })
      if (error) throw error
      setText('')
      query.retry()
      onSaved(
        remove
          ? 'Oferta retirada.'
          : `Oferta guardada para ${links.find((l) => l.code === tier)?.name}.`,
      )
      window.dispatchEvent(new Event('storefront-updated'))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
      onBusyChange(false)
    }
  }
  return (
    <section className="sf-offer-editor" aria-label="Oferta del catálogo">
      <h3>Oferta en la web</h3>
      <Select
        label="Catálogo de la oferta"
        value={tier}
        disabled={busy}
        onChange={(e) => {
          setTier(e.target.value)
          setText('')
          setError('')
        }}
      >
        {links
          .filter((l) => !selected || l.code === selected)
          .map((l) => (
            <option value={l.code} key={l.code}>
              {l.name}
            </option>
          ))}
      </Select>
      {query.loading ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorState message={query.error} retry={query.retry} />
      ) : (
        <>
          <p>
            Precio publicado: <strong>{price(original)}</strong>
            {offer?.final_price != null && (
              <span>
                {' '}
                · Oferta actual: <strong>{price(offer.final_price)}</strong>
                {offer.final_price >= original &&
                  ' · No aplicable: revisa el precio de lista.'}
              </span>
            )}
          </p>
          <Input
            label="Precio final de oferta (US$)"
            type="number"
            step={1}
            min={1}
            max={original - 1}
            disabled={busy || original <= 0}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setError('')
            }}
          />
          {final > 0 && final < original && (
            <p className="sf-discount-preview">
              {(((original - final) / original) * 100).toFixed(2)} % de
              descuento
            </p>
          )}
          {error && (
            <div>
              <p className="inline-error" role="alert">
                {error}
              </p>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setError('')
                  query.retry()
                }}
              >
                Actualizar oferta
              </Button>
            </div>
          )}
          <div className="form-actions">
            <Button
              type="button"
              disabled={busy || original <= 0}
              onClick={() => void save()}
            >
              Guardar oferta
            </Button>
            {offer?.final_price != null && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => void save(true)}
              >
                Quitar oferta
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  )
}

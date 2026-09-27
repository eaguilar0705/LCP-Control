import type { ReactNode } from 'react'
import type { PriceTier, PricingInput } from '../../lib/domain'
import { Input } from '../../components/ui'
import { formatCurrency } from '../../lib/format'
import {
  exactCost,
  priceTierLabels,
  priceTiers,
  tierQuote,
  tierStatus,
  type TierPrices,
  type TierStatus,
} from '../../lib/pricing'

const statusLabels: Record<TierStatus, string> = {
  computed: 'Calculado',
  pending: 'Pendiente de costo',
  manual: 'A mano',
}

/**
 * El costo promedio vigente (de sólo lectura) y el porcentaje de ganancia de
 * cada lista, con el desglose que pidió el dueño a la vista: costo, porcentaje
 * aplicado, ganancia y precio de venta. Se usa en la ficha del perfume y en la
 * pantalla Precios.
 *
 * Una lista con porcentaje se calcula sola en cuanto el perfume tiene costo
 * promedio. Mientras no lo tenga queda «pendiente» y conserva su precio. Una
 * sin porcentaje conserva su precio a mano: en la ficha del perfume se escribe
 * en dólares (`manual`); en la pantalla Precios sólo se enseña.
 */
export function PricingFields({
  pricing,
  averageCost,
  onChange,
  rate,
  prices,
  errors = {},
  manual,
  after,
  costHelp,
}: {
  pricing: PricingInput
  /** Costo promedio vigente en C$; `null` mientras no se conozca. */
  averageCost: number | null
  onChange: (next: PricingInput) => void
  rate: number | null
  /** Precios actuales de las tres listas (los de las listas a mano). */
  prices: TierPrices
  /** Avisos por campo: `pricing.markups.vip`… */
  errors?: Record<string, string>
  /** Campo del precio a mano de una lista que no se calcula. */
  manual?: (tier: PriceTier) => ReactNode
  /** Lo que va debajo de cada lista (el margen sobre el costo). */
  after?: (tier: PriceTier, priceNio: number | null) => ReactNode
  /** Dónde se completa el costo cuando falta (un enlace o un botón). */
  costHelp?: ReactNode
}) {
  const hasCost = averageCost !== null && Number.isFinite(averageCost)
  const anyMarkup = priceTiers.some((tier) => pricing.markups[tier] !== null)
  const numberOrNull = (text: string, value: number) =>
    text === '' ? null : value
  return (
    <div className="pricing-fields">
      <div className="pricing-purchase pricing-cost-source">
        <div className="pricing-cost-value" aria-live="polite">
          <span className="pricing-cell-label" id="pricing-cost-label">
            Costo promedio vigente
          </span>
          <output aria-labelledby="pricing-cost-label">
            {hasCost ? formatCurrency(averageCost, 'NIO') : 'Sin costo todavía'}
          </output>
          <small>
            {hasCost
              ? `C$ ${exactCost(averageCost)} por unidad · promedio de tienda y bodega, con el envío incluido. Se calcula solo; no se escribe aquí.`
              : 'El costo sale de las compras registradas o del costo inicial de las existencias.'}
          </small>
          {!hasCost && costHelp}
        </div>
        <p className="pricing-hint">
          {!hasCost && anyMarkup
            ? 'Los porcentajes quedan guardados y se aplican en cuanto el perfume tenga costo promedio. Mientras tanto cada lista conserva su precio.'
            : hasCost && !anyMarkup
              ? 'Escribe el porcentaje de ganancia sobre el costo de cada lista y el precio de venta se calcula solo.'
              : `Precio de venta = costo promedio × (1 + % de ganancia sobre el costo ÷ 100), al centavo. El equivalente en dólares sale de la tasa vigente${rate === null ? '' : ` (${rate} C$ por dólar)`}.`}
        </p>
      </div>
      <div className="pricing-rows">
        <div className="pricing-row pricing-row-head" aria-hidden="true">
          <span>Lista</span>
          <span>Costo promedio</span>
          <span>% de ganancia sobre el costo</span>
          <span>Ganancia</span>
          <span>Precio de venta</span>
        </div>
        {priceTiers.map((tier) => {
          const status = tierStatus(pricing, averageCost, tier)
          const quote = tierQuote(pricing, averageCost, tier, rate)
          const label = priceTierLabels[tier]
          const markup = pricing.markups[tier]
          const priceNio = quote ? quote.prices.NIO : prices[tier]?.NIO
          return (
            <div
              className={`pricing-row is-${status}`}
              key={tier}
              role="group"
              aria-label={label}
            >
              <div className="pricing-tier">
                <h3>{label}</h3>
                <span className={`pricing-badge is-${status}`}>
                  {statusLabels[status]}
                </span>
              </div>
              <div className="pricing-cell">
                <span className="pricing-cell-label">Costo promedio</span>
                <strong>
                  {hasCost ? formatCurrency(averageCost, 'NIO') : '—'}
                </strong>
              </div>
              <div className="pricing-cell pricing-markup">
                <Input
                  label={`% de ganancia sobre el costo · ${label}`}
                  error={errors[`pricing.markups.${tier}`]}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={1000}
                  step={0.01}
                  placeholder="—"
                  value={markup === null || Number.isNaN(markup) ? '' : markup}
                  onChange={(event) =>
                    onChange({
                      ...pricing,
                      markups: {
                        ...pricing.markups,
                        [tier]: numberOrNull(
                          event.target.value,
                          event.target.valueAsNumber,
                        ),
                      },
                    })
                  }
                />
              </div>
              <div className="pricing-cell">
                <span className="pricing-cell-label">Ganancia</span>
                <strong className={quote ? 'pricing-profit' : undefined}>
                  {quote ? formatCurrency(quote.profit, 'NIO') : '—'}
                </strong>
                {quote && <small>{quote.percent} % sobre el costo</small>}
              </div>
              <div className="pricing-cell pricing-sale">
                {quote ? (
                  <>
                    <span className="pricing-cell-label">Precio de venta</span>
                    <strong>{formatCurrency(quote.price, 'NIO')}</strong>
                    <small>
                      {Number.isNaN(quote.prices.USD)
                        ? 'Falta la tasa para el equivalente'
                        : `${formatCurrency(quote.prices.USD, 'USD')} con la tasa vigente`}
                    </small>
                  </>
                ) : manual ? (
                  <>
                    {manual(tier)}
                    {status === 'pending' && (
                      <small className="pricing-pending-note">
                        Se calculará con {markup} % cuando haya costo.
                      </small>
                    )}
                  </>
                ) : (
                  <>
                    <span className="pricing-cell-label">Precio de venta</span>
                    <strong>
                      {Number.isFinite(prices[tier]?.NIO)
                        ? formatCurrency(prices[tier].NIO, 'NIO')
                        : '—'}
                    </strong>
                    <small>
                      {Number.isFinite(prices[tier]?.USD)
                        ? `${formatCurrency(prices[tier].USD, 'USD')} · ${status === 'pending' ? 'precio publicado hasta que haya costo' : 'precio fijado a mano'}`
                        : status === 'pending'
                          ? 'Precio publicado hasta que haya costo'
                          : 'Precio fijado a mano'}
                    </small>
                  </>
                )}
              </div>
              {after?.(tier, Number.isFinite(priceNio) ? priceNio : null)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

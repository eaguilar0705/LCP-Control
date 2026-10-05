import type { ReactNode } from 'react'
import type { Currency, PriceTier, PricingInput } from '../../lib/domain'
import { Input, Select } from '../../components/ui'
import { formatCurrency } from '../../lib/format'
import {
  priceTierLabels,
  priceTiers,
  tierQuote,
  tierStatus,
  type TierPrices,
  type TierStatus,
} from '../../lib/pricing'

const statusLabels: Record<TierStatus, string> = {
  computed: 'Calculado',
  pending: 'Falta precio de compra',
  manual: 'A mano',
}

/**
 * El precio de compra del perfume y el porcentaje de ganancia de cada lista,
 * con el desglose a la vista: porcentaje, ganancia y precio de venta. Se usa en
 * la ficha del perfume.
 *
 * precio de venta = precio de compra × (1 + % ÷ 100), en la moneda de la
 * compra; la otra moneda sale de la tasa. Una lista sin porcentaje conserva su
 * precio a mano, que se escribe en dólares (`manual`).
 */
export function PricingFields({
  pricing,
  onChange,
  rate,
  prices,
  errors = {},
  manual,
  after,
}: {
  pricing: PricingInput
  onChange: (next: PricingInput) => void
  rate: number | null
  /** Precios actuales de las tres listas (los de las listas a mano). */
  prices: TierPrices
  /** Avisos por campo: `pricing.markups.vip`, `pricing.purchasePrice`… */
  errors?: Record<string, string>
  /** Campo del precio a mano de una lista que no se calcula. */
  manual?: (tier: PriceTier) => ReactNode
  /** Lo que va debajo de cada lista (el margen sobre el costo). */
  after?: (tier: PriceTier, priceNio: number | null) => ReactNode
}) {
  const numberOrNull = (text: string, value: number) =>
    text === '' ? null : value
  const currency = pricing.purchaseCurrency
  const purchase = pricing.purchasePrice
  return (
    <div className="pricing-fields">
      <div className="pricing-purchase">
        <Input
          label="Precio de compra"
          error={errors['pricing.purchasePrice']}
          type="number"
          inputMode="decimal"
          min={0.01}
          max={10000000}
          step={0.01}
          placeholder="—"
          value={purchase === null || Number.isNaN(purchase) ? '' : purchase}
          onChange={(event) =>
            onChange({
              ...pricing,
              purchasePrice: numberOrNull(
                event.target.value,
                event.target.valueAsNumber,
              ),
            })
          }
        />
        <Select
          label="Moneda de compra"
          value={currency}
          onChange={(event) =>
            onChange({
              ...pricing,
              purchaseCurrency: event.target.value as Currency,
            })
          }
        >
          <option value="USD">US$ Dólares</option>
          <option value="NIO">C$ Córdobas</option>
        </Select>
      </div>
      <div className="pricing-rows">
        <div className="pricing-row pricing-row-head" aria-hidden="true">
          <span>Lista</span>
          <span>Precio de compra</span>
          <span>% de ganancia</span>
          <span>Ganancia</span>
          <span>Precio de venta</span>
        </div>
        {priceTiers.map((tier) => {
          const status = tierStatus(pricing, tier)
          const quote = tierQuote(pricing, tier, rate)
          const label = priceTierLabels[tier]
          const markup = pricing.markups[tier]
          const priceNio = quote ? quote.prices.NIO : prices[tier]?.NIO
          const other: Currency = currency === 'NIO' ? 'USD' : 'NIO'
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
                <span className="pricing-cell-label">Precio de compra</span>
                <strong>
                  {quote ? formatCurrency(quote.cost, quote.currency) : '—'}
                </strong>
              </div>
              <div className="pricing-cell pricing-markup">
                <Input
                  label={`% de ganancia · ${label}`}
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
                  {quote ? formatCurrency(quote.profit, quote.currency) : '—'}
                </strong>
              </div>
              <div className="pricing-cell pricing-sale">
                {quote ? (
                  <>
                    <span className="pricing-cell-label">Precio de venta</span>
                    <strong>
                      {formatCurrency(quote.price, quote.currency)}
                    </strong>
                    {Number.isFinite(quote.prices[other]) && (
                      <small>
                        {formatCurrency(quote.prices[other], other)}
                      </small>
                    )}
                  </>
                ) : manual ? (
                  manual(tier)
                ) : (
                  <>
                    <span className="pricing-cell-label">Precio de venta</span>
                    <strong>
                      {Number.isFinite(prices[tier]?.NIO)
                        ? formatCurrency(prices[tier].NIO, 'NIO')
                        : '—'}
                    </strong>
                    {Number.isFinite(prices[tier]?.USD) && (
                      <small>{formatCurrency(prices[tier].USD, 'USD')}</small>
                    )}
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

import type { ReactNode } from 'react'
import type { Currency, PriceTier, PricingInput } from '../../lib/domain'
import { Input, Select } from '../../components/ui'
import { formatCurrency } from '../../lib/format'
import {
  priceTierLabels,
  priceTiers,
  tierQuote,
  type TierPrices,
} from '../../lib/pricing'

/**
 * El precio de compra y el porcentaje de ganancia de cada lista, con el
 * desglose que pidió el dueño a la vista: precio de compra, porcentaje
 * aplicado, ganancia y precio de venta. Se usa en la ficha del perfume y en la
 * pantalla Precios.
 *
 * Una lista con porcentaje (y precio de compra) se calcula sola. Una sin
 * porcentaje conserva su precio: en la ficha del perfume se escribe a mano en
 * dólares (`manual`); en la pantalla Precios sólo se enseña.
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
  /** Avisos por campo: `pricing.purchasePrice`, `pricing.markups.vip`… */
  errors?: Record<string, string>
  /** Campo del precio a mano de una lista sin porcentaje. */
  manual?: (tier: PriceTier) => ReactNode
  /** Lo que va debajo de cada lista (el margen sobre el costo contable). */
  after?: (tier: PriceTier, priceNio: number | null) => ReactNode
}) {
  const currency = pricing.purchaseCurrency
  const hasCost = pricing.purchasePrice !== null
  const anyMarkup = priceTiers.some((tier) => pricing.markups[tier] !== null)
  const numberOrNull = (text: string, value: number) =>
    text === '' ? null : value
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
          placeholder="Sin cargar"
          value={
            pricing.purchasePrice === null ||
            Number.isNaN(pricing.purchasePrice)
              ? ''
              : pricing.purchasePrice
          }
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
          <option value="NIO">C$ Córdobas</option>
          <option value="USD">US$ Dólares</option>
        </Select>
        <p className="pricing-hint">
          {!hasCost && anyMarkup
            ? 'Escribe el precio de compra para aplicar los porcentajes.'
            : hasCost && !anyMarkup
              ? 'Escribe el porcentaje de ganancia de cada lista y el precio de venta se calcula solo.'
              : `Precio de venta = precio de compra + el porcentaje de cada lista. El equivalente en ${currency === 'NIO' ? 'dólares' : 'córdobas'} sale de la tasa vigente${rate === null ? '' : ` (${rate} C$ por dólar)`}.`}
        </p>
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
          const quote = tierQuote(pricing, tier, rate)
          const label = priceTierLabels[tier]
          const markup = pricing.markups[tier]
          const other: Currency = currency === 'NIO' ? 'USD' : 'NIO'
          const priceNio = quote ? quote.prices.NIO : prices[tier]?.NIO
          return (
            <div
              className={`pricing-row ${quote ? 'is-computed' : 'is-manual'}`}
              key={tier}
              role="group"
              aria-label={label}
            >
              <div className="pricing-tier">
                <h3>{label}</h3>
                <span className={`pricing-badge ${quote ? 'is-computed' : ''}`}>
                  {quote ? 'Calculado' : 'A mano'}
                </span>
              </div>
              <div className="pricing-cell">
                <span className="pricing-cell-label">Precio de compra</span>
                <strong>
                  {hasCost && !Number.isNaN(pricing.purchasePrice)
                    ? formatCurrency(pricing.purchasePrice!, currency)
                    : '—'}
                </strong>
              </div>
              <div className="pricing-cell pricing-markup">
                <Input
                  label={`% de ganancia ${label}`}
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
                  {quote ? formatCurrency(quote.profit, currency) : '—'}
                </strong>
                {quote && <small>{quote.percent} % de la compra</small>}
              </div>
              <div className="pricing-cell pricing-sale">
                {quote ? (
                  <>
                    <span className="pricing-cell-label">Precio de venta</span>
                    <strong>{formatCurrency(quote.price, currency)}</strong>
                    <small>
                      {Number.isNaN(quote.prices[other])
                        ? 'Falta la tasa para el equivalente'
                        : `${formatCurrency(quote.prices[other], other)} con la tasa vigente`}
                    </small>
                  </>
                ) : manual ? (
                  manual(tier)
                ) : (
                  <>
                    <span className="pricing-cell-label">Precio de venta</span>
                    <strong>
                      {Number.isFinite(prices[tier]?.USD)
                        ? formatCurrency(prices[tier].USD, 'USD')
                        : '—'}
                    </strong>
                    <small>
                      {Number.isFinite(prices[tier]?.NIO)
                        ? `${formatCurrency(prices[tier].NIO, 'NIO')} · precio fijado a mano`
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

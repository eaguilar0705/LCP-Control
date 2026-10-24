import { Select } from './ui'
import type { Currency, PriceTier } from '../lib/domain'
import { usePriceTiers } from '../lib/usePriceTiers'
export function PriceControls({
  currency,
  tier,
  onCurrency,
  onTier,
}: {
  currency: Currency
  tier: PriceTier
  onCurrency: (v: Currency) => void
  onTier: (v: PriceTier) => void
}) {
  const tiers = usePriceTiers()
  return (
    <div className="price-controls">
      <Select
        label="Moneda"
        value={currency}
        onChange={(e) => onCurrency(e.target.value as Currency)}
      >
        <option value="NIO">C$ Córdobas</option>
        <option value="USD">US$ Dólares</option>
      </Select>
      <Select
        label="Lista de precios"
        value={tier}
        onChange={(e) => onTier(e.target.value as PriceTier)}
      >
        {tiers.map(({ code, name }) => (
          <option value={code} key={code}>
            {name}
          </option>
        ))}
      </Select>
    </div>
  )
}

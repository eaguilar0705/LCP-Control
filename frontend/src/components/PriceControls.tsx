import { Select } from './ui'
import type { Currency, PriceTier } from '../lib/domain'
import { priceTierLabels } from '../lib/pricing'
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
        {Object.entries(priceTierLabels).map(([id, label]) => (
          <option value={id} key={id}>
            {label}
          </option>
        ))}
      </Select>
    </div>
  )
}

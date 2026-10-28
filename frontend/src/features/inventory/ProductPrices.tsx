import type { Currency, Product, PriceTier } from '../../lib/domain'
import { formatCurrency } from '../../lib/format'
import { productPrice } from '../../lib/pricing'

import { inventoryPriceLists } from './inventory-price-lists'

export function ProductPriceValue({
  product,
  tier,
  currency,
}: {
  product: Product
  tier: PriceTier
  currency: Currency
}) {
  const amount = productPrice(product, tier, currency)
  return (
    <>
      {amount === null ? (
        <span className="price-pending">Pendiente</span>
      ) : (
        formatCurrency(amount, currency)
      )}
    </>
  )
}

export function ProductPrices({
  product,
  currency = 'NIO',
}: {
  product: Product
  currency?: Currency
}) {
  return (
    <dl className="product-prices" aria-label="Cuatro precios de venta">
      {inventoryPriceLists.map(({ code, name }) => {
        const amount = productPrice(product, code, currency)
        return (
          <div key={code} className={code === 'menudeo' ? 'price-retail' : ''}>
            <dt>{name}</dt>
            <dd>
              {amount === null ? 'Pendiente' : formatCurrency(amount, currency)}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

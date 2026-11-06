import { formatCurrency } from '../../lib/format'
import type { Currency } from '../../lib/domain'
import { purchaseAmounts } from './purchase-amount-model'
import './purchase-amounts.css'

export function PurchaseAmounts(props: {
  goods: number
  shipping: number
  currency: Currency
  exchangeRate: number | null | undefined
  systemRate: number | null | undefined
}) {
  const amounts = purchaseAmounts(props)
  return (
    <div className="purchase-amounts" aria-label="Importes de la compra">
      <div>
        <span>Total de la compra</span>
        <strong>
          {amounts ? formatCurrency(amounts.total, props.currency) : '—'}
        </strong>
      </div>
      <div>
        <span>Equivalente</span>
        <strong>
          {amounts?.equivalent
            ? formatCurrency(
                amounts.equivalent.amount,
                amounts.equivalent.currency,
              )
            : '—'}
        </strong>
      </div>
      {amounts?.rate && (
        <small>
          Tipo de cambio: C${' '}
          {new Intl.NumberFormat('es-NI', { maximumFractionDigits: 6 }).format(
            amounts.rate,
          )}{' '}
          por US$ 1
        </small>
      )}
    </div>
  )
}

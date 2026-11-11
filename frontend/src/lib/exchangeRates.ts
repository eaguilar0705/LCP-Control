import type { ExchangeRate } from './domain'

/** La ausencia del campo permite leer configuraciones anteriores a la separación. */
export function accountingExchangeRate(rate: ExchangeRate | null | undefined) {
  const value =
    rate?.accountingUsdToNio === undefined
      ? rate?.usdToNio
      : rate.accountingUsdToNio
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

import type { ExchangeRate } from './domain'

/** Configuraciones anteriores usan la tasa comercial también para los costos. */
export function inventoryExchangeRate(rate: ExchangeRate | null | undefined) {
  const value =
    rate?.inventoryUsdToNio === undefined
      ? rate?.usdToNio
      : rate.inventoryUsdToNio
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

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

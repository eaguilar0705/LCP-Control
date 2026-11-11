import type { Currency } from '../../lib/domain'

export interface StatementCurrency {
  currency?: Currency
  exchangeRate?: number | null
}

export function validStatementRate(
  rate: number | null | undefined,
): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0
}

/** Equivalencia de consulta. Los asientos y sus costos históricos siguen en NIO. */
export function statementCurrency({
  currency = 'NIO',
  exchangeRate,
}: StatementCurrency = {}) {
  if (currency === 'USD' && !validStatementRate(exchangeRate))
    throw new Error('Configura el tipo de cambio para consultar en dólares.')
  return {
    currency,
    label:
      currency === 'USD'
        ? `USD equivalentes · Tasa contable: C$${exchangeRate} por US$1`
        : 'NIO',
    // Sin redondeo intermedio ni reconversión del equivalente al libro contable.
    convert: (value: number | null) =>
      value === null
        ? null
        : currency === 'USD'
          ? value / exchangeRate!
          : value,
  }
}

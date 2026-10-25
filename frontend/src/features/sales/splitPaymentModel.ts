import type { Currency, InvoicePayment } from '../../lib/domain'

const halfUp = (value: bigint, denominator: bigint) =>
  (2n * value + denominator) / (2n * denominator)
export function paymentsNio(payments: InvoicePayment[]) {
  let total = 0n
  for (const p of payments) {
    const cents = Math.round(p.amount * 100)
    const micros = Math.round(p.exchangeRate * 1e6)
    if (
      !Number.isSafeInteger(cents) ||
      cents < 0 ||
      !Number.isSafeInteger(micros) ||
      micros <= 0
    )
      return NaN
    total += halfUp(BigInt(cents) * BigInt(micros), 1_000_000n)
  }
  return Number(total) / 100
}
export function splitPaymentsValid(
  payments: InvoicePayment[],
  total: number | null,
  currency: Currency,
  rate: number,
) {
  if (!payments.length) return true
  if (
    total === null ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    rate > 1e6 ||
    payments.length < 2 ||
    payments.length > 10
  )
    return false
  if (
    payments.some(
      (p) =>
        !Number.isFinite(p.amount) ||
        p.amount <= 0 ||
        p.amount > 1e8 ||
        Math.abs(p.amount * 100 - Math.round(p.amount * 100)) > 1e-6 ||
        !Number.isFinite(p.exchangeRate) ||
        p.exchangeRate <= 0 ||
        p.exchangeRate > 1e6 ||
        Math.abs(p.exchangeRate * 1e6 - Math.round(p.exchangeRate * 1e6)) >
          1e-3 ||
        (p.currency === 'NIO' && p.exchangeRate !== 1) ||
        (p.method.endsWith('_nio') && p.currency !== 'NIO') ||
        (p.method.endsWith('_usd') && p.currency !== 'USD'),
    )
  )
    return false
  const nio = Math.round(paymentsNio(payments) * 100)
  const micros = Math.round((currency === 'NIO' ? 1 : rate) * 1e6)
  return (
    Number.isSafeInteger(nio) &&
    Number(halfUp(BigInt(nio) * 1_000_000n, BigInt(micros))) ===
      Math.round(total * 100)
  )
}

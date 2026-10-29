import type { Currency, DocumentItemRecord } from '../../lib/domain'
export function lineDiscountPercent(item: DocumentItemRecord) {
  const original = item.originalUnitPrice ?? item.unitPrice
  return original > 0
    ? Math.max(0, 100 * (1 - item.lineTotal / (original * item.quantity)))
    : 0
}
export function discountedDescription(item: DocumentItemRecord) {
  const percent = lineDiscountPercent(item)
  return (
    item.description + (percent > 0 ? ` · Desc. ${percent.toFixed(2)} %` : '')
  )
}
const formats = new Map<Currency, Intl.NumberFormat>()
/** El renglón incluye su parte del descuento total; se muestran hasta cinco
 * decimales cuando hacen falta para no aparentar un error en la multiplicación. */
export function formatNetUnitPrice(
  item: DocumentItemRecord,
  currency: Currency,
) {
  let format = formats.get(currency)
  if (!format) {
    format = new Intl.NumberFormat('es-NI', {
      style: 'currency',
      currency,
      currencyDisplay: 'code',
      minimumFractionDigits: 2,
      maximumFractionDigits: 5,
    })
    formats.set(currency, format)
  }
  return format.format(item.lineTotal / item.quantity)
}

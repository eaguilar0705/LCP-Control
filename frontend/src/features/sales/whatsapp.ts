import { formatCurrency, formatDate } from '../../lib/format'
import { documentCopy, labels } from '../../lib/domain'
import { priceTierLabels } from '../../lib/pricing'
import type { DocumentRecord } from '../../lib/domain'

const NICARAGUA_CODE = '505'
const LOCAL_LENGTH = 8

/**
 * wa.me only accepts an international number in digits. Local Nicaraguan
 * numbers are stored as eight digits, so the country code is added here and
 * never written back to the customer record.
 */
export function whatsappNumber(
  phone: string | null | undefined,
): string | null {
  const digits = (phone ?? '').replace(/\D/g, '').replace(/^0+/, '')
  if (!digits) return null
  const full = digits.length === LOCAL_LENGTH ? NICARAGUA_CODE + digits : digits
  return /^[1-9][0-9]{7,14}$/.test(full) ? full : null
}

function line(quantity: number, description: string, total: string) {
  return `• ${quantity} × ${description} — ${total}`
}

/** Plain text: WhatsApp renders *bold* but strips anything more elaborate. */
export function whatsappMessage(document: DocumentRecord): string {
  const copy = documentCopy[document.kind]
  const parts = [
    `*${document.issuer.name}*`,
    document.issuer.phone,
    '',
    `*${copy.stamp} ${document.number}*`,
    `Cliente: ${document.customerName}`,
    `Fecha: ${formatDate(document.createdAt)}`,
  ]
  if (document.previewKind)
    parts.push(
      document.previewKind === 'example'
        ? 'EJEMPLO / SIN EMITIR'
        : 'BORRADOR / SIN EMITIR',
    )
  if (document.kind === 'proforma' && document.validUntil)
    parts.push(`Válida hasta: ${formatDate(document.validUntil)}`)
  if (document.kind === 'invoice' && document.paymentMethod)
    parts.push(
      `Pago: ${
        document.paymentMethod === 'pending'
          ? 'Pendiente'
          : labels.payment[document.paymentMethod]
      }`,
    )
  parts.push(
    `Lista: ${priceTierLabels[document.tier]} · ${document.currency}`,
    '',
    '*Detalle*',
    ...document.items.map((item) =>
      line(
        item.quantity,
        item.description,
        formatCurrency(item.lineTotal, document.currency),
      ),
    ),
    '',
    `*Total: ${formatCurrency(document.total, document.currency)}*`,
  )
  if (document.notes.trim()) parts.push('', `Nota: ${document.notes.trim()}`)
  parts.push(
    '',
    document.kind === 'proforma'
      ? 'Esta proforma es una cotización, no una factura.'
      : 'Gracias por su compra.',
  )
  return parts.filter((part) => part !== undefined).join('\n')
}

export function whatsappUrl(document: DocumentRecord): string {
  const number = whatsappNumber(document.customerPhone)
  const text = encodeURIComponent(whatsappMessage(document))
  return number
    ? `https://wa.me/${number}?text=${text}`
    : `https://wa.me/?text=${text}`
}

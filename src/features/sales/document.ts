import { z } from 'zod'
import { lineCents } from '../../lib/pricing'
import type {
  Currency,
  DocumentKind,
  DocumentRecord,
  PriceTier,
} from '../../lib/domain'
const money = z.number().finite().min(0).max(10000000)
const pair = z.object({ NIO: money, USD: money })
export const draftLineSchema = z.object({
  productId: z.string(),
  name: z.string(),
  barcode: z.string(),
  size: z.string(),
  quantity: z.number().int().min(1).max(9999),
  prices: z.object({ emprendedor: pair, vip: pair, premium: pair }),
})
// One schema, one discriminating field. A draft always knows whether it is an
// invoice or a proforma, so a proforma can never be reopened as an invoice.
export const documentDraftSchema = z.object({
  id: z.string(),
  kind: z.enum(['invoice', 'proforma']),
  reference: z.string(),
  customer: z.string().max(200),
  customerId: z.string().nullable().default(null),
  phone: z.string().max(40).default(''),
  // 80 es el tope que acepta la base al emitir; un borrador con más caracteres
  // se guardaría sin problema y fallaría recién al emitir el documento.
  taxId: z.string().max(80),
  currency: z.enum(['NIO', 'USD']),
  taxRate: z.number().finite().min(0).max(100).optional(),
  exchangeRate: z
    .number()
    .finite()
    .positive()
    .max(1000000)
    .nullable()
    .optional(),
  tier: z.enum(['emprendedor', 'vip', 'premium']),
  payment: z.enum(['pending', 'cash', 'card_pos', 'bank_transfer']),
  location: z.enum(['warehouse', 'store']),
  validUntil: z.string().max(10).default(''),
  notes: z.string().max(1500),
  createdAt: z.string(),
  lines: z.array(draftLineSchema).min(1),
})
export type DocumentDraft = z.infer<typeof documentDraftSchema>
export type DraftLine = z.infer<typeof draftLineSchema>
/** Catalogue totals already include the explicitly recorded tax. */
export function includedTax(total: number, rate: number) {
  const totalCents = Math.round(total * 100)
  const netCents = Math.round(totalCents / (1 + rate / 100))
  return { net: netCents / 100, tax: (totalCents - netCents) / 100 }
}
export function draftTotal(
  lines: DraftLine[],
  tier: PriceTier,
  currency: Currency,
) {
  const total = lines.reduce(
    (sum, line) => sum + lineCents(line.prices[tier][currency], line.quantity),
    0,
  )
  if (!Number.isSafeInteger(total))
    throw new Error('El importe es demasiado grande.')
  return total / 100
}
export function draftStorageKey(kind: DocumentKind) {
  return `lcp.drafts.${kind}.v2`
}
export const PROFORMA_VALID_DAYS = 7
export function defaultValidUntil(from: Date = new Date()) {
  const date = new Date(from)
  date.setDate(date.getDate() + PROFORMA_VALID_DAYS)
  return isoDate(date)
}
const managuaIsoDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Managua',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
export function isoDate(date: Date) {
  return managuaIsoDate.format(date)
}
/** Lets the screen preview and share a draft with exactly the same code paths
 * that render a document already stored in PostgreSQL. */
export function draftPreview(
  draft: DocumentDraft,
  issuer: DocumentRecord['issuer'],
  /** Tasa vigente del catálogo, para imprimir el equivalente del borrador. */
  catalogRate?: number | null,
): DocumentRecord {
  return {
    catalogRate: catalogRate ?? null,
    id: draft.id,
    previewKind: 'draft',
    customerTaxId: draft.taxId,
    kind: draft.kind,
    number: draft.reference,
    customerId: draft.customerId ?? '',
    customerName: draft.customer || 'Cliente por indicar',
    customerPhone: draft.phone || null,
    issuer,
    tier: draft.tier,
    currency: draft.currency,
    taxRate: draft.taxRate,
    exchangeRate: draft.currency === 'NIO' ? 1 : draft.exchangeRate,
    total: draftTotal(draft.lines, draft.tier, draft.currency),
    location: draft.kind === 'invoice' ? draft.location : null,
    validUntil: draft.kind === 'proforma' ? draft.validUntil || null : null,
    paymentMethod: draft.kind === 'invoice' ? draft.payment : null,
    notes: draft.notes,
    createdAt: draft.createdAt,
    items: draft.lines.map((line) => ({
      id: line.productId,
      productId: line.productId,
      description: `${line.name} · ${line.size}`,
      quantity: line.quantity,
      unitPrice: line.prices[draft.tier][draft.currency],
      lineTotal:
        lineCents(line.prices[draft.tier][draft.currency], line.quantity) / 100,
    })),
  }
}

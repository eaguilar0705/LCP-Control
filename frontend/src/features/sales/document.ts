import { z } from 'zod'
import { lineCents } from '../../lib/pricing'
import { paymentMethods } from '../../lib/domain'
import type {
  Currency,
  DocumentKind,
  DocumentRecord,
  PriceTier,
} from '../../lib/domain'
const money = z.number().finite().min(0).max(10000000)
const pair = z.object({ NIO: money, USD: money })
const discountSchema = z.object({
  tier: z.string(),
  currency: z.enum(['NIO', 'USD']),
  amount: money,
})
export const draftLineSchema = z.object({
  discount: discountSchema.optional(),
  productId: z.string(),
  name: z.string(),
  barcode: z.string(),
  size: z.string(),
  quantity: z.number().int().min(1).max(9999),
  prices: z.record(z.string().min(1).max(100), pair),
})
// One schema, one discriminating field. A draft always knows whether it is an
// invoice or a proforma, so a proforma can never be reopened as an invoice.
export const documentDraftSchema = z.object({
  discount: discountSchema.optional(),
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
  // Borradores guardados antes de quitar el IVA: se leen y se ignoran.
  taxRate: z.number().finite().min(0).max(100).optional(),
  exchangeRate: z
    .number()
    .finite()
    .positive()
    .max(1000000)
    .nullable()
    .optional(),
  tier: z.string().min(1).max(100),
  payment: z.enum(['pending', ...paymentMethods]),
  payments: z
    .array(
      z.object({
        method: z.enum(paymentMethods),
        currency: z.enum(['NIO', 'USD']),
        amount: money,
        exchangeRate: z.number().finite().positive().max(1000000),
      }),
    )
    .max(10)
    .optional(),
  location: z.enum(['warehouse', 'store']),
  validUntil: z.string().max(10).default(''),
  notes: z.string().max(1500),
  createdAt: z.string(),
  lines: z.array(draftLineSchema).min(1),
})
export type DocumentDraft = z.infer<typeof documentDraftSchema>
export type DraftLine = z.infer<typeof draftLineSchema>
export type DraftDiscount = z.infer<typeof discountSchema>
export function discountValue(
  discount: DraftDiscount | undefined,
  tier: PriceTier,
  currency: Currency,
) {
  return discount?.tier === tier && discount.currency === currency
    ? discount.amount
    : 0
}
export function draftLinePrice(
  line: DraftLine,
  tier: PriceTier,
  currency: Currency,
): number | null {
  const value = line.prices[tier]?.[currency]
  if (value == null || !Number.isFinite(value) || value <= 0) return null
  if (line.discount?.tier === tier && line.discount.currency === currency) {
    const final = line.discount.amount
    return final > 0 && final <= value ? final : null
  }
  return value
}
export function draftTotal(
  lines: DraftLine[],
  tier: PriceTier,
  currency: Currency,
  discount?: DraftDiscount,
) {
  if (lines.some((line) => draftLinePrice(line, tier, currency) === null))
    return null
  const total = lines.reduce(
    (sum, line) =>
      sum + lineCents(draftLinePrice(line, tier, currency)!, line.quantity),
    0,
  )
  if (!Number.isSafeInteger(total))
    throw new Error('El importe es demasiado grande.')
  const reduction = Math.round(discountValue(discount, tier, currency) * 100)
  if (reduction < 0 || (reduction > 0 && reduction >= total)) return null
  if (
    reduction > 0 &&
    [...draftAmounts(lines, tier, currency, discount).values()].some(
      (value) => value <= 0,
    )
  )
    return null
  return (total - reduction) / 100
}
/** Reparto acumulado al centavo, en el mismo orden estable que PostgreSQL. */
export function draftAmounts(
  lines: DraftLine[],
  tier: PriceTier,
  currency: Currency,
  discount?: DraftDiscount,
) {
  if (
    lines.some(
      (line) =>
        !Number.isInteger(line.quantity) ||
        line.quantity < 1 ||
        line.quantity > 9999,
    )
  )
    return new Map<string, number>()
  const subtotal = draftTotal(lines, tier, currency)
  if (subtotal === null || subtotal <= 0) return new Map<string, number>()
  const reduction = Math.round(discountValue(discount, tier, currency) * 100)
  let cumulative = 0,
    allocated = 0
  const result = new Map<string, number>()
  for (const line of [...lines].sort((a, b) =>
    a.productId.localeCompare(b.productId),
  )) {
    const cents = lineCents(
      draftLinePrice(line, tier, currency)!,
      line.quantity,
    )
    cumulative += cents
    const denominator = BigInt(Math.round(subtotal * 100))
    const next = Number(
      (2n * BigInt(reduction) * BigInt(cumulative) + denominator) /
        (2n * denominator),
    )
    result.set(line.productId, (cents - next + allocated) / 100)
    allocated = next
  }
  return result
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
  const total = draftTotal(
    draft.lines,
    draft.tier,
    draft.currency,
    draft.discount,
  )
  if (total === null)
    throw new Error('Hay perfumes sin precio en la lista seleccionada.')
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
    exchangeRate: draft.currency === 'NIO' ? 1 : draft.exchangeRate,
    total,
    originalTotal:
      draft.lines.reduce(
        (sum, line) =>
          sum +
          lineCents(line.prices[draft.tier][draft.currency], line.quantity),
        0,
      ) / 100,
    discountAmount:
      Math.round(
        (draft.lines.reduce(
          (sum, line) =>
            sum +
            lineCents(line.prices[draft.tier][draft.currency], line.quantity),
          0,
        ) /
          100 -
          total) *
          100,
      ) / 100,
    invoiceDiscount: discountValue(draft.discount, draft.tier, draft.currency),
    location: draft.kind === 'invoice' ? draft.location : null,
    validUntil: draft.kind === 'proforma' ? draft.validUntil || null : null,
    paymentMethod: draft.kind === 'invoice' ? draft.payment : null,
    payments: draft.kind === 'invoice' ? draft.payments : undefined,
    notes: draft.notes,
    createdAt: draft.createdAt,
    items: draft.lines.map((line) => ({
      id: line.productId,
      productId: line.productId,
      description: `${line.name} · ${line.size}`,
      quantity: line.quantity,
      originalUnitPrice: line.prices[draft.tier][draft.currency],
      unitPrice: draftLinePrice(line, draft.tier, draft.currency)!,
      lineTotal: draftAmounts(
        draft.lines,
        draft.tier,
        draft.currency,
        draft.discount,
      ).get(line.productId)!,
    })),
  }
}

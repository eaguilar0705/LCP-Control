import type { jsPDF } from 'jspdf'
import {
  documentCopy,
  type Currency,
  type DocumentKind,
  type DocumentRecord,
} from '../../lib/domain'
import { formatCurrency } from '../../lib/format'
import type { ReportRange } from '../reports/model'
import { LOGO_ALIAS, layoutDocumentPdf, newLetterPdf } from './pdfLayout'
import { periodLabel, shortDay } from './period'

/**
 * PDF de un periodo: primero el listado (una fila por documento, con los
 * totales por moneda y por forma de pago) y después cada documento completo,
 * igual al que se entregó, en el mismo orden del listado.
 *
 * Carta en puntos (612 × 792), con los mismos márgenes y colores que la
 * factura para que el archivo se lea como un solo documento del negocio.
 */
type RGB = [number, number, number]
const LEFT = 30
const RIGHT = 582
const WIDTH = RIGHT - LEFT
const ROW = 15
const TABLE_BOTTOM = 736
const FOOTER_Y = 756
const INK: RGB = [20, 16, 14]
const MUTED: RGB = [92, 81, 74]
const RULE: RGB = [185, 173, 163]
const ZEBRA: RGB = [247, 243, 238]
const PAPER: RGB = [246, 241, 234]
const WHITE: RGB = [255, 255, 255]
const ACCENT: Record<DocumentKind, RGB> = {
  invoice: [87, 23, 28],
  proforma: [122, 85, 18],
}
const COLUMNS = {
  number: LEFT + 6,
  date: 104,
  time: 160,
  customer: 194,
  extra: 408,
  total: RIGHT - 6,
}
const CUSTOMER_WIDTH = COLUMNS.extra - COLUMNS.customer - 10

const managuaDate = new Intl.DateTimeFormat('es-NI', {
  timeZone: 'America/Managua',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})
const managuaTime = new Intl.DateTimeFormat('es-NI', {
  timeZone: 'America/Managua',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const counts = new Intl.NumberFormat('es-NI')

type PaymentKey = NonNullable<DocumentRecord['paymentMethod']>
const PAYMENTS: { key: PaymentKey; label: string; short: string }[] = [
  { key: 'cash', label: 'Efectivo', short: 'Efectivo' },
  { key: 'card_pos', label: 'POS / Tarjeta', short: 'POS / Tarjeta' },
  {
    key: 'bank_transfer',
    label: 'Transferencia bancaria',
    short: 'Transferencia',
  },
  { key: 'pending', label: 'Pendiente de pago', short: 'Pendiente' },
]

function round(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}
function money(value: number, currency: Currency) {
  return formatCurrency(value, currency).replace(/\s/g, ' ')
}

export interface PeriodTotals {
  count: number
  byCurrency: Record<Currency, { count: number; total: number }>
  /**
   * Todo el periodo en córdobas, con la tasa guardada en cada documento en
   * dólares. `null` si alguno en dólares no la tiene: sumarlo con la tasa de
   * hoy daría una cifra que no corresponde a lo que se cobró.
   */
  totalNio: number | null
  byPayment: {
    key: PaymentKey
    label: string
    count: number
    totals: Record<Currency, number>
  }[]
}

export function periodTotals(documents: DocumentRecord[]): PeriodTotals {
  const byCurrency: PeriodTotals['byCurrency'] = {
    NIO: { count: 0, total: 0 },
    USD: { count: 0, total: 0 },
  }
  let totalNio: number | null = 0
  const payments = new Map<PaymentKey, PeriodTotals['byPayment'][number]>()
  for (const document of documents) {
    const bucket = byCurrency[document.currency]
    bucket.count += 1
    bucket.total = round(bucket.total + document.total)
    if (totalNio !== null) {
      if (document.currency === 'NIO') totalNio = round(totalNio + document.total)
      else if (document.exchangeRate)
        totalNio = round(totalNio + document.total * document.exchangeRate)
      else totalNio = null
    }
    if (document.paymentMethod) {
      const known = PAYMENTS.find((item) => item.key === document.paymentMethod)
      const entry = payments.get(document.paymentMethod) ?? {
        key: document.paymentMethod,
        label: known?.label ?? document.paymentMethod,
        count: 0,
        totals: { NIO: 0, USD: 0 },
      }
      entry.count += 1
      entry.totals[document.currency] = round(
        entry.totals[document.currency] + document.total,
      )
      payments.set(document.paymentMethod, entry)
    }
  }
  const byPayment = PAYMENTS.flatMap((item) => {
    const entry = payments.get(item.key)
    return entry ? [entry] : []
  })
  return { count: documents.length, byCurrency, totalNio, byPayment }
}

export interface PeriodPdfOptions {
  now?: Date
  /** Se llama cada tanto con cuántos documentos van dibujados. */
  onProgress?: (done: number, total: number) => void
}

/**
 * Arma el PDF cediendo el hilo cada pocos documentos: con cientos de hojas la
 * pantalla sigue respondiendo y puede mostrar el avance.
 */
export async function layoutPeriodPdf(
  kind: DocumentKind,
  range: ReportRange,
  documents: DocumentRecord[],
  logo: Uint8Array,
  { now = new Date(), onProgress }: PeriodPdfOptions = {},
): Promise<jsPDF> {
  const pdf = newLetterPdf()
  const accent = ACCENT[kind]
  const copy = documentCopy[kind]
  const title = `${copy.plural.toUpperCase()} EMITIDAS`
  const period = periodLabel(range)
  const totals = periodTotals(documents)

  function text(
    value: string | string[],
    x: number,
    y: number,
    size = 8,
    bold = false,
    align: 'left' | 'right' | 'center' = 'left',
    color: RGB = INK,
  ) {
    pdf
      .setFont('helvetica', bold ? 'bold' : 'normal')
      .setFontSize(size)
      .setTextColor(...color)
    pdf.text(value, x, y, { align })
  }
  /** Recorta con «…» lo que no cabe en el ancho de la columna. */
  function fit(value: string, width: number, size: number, bold = false) {
    const clean = value.replace(/\s+/g, ' ').trim()
    pdf.setFont('helvetica', bold ? 'bold' : 'normal').setFontSize(size)
    if (pdf.getTextWidth(clean) <= width) return clean
    let cut = clean
    while (cut && pdf.getTextWidth(`${cut}…`) > width) cut = cut.slice(0, -1)
    return `${cut.trimEnd()}…`
  }

  // ── Encabezado ────────────────────────────────────────────────────────
  function header(first: boolean) {
    pdf.setFillColor(...accent).rect(LEFT, 22, WIDTH, 3, 'F')
    if (!first) {
      text(`${title} · CONTINUACIÓN`, LEFT, 42, 9, true, 'left', accent)
      text(`Período ${period}`, RIGHT, 42, 8, false, 'right', MUTED)
      return 54
    }
    pdf.addImage(logo, 'JPEG', LEFT, 31, 118, 53.8, LOGO_ALIAS)
    pdf.setFillColor(...PAPER).roundedRect(342, 31, 240, 56, 3, 3, 'F')
    pdf.setFillColor(...accent).rect(342, 31, 2.5, 56, 'F')
    text(title, 572, 49, 14, true, 'right', accent)
    text(`Período ${period}`, 572, 64, 9, true, 'right')
    text(
      `Generado el ${managuaDate.format(now)} a las ${managuaTime.format(now)}`,
      572,
      77,
      7,
      false,
      'right',
      MUTED,
    )
    return 104
  }

  // ── Resumen del periodo ───────────────────────────────────────────────
  function summary(top: number) {
    const cards: [string, string][] = [
      [
        copy.plural.toUpperCase(),
        `${counts.format(totals.count)}`,
      ],
      ['TOTAL EN CÓRDOBAS', money(totals.byCurrency.NIO.total, 'NIO')],
      ['TOTAL EN DÓLARES', money(totals.byCurrency.USD.total, 'USD')],
    ]
    const converted = totals.byCurrency.USD.count > 0 && totals.totalNio !== null
    if (converted)
      cards.push(['TODO EN CÓRDOBAS *', money(totals.totalNio ?? 0, 'NIO')])
    const gap = 8
    const cardWidth = (WIDTH - gap * (cards.length - 1)) / cards.length
    cards.forEach(([label, value], index) => {
      const x = LEFT + index * (cardWidth + gap)
      pdf.setFillColor(...PAPER).roundedRect(x, top, cardWidth, 40, 3, 3, 'F')
      text(label, x + 10, top + 14, 6.5, true, 'left', MUTED)
      text(value, x + 10, top + 31, 12, true, 'left', index ? INK : accent)
    })
    let y = top + 40
    if (converted) {
      y += 10
      text(
        '* Los dólares se convierten con la tasa guardada en cada factura, no con la de hoy.',
        LEFT,
        y,
        6.5,
        false,
        'left',
        MUTED,
      )
    }
    if (kind === 'invoice' && totals.byPayment.length) {
      y += 18
      text('POR FORMA DE PAGO', LEFT, y, 6.5, true, 'left', MUTED)
      text('CANTIDAD', 250, y, 6.5, true, 'right', MUTED)
      text('CÓRDOBAS', 380, y, 6.5, true, 'right', MUTED)
      text('DÓLARES', 500, y, 6.5, true, 'right', MUTED)
      for (const row of totals.byPayment) {
        y += 12
        text(row.label, LEFT, y, 8)
        text(counts.format(row.count), 250, y, 8, false, 'right')
        text(
          row.totals.NIO ? money(row.totals.NIO, 'NIO') : '—',
          380,
          y,
          8,
          false,
          'right',
        )
        text(
          row.totals.USD ? money(row.totals.USD, 'USD') : '—',
          500,
          y,
          8,
          false,
          'right',
        )
      }
    }
    return y + 18
  }

  // ── Listado ───────────────────────────────────────────────────────────
  function tableHeading(y: number) {
    pdf.setFillColor(...accent).rect(LEFT, y, WIDTH, 15, 'F')
    for (const [label, x, align] of [
      ['N.º', COLUMNS.number, 'left'],
      ['FECHA', COLUMNS.date, 'left'],
      ['HORA', COLUMNS.time, 'left'],
      ['CLIENTE', COLUMNS.customer, 'left'],
      [kind === 'invoice' ? 'PAGO' : 'VIGENCIA', COLUMNS.extra, 'left'],
      ['TOTAL', COLUMNS.total, 'right'],
    ] as const)
      text(label, x, y + 10.3, 7.5, true, align, WHITE)
    return y + 15
  }
  function extra(document: DocumentRecord) {
    if (kind === 'proforma')
      return document.validUntil ? shortDay(document.validUntil) : '—'
    return (
      PAYMENTS.find((item) => item.key === document.paymentMethod)?.short ??
      '—'
    )
  }

  let y = tableHeading(summary(header(true)))
  documents.forEach((document, index) => {
    if (y + ROW > TABLE_BOTTOM) {
      pdf.addPage()
      y = tableHeading(header(false))
    }
    if (index % 2 === 1)
      pdf.setFillColor(...ZEBRA).rect(LEFT, y, WIDTH, ROW, 'F')
    pdf
      .setDrawColor(...RULE)
      .setLineWidth(0.4)
      .line(LEFT, y + ROW, RIGHT, y + ROW)
    const baseline = y + 10.3
    const created = new Date(document.createdAt)
    text(document.number, COLUMNS.number, baseline, 8, true)
    text(managuaDate.format(created), COLUMNS.date, baseline, 8)
    text(managuaTime.format(created), COLUMNS.time, baseline, 8, false, 'left', MUTED)
    text(
      fit(document.customerName, CUSTOMER_WIDTH, 8),
      COLUMNS.customer,
      baseline,
      8,
    )
    text(extra(document), COLUMNS.extra, baseline, 8)
    text(
      money(document.total, document.currency),
      COLUMNS.total,
      baseline,
      8,
      true,
      'right',
    )
    y += ROW
  })
  if (!documents.length) {
    text(`Sin ${copy.plural} en este período.`, LEFT + 6, y + 14, 8, false, 'left', MUTED)
    y += ROW + 4
  }

  // Totales al pie del listado, por moneda.
  const currencies = (['NIO', 'USD'] as const).filter(
    (currency) => totals.byCurrency[currency].count > 0,
  )
  if (y + 14 + currencies.length * 13 + 20 > TABLE_BOTTOM) {
    pdf.addPage()
    y = header(false)
  }
  pdf.setDrawColor(...accent).setLineWidth(1.2).line(LEFT, y, RIGHT, y)
  y += 14
  text('TOTAL DEL PERÍODO', LEFT + 6, y, 8, true, 'left', accent)
  for (const currency of currencies) {
    const { count, total } = totals.byCurrency[currency]
    text(
      `${counts.format(count)} en ${currency === 'NIO' ? 'córdobas' : 'dólares'}`,
      COLUMNS.extra,
      y,
      8,
      false,
      'left',
      MUTED,
    )
    text(money(total, currency), COLUMNS.total, y, 9, true, 'right')
    y += 13
  }
  if (documents.length)
    text(
      `A continuación, cada ${copy.singular} completa en el mismo orden del listado.`,
      LEFT + 6,
      y + 8,
      7.5,
      false,
      'left',
      MUTED,
    )

  // Pie de las hojas del listado; cada documento lleva el suyo.
  const listingPages = pdf.getNumberOfPages()
  for (let page = 1; page <= listingPages; page++) {
    pdf.setPage(page)
    pdf.setDrawColor(...accent).setLineWidth(1).line(LEFT, FOOTER_Y, RIGHT, FOOTER_Y)
    text(
      `Listado de ${copy.plural} ${period}`,
      LEFT,
      FOOTER_Y + 11,
      8,
      true,
      'left',
      accent,
    )
    text(
      `Hoja ${page} de ${listingPages} del listado`,
      RIGHT,
      FOOTER_Y + 11,
      8,
      false,
      'right',
      MUTED,
    )
    if (kind === 'invoice')
      text(
        'Documento de control administrativo. No es comprobante fiscal.',
        LEFT,
        FOOTER_Y + 22,
        6.5,
        false,
        'left',
        MUTED,
      )
  }
  pdf.setPage(listingPages)

  // ── Documentos completos ──────────────────────────────────────────────
  for (let index = 0; index < documents.length; index++) {
    layoutDocumentPdf(documents[index], logo, pdf)
    if ((index + 1) % 20 === 0) {
      onProgress?.(index + 1, documents.length)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  onProgress?.(documents.length, documents.length)
  return pdf
}

export async function renderPeriodPdf(
  kind: DocumentKind,
  range: ReportRange,
  documents: DocumentRecord[],
  logo: Uint8Array,
  options?: PeriodPdfOptions,
): Promise<Blob> {
  const pdf = await layoutPeriodPdf(kind, range, documents, logo, options)
  return pdf.output('blob')
}

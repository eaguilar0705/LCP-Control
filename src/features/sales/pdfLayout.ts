import { jsPDF } from 'jspdf'
import {
  documentCopy,
  labels,
  returnPolicy,
  type DocumentRecord,
} from '../../lib/domain'
import { formatCurrency, formatDate } from '../../lib/format'
import { equivalentAmount, priceTierLabels } from '../../lib/pricing'
import { includedTax } from './document'

/**
 * PDF de factura/proforma en carta, comprimido para que hasta 40 productos
 * quepan en una sola hoja. Coordenadas en puntos (612 × 792).
 *
 * La tabla elige el tamaño de letra más grande (10 → 8 pt, siempre en
 * negrita) con el que todos los renglones caben en la hoja junto con el
 * resumen, las firmas y el pie. Si ni con 8 pt caben, el documento continúa
 * en otra hoja con el encabezado de la tabla repetido.
 *
 * Las facturas llevan además la política de cambios en el pie; para hacerle
 * sitio, sus firmas y su pie suben unos puntos (ver `BOTTOM`).
 */
type RGB = [number, number, number]
const PAGE = { left: 30, right: 582, width: 552 }
const COLUMNS = {
  line: 30,
  quantity: 52,
  description: 86,
  unit: 380,
  total: 481,
}
const DESCRIPTION_WIDTH = COLUMNS.unit - COLUMNS.description - 10
const FONT_SIZES = [10, 9.5, 9, 8.5, 8] as const
const MIN_PAD = 2.2
const MAX_PAD = 9
/**
 * Posiciones del final de la hoja. `continued`: última línea útil de la tabla
 * en hojas que continúan; `summary`: límite inferior del resumen (deja
 * espacio para firmar). La factura sube 16 pt para la política de cambios.
 */
const BOTTOM = {
  proforma: { continued: 742, summary: 700, signature: 728, footer: 756 },
  invoice: { continued: 726, summary: 692, signature: 718, footer: 740 },
} as const
/** Interlineado de la política de cambios (letra de 6,8 pt). */
const POLICY_LINE = 8.2

const INK: RGB = [20, 16, 14]
const MUTED: RGB = [92, 81, 74]
const RULE: RGB = [185, 173, 163]
const ZEBRA: RGB = [247, 243, 238]

export interface PdfRowPlan {
  fontSize: number
  lineHeight: number
  padding: number
  singlePage: boolean
}

/**
 * Densidad de la tabla. `lines` es el número de líneas de cada descripción
 * para cada tamaño de letra; `available` el alto disponible en una sola hoja.
 */
export function planPdfRows(
  lineCounts: (fontSize: number) => number[],
  available: number,
): PdfRowPlan {
  for (const fontSize of FONT_SIZES) {
    const lines = lineCounts(fontSize)
    const lineHeight = fontSize * 1.15
    const text = lines.reduce((sum, n) => sum + n * lineHeight, 0)
    const padding = lines.length ? (available - text) / lines.length : MAX_PAD
    if (padding >= MIN_PAD)
      return {
        fontSize,
        lineHeight,
        padding: Math.min(MAX_PAD, padding),
        singlePage: true,
      }
  }
  return { fontSize: 9, lineHeight: 9 * 1.15, padding: 3, singlePage: false }
}

/** El logo se incrusta una sola vez aunque el PDF traiga cientos de hojas. */
export const LOGO_ALIAS = 'lcp-wordmark'

export function newLetterPdf() {
  return new jsPDF({ unit: 'pt', format: 'letter', compress: true })
}

/**
 * Dibuja el documento en un PDF nuevo o, con `target`, a continuación de las
 * hojas que ya tenga (el PDF de un periodo junta muchos). La numeración
 * «1 / 2» del pie es la de este documento, no la del archivo.
 */
export function layoutDocumentPdf(
  d: DocumentRecord,
  logo: Uint8Array,
  target?: jsPDF,
): jsPDF {
  const tax = d.taxRate == null ? null : includedTax(d.total, d.taxRate)
  // La tasa con la que se cotizó este documento, no la del dólar de hoy.
  const rate = d.catalogRate ?? (d.currency === 'USD' ? d.exchangeRate : null)
  const equivalent = equivalentAmount(d.total, d.currency, rate)
  const pdf = target ?? newLetterPdf()
  if (target) pdf.addPage()
  const firstPage = pdf.getNumberOfPages()
  const accent: RGB = d.kind === 'invoice' ? [87, 23, 28] : [122, 85, 18]
  const { left, right, width } = PAGE
  const {
    continued: CONTINUED_BOTTOM,
    summary: SUMMARY_BOTTOM,
    signature: SIGNATURE_Y,
    footer: FOOTER_Y,
  } = BOTTOM[d.kind]
  const money = (n: number) => formatCurrency(n, d.currency).replace(/\s/g, ' ')
  const clean = (s: string) => s.replace(/\s/g, ' ').trim()

  function text(
    s: string | string[],
    x: number,
    y: number,
    size = 8.5,
    bold = false,
    align: 'left' | 'right' | 'center' = 'left',
    color: RGB = INK,
  ) {
    pdf
      .setFont('helvetica', bold ? 'bold' : 'normal')
      .setFontSize(size)
      .setTextColor(...color)
    pdf.text(s, x, y, { align, lineHeightFactor: 1.15 })
  }
  function wrap(s: string, w: number, size: number, bold = false): string[] {
    pdf.setFont('helvetica', bold ? 'bold' : 'normal').setFontSize(size)
    return pdf.splitTextToSize(clean(s), w) as string[]
  }
  /** «ETIQUETA valor» en una línea; devuelve la x donde termina. */
  function field(
    label: string,
    value: string | string[],
    x: number,
    y: number,
    bold = false,
    size = 8.5,
  ) {
    text(label, x, y, 6.5, true, 'left', MUTED)
    pdf.setFont('helvetica', 'bold').setFontSize(6.5)
    const offset = pdf.getTextWidth(label) + 4
    text(value, x + offset, y, size, bold)
    return offset
  }

  // ── Encabezado ────────────────────────────────────────────────────────
  function header(continued: boolean) {
    pdf.setFillColor(...accent).rect(left, 22, width, 3, 'F')
    pdf.addImage(logo, 'JPEG', left, 31, 118, 53.8, LOGO_ALIAS)
    const address = wrap(
      d.issuer.address || 'Dirección: ______________________________',
      220,
      8,
    ).slice(0, 2)
    text(address, left + 130, 52, 8, false, 'left', MUTED)
    text(
      `${d.issuer.phone ? `Tel. ${d.issuer.phone}` : 'Teléfono: ______________'} · RUC: ______________`,
      left + 130,
      52 + address.length * 9.2,
      8,
      false,
      'left',
      MUTED,
    )
    pdf.setFillColor(246, 241, 234).roundedRect(392, 31, 190, 56, 3, 3, 'F')
    pdf.setFillColor(...accent).rect(392, 31, 2.5, 56, 'F')
    text(documentCopy[d.kind].stamp, 572, 49, 16, true, 'right', accent)
    text(d.number, 572, 63, 11, true, 'right', accent)
    text(
      continued
        ? 'CONTINUACIÓN'
        : d.previewKind === 'example'
          ? 'EJEMPLO / SIN EMITIR'
          : d.previewKind === 'draft'
            ? 'BORRADOR / SIN EMITIR'
            : 'DOCUMENTO EMITIDO',
      572,
      73,
      6.5,
      true,
      'right',
      accent,
    )
    text(`Fecha: ${formatDate(d.createdAt)}`, 572, 83, 8, false, 'right')
    return 95
  }

  function client(y: number) {
    const c1 = left + 8,
      c2 = left + 262,
      c3 = left + 408
    pdf.setFont('helvetica', 'bold').setFontSize(6.5)
    const nameOffset = pdf.getTextWidth('CLIENTE / RAZÓN SOCIAL') + 4
    const name = wrap(d.customerName, c2 - c1 - nameOffset - 8, 9, true).slice(
      0,
      2,
    )
    const extra = (name.length - 1) * 10.4
    const height = 44 + extra
    pdf
      .setDrawColor(...RULE)
      .setLineWidth(0.6)
      .roundedRect(left, y, width, height, 3, 3)
    const row1 = y + 12
    field('CLIENTE / RAZÓN SOCIAL', name, c1, row1, true, 9)
    field('RUC / ID', d.customerTaxId || '______________', c2, row1)
    field('TELÉFONO', d.customerPhone || '______________', c3, row1)
    const row2 = row1 + 12 + extra
    field(
      'LISTA · MONEDA',
      `${priceTierLabels[d.tier]} · ${d.currency === 'NIO' ? 'Córdobas (C$)' : 'Dólares (US$)'}`,
      c1,
      row2,
    )
    field(
      d.kind === 'proforma' ? 'VIGENCIA' : 'PAGO',
      d.kind === 'proforma'
        ? d.validUntil
          ? formatDate(d.validUntil)
          : '____________'
        : d.paymentMethod && d.paymentMethod !== 'pending'
          ? labels.payment[d.paymentMethod]
          : 'Pendiente',
      c2,
      row2,
    )
    if (d.currency === 'USD' && d.exchangeRate != null)
      field('T. CAMBIO', `${d.exchangeRate} NIO por USD`, c3, row2)
    field(
      'DIRECCIÓN',
      '________________________________________',
      c1,
      row2 + 12,
    )
    return y + height
  }

  function tableHeading(y: number) {
    pdf.setFillColor(...accent).rect(left, y, width, 15, 'F')
    for (const [label, x, align] of [
      ['N.º', 41, 'center'],
      ['CANT.', 69, 'center'],
      ['DESCRIPCIÓN', COLUMNS.description + 5, 'left'],
      ['PRECIO UNIT.', COLUMNS.total - 6, 'right'],
      ['IMPORTE', right - 6, 'right'],
    ] as const)
      text(label, x, y + 10.3, 7.5, true, align, [255, 255, 255])
    return y + 15
  }

  // ── Resumen: se mide antes para saber cuánto alto queda para la tabla ──
  const notes = wrap(
    d.notes || 'Gracias por elegir La Casa del Perfume.',
    300,
    8,
  )
  const units = d.items.reduce((sum, item) => sum + item.quantity, 0)
  const location =
    d.kind === 'invoice' && d.location
      ? `Entrega desde: ${labels.location[d.location]}`
      : null
  const notesHeight = 22 + notes.length * 9.2 + (location ? 11 : 0)
  const totalsHeight = 12 + (tax ? 12 : 0) + 26 + (equivalent ? 12 : 0)
  const summaryHeight = Math.max(notesHeight, totalsHeight)

  function summary(top: number) {
    const count = `${d.items.length} ${d.items.length === 1 ? 'producto' : 'productos'} · ${units} ${units === 1 ? 'unidad' : 'unidades'}`
    text(count, left, top + 8, 8, true)
    text('OBSERVACIONES', left, top + 19, 6.5, true, 'left', MUTED)
    text(notes, left, top + 28, 8)
    if (location) text(location, left, top + 28 + notes.length * 9.2 + 2, 8)
    const x = 372
    let y = top + 8
    text(tax ? 'Subtotal sin impuesto' : 'Subtotal (sin desglose)', x, y, 8.5)
    text(money(tax?.net ?? d.total), right, y, 9, true, 'right')
    if (tax) {
      y += 12
      text(`Impuesto incluido (${d.taxRate} %)`, x, y, 8.5)
      text(money(tax.tax), right, y, 9, true, 'right')
    }
    pdf
      .setFillColor(...accent)
      .roundedRect(x - 4, y + 5, right - x + 4, 22, 3, 3, 'F')
    text(
      `TOTAL ${d.currency}`,
      x + 4,
      y + 19.5,
      9,
      true,
      'left',
      [255, 255, 255],
    )
    text(
      money(d.total),
      right - 8,
      y + 20.5,
      13,
      true,
      'right',
      [255, 255, 255],
    )
    if (equivalent)
      text(
        `Equivale a ${formatCurrency(equivalent.amount, equivalent.currency).replace(/\s/g, ' ')} (a ${rate} C$ por dólar)`,
        right,
        y + 38,
        7.5,
        false,
        'right',
        MUTED,
      )
  }

  // ── Tabla ────────────────────────────────────────────────────────────
  let y = client(header(false) + 2) + 7
  const tableTop = y + 15
  // 1 pt de holgura: el redondeo no debe empujar el resumen a otra hoja.
  const available = SUMMARY_BOTTOM - summaryHeight - 10 - tableTop - 1
  const plan = planPdfRows(
    (size) =>
      d.items.map(
        (item) => wrap(item.description, DESCRIPTION_WIDTH, size, true).length,
      ),
    available,
  )
  const { fontSize, lineHeight, padding } = plan
  y = tableHeading(y)
  d.items.forEach((item, index) => {
    const lines = wrap(item.description, DESCRIPTION_WIDTH, fontSize, true)
    const height = lines.length * lineHeight + padding
    if (y + height > CONTINUED_BOTTOM) {
      pdf.addPage()
      y = tableHeading(header(true) + 4)
    }
    if (index % 2 === 1)
      pdf.setFillColor(...ZEBRA).rect(left, y, width, height, 'F')
    pdf
      .setDrawColor(...RULE)
      .setLineWidth(0.5)
      .line(left, y + height, right, y + height)
    const baseline = y + padding / 2 + fontSize * 0.86
    text(
      String(index + 1),
      41,
      baseline,
      fontSize - 1.5,
      false,
      'center',
      MUTED,
    )
    text(String(item.quantity), 69, baseline, fontSize, true, 'center')
    text(lines, COLUMNS.description + 5, baseline, fontSize, true)
    text(
      money(item.unitPrice),
      COLUMNS.total - 6,
      baseline,
      fontSize,
      true,
      'right',
    )
    text(money(item.lineTotal), right - 6, baseline, fontSize, true, 'right')
    y += height
  })
  pdf
    .setDrawColor(...accent)
    .setLineWidth(1.2)
    .line(left, y, right, y)

  // ── Resumen, firmas y pie ────────────────────────────────────────────
  if (y + 10 + summaryHeight > SUMMARY_BOTTOM) {
    pdf.addPage()
    y = header(true) + 4
  }
  summary(y + 6)
  pdf.setDrawColor(...MUTED).setLineWidth(0.6)
  pdf
    .line(70, SIGNATURE_Y, 250, SIGNATURE_Y)
    .line(362, SIGNATURE_Y, 542, SIGNATURE_Y)
  text('Elaborado por', 160, SIGNATURE_Y + 10, 8, false, 'center')
  text(
    d.kind === 'invoice' ? 'Recibido por' : 'Aceptación del cliente',
    452,
    SIGNATURE_Y + 10,
    8,
    false,
    'center',
  )
  /** Política de cambios: título en negrita y texto en la misma línea. */
  function policy(y: number) {
    const title = returnPolicy.title.toUpperCase()
    pdf.setFont('helvetica', 'bold').setFontSize(6.8)
    const titleWidth = pdf.getTextWidth(title) + 3
    const [first, ...rest] = wrap(returnPolicy.text, width - titleWidth, 6.8)
    text(title, left, y, 6.8, true)
    text(first, left + titleWidth, y, 6.8)
    const tail = wrap(rest.join(' '), width, 6.8)
    if (rest.length) text(tail, left, y + POLICY_LINE, 6.8)
    return y + POLICY_LINE * (1 + (rest.length ? tail.length : 0))
  }
  const lastPage = pdf.getNumberOfPages()
  const pageCount = lastPage - firstPage + 1
  const notice = `${d.previewKind === 'example' ? 'Ejemplo de diseño; no registra una venta. ' : d.previewKind === 'draft' ? 'Borrador sin emitir. ' : ''}${d.kind === 'invoice' ? 'Documento de control administrativo. No es comprobante fiscal. Desglose según la tasa de impuesto registrada.' : 'Cotización sujeta a disponibilidad. No constituye factura ni comprobante de pago.'}`
  for (let page = firstPage; page <= lastPage; page++) {
    pdf.setPage(page)
    pdf
      .setDrawColor(...accent)
      .setLineWidth(1)
      .line(left, FOOTER_Y, right, FOOTER_Y)
    text(
      'Gracias por tu confianza.',
      left,
      FOOTER_Y + 11,
      9,
      true,
      'left',
      accent,
    )
    text(
      `${page - firstPage + 1} / ${pageCount}`,
      right,
      FOOTER_Y + 11,
      8,
      false,
      'right',
      MUTED,
    )
    const noticeY =
      d.kind === 'invoice' ? policy(FOOTER_Y + 20) + 0.8 : FOOTER_Y + 21
    text(wrap(notice, width, 6.5), left, noticeY, 6.5, false, 'left', MUTED)
  }
  pdf.setPage(lastPage)
  return pdf
}

export function renderDocumentPdf(d: DocumentRecord, logo: Uint8Array): Blob {
  return layoutDocumentPdf(d, logo).output('blob')
}

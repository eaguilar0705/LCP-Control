import { buildWorkbook, type CellValue, type Sheet } from '../../lib/xlsx'
import { priceTierLabels } from '../../lib/pricing'
import { documentCopy, labels, type DocumentKind, type DocumentRecord } from '../../lib/domain'
import { includedTax } from './document'

/**
 * Libro con todos los documentos emitidos de un tipo. Dos hojas porque una
 * factura tiene varios renglones: «Facturas» lleva una fila por documento con
 * todos sus datos de encabezado y totales, y «Detalle» una fila por producto
 * vendido con el número de su factura, para poder cruzarlas o filtrar en Excel.
 * Las cifras van como números para que se puedan sumar sin limpiar el archivo.
 */
const managuaDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Managua',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const managuaTime = new Intl.DateTimeFormat('es-NI', {
  timeZone: 'America/Managua',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function day(value: string) {
  return managuaDate.format(new Date(value))
}
function time(value: string) {
  return managuaTime.format(new Date(value))
}
function paymentLabel(method: DocumentRecord['paymentMethod']) {
  if (!method) return ''
  return method === 'pending' ? 'Pendiente de pago' : labels.payment[method]
}
function round(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}
/** Córdobas de la operación con su propia tasa; vacío si no se guardó. */
function totalNio(document: DocumentRecord) {
  if (document.currency === 'NIO') return document.total
  return document.exchangeRate ? round(document.total * document.exchangeRate) : null
}

export function buildDocumentsWorkbook(
  kind: DocumentKind,
  documents: DocumentRecord[],
  options: { generatedAt?: Date; truncated?: boolean } = {},
): Blob {
  return buildWorkbook(documentsSheets(kind, documents, options))
}

export function documentsSheets(
  kind: DocumentKind,
  documents: DocumentRecord[],
  { generatedAt = new Date(), truncated = false }: { generatedAt?: Date; truncated?: boolean } = {},
): Sheet[] {
  const copy = documentCopy[kind]
  const title = kind === 'invoice' ? 'Facturas' : 'Proformas'
  const notes = [
    `La Casa del Perfume · ${title} emitidas`,
    `Generado el ${day(generatedAt.toISOString())} a las ${time(generatedAt.toISOString())} · ${documents.length} ${copy.plural}`,
    ...(truncated ? ['Aviso: se alcanzó el límite de filas; el archivo no incluye todos los documentos.'] : []),
  ]
  const invoiceOnly = kind === 'invoice'

  const header: Sheet = {
    name: title,
    notes,
    columns: [
      { header: 'Número', width: 14 },
      { header: 'Fecha', width: 12, format: 'date' },
      { header: 'Hora', width: 8 },
      { header: 'Cliente', width: 30 },
      { header: 'Cédula / RUC', width: 18 },
      { header: 'Teléfono', width: 14 },
      { header: 'Lista de precios', width: 14 },
      { header: 'Moneda', width: 8 },
      { header: 'Tipo de cambio (NIO por USD)', width: 14, format: 'number' },
      { header: 'Tasa del catálogo', width: 12, format: 'number' },
      { header: 'Impuesto %', width: 10, format: 'number' },
      { header: 'Subtotal sin impuesto', width: 16, format: 'money' },
      { header: 'Impuesto incluido', width: 14, format: 'money' },
      { header: 'Total', width: 14, format: 'money' },
      { header: 'Total en NIO', width: 14, format: 'money' },
      { header: invoiceOnly ? 'Forma de pago' : 'Vigente hasta', width: 20 },
      { header: invoiceOnly ? 'Salida de' : 'Ubicación', width: 10 },
      { header: 'Productos', width: 10, format: 'integer' },
      { header: 'Unidades', width: 10, format: 'integer' },
      { header: 'Notas', width: 40 },
      { header: 'Negocio emisor', width: 22 },
      { header: 'Dirección del emisor', width: 30 },
      { header: 'Teléfono del emisor', width: 14 },
      { header: 'ID del documento', width: 38 },
    ],
    rows: documents.map((document): CellValue[] => {
      const rate = document.taxRate
      const tax = rate === undefined || rate === null || !Number.isFinite(rate) ? null : includedTax(document.total, rate)
      return [
        document.number,
        day(document.createdAt),
        time(document.createdAt),
        document.customerName,
        document.customerTaxId ?? '',
        document.customerPhone ?? '',
        priceTierLabels[document.tier] ?? document.tier,
        document.currency,
        document.exchangeRate ?? null,
        document.catalogRate ?? null,
        rate ?? null,
        tax ? tax.net : null,
        tax ? tax.tax : null,
        document.total,
        totalNio(document),
        invoiceOnly ? paymentLabel(document.paymentMethod) : (document.validUntil ?? ''),
        document.location ? labels.location[document.location] : '',
        document.items.length,
        document.items.reduce((sum, item) => sum + item.quantity, 0),
        document.notes ?? '',
        document.issuer?.name ?? '',
        document.issuer?.address ?? '',
        document.issuer?.phone ?? '',
        document.id,
      ]
    }),
  }

  const detail: Sheet = {
    name: 'Detalle',
    notes: [`La Casa del Perfume · Detalle de ${copy.plural}`, 'Una fila por producto. El número enlaza cada renglón con la hoja anterior.'],
    columns: [
      { header: 'Número', width: 14 },
      { header: 'Fecha', width: 12, format: 'date' },
      { header: 'Cliente', width: 30 },
      { header: 'Renglón', width: 8, format: 'integer' },
      { header: 'Producto', width: 44 },
      { header: 'Cantidad', width: 10, format: 'integer' },
      { header: 'Precio unitario', width: 14, format: 'money' },
      { header: 'Importe', width: 14, format: 'money' },
      { header: 'Moneda', width: 8 },
      { header: 'Lista de precios', width: 14 },
      { header: 'ID del producto', width: 38 },
    ],
    rows: documents.flatMap((document) =>
      document.items.map((item, index): CellValue[] => [
        document.number,
        day(document.createdAt),
        document.customerName,
        index + 1,
        item.description,
        item.quantity,
        item.unitPrice,
        item.lineTotal,
        document.currency,
        priceTierLabels[document.tier] ?? document.tier,
        item.productId,
      ]),
    ),
  }
  return [header, detail]
}

export function documentsFileName(kind: DocumentKind, now: Date = new Date()) {
  return `${kind === 'invoice' ? 'facturas' : 'proformas'}-${day(now.toISOString())}.xlsx`
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

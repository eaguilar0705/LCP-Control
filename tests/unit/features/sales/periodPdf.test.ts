// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { layoutPeriodPdf, periodTotals } from '@/features/sales/periodPdf'
import { layoutDocumentPdf } from '@/features/sales/pdfLayout'
import { exampleDocument } from '@/features/sales/example'
import type { DocumentRecord } from '@/lib/domain'

const logo = new Uint8Array(readFileSync('public/brand/wordmark-wine.jpeg'))
const range = { from: '2026-09-01', to: '2026-09-30' }

function invoices(count: number, items = 3): DocumentRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    ...exampleDocument('invoice', items),
    previewKind: undefined,
    id: `doc-${index}`,
    number: `FAC-${String(index + 1).padStart(6, '0')}`,
    customerName: `Cliente ${index + 1}`,
    createdAt: new Date(Date.UTC(2026, 8, 1, 15) + index * 3_600_000).toISOString(),
  }))
}
function content(pdf: { internal: unknown }) {
  return (pdf.internal as { pages: (string[] | null)[] }).pages
    .flatMap((page) => page ?? [])
    .join('\n')
}

describe('totales del periodo', () => {
  const base = invoices(4)
  const documents: DocumentRecord[] = [
    { ...base[0], currency: 'NIO', total: 1000, paymentMethod: 'cash' },
    { ...base[1], currency: 'NIO', total: 500.5, paymentMethod: 'pending' },
    {
      ...base[2],
      currency: 'USD',
      total: 100,
      exchangeRate: 36.62,
      paymentMethod: 'cash',
    },
    {
      ...base[3],
      currency: 'USD',
      total: 50,
      exchangeRate: 36.7,
      paymentMethod: 'bank_transfer',
    },
  ]

  it('suma por moneda, por forma de pago y en córdobas con la tasa de cada factura', () => {
    const totals = periodTotals(documents)
    expect(totals.count).toBe(4)
    expect(totals.byCurrency).toEqual({
      NIO: { count: 2, total: 1500.5 },
      USD: { count: 2, total: 150 },
    })
    // 1500.50 + 100 × 36.62 + 50 × 36.70
    expect(totals.totalNio).toBe(6997.5)
    expect(totals.byPayment.map((row) => [row.key, row.count, row.totals])).toEqual([
      ['cash', 2, { NIO: 1000, USD: 100 }],
      ['bank_transfer', 1, { NIO: 0, USD: 50 }],
      ['pending', 1, { NIO: 500.5, USD: 0 }],
    ])
  })

  it('no inventa el total en córdobas si una factura en dólares no guardó su tasa', () => {
    const missing = [{ ...documents[2], exchangeRate: null }]
    expect(periodTotals(missing).totalNio).toBeNull()
  })
})

describe('PDF del periodo', () => {
  it('lleva el listado y después cada factura completa, con su propia numeración', async () => {
    const documents = invoices(3)
    const pdf = await layoutPeriodPdf('invoice', range, documents, logo)
    // 1 hoja de listado + 1 por factura.
    expect(pdf.getNumberOfPages()).toBe(4)
    const text = content(pdf)
    expect(text).toContain('FACTURAS EMITIDAS')
    expect(text).toContain('del 01/09/2026 al 30/09/2026')
    expect(text).toContain('Hoja 1 de 1 del listado')
    for (const document of documents) expect(text).toContain(document.number)
    expect(text.match(/\(1 \/ 1\)/g)).toHaveLength(3)
  })

  it('el listado continúa en otra hoja con el encabezado de la tabla repetido', async () => {
    const pdf = await layoutPeriodPdf('invoice', range, invoices(60, 1), logo)
    expect(pdf.getNumberOfPages()).toBe(62)
    const text = content(pdf)
    expect(text).toContain('Hoja 2 de 2 del listado')
    expect(text).toContain('CONTINUACI')
  })

  it('una factura larga numera sus hojas 1 / 2 y 2 / 2 dentro del archivo', async () => {
    const long = invoices(1, 40)[0]
    long.items = [...long.items, ...long.items].map((item, index) => ({
      ...item,
      id: String(index),
    }))
    const pdf = await layoutPeriodPdf('invoice', range, [long], logo)
    expect(pdf.getNumberOfPages()).toBe(3)
    const text = content(pdf)
    expect(text).toContain('(1 / 2)')
    expect(text).toContain('(2 / 2)')
  })

  it('incrusta el logo una sola vez aunque el archivo tenga muchas hojas', async () => {
    const pdf = await layoutPeriodPdf('invoice', range, invoices(25, 1), logo)
    const output = pdf.output()
    expect(output.match(/\/Subtype \/Image/g)).toHaveLength(1)
  })

  it('avisa el avance y termina con el total', async () => {
    const progress = vi.fn()
    await layoutPeriodPdf('invoice', range, invoices(45, 1), logo, {
      onProgress: progress,
    })
    expect(progress).toHaveBeenCalledWith(20, 45)
    expect(progress).toHaveBeenLastCalledWith(45, 45)
  })

  it('una factura sola sigue saliendo igual que antes', () => {
    const pdf = layoutDocumentPdf(invoices(1)[0], logo)
    expect(pdf.getNumberOfPages()).toBe(1)
    expect(content(pdf)).toContain('(1 / 1)')
  })
})

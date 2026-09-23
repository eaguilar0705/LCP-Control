// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { layoutDocumentPdf, planPdfRows } from '@/features/sales/pdfLayout'
import { exampleDocument } from '@/features/sales/example'
import { printDensity } from '@/features/sales/printDensity'

const logo = new Uint8Array(readFileSync('public/brand/wordmark-wine.jpeg'))

describe('PDF comprimido de facturas y proformas', () => {
  it.each([
    ['invoice', 20],
    ['invoice', 30],
    ['invoice', 40],
    ['proforma', 40],
  ] as const)('%s con %i productos ocupa una sola hoja', (kind, count) => {
    const pdf = layoutDocumentPdf(exampleDocument(kind, count), logo)
    expect(pdf.getNumberOfPages()).toBe(1)
  })
  it('continúa en otra hoja cuando no cabe ni con la letra mínima', () => {
    const document = exampleDocument('invoice', 40)
    document.items = [...document.items, ...document.items].map((item, i) => ({
      ...item,
      id: String(i),
    }))
    expect(layoutDocumentPdf(document, logo).getNumberOfPages()).toBe(2)
  })
  it('usa la letra más grande que cabe y nunca baja de 8 pt', () => {
    const few = planPdfRows(() => [1, 1, 1], 450)
    expect(few).toMatchObject({ fontSize: 10, singlePage: true })
    expect(few.padding).toBeLessThanOrEqual(9)
    const forty = planPdfRows(() => Array(40).fill(1), 470)
    expect(forty.singlePage).toBe(true)
    expect(forty.fontSize).toBeGreaterThanOrEqual(8)
    expect(planPdfRows(() => Array(80).fill(1), 450).singlePage).toBe(false)
  })
})

describe('densidad de la impresión HTML', () => {
  it('se compacta según los renglones', () => {
    expect(printDensity(exampleDocument('invoice', 3))).toBe('regular')
    expect(printDensity(exampleDocument('invoice', 20))).toBe('compact')
    expect(printDensity(exampleDocument('invoice', 30))).toBe('dense')
    expect(printDensity(exampleDocument('invoice', 40))).toBe('dense')
  })
})

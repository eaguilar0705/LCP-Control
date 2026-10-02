// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { layoutDocumentPdf, planPdfRows } from '@/features/sales/pdfLayout'
import { exampleDocument } from '@/features/sales/example'
import { printDensity } from '@/features/sales/printDensity'
import { returnPolicy } from '@/lib/domain'
import { businessIdentityLines, businessFromRow } from '@/lib/business'

const logo = new Uint8Array(readFileSync('public/brand/wordmark-wine.jpeg'))

it.each(['invoice', 'proforma'] as const)('conserva los datos completos del emisor en el PDF de %s', (kind) => {
  const document = exampleDocument(kind, 40)
  document.previewKind = undefined
  document.issuer = businessFromRow({ name: 'La Casa del Perfume', legal_name: 'Perfumes del Centro', tax_id: 'J0310000000001', address: 'Direccion completa del negocio', phone: '55550100', email: 'tienda@example.test', branch: 'Centro', billing_details: 'Serie A' })
  const pdf = layoutDocumentPdf(document, logo)
  const pages = (pdf.internal as unknown as { pages: string[][] }).pages.flat().join('\n')
  const words = [...pages.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map(match => match[1].replace(/\\([\\()])/g, '$1')).join(' ')
  for (const line of businessIdentityLines(document.issuer)) expect(words).toContain(line)
  expect(words).not.toContain('comprobante fiscal')
  expect(words).not.toContain('Ejemplo de diseño')
  expect(pdf.getNumberOfPages()).toBe(1)
})

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
  it('imprime la política de cambios sólo en facturas', () => {
    const content = (kind: 'invoice' | 'proforma') =>
      (
        layoutDocumentPdf(exampleDocument(kind, 3), logo)
          .internal as unknown as {
          pages: string[][]
        }
      ).pages
        .flat()
        .join('\n')
    const invoice = content('invoice')
    const words = [...invoice.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
      .map((match) => match[1].replace(/\\([\\()])/g, '$1'))
      .join(' ')
    expect(words).toContain(returnPolicy.text.replace(/\s+/g, ' '))
    expect(content('proforma')).not.toContain('Por favor, revise su producto')
    for (const block of invoice
      .split('BT')
      .filter((block) =>
        /Por favor, revise|En caso de presentar|El producto deberá/.test(block),
      )) {
      expect(block).toContain('/F2 7.5 Tf')
    }
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

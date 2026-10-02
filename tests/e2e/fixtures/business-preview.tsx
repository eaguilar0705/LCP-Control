import { createRoot } from 'react-dom/client'
import { DocumentPrint } from '../../../src/features/sales/DocumentPrint'
import { exampleDocument } from '../../../src/features/sales/example'
import { layoutDocumentPdf } from '../../../src/features/sales/pdfLayout'

export async function preview(kind: 'invoice' | 'proforma', extended = false) {
  const document = exampleDocument(kind, 40)
  document.previewKind = undefined
  document.notes = ''
  document.customerName = 'Cliente de verificacion'
  document.number = kind === 'invoice' ? 'FAC-QA' : 'PRO-QA'
  document.issuer = {
    name: 'La Casa del Perfume', legalName: 'Perfumes del Centro', taxId: 'J0310000000001',
    address: extended ? 'Direccion completa de la sucursal. '.repeat(17) : 'Managua, Plaza Central, modulo 5',
    phone: '55550100', email: 'tienda@example.test', branch: 'Centro',
    billingDetails: extended ? 'Informacion adicional de facturacion. '.repeat(6) : 'Serie A',
  }
  const node = window.document.createElement('div')
  window.document.body.replaceChildren(node)
  createRoot(node).render(<DocumentPrint document={document} />)
  const logo = new Uint8Array(await (await fetch('/brand/wordmark-wine.jpeg')).arrayBuffer())
  return Array.from(new Uint8Array(layoutDocumentPdf(document, logo).output('arraybuffer')))
}

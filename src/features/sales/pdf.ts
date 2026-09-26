import { documentCopy } from '../../lib/domain'
import type { DocumentKind, DocumentRecord } from '../../lib/domain'
import type { ReportRange } from '../reports/model'
import { periodFileName } from './period'

// Escaped on purpose: literal combining marks are invisible and easy to break.
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g')

export function documentFileName(document: DocumentRecord) {
  return `${document.number}-${document.customerName}`
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .concat('.pdf')
}

/** jsPDF is loaded on demand: the invoice screens work without it until the
 * operator actually asks for a PDF. */
let logoPromise: Promise<Uint8Array> | null = null
function loadLogo() {
  logoPromise ??= fetch('/brand/wordmark-wine.jpeg')
    .then(async (response) => {
      if (!response.ok) throw new Error('No pudimos cargar el logo.')
      return new Uint8Array(await response.arrayBuffer())
    })
    .catch((error) => {
      logoPromise = null
      throw error
    })
  return logoPromise
}
export async function buildDocumentPdf(
  document: DocumentRecord,
): Promise<Blob> {
  const { renderDocumentPdf } = await import('./pdfLayout')
  return renderDocumentPdf(document, await loadLogo())
}

/** Listado del periodo seguido de cada documento completo, en un solo PDF. */
export async function downloadPeriodPdf(
  kind: DocumentKind,
  range: ReportRange,
  documents: DocumentRecord[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const [{ renderPeriodPdf }, logo] = await Promise.all([
    import('./periodPdf'),
    loadLogo(),
  ])
  const blob = await renderPeriodPdf(kind, range, documents, logo, {
    onProgress,
  })
  downloadBlob(blob, periodFileName(kind, range))
}

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled'

/** Mobile gets the native share sheet (WhatsApp included); desktop, where the
 * API cannot attach files, gets the download so it can be attached by hand. */
export async function shareDocumentPdf(
  document: DocumentRecord,
): Promise<ShareOutcome> {
  const blob = await buildDocumentPdf(document)
  const name = documentFileName(document)
  const file = new File([blob], name, { type: 'application/pdf' })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: `${documentCopy[document.kind].stamp} ${document.number}`,
      })
      return 'shared'
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') return 'cancelled'
    }
  }
  downloadBlob(blob, name)
  return 'downloaded'
}

export async function downloadDocumentPdf(
  document: DocumentRecord,
): Promise<void> {
  downloadBlob(await buildDocumentPdf(document), documentFileName(document))
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = window.document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  window.document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

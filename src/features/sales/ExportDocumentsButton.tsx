import { useState } from 'react'
import { FileSpreadsheet } from 'lucide-react'
import { Button } from '../../components/ui'
import { useServices } from '../../services/useServices'
import { errorMessage } from '../../lib/errors'
import type { DocumentKind } from '../../lib/domain'
import { buildDocumentsWorkbook, documentsFileName, downloadBlob } from './documentExport'

/**
 * Descarga en Excel todos los documentos emitidos de un tipo, con todos sus
 * campos. Consulta la base en el momento: no depende de lo que haya cargado la
 * pantalla, que sólo muestra los más recientes.
 */
export function ExportDocumentsButton({ kind }: { kind: DocumentKind }) {
  const { salesService } = useServices()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null)
  const plural = kind === 'invoice' ? 'facturas' : 'proformas'

  async function run() {
    setBusy(true)
    setMessage(null)
    try {
      const { documents, truncated } = await salesService.exportDocuments(kind)
      if (!documents.length) {
        setMessage({ tone: 'info', text: `Todavía no hay ${plural} emitidas para exportar.` })
        return
      }
      downloadBlob(buildDocumentsWorkbook(kind, documents, { truncated }), documentsFileName(kind))
      setMessage({
        tone: 'info',
        text: truncated
          ? `Se exportaron ${documents.length} ${plural}; se alcanzó el límite y faltan las más recientes.`
          : `Se exportaron ${documents.length} ${plural} a Excel.`,
      })
    } catch (error) {
      setMessage({ tone: 'error', text: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="export-documents">
      <Button type="button" variant="secondary" disabled={busy} aria-busy={busy} onClick={() => void run()}>
        <FileSpreadsheet size={17} />
        {busy ? 'Exportando…' : 'Exportar a Excel'}
      </Button>
      {message && (
        <small role={message.tone === 'error' ? 'alert' : 'status'} className={message.tone === 'error' ? 'inline-error' : 'muted'}>
          {message.text}
        </small>
      )}
    </span>
  )
}

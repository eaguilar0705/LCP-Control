import { FileText, Plus, ArrowUpRight, Trash2 } from 'lucide-react'
import {
  WorkspaceHeading,
  WorkspaceEmpty,
} from '../../components/WorkspacePresentation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useServices } from '../../services/useServices'
import { useAccess } from '../../app/AccessContext'
import { useQuery } from '../../lib/useQuery'
import {
  Button,
  Card,
  ConfirmDialog,
  Input,
  ErrorState,
  LoadingState,
} from '../../components/ui'
import { can } from '../../lib/permissions'
import { formatCurrency, formatDate } from '../../lib/format'
import { errorMessage } from '../../lib/errors'
import type { DocumentKind, DocumentRecord } from '../../lib/domain'
import { DocumentPrint } from './DocumentPrint'
import { downloadDocumentPdf } from './pdf'
import { ExportDocumentsButton } from './ExportDocumentsButton'
import { matchesSearch } from '../../lib/search'
export function DocumentHistory({ kind }: { kind: DocumentKind }) {
  const { salesService } = useServices()
  const { base, demo, role } = useAccess()
  const load = useCallback(
    () => salesService.listDocuments(kind, 200),
    [salesService, kind],
  )
  const { data, error, loading, retry } = useQuery(load)
  const [selected, setSelected] = useState<DocumentRecord | null>(null)
  const [search, setSearch] = useState('')
  const [failure, setFailure] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [removing, setRemoving] = useState<DocumentRecord | null>(null)
  const [reason, setReason] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [removeError, setRemoveError] = useState('')
  const [notice, setNotice] = useState('')
  // El documento abierto se dibuja debajo de la lista: con 200 tarjetas quedaba
  // fuera de la pantalla y parecía que «Ver documento» no hacía nada.
  const viewer = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!selected) return
    viewer.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    viewer.current
      ?.querySelector<HTMLButtonElement>('button')
      ?.focus({ preventScroll: true })
  }, [selected])
  const matches = (data ?? []).filter((d) =>
    matchesSearch(`${d.number} ${d.customerName}`, search),
  )
  // Sólo facturas: las proformas no mueven inventario ni contabilidad.
  const removable = kind === 'invoice' && !demo && can(role, 'document.delete')
  function askRemove(record: DocumentRecord) {
    setReason('')
    setRemoveError('')
    setNotice('')
    setRemoving(record)
  }
  async function confirmRemove() {
    if (!removing || deleting) return
    setDeleting(true)
    setRemoveError('')
    try {
      const number = await salesService.deleteInvoice(removing.id, reason.trim())
      if (selected?.id === removing.id) setSelected(null)
      setRemoving(null)
      setNotice(
        `Factura ${number} eliminada. Sus productos volvieron al inventario de ${removing.location === 'warehouse' ? 'Bodega' : 'Tienda'}.`,
      )
      retry()
    } catch (e) {
      setRemoveError(errorMessage(e))
    } finally {
      setDeleting(false)
    }
  }
  return (
    <>
      <div className="no-print">
        <WorkspaceHeading
          eyebrow="ARCHIVO DEL NEGOCIO"
          title={
            kind === 'invoice' ? 'Facturas emitidas' : 'Proformas emitidas'
          }
          description="Consulta tus documentos y vuelve a imprimirlos cuando lo necesites."
          icon={FileText}
        >
          <Link
            className="button button-primary"
            to={`${base}/${kind === 'invoice' ? 'sales' : 'proformas'}`}
          >
            <Plus size={17} />
            Crear {kind === 'invoice' ? 'factura' : 'proforma'}
          </Link>
          {kind === 'invoice' && <ExportDocumentsButton kind="invoice" />}
        </WorkspaceHeading>
        <div className="directory-toolbar">
          <Input
            label="Buscar por número o cliente"
            type="search"
            placeholder="Escribe un nombre o número de documento…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="directory-count">
            {search.trim()
              ? `${matches.length} de ${data?.length ?? 0} documentos recientes`
              : `${data?.length ?? 0} documentos recientes`}
          </span>
        </div>
        {notice && (
          <p role="status" className="page-feedback">
            {notice}
          </p>
        )}
        {loading && <LoadingState />}
        {error && <ErrorState message={error} retry={retry} />}
        <div className="record-grid">
          {matches.map((d) => (
            <Card key={d.id} className="record-card">
              <div className="record-card-top">
                <span className="record-avatar">
                  <FileText size={22} />
                </span>
                <span className="record-badge is-muted">{d.currency}</span>
              </div>
              <h2>{d.number}</h2>
              <p>
                {d.customerName} · {formatDate(d.createdAt)}
              </p>
              <strong className="document-record-total">
                {formatCurrency(d.total, d.currency)}
              </strong>
              <Button variant="secondary" onClick={() => setSelected(d)}>
                Ver documento <ArrowUpRight size={16} />
              </Button>
              {removable && (
                <Button
                  type="button"
                  variant="ghost"
                  className="record-delete"
                  aria-label={`Eliminar factura ${d.number}`}
                  onClick={() => askRemove(d)}
                >
                  <Trash2 size={14} />
                  Eliminar
                </Button>
              )}
            </Card>
          ))}
        </div>
        {!loading && !error && !matches.length && (
          <WorkspaceEmpty
            icon={FileText}
            title={
              search ? 'No encontramos ese documento' : 'Tu archivo está listo'
            }
            description={
              search
                ? 'Prueba con otro nombre o número.'
                : 'Los documentos que emitas aparecerán aquí con su detalle y su PDF.'
            }
          />
        )}
        {selected && (
          <div className="form-actions document-viewer-actions" ref={viewer}>
            <Button type="button" onClick={() => window.print()}>
              Imprimir (carta o A4)
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={downloading}
              aria-busy={downloading}
              onClick={async () => {
                setDownloading(true)
                setFailure('')
                try {
                  await downloadDocumentPdf(selected)
                } catch (e) {
                  setFailure(errorMessage(e))
                } finally {
                  setDownloading(false)
                }
              }}
            >
              {downloading ? 'Generando PDF…' : 'Descargar PDF'}
            </Button>
            {removable && (
              <Button
                type="button"
                variant="ghost"
                className="record-delete"
                onClick={() => askRemove(selected)}
              >
                <Trash2 size={16} />
                Eliminar factura
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={() => setSelected(null)}
            >
              Cerrar documento
            </Button>
          </div>
        )}
        {failure && <ErrorState message={failure} />}
        <ConfirmDialog
          open={!!removing}
          title="Eliminar factura"
          confirmLabel="Eliminar factura"
          busyLabel="Eliminando…"
          busy={deleting}
          error={removeError}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setRemoving(null)}
        >
          {removing && (
            <>
              <p>
                ¿Eliminar la factura <strong>{removing.number}</strong> de{' '}
                {removing.customerName} por{' '}
                <strong>{formatCurrency(removing.total, removing.currency)}</strong>?
                Esta acción no se puede deshacer.
              </p>
              <p className="muted">
                Los productos vuelven al inventario de{' '}
                {removing.location === 'warehouse' ? 'Bodega' : 'Tienda'} y la
                venta deja de contar en reportes y contabilidad. El número no se
                vuelve a usar.
              </p>
              <Input
                label="Motivo (opcional)"
                maxLength={500}
                value={reason}
                disabled={deleting}
                onChange={(e) => setReason(e.target.value)}
              />
            </>
          )}
        </ConfirmDialog>
      </div>
      {selected && (
        <>
          {/* Región desplazable en el teléfono: enfocable para poder
              recorrerla también con el teclado. */}
          <div
            className="example-paper no-print"
            tabIndex={0}
            role="region"
            aria-label={`Documento ${selected.number}`}
          >
            <DocumentPrint document={selected} />
          </div>
          <div className="document-print-root" aria-hidden="true">
            <DocumentPrint document={selected} />
          </div>
        </>
      )}
    </>
  )
}

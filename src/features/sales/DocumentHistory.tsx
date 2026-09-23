import { FileText, Plus, ArrowUpRight } from 'lucide-react'
import {
  WorkspaceHeading,
  WorkspaceEmpty,
} from '../../components/WorkspacePresentation'
import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import { useServices } from '../../services/useServices'
import { useAccess } from '../../app/AccessContext'
import { useQuery } from '../../lib/useQuery'
import {
  Button,
  Card,
  Input,
  ErrorState,
  LoadingState,
} from '../../components/ui'
import { formatCurrency, formatDate } from '../../lib/format'
import { errorMessage } from '../../lib/errors'
import type { DocumentKind, DocumentRecord } from '../../lib/domain'
import { DocumentPrint } from './DocumentPrint'
import { downloadDocumentPdf } from './pdf'
export function DocumentHistory({ kind }: { kind: DocumentKind }) {
  const { salesService } = useServices()
  const { base } = useAccess()
  const load = useCallback(
    () => salesService.listDocuments(kind, 200),
    [salesService, kind],
  )
  const { data, error, loading, retry } = useQuery(load)
  const [selected, setSelected] = useState<DocumentRecord | null>(null)
  const [search, setSearch] = useState('')
  const [failure, setFailure] = useState('')
  const [downloading, setDownloading] = useState(false)
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
            {data?.length ?? 0} documentos recientes
          </span>
        </div>
        {loading && <LoadingState />}
        {error && <ErrorState message={error} retry={retry} />}
        <div className="record-grid">
          {data
            ?.filter((d) =>
              `${d.number} ${d.customerName}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((d) => (
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
              </Card>
            ))}
        </div>
        {!loading &&
          !error &&
          !(data ?? []).some((d) =>
            `${d.number} ${d.customerName}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          ) && (
            <WorkspaceEmpty
              icon={FileText}
              title={
                search
                  ? 'No encontramos ese documento'
                  : 'Tu archivo está listo'
              }
              description={
                search
                  ? 'Prueba con otro nombre o número.'
                  : 'Los documentos que emitas aparecerán aquí con su detalle y su PDF.'
              }
            />
          )}
        {selected && (
          <div className="form-actions">
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
      </div>
      {selected && (
        <>
          <div className="example-paper no-print">
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

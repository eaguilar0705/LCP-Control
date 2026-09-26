import {
  FileText,
  FileDown,
  Plus,
  ArrowUpRight,
  Trash2,
  CalendarRange,
} from 'lucide-react'
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
import { documentCopy } from '../../lib/domain'
import type { DocumentKind, DocumentRecord } from '../../lib/domain'
import { DocumentPrint } from './DocumentPrint'
import { downloadDocumentPdf, downloadPeriodPdf } from './pdf'
import { matchesSearch } from '../../lib/search'
import { adjustRange, type ReportRange } from '../reports/model'
import {
  historyPresetLabels,
  historyRange,
  periodLabel,
  type HistoryPreset,
} from './period'

const counts = new Intl.NumberFormat('es-NI')

export function DocumentHistory({ kind }: { kind: DocumentKind }) {
  const { salesService } = useServices()
  const { base, demo, role } = useAccess()
  const { singular, plural } = documentCopy[kind]
  const noun = (n: number) => `${counts.format(n)} ${n === 1 ? singular : plural}`
  // `null`: fechas elegidas a mano, ningún atajo queda marcado.
  const [preset, setPreset] = useState<HistoryPreset | null>('month')
  const [range, setRange] = useState<ReportRange>(() => historyRange('month'))
  // La respuesta lleva el periodo que pidió: mientras llega la del periodo
  // nuevo no se muestra la lista del anterior como si fuera la actual.
  const load = useCallback(
    async () => ({
      range,
      ...(await salesService.listDocuments(kind, { range })),
    }),
    [salesService, kind, range],
  )
  const { data, error, loading, retry } = useQuery(load)
  const current = data?.range === range ? data : null
  // Páginas pedidas con «Cargar más»; se descartan solas al cambiar de
  // periodo o recargar, porque quedan atadas a la respuesta de la que salen.
  const [more, setMore] = useState<{
    from: typeof data
    documents: DocumentRecord[]
  }>({ from: null, documents: [] })
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState('')
  const extra = current && more.from === current ? more.documents : []
  const documents = current ? [...current.documents, ...extra] : []
  const total = current?.total ?? 0
  const [exporting, setExporting] = useState('')
  const [exportNotice, setExportNotice] = useState<{
    tone: 'error' | 'info'
    text: string
  } | null>(null)
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
  const matches = documents.filter((d) =>
    matchesSearch(`${d.number} ${d.customerName}`, search),
  )
  const searching = !!search.trim()
  function choosePreset(next: HistoryPreset) {
    setPreset(next)
    setRange(historyRange(next))
    setExportNotice(null)
  }
  function chooseDay(edge: 'from' | 'to', value: string) {
    if (!value) return
    setPreset(null)
    setRange((previous) => adjustRange(previous, edge, value))
    setExportNotice(null)
  }
  async function loadMore() {
    if (!current || loadingMore) return
    setLoadingMore(true)
    setMoreError('')
    try {
      const page = await salesService.listDocuments(kind, {
        range,
        offset: documents.length,
      })
      // Una factura emitida mientras tanto corre la paginación un lugar: sin
      // esto la última de la página anterior aparecería dos veces.
      const seen = new Set(documents.map((d) => d.id))
      setMore({
        from: current,
        documents: [
          ...extra,
          ...page.documents.filter((d) => !seen.has(d.id)),
        ],
      })
    } catch (e) {
      setMoreError(errorMessage(e))
    } finally {
      setLoadingMore(false)
    }
  }
  async function exportPdf() {
    if (exporting) return
    setExporting('Buscando…')
    setExportNotice(null)
    try {
      const found = await salesService.exportDocuments(kind, range)
      if (!found.length) {
        setExportNotice({
          tone: 'info',
          text: `No hay ${plural} emitidas ${periodLabel(range)}.`,
        })
        return
      }
      setExporting('Generando PDF…')
      await downloadPeriodPdf(kind, range, found, (done, all) =>
        setExporting(`Generando ${counts.format(done)} de ${counts.format(all)}…`),
      )
      setExportNotice({
        tone: 'info',
        text: `PDF listo: ${noun(found.length)} ${periodLabel(range)}.`,
      })
    } catch (e) {
      setExportNotice({ tone: 'error', text: errorMessage(e) })
    } finally {
      setExporting('')
    }
  }
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
        </WorkspaceHeading>
        <Card className="report-filters history-filters">
          <div className="preset-row" role="group" aria-label="Periodo">
            <CalendarRange size={17} />
            {(Object.keys(historyPresetLabels) as HistoryPreset[]).map((key) => (
              <button
                key={key}
                type="button"
                className={`preset ${preset === key ? 'preset-active' : ''}`}
                aria-pressed={preset === key}
                onClick={() => choosePreset(key)}
              >
                {historyPresetLabels[key]}
              </button>
            ))}
          </div>
          <div className="history-filter-grid">
            <Input
              label="Desde"
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) => chooseDay('from', e.target.value)}
            />
            <Input
              label="Hasta"
              type="date"
              value={range.to}
              min={range.from}
              onChange={(e) => chooseDay('to', e.target.value)}
            />
            {/* La vista local no tiene documentos emitidos que exportar. */}
            {!demo && (
              <div className="history-export">
                <Button
                  type="button"
                  disabled={!!exporting}
                  aria-busy={!!exporting}
                  onClick={() => void exportPdf()}
                >
                  <FileDown size={17} />
                  {exporting || 'Exportar PDF del período'}
                </Button>
                <small className="muted">
                  Listado con totales y cada {singular} completa.
                </small>
              </div>
            )}
          </div>
          {exportNotice && (
            <p
              role={exportNotice.tone === 'error' ? 'alert' : 'status'}
              className={
                exportNotice.tone === 'error' ? 'inline-error' : 'page-feedback'
              }
            >
              {exportNotice.text}
            </p>
          )}
        </Card>
        <div className="directory-toolbar">
          <Input
            label="Buscar por número o cliente"
            type="search"
            placeholder="Escribe un nombre o número de documento…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="directory-count">
            {!current
              ? ''
              : searching
                ? `Coinciden ${counts.format(matches.length)} de ${noun(documents.length)}${documents.length < total ? ` cargadas de ${counts.format(total)}` : ''}`
                : documents.length < total
                  ? `${counts.format(documents.length)} de ${noun(total)} del período`
                  : `${noun(total)} en el período`}
          </span>
        </div>
        {notice && (
          <p role="status" className="page-feedback">
            {notice}
          </p>
        )}
        {(loading || (!current && !error)) && <LoadingState />}
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
        {current && documents.length < total && (
          <div className="history-more">
            <Button
              type="button"
              variant="secondary"
              disabled={loadingMore}
              aria-busy={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore
                ? 'Cargando…'
                : `Cargar más (${counts.format(total - documents.length)} restantes)`}
            </Button>
            {moreError && (
              <p className="inline-error" role="alert">
                {moreError}
              </p>
            )}
          </div>
        )}
        {current && !error && !matches.length && (
          <WorkspaceEmpty
            icon={FileText}
            title={
              searching
                ? 'No encontramos ese documento'
                : `Sin ${plural} en este período`
            }
            description={
              searching
                ? documents.length < total
                  ? 'Busca entre las que faltan con «Cargar más» o acorta el período.'
                  : 'Prueba con otro nombre o número.'
                : 'Elige otras fechas. Los documentos que emitas aparecerán aquí con su detalle y su PDF.'
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

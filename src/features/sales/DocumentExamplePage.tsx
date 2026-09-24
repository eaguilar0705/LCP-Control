import { useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Button, Select } from '../../components/ui'
import { exampleDocument, exampleItemCounts } from './example'
import { DocumentPrint } from './DocumentPrint'
import { downloadDocumentPdf } from './pdf'
export function DocumentExamplePage() {
  const { kind } = useParams()
  const [params, setParams] = useSearchParams()
  const requested = Number(params.get('productos'))
  const count = exampleItemCounts.includes(
    requested as (typeof exampleItemCounts)[number],
  )
    ? requested
    : 3
  const record = exampleDocument(
    kind === 'proforma' ? 'proforma' : 'invoice',
    count,
  )
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <>
      <div className="page-heading no-print">
        <div>
          <h1>
            {record.kind === 'invoice'
              ? 'Ejemplo de factura'
              : 'Ejemplo de proforma'}
          </h1>
          <p className="muted">
            Carta o A4 · datos de muestra · sin emisión. Hasta 40 productos
            caben en una hoja.
          </p>
        </div>
        <div className="form-actions">
          <Select
            label="Productos de muestra"
            value={String(count)}
            onChange={(e) =>
              setParams({ productos: e.target.value }, { replace: true })
            }
          >
            {exampleItemCounts.map((value) => (
              <option key={value} value={value}>
                {value} productos
              </option>
            ))}
          </Select>
          <Button type="button" onClick={() => window.print()}>
            Imprimir ejemplo
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            aria-busy={busy}
            onClick={async () => {
              setBusy(true)
              setMessage('')
              try {
                await downloadDocumentPdf(record)
              } catch {
                setMessage('No pudimos generar el PDF. Inténtalo de nuevo.')
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Generando PDF…' : 'Descargar PDF'}
          </Button>
        </div>
      </div>
      {message && <p role="alert">{message}</p>}
      {/* En el teléfono la hoja se desplaza de lado: enfocable para poder
          recorrerla también con el teclado. */}
      <div
        className="example-paper"
        tabIndex={0}
        role="region"
        aria-label={
          record.kind === 'invoice'
            ? 'Hoja de la factura de ejemplo'
            : 'Hoja de la proforma de ejemplo'
        }
      >
        <DocumentPrint document={record} />
      </div>
    </>
  )
}

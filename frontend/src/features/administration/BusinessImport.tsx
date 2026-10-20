import { useRef, useState, type ReactNode } from 'react'
import { Download, FileSpreadsheet, Upload } from 'lucide-react'
import type {
  BusinessImportRequest,
  BusinessImportResult,
} from '@lcp/contracts/businessImport'
import { useAccess } from '../../app/AccessContext'
import { Button, Dialog, Input } from '../../components/ui'
import { can } from '../../lib/permissions'
import { errorMessage } from '../../lib/errors'
import { formatCurrency } from '../../lib/format'
import { download } from '../reports/export'
import { localDay } from '../reports/model'
import { importBusinessExcel } from './businessImportService'
import type { BusinessImportProblem } from './businessImportWorkbook'
import '../../styles/business-import.css'

const costFormat = new Intl.NumberFormat('es-NI', {
  style: 'currency',
  currency: 'NIO',
  currencyDisplay: 'code',
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
})

export function BusinessImport({ onImported }: { onImported: () => void }) {
  const { role, demo } = useAccess()
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState(() => localDay(new Date()))
  const [input, setInput] = useState<BusinessImportRequest | null>(null)
  const [problems, setProblems] = useState<BusinessImportProblem[]>([])
  const [preview, setPreview] = useState<BusinessImportResult | null>(null)
  const [done, setDone] = useState<BusinessImportResult | null>(null)
  const [failure, setFailure] = useState('')
  const [reviewed, setReviewed] = useState(false)
  const [busy, setBusy] = useState('')
  const working = useRef(false)
  if (demo || !can(role, 'settings.manage')) return null

  function start(action: string) {
    if (working.current) return false
    working.current = true
    setBusy(action)
    setFailure('')
    return true
  }
  function finish() {
    working.current = false
    setBusy('')
  }
  async function template() {
    if (!start('template')) return
    try {
      const { businessImportTemplate } =
        await import('./businessImportWorkbook')
      download(
        businessImportTemplate(),
        'plantilla-migracion-casa-del-perfume.xlsx',
      )
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      finish()
    }
  }
  async function read(file: File | undefined) {
    if (!start('reading')) return
    setInput(null)
    setPreview(null)
    setDone(null)
    setProblems([])
    setReviewed(false)
    try {
      if (!file) return
      const { readBusinessWorkbook } = await import('./businessImportWorkbook')
      const parsed = await readBusinessWorkbook(file)
      setProblems(parsed.problems)
      if (parsed.problems.length) return
      const digest = await crypto.subtle.digest(
        'SHA-256',
        await file.arrayBuffer(),
      )
      const sourceHash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('')
      setInput({
        ...parsed.data,
        version: 1,
        requestId: crypto.randomUUID(),
        sourceHash,
        filename: file.name,
        occurredOn: date,
      })
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      finish()
    }
  }
  async function validate() {
    if (!input || !start('preview')) return
    setPreview(null)
    setReviewed(false)
    try {
      setPreview(await importBusinessExcel(input, true))
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      finish()
    }
  }
  async function commit() {
    if (!input || !preview || !reviewed || !start('import')) return
    try {
      const result = await importBusinessExcel(input, false)
      setDone(result)
      onImported()
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      finish()
    }
  }
  function downloadProblems() {
    const lines = [
      'Hoja\tFila\tError',
      ...problems.map((p) =>
        [p.sheet, p.row, p.message]
          .map((value) => String(value).replace(/[\t\r\n]/g, ' '))
          .join('\t'),
      ),
    ]
    download(
      new Blob(['\uFEFF', lines.join('\r\n')], {
        type: 'text/plain;charset=utf-8',
      }),
      'errores-importacion.txt',
    )
  }

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        <Upload size={17} /> Importar desde Excel
      </Button>
      <Dialog
        open={open}
        title="Importar negocio desde Excel"
        className="business-import-dialog"
        onClose={() => {
          if (!working.current) setOpen(false)
        }}
      >
        {done ? (
          <div role="status" className="business-import-success">
            <FileSpreadsheet size={30} />
            <h3>
              {done.alreadyImported
                ? 'Este archivo ya estaba importado'
                : 'Datos importados correctamente'}
            </h3>
            <p>
              {done.alreadyImported
                ? 'La carga anterior se conserva sin duplicar registros.'
                : 'Los datos ya están disponibles en inventario, clientes, proveedores y contabilidad.'}
            </p>
            <ImportCounts result={done} />
            <div className="form-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setInput(null)
                  setPreview(null)
                  setDone(null)
                  setProblems([])
                  setReviewed(false)
                  setFailure('')
                }}
              >
                Importar otro archivo
              </Button>
              <Button type="button" onClick={() => setOpen(false)}>
                Cerrar
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p>
              Carga inicial de productos, precios, existencias por bodega y
              tienda, cuentas contables y saldos de apertura. También puedes
              incluir clientes, proveedores y datos de facturación del negocio.
            </p>
            <ol className="business-import-steps">
              <li>
                Descarga la plantilla y copia los datos de tu Excel en las hojas
                correspondientes. Conserva los encabezados.
              </li>
              <li>
                Selecciona el archivo y revisa los datos. La validación
                comprobará también los registros que ya existen.
              </li>
              <li>
                Confirma la carga completa. Si hay un error, no se guardará
                ninguna fila.
              </li>
            </ol>
            <Button
              type="button"
              variant="secondary"
              disabled={!!busy}
              onClick={template}
            >
              <Download size={16} />{' '}
              {busy === 'template'
                ? 'Preparando…'
                : 'Descargar plantilla Excel'}
            </Button>
            <div className="form-grid business-import-fields">
              <Input
                label="Archivo Excel (.xlsx)"
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                disabled={!!busy}
                onClick={(event) => {
                  event.currentTarget.value = ''
                }}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  void read(file)
                }}
              />
              <Input
                label="Fecha de saldos iniciales"
                type="date"
                required
                value={date}
                max={localDay(new Date())}
                disabled={!!busy}
                onChange={(event) => {
                  const value = event.target.value
                  setDate(value)
                  setPreview(null)
                  setReviewed(false)
                  if (input)
                    setInput({
                      ...input,
                      occurredOn: value,
                      requestId: crypto.randomUUID(),
                    })
                }}
              />
            </div>
            <p className="muted">
              Las existencias vacías quedan pendientes de conteo. Los costos y
              saldos se expresan en córdobas; los precios de venta, en dólares.
              La hoja Instrucciones explica cada columna.
            </p>
            {busy === 'reading' && (
              <p role="status">Leyendo y revisando el archivo…</p>
            )}
            {problems.length > 0 && (
              <div className="business-import-problems" role="alert">
                <h3>
                  Corrige {problems.length}{' '}
                  {problems.length === 1 ? 'error' : 'errores'} en el archivo
                </h3>
                <ul>
                  {problems.slice(0, 20).map((p, index) => (
                    <li key={index}>
                      <strong>
                        {p.sheet}, fila {p.row}:
                      </strong>{' '}
                      {p.message}
                    </li>
                  ))}
                </ul>
                {problems.length > 20 && (
                  <p>Se muestran los primeros 20 errores.</p>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  onClick={downloadProblems}
                >
                  Descargar lista de errores
                </Button>
              </div>
            )}
            {input && (
              <>
                <h3>Datos del archivo: {input.filename}</h3>
                <ImportCounts
                  result={{
                    preview: true,
                    alreadyImported: false,
                    business: !!input.business,
                    products: input.products.length,
                    stocks: input.stocks.length,
                    accounts: input.accounts.length,
                    openingBalances: input.openingBalances.length,
                    customers: input.customers.length,
                    suppliers: input.suppliers.length,
                  }}
                />
                <ImportPreview input={input} />
                {preview && (
                  <p role="status" className="workspace-feedback">
                    {preview.alreadyImported
                      ? 'El sistema reconoce este archivo: al confirmar se recuperará la carga anterior sin duplicarla.'
                      : 'Validación completada. Todos los datos pueden cargarse juntos.'}
                  </p>
                )}
                {preview && (
                  <label className="business-import-review">
                    <input
                      type="checkbox"
                      checked={reviewed}
                      disabled={!!busy}
                      onChange={(event) => setReviewed(event.target.checked)}
                    />
                    Revisé los datos y la fecha de apertura.
                  </label>
                )}
              </>
            )}
            {failure && (
              <p role="alert" className="inline-error">
                {failure}
              </p>
            )}
            <div className="form-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={!!busy}
                onClick={() => setOpen(false)}
              >
                Cancelar
              </Button>
              {input &&
                (!preview ? (
                  <Button
                    type="button"
                    disabled={!!busy || !date || date > localDay(new Date())}
                    aria-busy={busy === 'preview'}
                    onClick={validate}
                  >
                    {busy === 'preview'
                      ? 'Validando…'
                      : 'Validar en el sistema'}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    disabled={!!busy || !reviewed}
                    aria-busy={busy === 'import'}
                    onClick={commit}
                  >
                    {busy === 'import'
                      ? 'Importando…'
                      : preview.alreadyImported
                        ? 'Confirmar carga existente'
                        : 'Confirmar importación'}
                  </Button>
                ))}
            </div>
          </>
        )}
      </Dialog>
    </>
  )
}

function ImportCounts({ result }: { result: BusinessImportResult }) {
  return (
    <dl className="business-import-counts">
      {[
        ['Productos', result.products],
        ['Existencias', result.stocks],
        ['Cuentas', result.accounts],
        ['Saldos', result.openingBalances],
        ['Clientes', result.customers],
        ['Proveedores', result.suppliers],
        ['Datos del negocio', result.business ? 'Sí' : '—'],
      ].map(([label, count]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{count}</dd>
        </div>
      ))}
    </dl>
  )
}

function PreviewTable({
  title,
  headers,
  rows,
}: {
  title: string
  headers: string[]
  rows: ReactNode[][]
}) {
  if (!rows.length) return null
  return (
    <details className="business-import-preview">
      <summary>
        {title} ({rows.length})
      </summary>
      <div
        className="business-import-table"
        tabIndex={0}
        role="region"
        aria-label={`Vista previa de ${title}`}
      >
        <table>
          <thead>
            <tr>
              {headers.map((header) => (
                <th key={header}>{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 10).map((row, index) => (
              <tr key={index}>
                {row.map((cell, col) => (
                  <td key={col}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 10 && (
        <p className="muted">Primeras 10 filas de {rows.length}.</p>
      )}
    </details>
  )
}

function ImportPreview({ input }: { input: BusinessImportRequest }) {
  const pending = (value: number | null) =>
    value === null ? 'Pendiente' : value
  const money = (value: number | null, currency: 'USD' | 'NIO') =>
    value === null ? 'Pendiente' : formatCurrency(value, currency)
  const sum = (key: 'debit' | 'credit') =>
    input.openingBalances.reduce(
      (total, row) => total + Math.round(row[key] * 100),
      0,
    ) / 100
  return (
    <div>
      <PreviewTable
        title="Productos"
        headers={[
          'SKU',
          'Nombre',
          'Marca',
          'Emprendedor USD',
          'VIP USD',
          'Premium USD',
        ]}
        rows={input.products.map((row) => [
          row.sku,
          row.name,
          row.brand,
          ...Object.values(row.pricesUSD).map((v) => money(v, 'USD')),
        ])}
      />
      <PreviewTable
        title="Existencias"
        headers={['SKU', 'Bodega', 'Tienda', 'Costo unitario NIO']}
        rows={input.stocks.map((row) => [
          row.sku,
          pending(row.warehouse),
          pending(row.store),
          row.unitCostNio === null
            ? 'Pendiente'
            : costFormat.format(row.unitCostNio),
        ])}
      />
      <PreviewTable
        title="Cuentas"
        headers={['Código', 'Nombre', 'Cuenta mayor']}
        rows={input.accounts.map((row) => [
          row.code,
          row.name,
          row.parent ?? '—',
        ])}
      />
      <PreviewTable
        title="Saldos iniciales"
        headers={['Cuenta', 'Debe NIO', 'Haber NIO']}
        rows={input.openingBalances.map((row) => [
          row.account,
          money(row.debit, 'NIO'),
          money(row.credit, 'NIO'),
        ])}
      />
      {!!input.openingBalances.length && (
        <p>
          Debe: <strong>{money(sum('debit'), 'NIO')}</strong> · Haber:{' '}
          <strong>{money(sum('credit'), 'NIO')}</strong>
        </p>
      )}
      <PreviewTable
        title="Clientes"
        headers={['Nombre', 'Teléfono', 'Nivel']}
        rows={input.customers.map((row) => [
          row.name,
          row.phone ?? '—',
          row.priceTier,
        ])}
      />
      <PreviewTable
        title="Proveedores"
        headers={['Nombre', 'Teléfono', 'Correo']}
        rows={input.suppliers.map((row) => [
          row.name,
          row.phone ?? '—',
          row.email,
        ])}
      />
      {input.business && (
        <PreviewTable
          title="Datos del negocio"
          headers={['Nombre', 'Razón social', 'RUC', 'Sucursal']}
          rows={[
            [
              input.business.name,
              input.business.legalName,
              input.business.taxId,
              input.business.branch,
            ],
          ]}
        />
      )}
    </div>
  )
}

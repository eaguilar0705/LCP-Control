import { useState } from 'react'
import { Button, Dialog, Input, Select } from '../../components/ui'
import type {
  Currency,
  PricingInput,
  Product,
  ProductPricing,
} from '../../lib/domain'
import { errorMessage } from '../../lib/errors'
import { formatCurrency } from '../../lib/format'
import { priceTierLabels, priceTiers } from '../../lib/pricing'
import { readSpreadsheet, SpreadsheetError } from '../../lib/spreadsheet'
import { useServices } from '../../services/useServices'
import {
  planPricingImport,
  PricingFileError,
  type PlannedPricing,
  type PricingPlan,
} from './importPlan'

const SHOWN_PROBLEMS = 50
const counts = new Intl.NumberFormat('es-NI')

function purchaseText(pricing: PricingInput) {
  return pricing.purchasePrice === null
    ? 'Sin cargar'
    : formatCurrency(pricing.purchasePrice, pricing.purchaseCurrency)
}
function markupText(value: number | null) {
  return value === null ? '—' : `${value} %`
}

/**
 * Cargar precios de compra y porcentajes desde un Excel o un CSV. Se lee el
 * archivo en el navegador, se enseña qué va a cambiar (y qué filas no se
 * pueden usar, con el motivo) y sólo al confirmar se guarda, todo junto.
 */
export function PricingImportDialog({
  products,
  pricing,
  rate,
  readOnly,
  onClose,
  onSaved,
}: {
  products: Product[]
  pricing: ProductPricing[]
  rate: number | null
  readOnly: boolean
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const { productService } = useServices()
  const [currency, setCurrency] = useState<Currency>('NIO')
  const [file, setFile] = useState<File | null>(null)
  const [plan, setPlan] = useState<PricingPlan | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function read(next: File, chosen: Currency) {
    setBusy(true)
    setError('')
    setPlan(null)
    try {
      const rows = await readSpreadsheet(next)
      setPlan(
        planPricingImport({
          rows,
          products,
          pricing,
          rate,
          defaultCurrency: chosen,
        }),
      )
    } catch (e) {
      setError(
        e instanceof SpreadsheetError || e instanceof PricingFileError
          ? e.message
          : 'No pudimos leer el archivo. Guárdalo como Excel (.xlsx) o CSV y vuelve a intentarlo.',
      )
    } finally {
      setBusy(false)
    }
  }
  async function save() {
    if (!plan?.changes.length || busy || readOnly) return
    setBusy(true)
    setError('')
    try {
      const saved = await productService.savePricing(
        plan.changes.map((change) => ({
          productId: change.product.id,
          revision: change.product.revision ?? 0,
          pricing: change.after,
        })),
      )
      onSaved(
        `Precios cargados: ${counts.format(saved)} ${saved === 1 ? 'perfume actualizado' : 'perfumes actualizados'}.`,
      )
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const large =
    plan?.changes.filter((change) => change.largeChanges.length) ?? []
  return (
    <Dialog
      open
      title="Cargar precios desde un archivo"
      className="pricing-import-dialog"
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <p className="muted">
        Acepta Excel (.xlsx) o CSV. Hace falta una fila de encabezados con{' '}
        <strong>Código</strong> (o <strong>Marca</strong> y{' '}
        <strong>Perfume</strong>) y los datos que quieras cargar:{' '}
        <strong>Precio de compra</strong>, <strong>Moneda</strong>,{' '}
        <strong>% Emprendedor</strong>, <strong>% VIP</strong> y{' '}
        <strong>% Premium</strong>. Una celda vacía no cambia nada. La plantilla
        ya trae el catálogo con esas columnas.
      </p>
      <div className="pricing-import-controls">
        <Select
          label="Moneda si el archivo no la indica"
          value={currency}
          disabled={busy}
          onChange={(event) => {
            const chosen = event.target.value as Currency
            setCurrency(chosen)
            if (file) void read(file, chosen)
          }}
        >
          <option value="NIO">C$ Córdobas</option>
          <option value="USD">US$ Dólares</option>
        </Select>
        <Input
          label="Archivo con los precios"
          type="file"
          disabled={busy}
          accept=".xlsx,.xlsm,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          // Se vacía al abrir el selector para poder volver a elegir el mismo
          // archivo después de corregirlo; mientras tanto se ve su nombre.
          onClick={(event) => {
            event.currentTarget.value = ''
          }}
          onChange={(event) => {
            const next = event.target.files?.[0]
            if (!next) return
            setFile(next)
            void read(next, currency)
          }}
        />
      </div>
      {busy && !plan && (
        <p className="muted" role="status">
          Leyendo el archivo…
        </p>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {plan && file && (
        <section className="pricing-import-preview" aria-live="polite">
          <p className="pricing-import-summary">
            <strong>{file.name}</strong>: {counts.format(plan.changes.length)}{' '}
            {plan.changes.length === 1 ? 'perfume cambia' : 'perfumes cambian'},{' '}
            {counts.format(plan.unchanged)} sin cambios
            {plan.problems.length > 0 &&
              ` y ${counts.format(plan.problems.length)} ${plan.problems.length === 1 ? 'fila no se puede usar' : 'filas no se pueden usar'}`}
            . Encabezados en la fila {plan.headerLine}.
          </p>
          {large.length > 0 && (
            <p className="pricing-import-warning" role="alert">
              {large.length === 1
                ? 'Un perfume cambia su precio de venta'
                : `${counts.format(large.length)} perfumes cambian su precio de venta`}{' '}
              más de un 30 %. Están marcados abajo: revisa que el precio de
              compra y la moneda sean los correctos.
            </p>
          )}
          {rate === null && (
            <p className="pricing-import-warning" role="alert">
              Falta el tipo de cambio en Negocio: sin él no se pueden guardar
              precios.
            </p>
          )}
          {plan.changes.length > 0 && <ChangesTable changes={plan.changes} />}
          {plan.problems.length > 0 && (
            <div className="pricing-import-problems">
              <h3>Filas que no se van a cargar</h3>
              <ul>
                {plan.problems.slice(0, SHOWN_PROBLEMS).map((problem) => (
                  <li key={`${problem.line}:${problem.reason}`}>
                    <strong>Fila {problem.line}:</strong> {problem.reason}
                    {problem.text && <small>{problem.text}</small>}
                  </li>
                ))}
              </ul>
              {plan.problems.length > SHOWN_PROBLEMS && (
                <p className="muted">
                  y {counts.format(plan.problems.length - SHOWN_PROBLEMS)} más.
                  Corrige las primeras y vuelve a cargar el archivo.
                </p>
              )}
            </div>
          )}
        </section>
      )}
      {readOnly && plan && (
        <p className="page-feedback">
          Vista de ejemplo: puedes revisar el archivo, pero los precios no se
          guardan.
        </p>
      )}
      <div className="form-actions">
        <Button
          type="button"
          disabled={
            busy ||
            readOnly ||
            rate === null ||
            !plan ||
            plan.changes.length === 0
          }
          aria-busy={busy && !!plan}
          onClick={() => void save()}
        >
          {busy && plan
            ? 'Guardando…'
            : plan && plan.changes.length > 0
              ? `Guardar ${counts.format(plan.changes.length)} ${plan.changes.length === 1 ? 'perfume' : 'perfumes'}`
              : 'Guardar'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onClose}
        >
          Cancelar
        </Button>
      </div>
    </Dialog>
  )
}

function ChangesTable({ changes }: { changes: PlannedPricing[] }) {
  return (
    <div
      className="pricing-import-table"
      role="region"
      aria-label="Cambios"
      tabIndex={0}
    >
      <table>
        <thead>
          <tr>
            <th>Fila</th>
            <th>Perfume</th>
            <th>Precio de compra</th>
            {priceTiers.map((tier) => (
              <th key={tier}>{priceTierLabels[tier]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {changes.map((change) => (
            <tr
              key={change.product.id}
              className={
                change.largeChanges.length ? 'is-large-change' : undefined
              }
            >
              <td>{change.line}</td>
              <td>
                <strong>{change.product.name}</strong>
                <small>
                  {change.product.brand} · {change.product.barcode}
                </small>
              </td>
              <td>
                {purchaseText(change.after)}
                {change.before.purchasePrice !== null &&
                  purchaseText(change.before) !==
                    purchaseText(change.after) && (
                    <small>antes {purchaseText(change.before)}</small>
                  )}
              </td>
              {priceTiers.map((tier) => {
                const before = change.prices.before[tier]?.NIO
                const after = change.prices.after[tier]?.NIO
                const moved = before !== after
                return (
                  <td
                    key={tier}
                    className={
                      change.largeChanges.includes(tier)
                        ? 'is-large-change'
                        : undefined
                    }
                  >
                    {markupText(change.after.markups[tier])}
                    {change.before.markups[tier] !== null &&
                      change.before.markups[tier] !==
                        change.after.markups[tier] && (
                        <small>
                          antes {markupText(change.before.markups[tier])}
                        </small>
                      )}
                    <small>
                      {Number.isFinite(after)
                        ? moved && Number.isFinite(before)
                          ? `${formatCurrency(before, 'NIO')} → ${formatCurrency(after, 'NIO')}`
                          : formatCurrency(after, 'NIO')
                        : '—'}
                    </small>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

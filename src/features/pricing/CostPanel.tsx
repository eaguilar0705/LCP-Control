import { useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { ProductSelect } from '../../components/ProductSelect'
import { Button, Dialog, Input, Select } from '../../components/ui'
import { useServices } from '../../services/useServices'
import { errorMessage } from '../../lib/errors'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { exactCost, landedUnitCost } from '../../lib/pricing'
import {
  labels,
  type Currency,
  type InventoryItem,
  type InventoryLocation,
  type ProductPricing,
} from '../../lib/domain'
import type { OpeningCostInput, ShipmentInput } from '../reports/accounting'
import { localDay } from '../reports/model'
import {
  hasDecimals,
  previewPurchase,
  typed,
  validRate,
  type LinePreview,
  type PurchaseLineDraft,
} from './costPreview'

const counts = new Intl.NumberFormat('es-NI')

function totalOf(item: InventoryItem) {
  const { store, warehouse } = item.quantities
  return store === null || warehouse === null ? null : store + warehouse
}

const blankLine = (productId = ''): PurchaseLineDraft => ({
  productId,
  location: 'warehouse',
  quantity: '',
  unitPrice: '',
})
const round2 = (value: number) => Math.round(value * 100) / 100
const round6 = (value: number) => Math.round(value * 1e6) / 1e6

/**
 * Registrar una compra: uno o varios perfumes con su costo por unidad y el
 * envío del pedido. Mientras se escribe se ve, por renglón, el promedio que va
 * a quedar y el precio de cada lista calculada.
 */
export function PurchaseDialog({
  inventory,
  pricing,
  catalogRate,
  initialProduct,
  onClose,
  onRecorded,
}: {
  inventory: InventoryItem[]
  pricing: ProductPricing[]
  catalogRate: number | null
  initialProduct: string
  onClose: () => void
  onRecorded: (message: string) => void
}) {
  const { accountingService } = useServices()
  const [operation] = useState(() =>
    createIdempotentOperation<Omit<ShipmentInput, 'requestId'>, unknown>(
      accountingService.recordShipment,
    ),
  )
  const [incurredOn, setIncurredOn] = useState(localDay(new Date()))
  const [supplier, setSupplier] = useState('')
  const [reference, setReference] = useState('')
  const [currency, setCurrency] = useState<Currency>('NIO')
  const [rateText, setRateText] = useState(
    catalogRate ? String(catalogRate) : '',
  )
  const [shipping, setShipping] = useState('0')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<PurchaseLineDraft[]>([
    blankLine(initialProduct),
  ])
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const preview = previewPurchase({
    lines,
    shippingText: shipping,
    currency,
    rateText,
    inventory,
    pricing,
    catalogRate,
  })
  const products = inventory.map((item) => item.product)
  const today = localDay(new Date())
  const dateProblem =
    !incurredOn || incurredOn > today
      ? 'Elige una fecha que no sea futura.'
      : null
  function update(index: number, changes: Partial<PurchaseLineDraft>) {
    setLines((current) =>
      current.map((line, position) =>
        position === index ? { ...line, ...changes } : line,
      ),
    )
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setChecked(true)
    if (!preview.ready || dateProblem) return
    const rate = validRate(currency, rateText)!
    setBusy(true)
    setFailure('')
    try {
      await operation.execute({
        incurredOn,
        supplier: supplier.trim(),
        agency: '',
        reference: reference.trim(),
        note: note.trim(),
        currency,
        exchangeRate: rate,
        shippingAmount: round2(typed(shipping)),
        lines: preview.lines.map((line, index) => ({
          productId: line.productId,
          location: lines[index].location,
          quantity: line.quantity,
          unitPrice: round6(line.unitPrice),
        })),
      })
      onRecorded(
        `Compra registrada: ${counts.format(preview.units)} ${preview.units === 1 ? 'unidad' : 'unidades'} en inventario y costo promedio actualizado.`,
      )
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      title="Registrar compra"
      className="pricing-purchase-dialog"
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form noValidate onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy} className="pricing-purchase-form">
          <div className="form-grid">
            <Input
              label="Fecha de la compra"
              type="date"
              required
              max={today}
              value={incurredOn}
              error={checked ? (dateProblem ?? undefined) : undefined}
              onChange={(event) => setIncurredOn(event.target.value)}
            />
            <Input
              label="Proveedor"
              maxLength={160}
              value={supplier}
              onChange={(event) => setSupplier(event.target.value)}
            />
            <Input
              label="Factura o referencia"
              maxLength={200}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
            <Select
              label="Moneda de la compra"
              value={currency}
              onChange={(event) => setCurrency(event.target.value as Currency)}
            >
              <option value="NIO">C$ Córdobas</option>
              <option value="USD">US$ Dólares</option>
            </Select>
            {currency === 'USD' && (
              <Input
                label="Tasa del pedido (C$ por dólar)"
                type="number"
                inputMode="decimal"
                min={0.000001}
                step={0.000001}
                value={rateText}
                error={
                  checked && validRate(currency, rateText) === null
                    ? 'Escribe la tasa con hasta seis decimales.'
                    : undefined
                }
                onChange={(event) => setRateText(event.target.value)}
              />
            )}
            <Input
              label={`Envío de todo el pedido (${currency === 'NIO' ? 'C$' : 'US$'})`}
              type="number"
              inputMode="decimal"
              min={0}
              step={0.01}
              value={shipping}
              onChange={(event) => setShipping(event.target.value)}
            />
          </div>
          <div className="pricing-purchase-lines">
            {lines.map((line, index) => (
              <PurchaseLine
                key={index}
                index={index}
                line={line}
                preview={preview.lines[index]}
                products={products}
                currency={currency}
                checked={checked}
                removable={lines.length > 1}
                onChange={(changes) => update(index, changes)}
                onRemove={() =>
                  setLines((current) =>
                    current.filter((_, position) => position !== index),
                  )
                }
              />
            ))}
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={lines.length >= 200}
            onClick={() => setLines((current) => [...current, blankLine()])}
          >
            <Plus size={16} /> Agregar perfume
          </Button>
          <Input
            label="Nota"
            maxLength={2000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <p className="pricing-purchase-total">
            {counts.format(preview.units)}{' '}
            {preview.units === 1 ? 'unidad' : 'unidades'} · envío por unidad{' '}
            {preview.perUnit === null
              ? '—'
              : `${currency === 'NIO' ? 'C$' : 'US$'} ${exactCost(preview.perUnit)}`}
          </p>
        </fieldset>
        {checked && preview.problem && (
          <p role="alert" className="inline-error">
            {preview.problem}
          </p>
        )}
        {failure && (
          <p role="alert" className="inline-error">
            {failure}
          </p>
        )}
        <div className="form-actions">
          <Button type="submit" disabled={busy} aria-busy={busy}>
            {busy ? 'Registrando…' : 'Registrar compra'}
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
      </form>
    </Dialog>
  )
}

function PurchaseLine({
  index,
  line,
  preview,
  products,
  currency,
  checked,
  removable,
  onChange,
  onRemove,
}: {
  index: number
  line: PurchaseLineDraft
  preview: LinePreview
  products: InventoryItem['product'][]
  currency: Currency
  checked: boolean
  removable: boolean
  onChange: (changes: Partial<PurchaseLineDraft>) => void
  onRemove: () => void
}) {
  const symbol = currency === 'NIO' ? 'C$' : 'US$'
  return (
    <section
      className="pricing-purchase-line"
      aria-label={`Perfume ${index + 1}`}
    >
      <div className="pricing-purchase-line-fields">
        <ProductSelect
          label={`Perfume ${index + 1}`}
          products={products}
          value={line.productId}
          onChange={(productId) => onChange({ productId })}
        />
        <Select
          label="Entra a"
          value={line.location}
          onChange={(event) =>
            onChange({ location: event.target.value as InventoryLocation })
          }
        >
          <option value="warehouse">{labels.location.warehouse}</option>
          <option value="store">{labels.location.store}</option>
        </Select>
        <Input
          label="Unidades"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={line.quantity}
          onChange={(event) => onChange({ quantity: event.target.value })}
        />
        <Input
          label={`Costo por unidad (${symbol})`}
          type="number"
          inputMode="decimal"
          min={0}
          step={0.000001}
          value={line.unitPrice}
          onChange={(event) => onChange({ unitPrice: event.target.value })}
        />
        {removable && (
          <Button
            type="button"
            variant="ghost"
            aria-label={`Quitar perfume ${index + 1}`}
            onClick={onRemove}
          >
            <Trash2 size={16} />
          </Button>
        )}
      </div>
      {preview.problem ? (
        line.productId || checked ? (
          <p className={checked ? 'field-error' : 'muted'}>{preview.problem}</p>
        ) : null
      ) : preview.nextAverage !== null ? (
        <CostOutcome
          existing={preview.existing ?? 0}
          previousAverage={preview.previousAverage}
          incoming={preview.quantity}
          incomingCost={preview.landed}
          nextAverage={preview.nextAverage}
        />
      ) : null}
    </section>
  )
}

/** El cálculo del promedio y los precios que van a quedar, como en el Excel. */
function CostOutcome({
  existing,
  previousAverage,
  incoming,
  incomingCost,
  nextAverage,
}: {
  existing: number
  previousAverage: number | null
  incoming: number | null
  incomingCost: number | null
  nextAverage: number
}) {
  return (
    <div className="pricing-outcome" aria-live="polite">
      <p>
        {existing === 0
          ? 'Sin existencias'
          : previousAverage !== null
            ? `${counts.format(existing)} u. × C$ ${exactCost(previousAverage)}`
            : `${counts.format(existing)} u. contadas`}
        {incoming !== null &&
          incomingCost !== null &&
          ` + ${counts.format(incoming)} u. × C$ ${exactCost(incomingCost)}`}{' '}
        → costo promedio <strong>C$ {exactCost(nextAverage)}</strong>
      </p>
    </div>
  )
}

/**
 * El costo de las unidades que ya estaban contadas cuando se empezó a llevar
 * el costo. Sólo para perfumes con existencias y sin costo promedio.
 */
export function OpeningCostDialog({
  item,
  catalogRate,
  onClose,
  onRecorded,
}: {
  item: InventoryItem
  pricing: ProductPricing | undefined
  catalogRate: number | null
  onClose: () => void
  onRecorded: (message: string) => void
}) {
  const { accountingService } = useServices()
  const [operation] = useState(() =>
    createIdempotentOperation<Omit<OpeningCostInput, 'requestId'>, unknown>(
      accountingService.setOpeningCost,
    ),
  )
  const [currency, setCurrency] = useState<Currency>('NIO')
  const [rateText, setRateText] = useState(
    catalogRate ? String(catalogRate) : '',
  )
  const [unitText, setUnitText] = useState('')
  const [note, setNote] = useState('')
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const total = totalOf(item) ?? 0
  const unit = typed(unitText)
  const rate = validRate(currency, rateText)
  const unitProblem =
    !Number.isFinite(unit) ||
    unit < 0 ||
    unit > 1_000_000_000 ||
    !hasDecimals(unit, 6)
      ? 'Escribe el costo por unidad (hasta seis decimales).'
      : null
  const noteProblem =
    note.trim().length < 3
      ? 'Indica de dónde sale el costo (factura, lista del proveedor…).'
      : null
  const cost =
    !unitProblem && rate !== null ? landedUnitCost(unit, 0, rate) : null
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setChecked(true)
    if (unitProblem || noteProblem || rate === null) return
    setBusy(true)
    setFailure('')
    try {
      await operation.execute({
        productId: item.product.id,
        unitCost: round6(unit),
        currency,
        exchangeRate: rate,
        note: note.trim(),
      })
      onRecorded(`Costo inicial de «${item.product.name}» registrado.`)
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      title={`Costo inicial · ${item.product.name}`}
      className="pricing-dialog"
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form noValidate onSubmit={(event) => void submit(event)}>
        <p className="muted">
          {counts.format(total)} unidades contadas en tienda y bodega.
        </p>
        <fieldset disabled={busy} className="form-grid">
          <Input
            label={`Costo por unidad (${currency === 'NIO' ? 'C$' : 'US$'})`}
            type="number"
            inputMode="decimal"
            min={0}
            step={0.000001}
            value={unitText}
            error={checked ? (unitProblem ?? undefined) : undefined}
            onChange={(event) => setUnitText(event.target.value)}
          />
          <Select
            label="Moneda"
            value={currency}
            onChange={(event) => setCurrency(event.target.value as Currency)}
          >
            <option value="NIO">C$ Córdobas</option>
            <option value="USD">US$ Dólares</option>
          </Select>
          {currency === 'USD' && (
            <Input
              label="Tasa (C$ por dólar)"
              type="number"
              inputMode="decimal"
              min={0.000001}
              step={0.000001}
              value={rateText}
              error={
                checked && rate === null
                  ? 'Escribe la tasa con hasta seis decimales.'
                  : undefined
              }
              onChange={(event) => setRateText(event.target.value)}
            />
          )}
          <Input
            label="Origen del costo / comprobante"
            maxLength={2000}
            value={note}
            error={checked ? (noteProblem ?? undefined) : undefined}
            onChange={(event) => setNote(event.target.value)}
          />
        </fieldset>
        {cost !== null && (
          <CostOutcome
            existing={total}
            previousAverage={null}
            incoming={null}
            incomingCost={null}
            nextAverage={cost}
          />
        )}
        {failure && (
          <p role="alert" className="inline-error">
            {failure}
          </p>
        )}
        <div className="form-actions">
          <Button type="submit" disabled={busy} aria-busy={busy}>
            {busy ? 'Guardando…' : 'Guardar costo inicial'}
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
      </form>
    </Dialog>
  )
}

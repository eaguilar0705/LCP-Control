import { useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { ProductSelect } from '../../components/ProductSelect'
import { SupplierAutocomplete } from '../../components/SupplierAutocomplete'
import { Button, Dialog, Input, Select } from '../../components/ui'
import { useServices } from '../../services/useServices'
import { useAccess } from '../../app/AccessContext'
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
import { shipmentPayments, type ShipmentPayment } from '../accounting/finance'
import { localDay } from '../reports/model'
import { PaymentDateConfirmation } from '../accounting/PaymentDateConfirmation'
import {
  correctPurchase,
  purchaseBanks,
  purchaseConfirmation,
  type PurchasePaymentTreatment,
  type PurchaseHistoryRecord,
} from './purchaseService'
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
const round5 = (value: number) => Math.round(value * 1e5) / 1e5

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
  initialLocation = 'warehouse',
  initialQuantity,
  initialNote = '',
  correcting,
  onClose,
  onRecorded,
}: {
  inventory: InventoryItem[]
  pricing: ProductPricing[]
  catalogRate: number | null
  initialProduct: string
  initialLocation?: InventoryLocation
  initialQuantity?: number
  initialNote?: string
  correcting?: PurchaseHistoryRecord
  onClose: () => void
  onRecorded: (message: string) => void
}) {
  const { accountingService } = useServices()
  const { storageScope } = useAccess()
  const [operation] = useState(() =>
    createIdempotentOperation<
      Omit<ShipmentInput, 'requestId'> & {
        correctionReason?: string
        refundConfirmed?: boolean
        paymentTreatment?: PurchasePaymentTreatment
      },
      unknown
    >(
      ({
        correctionReason,
        refundConfirmed,
        paymentTreatment,
        requestId,
        ...purchase
      }) =>
        correcting
          ? correctPurchase({
              requestId,
              shipmentId: correcting.id,
              reason: correctionReason ?? '',
              refundConfirmed: refundConfirmed ?? false,
              paymentTreatment,
              replacement: purchase,
            })
          : accountingService.recordShipment({ ...purchase, requestId }),
      {
        scope: storageScope ?? 'anonymous',
        key: correcting ? 'purchase-correction' : 'purchase',
        label: correcting ? 'Corrección de compra' : 'Compra',
      },
    ),
  )
  const [incurredOn, setIncurredOn] = useState(localDay(new Date()))
  const [supplier, setSupplier] = useState(correcting?.supplier ?? '')
  const [reference, setReference] = useState(correcting?.reference ?? '')
  const [payment, setPayment] = useState<ShipmentPayment>(
    correcting?.account ?? 'caja',
  )
  const [currency, setCurrency] = useState<Currency>(
    correcting?.currency ?? 'NIO',
  )
  const [bank, setBank] = useState(correcting?.bank_ledger_account ?? '')
  const [correctionReason, setCorrectionReason] = useState('')
  const [refundConfirmed, setRefundConfirmed] = useState(false)
  const [paymentTreatment, setPaymentTreatment] =
    useState<PurchasePaymentTreatment>(
      correcting?.account === 'credito' ? 'keep_payments' : 'recording_error',
    )
  const [rateText, setRateText] = useState(
    correcting
      ? String(correcting.exchange_rate)
      : catalogRate
        ? String(catalogRate)
        : '',
  )
  const [shipping, setShipping] = useState(
    String(correcting?.shipping_amount ?? 0),
  )
  const [note, setNote] = useState(correcting?.note ?? initialNote)
  const [lines, setLines] = useState<PurchaseLineDraft[]>(
    correcting
      ? correcting.lines.map((line) => ({
          productId: line.product_id,
          location: line.location,
          quantity: String(line.quantity),
          unitPrice: String(line.unit_price),
        }))
      : [
          {
            ...blankLine(initialProduct),
            location: initialLocation,
            quantity:
              initialQuantity === undefined ? '' : String(initialQuantity),
          },
        ],
  )
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const uncertain = operation.isUncertain()
  const [confirmedPaymentDate, setConfirmedPaymentDate] = useState('')
  const preview = previewPurchase({
    lines,
    shippingText: shipping,
    currency,
    rateText,
    inventory: correcting
      ? inventory.map((item) => {
          const previous = correcting.before_states.find(
            (s) => s.product_id === item.product.id,
          )
          return previous
            ? {
                ...item,
                quantities: {
                  store: previous.store_before,
                  warehouse: previous.warehouse_before,
                },
              }
            : item
        })
      : inventory,
    pricing: correcting
      ? pricing.map((row) => {
          const previous = correcting.before_states.find(
            (s) => s.product_id === row.productId,
          )
          return previous ? { ...row, averageCost: previous.cost_before } : row
        })
      : pricing,
    catalogRate,
  })
  const products = inventory.map((item) => item.product)
  const [today, setToday] = useState(() => localDay(new Date()))
  const dateKey = `${payment}:${incurredOn}`
  const pastPayment =
    payment !== 'credito' && !!incurredOn && incurredOn < today
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
    if (uncertain) {
      setBusy(true)
      setFailure('')
      try {
        await operation.retryPending()
        onRecorded(
          'Compra confirmada. Inventario y costo promedio actualizados.',
        )
      } catch (error) {
        setFailure(errorMessage(error))
      } finally {
        setBusy(false)
      }
      return
    }
    setChecked(true)
    const submitToday = localDay(new Date())
    setToday(submitToday)
    if (!preview.ready || !incurredOn || incurredOn > submitToday) return
    if (
      payment === 'banco' &&
      !purchaseBanks.some(
        (item) => item.code === bank && item.currency === currency,
      )
    ) {
      setFailure('Selecciona el banco pagador en la moneda de la compra.')
      return
    }
    if (
      correcting &&
      (correctionReason.trim().length < 3 ||
        (correcting.refund_nio > 0 && !refundConfirmed))
    ) {
      setFailure(
        'Escribe el motivo y confirma cómo se corregirán los pagos de la compra original.',
      )
      return
    }
    if (
      payment !== 'credito' &&
      incurredOn < submitToday &&
      confirmedPaymentDate !== dateKey
    ) {
      setFailure('Confirma la fecha real del pago de esta compra.')
      return
    }
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
        account: payment,
        ...(payment === 'banco' ? { bankLedgerAccount: bank } : {}),
        ...(correcting
          ? {
              correctionReason: correctionReason.trim(),
              refundConfirmed,
              paymentTreatment,
            }
          : {}),
        lines: preview.lines.map((line, index) => ({
          productId: line.productId,
          location: lines[index].location,
          quantity: line.quantity,
          unitPrice: round5(line.unitPrice),
        })),
      })
      onRecorded(
        correcting
          ? 'Compra corregida. El original y su anulación permanecen en el historial.'
          : `Compra registrada: ${counts.format(preview.units)} ${preview.units === 1 ? 'unidad' : 'unidades'} en inventario y costo promedio actualizado.`,
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
      title={correcting ? 'Corregir compra' : 'Registrar compra'}
      className="pricing-purchase-dialog"
      dismissible={!busy && !uncertain}
      onClose={() => {
        if (!busy && !uncertain) onClose()
      }}
    >
      <form noValidate onSubmit={(event) => void submit(event)}>
        <fieldset
          disabled={busy || uncertain}
          className="pricing-purchase-form"
        >
          {correcting && (
            <>
              <p>
                Se anulará la compra original y se registrará este reemplazo en
                la jornada de hoy. Los precios de venta se conservan.
              </p>
              <Input
                label="Motivo de la corrección"
                required
                minLength={3}
                maxLength={500}
                value={correctionReason}
                onChange={(event) => setCorrectionReason(event.target.value)}
              />
              {correcting.refund_nio > 0 && (
                <Select
                  label="Tratamiento de los pagos"
                  value={paymentTreatment}
                  onChange={(event) => {
                    setPaymentTreatment(
                      event.target.value as PurchasePaymentTreatment,
                    )
                    setRefundConfirmed(false)
                  }}
                >
                  {correcting.account === 'credito' && (
                    <option value="keep_payments">
                      Conservar abonos reales en el reemplazo
                    </option>
                  )}
                  <option value="recording_error">
                    Corregir pagos registrados por error
                  </option>
                  <option value="refund">
                    Registrar devolución real del proveedor
                  </option>
                </Select>
              )}
              {correcting.refund_nio > 0 && (
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={refundConfirmed}
                    onChange={(event) =>
                      setRefundConfirmed(event.target.checked)
                    }
                  />
                  {purchaseConfirmation(paymentTreatment)} (C${' '}
                  {Number(correcting.refund_nio).toFixed(2)}).
                </label>
              )}
            </>
          )}
          <div className="form-grid">
            <Input
              label={correcting ? 'Fecha del reemplazo' : 'Fecha de la compra'}
              type="date"
              disabled={Boolean(correcting)}
              required
              max={today}
              value={incurredOn}
              error={checked ? (dateProblem ?? undefined) : undefined}
              onChange={(event) => setIncurredOn(event.target.value)}
            />
            <SupplierAutocomplete
              value={supplier}
              onChange={setSupplier}
              disabled={busy}
            />
            <Input
              label="Factura o referencia"
              maxLength={200}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
            <Select
              label="Pago"
              value={payment}
              onChange={(event) =>
                setPayment(event.target.value as ShipmentPayment)
              }
            >
              {(Object.keys(shipmentPayments) as ShipmentPayment[]).map(
                (id) => (
                  <option key={id} value={id}>
                    {shipmentPayments[id]}
                  </option>
                ),
              )}
            </Select>
            <Select
              label="Moneda de la compra"
              value={currency}
              onChange={(event) => {
                setCurrency(event.target.value as Currency)
                setBank('')
              }}
            >
              <option value="NIO">C$ Córdobas</option>
              <option value="USD">US$ Dólares</option>
            </Select>
            {payment === 'banco' && (
              <Select
                label="Banco pagador"
                value={bank}
                onChange={(event) => setBank(event.target.value)}
                required
              >
                <option value="">Seleccionar banco</option>
                {purchaseBanks
                  .filter((item) => item.currency === currency)
                  .map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.name}
                    </option>
                  ))}
              </Select>
            )}
            {currency === 'USD' && (
              <Input
                label="Tasa del pedido (C$ por dólar)"
                type="number"
                inputMode="decimal"
                min={0.000001}
                step={0.00001}
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
          {pastPayment && (
            <PaymentDateConfirmation
              date={incurredOn}
              confirmed={confirmedPaymentDate === dateKey}
              onConfirm={(value) =>
                setConfirmedPaymentDate(value ? dateKey : '')
              }
              onToday={() => {
                const nextToday = localDay(new Date())
                setToday(nextToday)
                setIncurredOn(nextToday)
              }}
            />
          )}
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
            {busy
              ? 'Registrando…'
              : uncertain
                ? 'Verificar guardado'
                : correcting
                  ? 'Guardar corrección'
                  : 'Registrar compra'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || uncertain}
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
          step={0.01}
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
        → promedio estimado <strong>C$ {exactCost(nextAverage)}</strong>
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
  notice,
  onClose,
  onRecorded,
}: {
  item: InventoryItem
  pricing: ProductPricing | undefined
  catalogRate: number | null
  notice?: string
  onClose: () => void
  onRecorded: (message: string) => void
}) {
  const { accountingService } = useServices()
  const { storageScope = 'anonymous' } = useAccess()
  const [operation] = useState(() =>
    createIdempotentOperation<Omit<OpeningCostInput, 'requestId'>, unknown>(
      accountingService.setOpeningCost,
      { scope: storageScope, key: 'opening-cost', label: 'Costo inicial' },
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
    !hasDecimals(unit, 2)
      ? 'Escribe el costo por unidad (hasta dos decimales).'
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
        unitCost: round5(unit),
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
        {notice && <p role="status">{notice}</p>}
        <p className="muted">
          {counts.format(total)} unidades contadas en tienda y bodega.
        </p>
        <fieldset disabled={busy} className="form-grid">
          <Input
            label={`Costo por unidad (${currency === 'NIO' ? 'C$' : 'US$'})`}
            type="number"
            inputMode="decimal"
            min={0}
            step={0.01}
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
              step={0.00001}
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

import { useCallback, useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { ProductSelect } from '../../components/ProductSelect'
import { SupplierAutocomplete } from '../../components/SupplierAutocomplete'
import { Button, Dialog, Input, Select } from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { useServices } from '../../services/useServices'
import { useQuery } from '../../lib/useQuery'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { errorMessage } from '../../lib/errors'
import { accountingExchangeRate } from '../../lib/exchangeRates'
import {
  labels,
  type Currency,
  type InventoryItem,
  type InventoryLocation,
} from '../../lib/domain'
import { localDay } from '../reports/model'
import { PurchaseAmounts } from '../pricing/PurchaseAmounts'
import {
  hasDecimals,
  typed,
  validRate,
  type PurchaseLineDraft,
} from '../pricing/costPreview'
import {
  recordInventoryReceipt,
  type InventoryReceiptInput,
} from './inventoryReceipts'
import './inventory-receipts.css'

const blankLine = (): PurchaseLineDraft => ({
  productId: '',
  location: 'warehouse',
  quantity: '',
  unitPrice: '',
})

export function InventoryReceiptDialog({
  items,
  initialProduct = '',
  initialLocation = 'warehouse',
  initialQuantity,
  initialNote = '',
  onClose,
  onRecorded,
}: {
  items: InventoryItem[]
  initialProduct?: string
  initialLocation?: InventoryLocation
  initialQuantity?: number
  initialNote?: string
  onClose: () => void
  onRecorded: (message: string) => void
}) {
  const { storageScope = 'anonymous' } = useAccess()
  const { settingsService } = useServices()
  const loadRate = useCallback(
    () => settingsService.getExchangeRate(),
    [settingsService],
  )
  const { data: catalogRate } = useQuery(loadRate)
  const [operation] = useState(() =>
    createIdempotentOperation<Omit<InventoryReceiptInput, 'requestId'>, string>(
      recordInventoryReceipt,
      {
        scope: storageScope,
        key: 'inventory-receipt',
        label: 'Recepción de mercadería',
      },
    ),
  )
  const [incurredOn, setIncurredOn] = useState(() => localDay(new Date()))
  const [currency, setCurrency] = useState<Currency>('NIO')
  const [rateText, setRateText] = useState<string | null>(null)
  const rateValue =
    rateText ?? String(accountingExchangeRate(catalogRate) ?? '')
  const [shipping, setShipping] = useState('0')
  const [supplier, setSupplier] = useState('')
  const [agency, setAgency] = useState('')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState(initialNote)
  const [lines, setLines] = useState<PurchaseLineDraft[]>(() => [
    {
      ...blankLine(),
      productId: initialProduct,
      location: initialLocation,
      quantity: initialQuantity === undefined ? '' : String(initialQuantity),
    },
  ])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const uncertain = operation.isUncertain()
  const rate = validRate(currency, rateValue)
  const units = lines.reduce(
    (total, line) =>
      total +
      (Number.isInteger(typed(line.quantity)) ? typed(line.quantity) : 0),
    0,
  )
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
    setFailure('')
    if (!uncertain) {
      const seen = new Set<string>()
      for (const line of lines) {
        const quantity = typed(line.quantity),
          unitPrice = typed(line.unitPrice)
        if (
          !items.some(
            (item) => item.product.id === line.productId && item.product.active,
          ) ||
          seen.has(line.productId)
        ) {
          setFailure('Selecciona perfumes activos sin repetirlos en el pedido.')
          return
        }
        seen.add(line.productId)
        if (
          !Number.isInteger(quantity) ||
          quantity < 1 ||
          quantity > 1_000_000
        ) {
          setFailure('Escribe cantidades enteras entre 1 y 1,000,000.')
          return
        }
        if (
          !Number.isFinite(unitPrice) ||
          unitPrice < 0 ||
          unitPrice > 1_000_000_000 ||
          !hasDecimals(unitPrice, 2)
        ) {
          setFailure(
            'Escribe el costo por unidad de cada perfume, con hasta dos decimales.',
          )
          return
        }
      }
      const shippingAmount = typed(shipping)
      if (
        !incurredOn ||
        incurredOn > localDay(new Date()) ||
        rate === null ||
        !Number.isFinite(shippingAmount) ||
        shippingAmount < 0 ||
        shippingAmount > 1_000_000_000 ||
        !hasDecimals(shippingAmount, 2)
      ) {
        setFailure(
          'Revisa la fecha, la tasa y el envío del pedido. Si no hubo envío, escribe 0.',
        )
        return
      }
      if (
        lines.reduce(
          (total, line) => total + typed(line.quantity) * typed(line.unitPrice),
          shippingAmount,
        ) <= 0
      ) {
        setFailure('Revisa el costo de los perfumes y del envío.')
        return
      }
    }
    setBusy(true)
    try {
      if (uncertain) await operation.retryPending()
      else
        await operation.execute({
          incurredOn,
          supplier: supplier.trim(),
          agency: agency.trim(),
          reference: reference.trim(),
          note: note.trim(),
          currency,
          exchangeRate: rate!,
          shippingAmount: typed(shipping),
          lines: lines.map((line) => ({
            productId: line.productId,
            location: line.location,
            quantity: typed(line.quantity),
            unitPrice: typed(line.unitPrice),
          })),
        })
      onRecorded(
        'Recepción guardada, pendiente de revisión contable. Estas unidades todavía no están disponibles para vender.',
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
      title="Recibir mercadería"
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
          <p className="receipt-notice">
            La mercadería quedará pendiente de revisión contable. Estará
            disponible para vender después de que Contabilidad confirme el costo
            y la cuenta de pago.
          </p>
          <div className="form-grid">
            <Input
              label="Fecha de recepción"
              type="date"
              required
              max={localDay(new Date())}
              value={incurredOn}
              onChange={(event) => setIncurredOn(event.target.value)}
            />
            <SupplierAutocomplete
              value={supplier}
              onChange={setSupplier}
              disabled={busy || uncertain}
            />
            <Input
              label="Factura o referencia"
              maxLength={200}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
            <Input
              label="Agencia de envío"
              maxLength={160}
              value={agency}
              onChange={(event) => setAgency(event.target.value)}
            />
            <Select
              label="Moneda de la compra"
              value={currency}
              onChange={(event) => {
                setCurrency(event.target.value as Currency)
                if (!rateText && catalogRate)
                  setRateText(String(catalogRate.usdToNio))
              }}
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
                value={rateValue}
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
              <section
                className="pricing-purchase-line"
                aria-label={`Perfume ${index + 1}`}
                key={index}
              >
                <div className="pricing-purchase-line-fields">
                  <ProductSelect
                    label={`Perfume ${index + 1}`}
                    products={items
                      .filter((item) => item.product.active)
                      .map((item) => item.product)}
                    value={line.productId}
                    onChange={(productId) => update(index, { productId })}
                  />
                  <Select
                    label="Entra a"
                    value={line.location}
                    onChange={(event) =>
                      update(index, {
                        location: event.target.value as InventoryLocation,
                      })
                    }
                  >
                    <option value="warehouse">
                      {labels.location.warehouse}
                    </option>
                    <option value="store">{labels.location.store}</option>
                  </Select>
                  <Input
                    label="Unidades"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={1_000_000}
                    step={1}
                    value={line.quantity}
                    onChange={(event) =>
                      update(index, { quantity: event.target.value })
                    }
                  />
                  <Input
                    label={`Costo por unidad (${currency === 'NIO' ? 'C$' : 'US$'})`}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.01}
                    value={line.unitPrice}
                    onChange={(event) =>
                      update(index, { unitPrice: event.target.value })
                    }
                  />
                  {lines.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={`Quitar perfume ${index + 1}`}
                      onClick={() =>
                        setLines((current) =>
                          current.filter((_, position) => position !== index),
                        )
                      }
                    >
                      <Trash2 size={16} />
                    </Button>
                  )}
                </div>
              </section>
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
            {units.toLocaleString('es-NI')} unidades pendientes de revisión
          </p>
          <PurchaseAmounts
            goods={lines.reduce(
              (sum, line) =>
                sum +
                (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0),
              0,
            )}
            shipping={Number(shipping)}
            currency={currency}
            exchangeRate={rate}
            systemRate={catalogRate?.usdToNio}
          />
        </fieldset>
        {failure && (
          <p role="alert" className="inline-error">
            {failure}
          </p>
        )}
        <div className="form-actions">
          <Button type="submit" disabled={busy} aria-busy={busy}>
            {busy
              ? 'Guardando…'
              : uncertain
                ? 'Verificar guardado'
                : 'Guardar recepción'}
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

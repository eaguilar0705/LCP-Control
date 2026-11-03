import { useCallback, useState, type FormEvent } from 'react'
import { Plus, Trash2, RefreshCw } from 'lucide-react'
import {
  Button,
  Dialog,
  Input,
  Select,
  ErrorState,
  LoadingState,
} from '../../components/ui'
import { ProductSelect } from '../../components/ProductSelect'
import { useQuery } from '../../lib/useQuery'
import { useServices } from '../../services/useServices'
import { useAccess } from '../../app/AccessContext'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { AppError, errorMessage } from '../../lib/errors'
import { formatCurrency, formatDate } from '../../lib/format'
import {
  labels,
  type Currency,
  type DocumentRecord,
  type InvoicePayment,
  type InventoryItem,
  type InventoryLocation,
  type PaymentMethod,
  type PriceTier,
  type ShippingMethod,
} from '../../lib/domain'
import { priceTierLabels, productPrice } from '../../lib/pricing'
import { listContacts, type ContactRecord } from '../../services/workspace'
import { CustomerAutocomplete } from './CustomerAutocomplete'
import { SplitPayments } from './SplitPayments'
import { splitPaymentsValid } from './splitPaymentModel'
import { shippingMethodLabels } from './shipping'
import { DocumentPrint } from './DocumentPrint'
import { downloadDocumentPdf } from './pdf'
import {
  correctInvoice,
  getInvoiceEditDetail,
  type EditableInvoice,
  type InvoiceCorrectionInput,
  type InvoiceEditDetail,
} from './invoiceCorrections'
import './invoice-edit.css'

const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const money = (n: number, max = 10000000) =>
  Number.isFinite(n) &&
  n >= 0 &&
  n <= max &&
  Math.abs(n * 100 - Math.round(n * 100)) < 0.000001
export function InvoiceEditDialog({
  document,
  onClose,
  onSaved,
}: {
  document: DocumentRecord
  onClose: () => void
  onSaved: (document: DocumentRecord) => void
}) {
  const { inventoryService } = useServices()
  const load = useCallback(async () => {
    const [detail, inventory, customers] = await Promise.all([
      getInvoiceEditDetail(document.id),
      inventoryService.getInventory(true),
      listContacts('customers'),
    ])
    return { detail, inventory, customers }
  }, [document.id, inventoryService])
  const { data, error, loading, retry } = useQuery(load)
  const [pending, setPending] = useState(false)
  return (
    <Dialog
      open
      title={`Editar factura ${document.number}`}
      className="invoice-edit-dialog"
      dismissible={!pending}
      onClose={() => {
        if (!pending) onClose()
      }}
    >
      {loading ? (
        <LoadingState />
      ) : error || !data ? (
        <ErrorState
          message={error ?? 'No se recibió la factura.'}
          retry={retry}
        />
      ) : data.detail.hasReturns ? (
        <>
          <p role="alert">
            Esta factura tiene notas de crédito. Conserva su detalle original y
            registra la corrección con una nueva factura o devolución.
          </p>
          <Button variant="secondary" onClick={onClose}>
            Cerrar
          </Button>
        </>
      ) : (
        <InvoiceEditForm
          key={data.detail.document.revision}
          {...data}
          onPending={setPending}
          onReload={retry}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </Dialog>
  )
}
function InvoiceEditForm({
  detail,
  inventory,
  customers,
  onPending,
  onReload,
  onClose,
  onSaved,
}: {
  detail: InvoiceEditDetail
  inventory: InventoryItem[]
  customers: ContactRecord[]
  onPending: (pending: boolean) => void
  onReload: () => void
  onClose: () => void
  onSaved: (d: DocumentRecord) => void
}) {
  const d = detail.document
  const { storageScope = 'anonymous' } = useAccess()
  const [customerId, setCustomerId] = useState<string | null>(d.customerId)
  const [customer, setCustomer] = useState(d.customerName)
  const [phone, setPhone] = useState(d.customerPhone ?? '')
  const [taxId, setTaxId] = useState(d.customerTaxId ?? '')
  const [currency, setCurrency] = useState(d.currency)
  const [rateText, setRateText] = useState(
    String(
      d.currency === 'USD' ? (d.exchangeRate ?? '') : (d.catalogRate ?? ''),
    ),
  )
  const [tier, setTier] = useState(d.tier)
  const [location, setLocation] = useState<InventoryLocation>(
    d.location ?? 'store',
  )
  const [payment, setPayment] = useState<PaymentMethod | 'pending'>(
    d.paymentMethod ?? 'pending',
  )
  const [payments, setPayments] = useState<InvoicePayment[]>(d.payments ?? [])
  const [shippingMethod, setShippingMethod] = useState<ShippingMethod | ''>(
    d.shippingMethod ?? '',
  )
  const [shippingText, setShippingText] = useState(
    String(d.shippingAmount ?? 0),
  )
  const [discountText, setDiscountText] = useState(
    String(d.invoiceDiscount ?? 0),
  )
  const [notes, setNotes] = useState(d.notes)
  const [lines, setLines] = useState(() =>
    d.items.map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
      price: i.originalUnitPrice ?? i.unitPrice,
      discount: round((i.originalUnitPrice ?? i.unitPrice) - i.unitPrice),
    })),
  )
  const [operation] = useState(() =>
    createIdempotentOperation<
      Omit<InvoiceCorrectionInput, 'requestId'>,
      EditableInvoice
    >(correctInvoice, {
      scope: storageScope,
      key: 'invoice-correction',
      label: 'Edición de factura',
    }),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stale, setStale] = useState(false)
  const [historyDocument, setHistoryDocument] =
    useState<EditableInvoice | null>(null)
  const [downloading, setDownloading] = useState(false)
  const uncertain = operation.isUncertain()
  const rate = Number(rateText)
  const accountingRate = currency === 'NIO' ? 1 : rate
  const goods = round(
    lines.reduce((sum, l) => sum + l.quantity * (l.price - l.discount), 0),
  )
  const total = round(goods - Number(discountText) + Number(shippingText))
  const lineValid =
    lines.length > 0 &&
    lines.length <= 100 &&
    lines.every(
      (l) =>
        l.productId &&
        Number.isInteger(l.quantity) &&
        l.quantity > 0 &&
        l.quantity <= 10000 &&
        money(l.price) &&
        l.price > 0 &&
        money(l.discount) &&
        l.discount < l.price,
    )
  const valid =
    lineValid &&
    money(Number(discountText), 100000000000000) &&
    Number(discountText) < goods &&
    money(Number(shippingText)) &&
    total > 0 &&
    (shippingMethod || Number(shippingText) === 0) &&
    accountingRate > 0 &&
    accountingRate <= 1000 &&
    Number.isFinite(accountingRate) &&
    (payments.length === 0 ||
      splitPaymentsValid(payments, total, currency, accountingRate))
  const signature = JSON.stringify({
    customerId,
    customer,
    phone,
    taxId,
    currency,
    rateText,
    tier,
    location,
    payment,
    payments,
    shippingMethod,
    shippingText,
    discountText,
    notes,
    lines,
  })
  const [originalSignature] = useState(signature)
  const changed = signature !== originalSignature
  const selectedProducts = new Set(lines.map((l) => l.productId))
  function priceFor(productId: string) {
    const product = inventory.find((i) => i.product.id === productId)?.product
    return product ? (productPrice(product, tier, currency) ?? 0) : 0
  }
  function availableFor(productId: string) {
    const count = inventory.find((i) => i.product.id === productId)?.quantities[
      location
    ]
    const included =
      location === d.location
        ? (d.items.find((i) => i.productId === productId)?.quantity ?? 0)
        : 0
    return count == null
      ? 'Conteo pendiente'
      : `Hasta ${count + included} unidades desde ${labels.location[location]}`
  }
  function convert(next: Currency) {
    if (next === currency) return
    if (!Number.isFinite(rate) || rate <= 0) {
      setError('Indica el tipo de cambio antes de cambiar la moneda.')
      return
    }
    const factor = currency === 'USD' ? rate : 1 / rate
    setLines((old) =>
      old.map((l) => ({
        ...l,
        price: round(l.price * factor),
        discount: round(l.discount * factor),
      })),
    )
    setDiscountText(String(round(Number(discountText) * factor)))
    setShippingText(String(round(Number(shippingText) * factor)))
    setPayments([])
    setCurrency(next)
    if (payment.endsWith('_nio') || payment.endsWith('_usd'))
      setPayment(
        payment.replace(
          /_(nio|usd)$/,
          next === 'NIO' ? '_nio' : '_usd',
        ) as PaymentMethod,
      )
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || stale) return
    if (!uncertain && !valid) {
      setError(
        'Revisa cantidades, precios, descuentos, envío y pagos antes de guardar.',
      )
      return
    }
    setBusy(true)
    setError('')
    onPending(true)
    try {
      const result = uncertain
        ? await operation.retryPending()
        : await operation.execute({
            documentId: d.id,
            expectedRevision: d.revision,
            customerId,
            customerName: customer.trim(),
            customerPhone: phone.trim() || null,
            customerTaxId: taxId.trim(),
            currency,
            exchangeRate: accountingRate,
            ...(Number.isFinite(rate) && rate > 0 ? { catalogRate: rate } : {}),
            tier,
            location,
            paymentMethod: payments[0]?.method ?? payment,
            ...(payments.length ? { payments } : {}),
            notes,
            invoiceDiscount: Number(discountText),
            shippingMethod: shippingMethod || null,
            shippingAmount: Number(shippingText),
            expectedTotal: total,
            items: lines.map((l) => ({
              productId: l.productId,
              quantity: l.quantity,
              unitPrice: l.price,
              finalUnitPrice: round(l.price - l.discount),
            })),
          })
      onPending(false)
      onSaved(result)
    } catch (failure) {
      setError(errorMessage(failure))
      onPending(operation.isUncertain())
      if (failure instanceof AppError && /factura cambió/.test(failure.message))
        setStale(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {historyDocument ? (
        <div className="invoice-edit-version">
          <p>Versión del historial · revisión {historyDocument.revision}</p>
          <div className="form-actions">
            <Button
              variant="secondary"
              onClick={() => setHistoryDocument(null)}
            >
              Volver a editar
            </Button>
            <Button
              disabled={downloading}
              onClick={async () => {
                setDownloading(true)
                try {
                  await downloadDocumentPdf(historyDocument)
                } catch (e) {
                  setError(errorMessage(e))
                } finally {
                  setDownloading(false)
                }
              }}
            >
              Descargar esta versión
            </Button>
          </div>
          <div className="invoice-edit-paper">
            <DocumentPrint document={historyDocument} />
          </div>
        </div>
      ) : (
        <form
          className="invoice-edit-form"
          onSubmit={submit}
          onChange={() => {
            if (!uncertain && !stale) setError('')
          }}
        >
          <p>
            {formatDate(d.createdAt)} · revisión {d.revision}
          </p>
          {!!detail.collections.length && (
            <p className="day-notice">
              {detail.collections.length === 1
                ? 'Hay un cobro registrado.'
                : `Hay ${detail.collections.length} cobros registrados.`}{' '}
              Si cambias la factura a pagada, los cobros de la misma fecha se
              incorporan a la forma de pago elegida sin duplicar el dinero
              recibido.
            </p>
          )}
          <fieldset
            className="invoice-edit-fields"
            disabled={busy || uncertain || stale}
          >
            <div className="invoice-edit-grid">
              <CustomerAutocomplete
                value={customer}
                customers={customers}
                selected={false}
                loading={false}
                maxLength={160}
                onChange={(name) => {
                  setCustomer(name)
                  setCustomerId(null)
                }}
                onSelect={(c) => {
                  setCustomer(c.name)
                  setCustomerId(c.id)
                  setPhone(c.phone ?? '')
                  setTaxId(c.taxId ?? '')
                }}
                onClear={() => {
                  setCustomer('')
                  setCustomerId(null)
                }}
              />
              <Input
                label="WhatsApp del cliente"
                value={phone}
                maxLength={40}
                onChange={(e) => setPhone(e.target.value)}
              />
              <Input
                label="RUC / Identificación del cliente"
                value={taxId}
                maxLength={80}
                onChange={(e) => setTaxId(e.target.value)}
              />
              <Select
                label="Lista de precios"
                value={tier}
                onChange={(e) => setTier(e.target.value as PriceTier)}
              >
                {Object.entries(priceTierLabels).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </Select>
              <Select
                label="Moneda de la factura"
                value={currency}
                onChange={(e) => convert(e.target.value as Currency)}
              >
                <option value="NIO">C$ Córdobas</option>
                <option value="USD">US$ Dólares</option>
              </Select>
              <Input
                label="Tipo de cambio C$ por US$"
                type="number"
                min="0.000001"
                max="1000"
                step="0.000001"
                required={currency === 'USD'}
                value={rateText}
                onChange={(e) => setRateText(e.target.value)}
              />
              <Select
                label="Sale de"
                value={location}
                onChange={(e) =>
                  setLocation(e.target.value as InventoryLocation)
                }
              >
                <option value="store">Tienda</option>
                <option value="warehouse">Bodega</option>
              </Select>
            </div>
            <div className="section-heading">
              <h3>Productos</h3>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  const missing = lines.some((l) => priceFor(l.productId) <= 0)
                  if (missing) {
                    setError(
                      'Hay perfumes sin precio en la lista seleccionada. Completa su precio manualmente.',
                    )
                    return
                  }
                  setLines((old) =>
                    old.map((l) => ({
                      ...l,
                      price: priceFor(l.productId),
                      discount: 0,
                    })),
                  )
                }}
              >
                <RefreshCw size={15} />
                Usar precios de la lista
              </Button>
            </div>
            <div className="invoice-edit-lines">
              {lines.map((line, index) => (
                <div className="invoice-edit-line" key={index}>
                  <ProductSelect
                    label={`Perfume ${index + 1}`}
                    products={inventory
                      .map((i) => i.product)
                      .filter(
                        (p) =>
                          p.id === line.productId ||
                          (!selectedProducts.has(p.id) && p.active),
                      )}
                    value={line.productId}
                    onChange={(id) =>
                      setLines((old) =>
                        old.map((l, i) =>
                          i === index
                            ? {
                                productId: id,
                                quantity: 1,
                                price: priceFor(id),
                                discount: 0,
                              }
                            : l,
                        ),
                      )
                    }
                  />
                  <div className="invoice-edit-line-inputs">
                    <Input
                      label={`Cantidad ${index + 1}`}
                      type="number"
                      min="1"
                      max="10000"
                      step="1"
                      required
                      value={line.quantity || ''}
                      onChange={(e) =>
                        setLines((old) =>
                          old.map((l, i) =>
                            i === index
                              ? { ...l, quantity: Number(e.target.value) }
                              : l,
                          ),
                        )
                      }
                    />
                    <Input
                      label={`Precio unitario ${index + 1}`}
                      type="number"
                      min="0.01"
                      max="10000000"
                      step="0.01"
                      required
                      value={line.price || ''}
                      onChange={(e) =>
                        setLines((old) =>
                          old.map((l, i) =>
                            i === index
                              ? { ...l, price: Number(e.target.value) }
                              : l,
                          ),
                        )
                      }
                    />
                    <Input
                      label={`Descuento por unidad ${index + 1}`}
                      type="number"
                      min="0"
                      max={line.price}
                      step="0.01"
                      value={line.discount || ''}
                      onChange={(e) =>
                        setLines((old) =>
                          old.map((l, i) =>
                            i === index
                              ? { ...l, discount: Number(e.target.value) }
                              : l,
                          ),
                        )
                      }
                    />
                  </div>
                  <div className="invoice-edit-line-footer">
                    <small>{availableFor(line.productId)}</small>
                    <strong>
                      {formatCurrency(
                        round(line.quantity * (line.price - line.discount)),
                        currency,
                      )}
                    </strong>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={lines.length <= 1}
                      aria-label={`Quitar perfume ${index + 1}`}
                      onClick={() =>
                        setLines((old) => old.filter((_, i) => i !== index))
                      }
                    >
                      <Trash2 size={16} />
                      Quitar
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={lines.length >= 100}
              onClick={() =>
                setLines((old) => [
                  ...old,
                  { productId: '', quantity: 1, price: 0, discount: 0 },
                ])
              }
            >
              <Plus size={16} />
              Agregar perfume
            </Button>
            <div className="invoice-edit-grid">
              <Input
                label={`Descuento total (${currency})`}
                type="number"
                min="0"
                step="0.01"
                value={discountText}
                onChange={(e) => setDiscountText(e.target.value)}
              />
              <Select
                label="Tipo de envío"
                value={shippingMethod}
                onChange={(e) => {
                  setShippingMethod(e.target.value as ShippingMethod | '')
                  if (!e.target.value) setShippingText('0')
                }}
              >
                <option value="">Sin envío</option>
                {Object.entries(shippingMethodLabels).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </Select>
              {!!shippingMethod && (
                <Input
                  label={`Cobro por envío (${currency})`}
                  type="number"
                  min="0"
                  max="10000000"
                  step="0.01"
                  value={shippingText}
                  onChange={(e) => setShippingText(e.target.value)}
                />
              )}
            </div>
            {payments.length ? (
              <SplitPayments
                value={payments}
                onChange={setPayments}
                currency={currency}
                total={total}
                rate={accountingRate}
              />
            ) : (
              <div className="invoice-edit-grid">
                <Select
                  label="Forma de pago"
                  value={payment}
                  onChange={(e) =>
                    setPayment(e.target.value as PaymentMethod | 'pending')
                  }
                >
                  <option value="pending">Por cobrar</option>
                  {Object.entries(labels.payment)
                    .filter(
                      ([id]) =>
                        !id.endsWith(currency === 'NIO' ? '_usd' : '_nio'),
                    )
                    .map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                </Select>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    setPayments([
                      {
                        method: payment === 'pending' ? 'cash' : payment,
                        currency,
                        amount: total,
                        exchangeRate: accountingRate,
                      },
                      {
                        method: 'cash',
                        currency,
                        amount: 0,
                        exchangeRate: accountingRate,
                      },
                    ])
                  }
                >
                  Dividir pago
                </Button>
              </div>
            )}
            <Input
              label="Notas de la factura"
              value={notes}
              maxLength={2000}
              onChange={(e) => setNotes(e.target.value)}
            />
          </fieldset>
          <div className="invoice-edit-total">
            <span>Total corregido</span>
            <strong>
              {Number.isFinite(total)
                ? formatCurrency(total, currency)
                : 'Revisar importes'}
            </strong>
          </div>
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
          {stale && (
            <Button type="button" variant="secondary" onClick={onReload}>
              Cargar última versión
            </Button>
          )}
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={busy || uncertain}
              onClick={onClose}
            >
              Cancelar
            </Button>
            <Button disabled={busy || stale || (!uncertain && !changed)}>
              {busy
                ? 'Guardando…'
                : uncertain
                  ? 'Verificar guardado'
                  : 'Guardar cambios'}
            </Button>
          </div>
        </form>
      )}
      {!!detail.history.length && !uncertain && (
        <details className="day-history">
          <summary>Historial de ediciones ({detail.history.length})</summary>
          {detail.history.map((h) => (
            <article className="day-history-event" key={h.id}>
              <div>
                <strong>Revisión {h.revision}</strong>
                <span>
                  {formatDate(h.createdAt)} · {h.actorName}
                </span>
              </div>
              <div className="form-actions">
                <Button
                  variant="secondary"
                  onClick={() => setHistoryDocument(h.before)}
                >
                  Ver versión anterior · revisión {h.before.revision}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setHistoryDocument(h.after)}
                >
                  Ver versión guardada · revisión {h.after.revision}
                </Button>
              </div>
            </article>
          ))}
        </details>
      )}
    </>
  )
}

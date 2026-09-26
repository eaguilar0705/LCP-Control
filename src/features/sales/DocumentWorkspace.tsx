import { ProductPicker } from './ProductPicker'
import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import { listContacts } from '../../services/workspace'
import { DocumentPrint } from './DocumentPrint'
import {
  CircleCheckBig,
  FileDown,
  MessageCircle,
  Plus,
  Printer,
  Save,
  Trash2,
} from 'lucide-react'
import {
  Button,
  Card,
  ConfirmDialog,
  Input,
  Select,
  ErrorState,
  LoadingState,
} from '../../components/ui'
import { Brand } from '../../components/Brand'
import { PriceControls } from '../../components/PriceControls'
import { useServices } from '../../services/useServices'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { useAccess } from '../../app/AccessContext'
import { useQuery } from '../../lib/useQuery'
import { useWorkspaceDrafts } from '../../lib/workspaceDrafts'
import { errorMessage } from '../../lib/errors'
import { formatCurrency, formatDate } from '../../lib/format'
import { documentCopy, labels } from '../../lib/domain'
import type {
  Currency,
  DocumentKind,
  DocumentRecord,
  InventoryLocation,
  PriceTier,
  NewDocument,
} from '../../lib/domain'
import { equivalentAmount, priceTierLabels } from '../../lib/pricing'
import {
  defaultValidUntil,
  documentDraftSchema,
  draftPreview,
  draftStorageKey,
  draftTotal,
  isoDate,
  includedTax,
  type DocumentDraft,
  type DraftLine,
} from './document'
import { whatsappNumber, whatsappUrl } from './whatsapp'
import { shareDocumentPdf } from './pdf'

const paymentOptions = {
  pending: 'Pendiente de pago',
  ...labels.payment,
}
// Tope de PostgreSQL para el nombre del cliente al emitir (create_document).
const MAX_CUSTOMER_NAME = 160
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/

export function DocumentWorkspace({ kind }: { kind: DocumentKind }) {
  const { inventoryService, salesService } = useServices()
  const [operation] = useState(() =>
    createIdempotentOperation<Omit<NewDocument, 'requestId'>, DocumentRecord>(
      salesService.createDocument,
    ),
  )
  const copy = documentCopy[kind]
  const { demo, base } = useAccess()
  const {
    data,
    loading,
    error: loadError,
    retry,
  } = useQuery(inventoryService.getInventory)
  const {
    data: business,
    error: businessError,
    loading: businessLoading,
    retry: retryBusiness,
  } = useQuery(salesService.getBusiness)
  const { data: savedRate } = useQuery(salesService.getExchangeRate)
  const {
    items: drafts,
    save,
    error,
    loading: draftsLoading,
    retry: retryDrafts,
  } = useWorkspaceDrafts(draftStorageKey(kind), documentDraftSchema)
  const [currency, setCurrency] = useState<Currency>('NIO')
  const [taxRate, setTaxRate] = useState(0)
  // `null` significa «no lo he tocado»: entonces rige la tasa del negocio. Una
  // cadena vacía es una decisión del usuario y deja el campo en blanco.
  const [exchangeText, setExchangeText] = useState<string | null>(null)
  const [tier, setTier] = useState<PriceTier>('emprendedor')
  const loadCustomers = useCallback(
    () => (demo ? Promise.resolve([]) : listContacts('customers')),
    [demo],
  )
  const {
    data: customers,
    error: customersError,
    retry: retryCustomers,
  } = useQuery(loadCustomers)
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [customer, setCustomer] = useState('')
  const [phone, setPhone] = useState('')
  const [taxId, setTaxId] = useState('')
  const [payment, setPayment] = useState<DocumentDraft['payment']>('pending')
  const [location, setLocation] = useState<InventoryLocation>('store')
  const [validUntil, setValidUntil] = useState(defaultValidUntil())
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([])
  const [current, setCurrent] = useState<{
    id: string
    reference: string
    createdAt: string
  } | null>(null)
  const [issued, setIssued] = useState<DocumentRecord | null>(null)
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)
  // Guardar y compartir tienen su propio estado: el botón muestra qué ocurre
  // y un doble clic no envía dos veces la misma revisión de borradores.
  const [savingDraft, setSavingDraft] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const exchangeField =
    exchangeText ?? (savedRate ? String(savedRate.usdToNio) : '')
  const exchangeRate = exchangeField === '' ? null : Number(exchangeField)

  const valid = lines.every(
    (line) =>
      Number.isInteger(line.quantity) &&
      line.quantity > 0 &&
      line.quantity <= 9999,
  )
  const total = valid ? draftTotal(lines, tier, currency) : null
  const validTax = Number.isFinite(taxRate) && taxRate >= 0 && taxRate <= 100
  const validExchange = currency === 'NIO' || (exchangeRate !== null && Number.isFinite(exchangeRate) && exchangeRate > 0 && exchangeRate <= 1000000)
  /**
   * Motivo por el que una línea no puede facturarse, junto a su cantidad. Las
   * existencias se comprueban al emitir en PostgreSQL, que es la autoridad;
   * avisar aquí evita llegar al final del documento para descubrir que faltaba
   * producto. Una ubicación sin conteo también se señala: la base rechazaría la
   * factura con su propio mensaje y el vendedor perdería el documento entero.
   */
  function quantityIssue(line: DraftLine): string | undefined {
    if (!Number.isInteger(line.quantity) || line.quantity < 1)
      return 'Escribe una cantidad entera de 1 a 9999.'
    if (line.quantity > 9999) return 'El máximo por renglón es 9999.'
    const item = data?.find((entry) => entry.product.id === line.productId)
    if (!item || !item.product.active || !item.product.prices)
      return 'Este producto ya no está disponible. Retíralo del documento.'
    if (kind !== 'invoice') return undefined
    const available = item.quantities[location]
    if (available == null)
      return `Sin conteo en ${labels.location[location]}. Registra el inventario antes de facturar.`
    if (available === 0) return `No hay existencias en ${labels.location[location]}.`
    return line.quantity > available
      ? `Solo hay ${available} en ${labels.location[location]}.`
      : undefined
  }
  const shortages = lines.filter((line) => quantityIssue(line)).length
  /**
   * Datos del cliente y de la vigencia que la base rechazaría al emitir. Se
   * avisan junto al campo: antes el nombre vacío o de más de 160 letras se
   * descubría al final, un teléfono mal escrito se descartaba sin decir nada y
   * una vigencia borrada volvía como «No pudimos completar la operación».
   * Los borradores sí pueden quedar incompletos.
   */
  const customerIssue = customerId
    ? undefined
    : !customer.trim()
      ? 'Escribe el nombre del cliente o elige uno registrado.'
      : customer.trim().length > MAX_CUSTOMER_NAME
        ? `Usa ${MAX_CUSTOMER_NAME} caracteres como máximo.`
        : undefined
  const phoneIssue =
    !customerId && phone.trim() && !whatsappNumber(phone)
      ? 'Revisa el número: 8 dígitos, o completo con el código del país.'
      : undefined
  const validityIssue =
    kind !== 'proforma'
      ? undefined
      : !DAY_ONLY.test(validUntil)
        ? 'Elige hasta qué fecha es válida la proforma.'
        : validUntil < isoDate(new Date())
          ? 'La vigencia no puede ser anterior a hoy.'
          : undefined
  const dataIssues = !!(customerIssue || phoneIssue || validityIssue)
  const draft: DocumentDraft | null =
    lines.length && valid && validTax
      ? {
          id: current?.id ?? 'preview',
          kind,
          reference: current?.reference ?? `${copy.prefix}borrador`,
          customer,
          customerId,
          phone,
          taxId,
          currency,
          taxRate,
          exchangeRate: currency === 'NIO' ? 1 : exchangeRate,
          tier,
          payment,
          location,
          validUntil,
          notes,
          createdAt: current?.createdAt ?? new Date().toISOString(),
          lines,
        }
      : null
  // What is shared is always what is on screen: the issued document when it
  // exists, otherwise the draft rendered through the very same shape.
  const shareable: DocumentRecord | null =
    issued ??
    (draft && business
      ? draftPreview(draft, business, savedRate?.usdToNio ?? null)
      : null)

  function add(productId: string) {
    const product = data?.find((item) => item.product.id === productId)?.product
    if (!product?.prices) {
      setMessage('Selecciona un producto del catálogo.')
      return
    }
    if (lines.some((line) => line.productId === product.id)) {
      setMessage(
        `El producto ya está en la ${copy.singular}. Puedes cambiar su cantidad.`,
      )
      return
    }
    setIssued(null)
    setLines([
      ...lines,
      {
        productId: product.id,
        name: `${product.brand} ${product.name}`,
        barcode: product.barcode,
        size:
          product.size === null
            ? 'Tamaño por confirmar'
            : `${product.size} ${product.unit}`,
        quantity: 1,
        prices: structuredClone(product.prices),
      },
    ])
    setMessage('')
  }

  async function saveDraft() {
    if (draftsLoading) {
      setMessage('Espera a que carguen tus borradores.')
      return
    }
    const stamp = current ?? {
      id: crypto.randomUUID(),
      reference: `${copy.prefix}B${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
      createdAt: new Date().toISOString(),
    }
    const result = documentDraftSchema.safeParse({
      ...stamp,
      kind,
      customer,
      customerId,
      phone,
      taxId,
      payment,
      location,
      validUntil,
      notes,
      currency,
      taxRate,
      exchangeRate: currency === 'NIO' ? 1 : exchangeRate,
      tier,
      lines,
    })
    if (!result.success) {
      setMessage('Agrega productos y revisa las cantidades, tasa de impuesto y tipo de cambio.')
      return
    }
    if (savingDraft) return
    setSavingDraft(true)
    try {
      if (
        await save([
          result.data,
          ...drafts.filter((item) => item.id !== stamp.id),
        ])
      ) {
        setCurrent(stamp)
        setMessage(
          demo
            ? 'Borrador guardado en este navegador.'
            : 'Borrador guardado en tu cuenta.',
        )
      }
    } finally {
      setSavingDraft(false)
    }
  }

  /**
   * Quita de la lista el borrador abierto. Sin esto los borradores sólo salían
   * al emitirse y se acumulaban hasta el tope de 1 MB por cuenta, a partir del
   * cual ya no se podía guardar ninguno.
   */
  async function discardDraft() {
    if (!current || issued || savingDraft) return
    setSavingDraft(true)
    try {
      if (await save(drafts.filter((item) => item.id !== current.id))) {
        setConfirmDiscard(false)
        clear()
        setMessage('Borrador eliminado.')
      }
    } finally {
      setSavingDraft(false)
    }
  }

  async function issue() {
    // Las existencias también se comprueban aquí, no sólo al pintar el aviso:
    // emitir con un renglón sin producto termina en un error de la base y el
    // vendedor pierde el documento que ya tenía armado.
    if (
      !lines.length ||
      !valid ||
      !validTax ||
      shortages > 0 ||
      dataIssues ||
      (kind === 'invoice' && !validExchange) ||
      busy ||
      issued ||
      demo
    )
      return
    setBusy(true)
    setFailure('')
    setMessage('')
    try {
      const record = await operation.execute({
        kind,
        customerId: customerId ?? undefined,
        customerName: customer.trim(),
        customerTaxId: taxId.trim(),
        customerPhone: whatsappNumber(phone),
        tier,
        currency,
        taxRate,
        // Una proforma en dólares puede emitirse sin tasa: el contrato la
        // omite en lugar de guardar un nulo que la base rechazaría.
        exchangeRate: currency === 'NIO' ? 1 : (exchangeRate ?? undefined),
        location: kind === 'invoice' ? location : null,
        paymentMethod: kind === 'invoice' ? payment : null,
        validUntil: kind === 'proforma' ? validUntil : null,
        notes,
        items: lines.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
        })),
      })
      setIssued(record)
      if (current) await save(drafts.filter((item) => item.id !== current.id))
      setCurrent({
        id: record.id,
        reference: record.number,
        createdAt: record.createdAt,
      })
      setMessage(
        kind === 'invoice'
          ? `Factura ${record.number} emitida. Las existencias ya se descontaron.`
          : `Proforma ${record.number} emitida. No modifica inventario.`,
      )
      retry()
    } catch (issueError) {
      setFailure(errorMessage(issueError))
    } finally {
      setBusy(false)
    }
  }

  function load(item: DocumentDraft) {
    operation.reset()
    setCurrent(item)
    setIssued(null)
    setCurrency(item.currency)
    setTaxRate(item.taxRate ?? 0)
    setExchangeText(
      item.currency === 'USD' && item.exchangeRate != null
        ? String(item.exchangeRate)
        : null,
    )
    setTier(item.tier)
    setCustomerId(item.customerId)
    setCustomer(item.customer)
    setPhone(item.phone)
    setTaxId(item.taxId)
    setPayment(item.payment)
    setLocation(item.location)
    setValidUntil(item.validUntil || defaultValidUntil())
    setNotes(item.notes)
    let pricesChanged = false
    const refreshedLines = item.lines.map((line) => {
      const product = data?.find((entry) => entry.product.id === line.productId)?.product
      if (!product?.active || !product.prices) return structuredClone(line)
      const prices = structuredClone(product.prices)
      if (Object.keys(priceTierLabels).some((key) => {
        const priceTier = key as PriceTier
        return prices[priceTier].NIO !== line.prices[priceTier].NIO ||
          prices[priceTier].USD !== line.prices[priceTier].USD
      })) pricesChanged = true
      return { ...line, prices }
    })
    setLines(refreshedLines)
    setFailure('')
    setMessage(pricesChanged
      ? 'Borrador abierto con los precios actuales del catálogo. Revisa el total antes de emitir y guarda los cambios.'
      : 'Borrador abierto. Guarda los cambios al terminar.')
  }

  function clear() {
    operation.reset()
    setCurrent(null)
    setIssued(null)
    setCustomerId(null)
    setCustomer('')
    setPhone('')
    setTaxId('')
    setTaxRate(0)
    setExchangeText(null)
    setNotes('')
    setLines([])
    setValidUntil(defaultValidUntil())
    setMessage('')
    setFailure('')
    setPayment('pending')
    setLocation('store')
  }

  function sendWhatsapp() {
    if (!shareable) return
    window.open(whatsappUrl(shareable), '_blank', 'noopener,noreferrer')
    setMessage(
      whatsappNumber(shareable.customerPhone)
        ? 'WhatsApp abierto con el mensaje listo para enviar.'
        : 'WhatsApp abierto. Elige el contacto; el cliente no tiene teléfono guardado.',
    )
  }

  async function sharePdf() {
    if (!shareable || sharing) return
    setBusy(true)
    setSharing(true)
    try {
      const outcome = await shareDocumentPdf(shareable)
      setMessage(
        outcome === 'shared'
          ? 'PDF enviado al menú de compartir.'
          : outcome === 'downloaded'
            ? 'PDF descargado. Adjúntalo en WhatsApp Web o en el chat del cliente.'
            : 'Compartir cancelado.',
      )
    } catch (shareError) {
      setFailure(errorMessage(shareError))
    } finally {
      setBusy(false)
      setSharing(false)
    }
  }

  if (loading || businessLoading) return <LoadingState />
  if (loadError) return <ErrorState message={loadError} retry={retry} />
  if (businessError)
    return <ErrorState message={businessError} retry={retryBusiness} />
  const ready = !!lines.length && valid && validTax
  // Guardar un borrador o imprimirlo no toca el inventario; emitir sí, así que
  // sólo la emisión exige que cada renglón tenga existencias suficientes.
  const issuable =
    ready &&
    shortages === 0 &&
    !dataIssues &&
    (kind !== 'invoice' || validExchange)
  // El borrador abierto sigue en la lista: se puede eliminar.
  const discardable =
    !!current && !issued && drafts.some((item) => item.id === current.id)
  const displayedTotal = issued?.total ?? total
  /**
   * El catálogo se cotiza en dólares y el precio en córdobas sale de la tasa
   * vigente, así que el mismo total existe en las dos monedas. Enseñarlo antes
   * de emitir evita la pregunta de siempre: «¿y eso cuánto es en dólares?».
   * Un documento ya emitido usa la tasa con la que se cotizó, no la de hoy.
   */
  const displayedRate = issued
    ? (issued.catalogRate ??
      (issued.currency === 'USD' ? issued.exchangeRate : null))
    : (savedRate?.usdToNio ?? null)
  const equivalent =
    displayedTotal === null
      ? null
      : equivalentAmount(
          displayedTotal,
          issued?.currency ?? currency,
          displayedRate,
        )
  const displayedTaxRate = issued ? issued.taxRate : taxRate
  const taxBreakdown = displayedTotal !== null && displayedTaxRate !== undefined && displayedTaxRate !== null && Number.isFinite(displayedTaxRate) ? includedTax(displayedTotal, displayedTaxRate) : null
  return (
    <>
      <div className="page-heading no-print">
        <div>
          <h1>{copy.title}</h1>
          <p className="muted">{copy.subtitle}</p>
        </div>
        <a
          className="button button-secondary"
          href={`${base}/documents/example/${kind}`}
          target="_blank"
          rel="noreferrer"
        >
          Ver ejemplo en carta
        </a>
        <Button variant="secondary" onClick={clear} disabled={busy}>
          <Plus size={18} />
          {kind === 'invoice' ? 'Nueva factura' : 'Nueva proforma'}
        </Button>
      </div>
      {!demo && (
        <p className="no-print">
          <Link
            to={`${base}/${kind === 'invoice' ? 'sales' : 'proformas'}/history`}
          >
            Consultar {kind === 'invoice' ? 'facturas' : 'proformas'} emitidas
          </Link>
        </p>
      )}
      <div className={`invoice-layout doc-${kind} no-print`}>
        <fieldset
          className="invoice-editor no-print"
          disabled={busy || !!issued}
        >
          <Card className="form-card picker-panel">
            <div className="section-heading">
              <div>
                <span className="section-kicker">ELIGE TUS PERFUMES</span>
                <h2>Catálogo a la mano</h2>
              </div>
              <span className="section-counter">
                {lines.length} {lines.length === 1 ? 'agregado' : 'agregados'}
              </span>
            </div>
            <PriceControls
              currency={currency}
              tier={tier}
              onCurrency={(value) => {
                setIssued(null)
                setCurrency(value)
              }}
              onTier={(value) => {
                setIssued(null)
                setTier(value)
              }}
            />
            <ProductPicker
              items={data ?? []}
              currency={currency}
              tier={tier}
              location={location}
              added={lines.map((line) => line.productId)}
              onAdd={add}
            />
          </Card>
          <Card className="form-card">
            <div className="section-heading">
              <div>
                <span className="section-kicker">CLIENTE Y CONDICIONES</span>
                <h2>Datos de la {copy.singular}</h2>
              </div>
            </div>
            {!demo && (
              <Select
                label="Cliente registrado"
                value={customerId ?? ''}
                onChange={(e) => {
                  const selected = customers?.find(
                    (c) => c.id === e.target.value,
                  )
                  setCustomerId(selected?.id ?? null)
                  setCustomer(selected?.name ?? '')
                  setPhone(selected?.phone ?? '')
                  setTaxId(selected?.taxId ?? '')
                  if (selected?.priceTier)
                    setTier(selected.priceTier as PriceTier)
                }}
              >
                <option value="">Nuevo cliente</option>
                {customers
                  ?.filter((c) => c.active)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {c.phone}
                    </option>
                  ))}
              </Select>
            )}
            {customersError && (
              <ErrorState message={customersError} retry={retryCustomers} />
            )}
            <div className="form-grid">
              <Input
                label="Cliente"
                maxLength={MAX_CUSTOMER_NAME}
                // Con el formulario en blanco no se marca nada; en cuanto hay
                // productos, el documento necesita a quién va dirigido.
                error={issued || !lines.length ? undefined : customerIssue}
                value={customer}
                disabled={!!customerId}
                onChange={(e) => setCustomer(e.target.value)}
                placeholder="Nombre del cliente"
              />
              <Input
                label="WhatsApp del cliente"
                type="tel"
                inputMode="tel"
                maxLength={40}
                error={issued ? undefined : phoneIssue}
                value={phone}
                disabled={!!customerId}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="8888 0000"
              />
              <Input
                label="RUC / Identificación del cliente"
                maxLength={80}
                value={taxId}
                onChange={(e) => setTaxId(e.target.value)}
              />
              {kind === 'invoice' ? (
                <>
                  <Select
                    label="Forma de pago"
                    value={payment}
                    onChange={(e) =>
                      setPayment(e.target.value as DocumentDraft['payment'])
                    }
                  >
                    {Object.entries(paymentOptions).map(([id, label]) => (
                      <option value={id} key={id}>
                        {label}
                      </option>
                    ))}
                  </Select>
                  <Select
                    label="Sale de"
                    value={location}
                    onChange={(e) =>
                      setLocation(e.target.value as InventoryLocation)
                    }
                  >
                    {Object.entries(labels.location).map(([id, label]) => (
                      <option value={id} key={id}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </>
              ) : (
                <Input
                  label="Válida hasta"
                  type="date"
                  required
                  min={isoDate(new Date())}
                  error={issued ? undefined : validityIssue}
                  value={validUntil}
                  onChange={(e) => setValidUntil(e.target.value)}
                />
              )}
            </div>
            <div className="form-grid">
              <Input
                label="Impuesto incluido en el precio (%)"
                type="number" min={0} max={100} step="0.01"
                value={Number.isNaN(taxRate) ? '' : taxRate}
                error={!validTax ? 'Indica una tasa entre 0 y 100.' : undefined}
                onChange={(event) => setTaxRate(event.target.valueAsNumber)}
              />
              {currency === 'USD' && (
                <Input
                  label="Tipo de cambio (NIO por 1 USD)"
                  type="number" min="0.000001" max={1000000} step="0.000001"
                  value={exchangeField}
                  error={kind === 'invoice' && !validExchange ? 'Registra el tipo de cambio para contabilizar esta venta.' : undefined}
                  onChange={(event) => setExchangeText(event.target.value)}
                />
              )}
            </div>
            <p className="muted">
              El precio de catálogo es el total a cobrar; la tasa separa el
              impuesto incluido.
              {currency === 'USD' &&
                savedRate &&
                ` Tipo de cambio propuesto por el negocio: ${savedRate.usdToNio} C$ por dólar. Cambiarlo aquí afecta sólo a este documento.`}
            </p>
          </Card>
          {drafts.length > 0 && (
            <Card className="form-card">
              <h2>Borradores de {copy.plural}</h2>
              <div className="saved-drafts">
                {drafts.map((item) => (
                  <button key={item.id} onClick={() => load(item)}>
                    <strong>
                      {item.reference} · {item.customer || 'Sin cliente'}
                    </strong>
                    <span>
                      {formatCurrency(
                        draftTotal(item.lines, item.tier, item.currency),
                        item.currency,
                      )}{' '}
                      · {formatDate(item.createdAt)}
                    </span>
                  </button>
                ))}
              </div>
            </Card>
          )}
        </fieldset>
        <Card className="invoice-paper">
          <div className="invoice-heading">
            <Brand wordmark />
            <div>
              <strong>
                {issued ? copy.stamp : `${copy.stamp} · BORRADOR`}
              </strong>
              <span>{current?.reference ?? 'Sin guardar'}</span>
            </div>
          </div>
          <div className="invoice-meta">
            <p>
              {issued?.customerName || customer || 'Cliente por indicar'}
              {(issued ? issued.customerPhone : phone) && (
                <small>WhatsApp: {issued ? issued.customerPhone : phone}</small>
              )}
              {!issued && taxId && <small>RUC: {taxId}</small>}
            </p>
            <p>
              {formatDate(current?.createdAt ?? new Date())}
              <small>
                {priceTierLabels[tier]} · {currency}
                {kind === 'invoice'
                  ? ` · ${paymentOptions[payment]}`
                  : validUntil
                    ? ` · Válida hasta ${formatDate(validUntil)}`
                    : ''}
              </small>
              {kind === 'invoice' && (
                <small>Sale de {labels.location[location]}</small>
              )}
            </p>
          </div>
          <div className="invoice-lines">
            {issued ? (
              issued.items.map((item) => (
                <div className="invoice-line" key={item.id}>
                  <div>
                    <strong>{item.description}</strong>
                    <span>
                      {formatCurrency(item.unitPrice, issued.currency)} por
                      unidad
                    </span>
                  </div>
                  <span>{item.quantity} uds.</span>
                  <strong>
                    {formatCurrency(item.lineTotal, issued.currency)}
                  </strong>
                </div>
              ))
            ) : lines.length === 0 ? (
              <p className="empty-lines">
                Agrega productos para ver el detalle de la {copy.singular}.
              </p>
            ) : (
              lines.map((line) => (
                <div className="invoice-line" key={line.productId}>
                  <div>
                    <strong>{line.name}</strong>
                    <small>
                      {line.size} · {line.barcode}
                    </small>
                    <span>
                      {formatCurrency(line.prices[tier][currency], currency)}{' '}
                      por unidad
                    </span>
                  </div>
                  <div className="invoice-line-quantity">
                    <Input
                      label={`Cantidad de ${line.name}`}
                      error={issued ? undefined : quantityIssue(line)}
                      type="number"
                      min={1}
                      max={9999}
                      step={1}
                      disabled={busy || !!issued}
                      value={Number.isNaN(line.quantity) ? '' : line.quantity}
                      onChange={(e) =>
                        setLines(
                          lines.map((item) =>
                            item.productId === line.productId
                              ? { ...item, quantity: e.target.valueAsNumber }
                              : item,
                          ),
                        )
                      }
                    />
                    <Button
                      className="no-print"
                      variant="ghost"
                      aria-label={`Quitar ${line.name}`}
                      disabled={busy || !!issued}
                      onClick={() => {
                        setIssued(null)
                        setLines(
                          lines.filter(
                            (item) => item.productId !== line.productId,
                          ),
                        )
                      }}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                  <strong>
                    {Number.isInteger(line.quantity) &&
                    line.quantity > 0 &&
                    line.quantity <= 9999
                      ? formatCurrency(
                          (Math.round(line.prices[tier][currency] * 100) *
                            line.quantity) /
                            100,
                          currency,
                        )
                      : 'Revisar cantidad'}
                  </strong>
                </div>
              ))
            )}
          </div>
          {taxBreakdown && (
            <div className="invoice-meta">
              <p>Venta sin impuesto<small>{formatCurrency(taxBreakdown.net, issued?.currency ?? currency)}</small></p>
              <p>Impuesto incluido ({displayedTaxRate} %)<small>{formatCurrency(taxBreakdown.tax, issued?.currency ?? currency)}</small></p>
            </div>
          )}
          <div className="invoice-total">
            <span>Total de la {copy.singular}</span>
            <strong>
              {issued
                ? formatCurrency(issued.total, issued.currency)
                : total === null
                  ? 'Revisar cantidades'
                  : formatCurrency(total, currency)}
            </strong>
          </div>
          {equivalent && (
            <p className="invoice-equivalent">
              <span>
                Equivale a{' '}
                <strong>
                  {formatCurrency(equivalent.amount, equivalent.currency)}
                </strong>
              </span>
              <small>
                A {displayedRate} C$ por dólar. Cambia la moneda arriba para
                cobrar en {equivalent.currency === 'USD' ? 'dólares' : 'córdobas'}.
              </small>
            </p>
          )}
          <label className="field no-print">
            <span>Notas</span>
            <textarea
              rows={2}
              maxLength={1500}
              value={notes}
              disabled={busy || !!issued}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <p className="print-only">{notes}</p>
          <p className="invoice-notice">{copy.notice}</p>
          {!issued && shortages > 0 && (
            <p className="inline-error no-print" role="status">
              {shortages === 1
                ? 'No se puede emitir: un renglón necesita revisión, mira el aviso bajo su cantidad.'
                : `No se puede emitir: ${shortages} renglones necesitan revisión, mira los avisos bajo sus cantidades.`}
            </p>
          )}
          {!issued && lines.length > 0 && dataIssues && (
            <p className="inline-error no-print" role="status">
              {`No se puede emitir: revisa los datos marcados en «Datos de la ${copy.singular}».`}
            </p>
          )}
          <div className="form-actions no-print">
            <Button
              onClick={issue}
              disabled={demo || !issuable || busy || !!issued}
            >
              <CircleCheckBig size={17} />
              {issued
                ? `${copy.stamp} emitida`
                : busy
                  ? 'Emitiendo…'
                  : `Emitir ${copy.singular}`}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void saveDraft()}
              disabled={
                !ready ||
                busy ||
                savingDraft ||
                !!issued ||
                draftsLoading ||
                !!error
              }
              aria-busy={savingDraft}
            >
              <Save size={17} />
              {savingDraft ? 'Guardando…' : 'Guardar borrador'}
            </Button>
            {discardable && (
              <Button
                type="button"
                variant="ghost"
                className="record-delete"
                onClick={() => setConfirmDiscard(true)}
                disabled={busy || savingDraft || draftsLoading || !!error}
              >
                <Trash2 size={17} />
                Eliminar borrador
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              onClick={() => window.print()}
              disabled={!ready}
            >
              <Printer size={17} />
              Imprimir
            </Button>
          </div>
          <div className="form-actions whatsapp-actions no-print">
            <Button
              className="button-whatsapp"
              onClick={sendWhatsapp}
              disabled={!shareable}
            >
              <MessageCircle size={17} />
              Enviar por WhatsApp
            </Button>
            <Button
              type="button"
              className="button-whatsapp-outline"
              onClick={() => void sharePdf()}
              disabled={!shareable || busy}
              aria-busy={sharing}
            >
              <FileDown size={17} />
              {sharing ? 'Generando PDF…' : 'Compartir PDF'}
            </Button>
          </div>
          <p className="whatsapp-hint no-print">
            {demo
              ? 'La vista local comparte el borrador; no emite documentos.'
              : issued
                ? `Se comparte la ${copy.singular} ${issued.number} tal como quedó registrada.`
                : `Aún sin emitir: se comparte el borrador. Emite la ${copy.singular} para enviarla con su número definitivo.`}
          </p>
          {message && (
            <p role="status" className="page-feedback no-print">
              {message}
            </p>
          )}
          {error && (
            <Button variant="secondary" onClick={retryDrafts}>
              Recargar borradores
            </Button>
          )}
          {(failure || error) && (
            <p role="alert" className="inline-error no-print">
              {failure || error}
            </p>
          )}
        </Card>
      </div>
      {confirmDiscard && (
        <ConfirmDialog
          open
          title="Eliminar borrador"
          confirmLabel="Eliminar borrador"
          busyLabel="Eliminando…"
          busy={savingDraft}
          error={error}
          onConfirm={() => void discardDraft()}
          onCancel={() => setConfirmDiscard(false)}
        >
          <p>
            ¿Eliminar el borrador <strong>{current?.reference}</strong>? No
            afecta al inventario ni a los documentos emitidos.
          </p>
        </ConfirmDialog>
      )}
      {shareable && (
        <div className="document-print-root" aria-hidden="true">
          <DocumentPrint document={shareable} />
        </div>
      )}
    </>
  )
}

import { ProductPicker } from './ProductPicker'
import './document-workbench.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { listContacts } from '../../services/workspace'
import { DocumentPrint } from './DocumentPrint'
import {
  CircleCheckBig,
  ChevronDown,
  DoorClosed,
  DoorOpen,
  FileDown,
  MessageCircle,
  Plus,
  Printer,
  RefreshCw,
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
import { AppError, errorMessage } from '../../lib/errors'
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
import {
  equivalentAmount,
  priceTierLabels,
  productPrice,
} from '../../lib/pricing'
import {
  defaultValidUntil,
  documentDraftSchema,
  draftPreview,
  draftStorageKey,
  draftTotal,
  draftLinePrice,
  isoDate,
  type DocumentDraft,
  type DraftLine,
} from './document'
import { whatsappNumber, whatsappUrl } from './whatsapp'
import { shareDocumentPdf } from './pdf'
import { getBusinessDay } from '../accounting/businessDay'
import {
  documentAttemptStatus,
  forgetDocument,
  pendingDocument,
  rememberDocument,
} from './pendingDocuments'

const paymentOptions = {
  pending: 'Pendiente de pago',
  ...labels.payment,
}
// Tope de PostgreSQL para el nombre del cliente al emitir (create_document).
const MAX_CUSTOMER_NAME = 160
const MAX_DOCUMENT_ITEMS = 100
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/
function formattedDraftTotal(draft: DocumentDraft) {
  const total = draftTotal(draft.lines, draft.tier, draft.currency)
  return total === null ? 'Sin precio' : formatCurrency(total, draft.currency)
}

export function DocumentWorkspace({ kind }: { kind: DocumentKind }) {
  const navigate = useNavigate()
  const { demo, base, storageScope } = useAccess()
  const scope = storageScope ?? (demo ? 'demo' : 'anonymous')
  const [restored] = useState(() => pendingDocument(scope, kind))
  const [draftRequestSeed, setDraftRequestSeed] = useState<string | undefined>(
    restored?.requestIdSeed,
  )
  const { inventoryService, salesService } = useServices()
  const [operation] = useState(
    () =>
      restored?.operation ??
      createIdempotentOperation<Omit<NewDocument, 'requestId'>, DocumentRecord>(
        salesService.createDocument,
      ),
  )
  const copy = documentCopy[kind]
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
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
  const [currency, setCurrency] = useState<Currency>(
    restored?.draft.currency ?? 'NIO',
  )
  // `null` significa «no lo he tocado»: entonces rige la tasa del negocio. Una
  // cadena vacía es una decisión del usuario y deja el campo en blanco.
  const [exchangeText, setExchangeText] = useState<string | null>(
    restored?.draft.currency === 'USD' && restored.draft.exchangeRate != null
      ? String(restored.draft.exchangeRate)
      : null,
  )
  const [tier, setTier] = useState<PriceTier>(
    restored?.draft.tier ?? 'emprendedor',
  )
  const loadCustomers = useCallback(
    () => (demo ? Promise.resolve([]) : listContacts('customers')),
    [demo],
  )
  const {
    data: customers,
    error: customersError,
    retry: retryCustomers,
  } = useQuery(loadCustomers)
  const [customerId, setCustomerId] = useState<string | null>(
    restored?.draft.customerId ?? null,
  )
  const [customer, setCustomer] = useState(restored?.draft.customer ?? '')
  const [phone, setPhone] = useState(restored?.draft.phone ?? '')
  const [taxId, setTaxId] = useState(restored?.draft.taxId ?? '')
  const [payment, setPayment] = useState<DocumentDraft['payment']>(
    restored?.draft.payment ?? 'pending',
  )
  const [location, setLocation] = useState<InventoryLocation>(
    restored?.draft.location ?? 'store',
  )
  const [validUntil, setValidUntil] = useState(
    restored?.draft.validUntil ?? defaultValidUntil(),
  )
  const [notes, setNotes] = useState(restored?.draft.notes ?? '')
  const [lines, setLines] = useState<DraftLine[]>(() =>
    structuredClone(restored?.draft.lines ?? []),
  )
  const [current, setCurrent] = useState<{
    id: string
    reference: string
    createdAt: string
  } | null>(
    restored?.requestIdSeed
      ? {
          id: restored.draft.id,
          reference: restored.draft.reference,
          createdAt: restored.draft.createdAt,
        }
      : null,
  )
  const [issued, setIssued] = useState<DocumentRecord | null>(null)
  const [message, setMessage] = useState('')
  const [priceReviewRequired, setPriceReviewRequired] = useState(false)
  const [failure, setFailure] = useState(
    restored
      ? 'Hay una emisión pendiente de confirmar. Reintenta la misma operación para recuperar el documento sin duplicarlo.'
      : '',
  )
  const [busy, setBusy] = useState(false)
  // Guardar y compartir tienen su propio estado: el botón muestra qué ocurre
  // y un doble clic no envía dos veces la misma revisión de borradores.
  const [savingDraft, setSavingDraft] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [replaceWith, setReplaceWith] = useState<
    { draft: DocumentDraft } | { empty: true } | { path: string } | null
  >(null)
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null)
  // Una respuesta perdida no autoriza una venta distinta. Se conserva en
  // memoria la solicitud original hasta recibir una respuesta definitiva.
  const [pendingIssue, setPendingIssue] = useState<Omit<
    NewDocument,
    'requestId'
  > | null>(restored?.payload ?? null)
  const loadDay = useCallback(
    () =>
      demo || kind !== 'invoice' ? Promise.resolve(null) : getBusinessDay(),
    [demo, kind],
  )
  const {
    data: businessDay,
    error: dayError,
    refresh: refreshDay,
  } = useQuery(loadDay)
  useEffect(() => {
    if (demo || kind !== 'invoice') return
    const update = () => {
      if (!busy && document.visibilityState === 'visible') refreshDay()
    }
    window.addEventListener('focus', update)
    window.addEventListener('online', update)
    document.addEventListener('visibilitychange', update)
    const timer = window.setInterval(update, 60000)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('online', update)
      document.removeEventListener('visibilitychange', update)
      window.clearInterval(timer)
    }
  }, [demo, kind, busy, refreshDay])

  const formSnapshot = JSON.stringify({
    customerId,
    customer,
    phone,
    taxId,
    currency,
    exchangeText,
    tier,
    payment,
    location,
    validUntil,
    notes,
    lines,
  })
  const hasContent = !!(
    customerId ||
    customer ||
    phone ||
    taxId ||
    notes ||
    lines.length
  )
  const dirty =
    !issued &&
    (!!pendingIssue ||
      (savedSnapshot !== null ? savedSnapshot !== formSnapshot : hasContent))
  useEffect(() => {
    if (!dirty && !busy && !savingDraft) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, busy, savingDraft])
  useEffect(() => {
    if (!dirty && !busy && !savingDraft) return
    const protectNavigation = (event: MouseEvent) => {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      )
        return
      const link = event.target.closest('a[href]')
      if (!(link instanceof HTMLAnchorElement)) return
      if (link.hasAttribute('download')) return
      if (link.target && link.target !== '_self') return
      const destination = new URL(link.href, window.location.href)
      if (
        !['http:', 'https:'].includes(destination.protocol) ||
        destination.origin !== window.location.origin ||
        (destination.pathname === window.location.pathname &&
          destination.search === window.location.search)
      )
        return
      event.preventDefault()
      event.stopPropagation()
      if (pendingIssue)
        setFailure(
          `Verifica primero la ${copy.singular} pendiente de confirmación con «Reintentar emisión».`,
        )
      else if (busy || savingDraft)
        setFailure('Espera a que termine la operación antes de salir.')
      else
        setReplaceWith({
          path: destination.pathname + destination.search + destination.hash,
        })
    }
    document.addEventListener('click', protectNavigation, true)
    return () => document.removeEventListener('click', protectNavigation, true)
  }, [dirty, busy, savingDraft, pendingIssue, copy.singular])

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
  const validExchange =
    currency === 'NIO' ||
    (exchangeRate !== null &&
      Number.isFinite(exchangeRate) &&
      exchangeRate > 0 &&
      exchangeRate <= 1000000)
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
    if (
      draftLinePrice(line, tier, currency) === null ||
      productPrice(item.product, tier, currency) === null
    )
      return 'Sin precio en la lista seleccionada. Registra su precio o cambia de lista.'
    if (kind !== 'invoice') return undefined
    const available = item.quantities[location]
    if (available == null)
      return `Sin conteo en ${labels.location[location]}. Registra el inventario antes de facturar.`
    if (available === 0)
      return `No hay existencias en ${labels.location[location]}.`
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
    lines.length && valid && total !== null
      ? {
          id: current?.id ?? 'preview',
          kind,
          reference: current?.reference ?? `${copy.prefix}borrador`,
          customer,
          customerId,
          phone,
          taxId,
          currency,
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
    if (!product?.prices || productPrice(product, tier, currency) === null) {
      setMessage('El perfume no tiene precio en la lista seleccionada.')
      return
    }
    if (lines.some((line) => line.productId === product.id)) {
      setMessage(
        `El producto ya está en la ${copy.singular}. Puedes cambiar su cantidad.`,
      )
      return
    }
    if (lines.length >= MAX_DOCUMENT_ITEMS) {
      setMessage(
        `Cada documento admite hasta ${MAX_DOCUMENT_ITEMS} productos. Emite otro documento para los demás.`,
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
      exchangeRate: currency === 'NIO' ? 1 : exchangeRate,
      tier,
      lines,
    })
    if (!result.success) {
      setMessage(
        'Agrega productos y revisa las cantidades y el tipo de cambio.',
      )
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
        setDraftRequestSeed(stamp.id)
        setSavedSnapshot(formSnapshot)
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

  async function updatePrices() {
    if (busy || issued || pendingIssue) return
    setBusy(true)
    setFailure('')
    try {
      const inventory = await inventoryService.getInventory()
      let unavailable = false
      const updated = lines.map((line) => {
        const product = inventory.find(
          (item) => item.product.id === line.productId,
        )?.product
        if (!product?.active || !product.prices) {
          unavailable = true
          return line
        }
        return {
          ...line,
          name: `${product.brand} ${product.name}`,
          barcode: product.barcode,
          size:
            product.size === null
              ? 'Tamaño por confirmar'
              : `${product.size} ${product.unit}`,
          prices: structuredClone(product.prices),
        }
      })
      if (!mounted.current) return
      setLines(updated)
      setPriceReviewRequired(unavailable)
      setMessage(
        unavailable
          ? 'Hay productos que ya no están disponibles. Retíralos y vuelve a actualizar los precios.'
          : 'Precios actualizados. Revisa el total antes de emitir.',
      )
      retry()
    } catch (error) {
      if (mounted.current) setFailure(errorMessage(error))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function issue() {
    // Las existencias también se comprueban aquí, no sólo al pintar el aviso:
    // emitir con un renglón sin producto termina en un error de la base y el
    // vendedor pierde el documento que ya tenía armado.
    if (
      (!pendingIssue &&
        (priceReviewRequired ||
          !lines.length ||
          !valid ||
          total === null ||
          shortages > 0 ||
          dataIssues ||
          (kind === 'invoice' && !validExchange))) ||
      busy ||
      issued ||
      demo
    )
      return
    const attemptDraft = pendingDocument(scope, kind)?.draft ?? draft
    if (!attemptDraft) return
    setBusy(true)
    setFailure('')
    setMessage('')
    const payload = pendingIssue ?? {
      kind,
      customerId: customerId ?? undefined,
      customerName: customer.trim(),
      customerTaxId: taxId.trim(),
      customerPhone: whatsappNumber(phone),
      tier,
      currency,
      exchangeRate: currency === 'NIO' ? 1 : (exchangeRate ?? undefined),
      location: kind === 'invoice' ? location : null,
      paymentMethod: kind === 'invoice' ? payment : null,
      validUntil: kind === 'proforma' ? validUntil : null,
      notes,
      expectedTotal: total ?? undefined,
      items: lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        expectedUnitPrice: line.prices[tier][currency],
      })),
    }
    rememberDocument(scope, {
      kind,
      operation,
      payload,
      draft: structuredClone(attemptDraft),
      requestIdSeed: draftRequestSeed,
      status: 'sending',
    })
    let record: DocumentRecord
    try {
      // PostgreSQL busca primero requestId y luego comprueba la jornada. Un
      // preflight aquí impediría recuperar una factura ya emitida si otro
      // administrador cerró la tienda mientras se perdió su respuesta.
      // El UUID del borrador se mantiene incluso después de recargar. Si
      // retirar ese borrador falla, volver a abrirlo recupera su emisión previa
      // o rechaza datos distintos; jamás registra una segunda venta.
      record = await operation.execute(payload, draftRequestSeed)
    } catch (issueError) {
      const definitive =
        issueError instanceof AppError &&
        [
          'validation',
          'unauthorized',
          'rate_limited',
          'configuration',
        ].includes(issueError.kind)
      if (definitive) forgetDocument(scope, kind, operation)
      else documentAttemptStatus(scope, kind, operation, 'uncertain')
      if (!mounted.current) return
      setPendingIssue(definitive ? null : payload)
      if (
        definitive &&
        errorMessage(issueError).includes('Los precios cambiaron')
      ) {
        setPriceReviewRequired(true)
        retry()
      }
      setFailure(
        definitive
          ? errorMessage(issueError)
          : 'No pudimos confirmar la emisión. Conservamos los datos: reintenta esta misma operación para comprobarla sin duplicarla.',
      )
      if (mounted.current) {
        setBusy(false)
        if (kind === 'invoice') refreshDay()
      }
      return
    }
    documentAttemptStatus(scope, kind, operation, 'confirmed')
    // Si Atrás/Adelante desmontó el formulario, se conserva la confirmación
    // para recuperarla desde el aviso del panel con la misma promesa resuelta.
    if (!mounted.current) return
    setPendingIssue(null)
    setIssued(record)
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
    forgetDocument(scope, kind, operation)
    // La emisión ya está confirmada. Un fallo al retirar su borrador nunca
    // vuelve a convertirla en una venta pendiente ni permite emitirla otra vez.
    if (current && drafts.some((item) => item.id === current.id)) {
      try {
        const removed = await save(
          drafts.filter((item) => item.id !== current.id),
        )
        if (!removed && mounted.current)
          setFailure(
            `La ${copy.singular} está emitida, pero no se pudo retirar su borrador. No vuelvas a emitir ese borrador.`,
          )
      } catch {
        if (mounted.current)
          setFailure(
            `La ${copy.singular} está emitida, pero no se pudo retirar su borrador. No vuelvas a emitir ese borrador.`,
          )
      }
    }
    if (mounted.current) {
      retry()
      setBusy(false)
      if (kind === 'invoice') refreshDay()
    }
  }

  function load(item: DocumentDraft) {
    setPriceReviewRequired(false)
    operation.reset()
    setCurrent(item)
    setDraftRequestSeed(item.id)
    setIssued(null)
    setCurrency(item.currency)
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
      const product = data?.find(
        (entry) => entry.product.id === line.productId,
      )?.product
      if (!product?.active || !product.prices) return structuredClone(line)
      const prices = structuredClone(product.prices)
      if (
        Object.keys(priceTierLabels).some((key) => {
          const priceTier = key as PriceTier
          return (
            prices[priceTier]?.NIO !== line.prices[priceTier]?.NIO ||
            prices[priceTier]?.USD !== line.prices[priceTier]?.USD
          )
        })
      )
        pricesChanged = true
      return { ...line, prices }
    })
    setLines(refreshedLines)
    setSavedSnapshot(
      JSON.stringify({
        customerId: item.customerId,
        customer: item.customer,
        phone: item.phone,
        taxId: item.taxId,
        currency: item.currency,
        exchangeText:
          item.currency === 'USD' && item.exchangeRate != null
            ? String(item.exchangeRate)
            : null,
        tier: item.tier,
        payment: item.payment,
        location: item.location,
        validUntil: item.validUntil || defaultValidUntil(),
        notes: item.notes,
        lines: pricesChanged ? item.lines : refreshedLines,
      }),
    )
    setFailure('')
    setMessage(
      pricesChanged
        ? 'Borrador abierto con los precios actuales del catálogo. Revisa el total antes de emitir y guarda los cambios.'
        : 'Borrador abierto. Guarda los cambios al terminar.',
    )
  }

  function clear() {
    setPriceReviewRequired(false)
    operation.reset()
    setCurrent(null)
    setIssued(null)
    setCustomerId(null)
    setCustomer('')
    setPhone('')
    setTaxId('')
    setExchangeText(null)
    setNotes('')
    setLines([])
    setValidUntil(defaultValidUntil())
    setMessage('')
    setFailure('')
    setPayment('pending')
    setLocation('store')
    setSavedSnapshot(null)
    setPendingIssue(null)
    setDraftRequestSeed(undefined)
  }

  function requestReplace(next: NonNullable<typeof replaceWith>) {
    if (busy || savingDraft || pendingIssue) return
    if (dirty) setReplaceWith(next)
    else if ('draft' in next) load(next.draft)
    else if ('path' in next) void navigate(next.path)
    else clear()
  }

  function replaceDocument() {
    if (!replaceWith || busy || savingDraft || pendingIssue) return
    if ('draft' in replaceWith) load(replaceWith.draft)
    else if ('path' in replaceWith) void navigate(replaceWith.path)
    else clear()
    setReplaceWith(null)
  }

  function goToSection(id: string) {
    const section = document.getElementById(id)
    if (id === 'document-customer') {
      const details = section?.querySelector('details')
      if (details) details.open = true
    }
    section?.scrollIntoView({ block: 'start', behavior: 'auto' })
    const target =
      id === 'document-catalog'
        ? section?.querySelector<HTMLInputElement>('input[type="search"]')
        : id === 'document-customer'
          ? (section?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
            section?.querySelector<HTMLElement>(
              'input:not(:disabled), select:not(:disabled)',
            ))
          : section
    const focusTarget = target ?? section
    focusTarget?.focus({ preventScroll: true })
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
  const ready = !!lines.length && valid && total !== null
  // Guardar un borrador o imprimirlo no toca el inventario; emitir sí, así que
  // sólo la emisión exige que cada renglón tenga existencias suficientes.
  const issuable =
    !!pendingIssue ||
    (ready &&
      !priceReviewRequired &&
      shortages === 0 &&
      !dataIssues &&
      (kind !== 'invoice' || validExchange) &&
      (kind !== 'invoice' ||
        !businessDay ||
        (businessDay.status === 'open' &&
          businessDay.day === businessDay.today)))
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
  return (
    <>
      <div className="page-heading no-print">
        <div>
          <h1>{copy.title}</h1>
        </div>
        {demo && (
          <a
            className="button button-secondary"
            href={`${base}/documents/example/${kind}`}
            target="_blank"
            rel="noreferrer"
          >
            Ver ejemplo en carta
          </a>
        )}
        <Button
          variant="secondary"
          onClick={() => requestReplace({ empty: true })}
          disabled={busy || savingDraft || !!pendingIssue}
        >
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
      {!demo && kind === 'invoice' && (
        <div
          className={`sales-day-status no-print ${businessDay?.status === 'open' ? 'is-open' : ''}`}
          role="status"
          aria-label="Jornada para facturar"
        >
          {businessDay?.status === 'open' ? (
            <DoorOpen size={19} aria-hidden="true" />
          ) : (
            <DoorClosed size={19} aria-hidden="true" />
          )}
          <div>
            <strong>
              {dayError
                ? 'No se pudo actualizar la jornada'
                : !businessDay
                  ? 'Consultando jornada…'
                  : businessDay.status === 'open'
                    ? 'Tienda abierta'
                    : businessDay.status === 'closed'
                      ? 'Jornada cerrada'
                      : businessDay.openDay
                        ? 'Hay una jornada anterior pendiente'
                        : 'Tienda sin abrir'}
            </strong>
            {businessDay && <span>{formatDate(businessDay.today)}</span>}
          </div>
          <Link to={base || '/'}>Ver jornada en Inicio</Link>
          <Button
            type="button"
            variant="ghost"
            aria-label="Actualizar jornada de facturación"
            onClick={refreshDay}
            disabled={busy}
          >
            <RefreshCw size={17} />
          </Button>
        </div>
      )}
      <nav
        className="document-navigation no-print"
        aria-label="Moverse por el documento"
      >
        <Button
          type="button"
          variant="secondary"
          onClick={() => goToSection('document-catalog')}
        >
          Buscar productos
        </Button>
        <span>
          <small>
            {lines.length} {lines.length === 1 ? 'producto' : 'productos'}
          </small>
          <strong>
            {displayedTotal === null
              ? 'Revisar total'
              : formatCurrency(displayedTotal, issued?.currency ?? currency)}
          </strong>
        </span>
        <Button type="button" onClick={() => goToSection('document-review')}>
          Ver documento
        </Button>
      </nav>
      <div className={`invoice-layout document-workbench doc-${kind} no-print`}>
        <fieldset
          id="document-customer"
          tabIndex={-1}
          className="document-customer-panel"
          disabled={busy || !!issued || !!pendingIssue}
        >
          <Card className="form-card document-customer-card">
            <details>
              <summary className="document-customer-summary">
                <div>
                  <h2>Datos de la {copy.singular}</h2>
                  <span>
                    {customer || 'Cliente por indicar'} ·{' '}
                    {kind === 'invoice'
                      ? `${paymentOptions[payment]} · ${labels.location[location]}`
                      : validUntil
                        ? `Válida hasta ${formatDate(validUntil)}`
                        : 'Vigencia por indicar'}
                  </span>
                  {!issued &&
                    lines.length > 0 &&
                    (dataIssues || (kind === 'invoice' && !validExchange)) && (
                      <small className="document-customer-warning">
                        Completar datos
                      </small>
                    )}
                </div>
                <ChevronDown size={19} aria-hidden="true" />
              </summary>
              <div className="form-grid">
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
                {currency === 'USD' && (
                  <Input
                    label="Tipo de cambio (NIO por 1 USD)"
                    type="number"
                    min="0.000001"
                    max={1000000}
                    step="0.000001"
                    value={exchangeField}
                    error={
                      kind === 'invoice' && !validExchange
                        ? 'Registra el tipo de cambio para contabilizar esta venta.'
                        : undefined
                    }
                    onChange={(event) => setExchangeText(event.target.value)}
                  />
                )}
              </div>
            </details>
          </Card>
        </fieldset>
        <fieldset
          id="document-catalog"
          tabIndex={-1}
          className="invoice-editor document-catalog"
          disabled={busy || !!issued || !!pendingIssue}
        >
          <Card className="form-card picker-panel">
            <div className="section-heading">
              <div>
                <h2>Productos</h2>
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
        </fieldset>
        <section
          id="document-review"
          tabIndex={-1}
          className="document-review-panel"
          aria-label="Documento actual"
        >
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
                  <small>
                    WhatsApp: {issued ? issued.customerPhone : phone}
                  </small>
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
                <p className="empty-lines">Sin productos</p>
              ) : (
                lines.map((line) => (
                  <div className="invoice-line" key={line.productId}>
                    <div>
                      <strong>{line.name}</strong>
                      <small>
                        {line.size} · {line.barcode}
                      </small>
                      <span>
                        {draftLinePrice(line, tier, currency) === null
                          ? 'Sin precio en esta lista'
                          : `${formatCurrency(draftLinePrice(line, tier, currency)!, currency)} por unidad`}
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
                        disabled={busy || !!issued || !!pendingIssue}
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
                        disabled={busy || !!issued || !!pendingIssue}
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
                      line.quantity <= 9999 &&
                      draftLinePrice(line, tier, currency) !== null
                        ? formatCurrency(
                            (Math.round(
                              draftLinePrice(line, tier, currency)! * 100,
                            ) *
                              line.quantity) /
                              100,
                            currency,
                          )
                        : draftLinePrice(line, tier, currency) === null
                          ? 'Sin precio'
                          : 'Revisar cantidad'}
                    </strong>
                  </div>
                ))
              )}
            </div>
            <div className="document-checkout">
              <div className="invoice-total">
                <span>Total de la {copy.singular}</span>
                <strong>
                  {issued
                    ? formatCurrency(issued.total, issued.currency)
                    : total === null
                      ? valid
                        ? 'Revisar precios'
                        : 'Revisar cantidades'
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
                  <small>{displayedRate} C$ por dólar</small>
                </p>
              )}
              <label className="field no-print">
                <span>Notas</span>
                <textarea
                  rows={1}
                  maxLength={1500}
                  value={notes}
                  disabled={busy || !!issued || !!pendingIssue}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
              <p className="print-only">{notes}</p>

              {!issued && !pendingIssue && shortages > 0 && (
                <p className="inline-error no-print" role="status">
                  {shortages === 1
                    ? 'No se puede emitir: un renglón necesita revisión, mira el aviso bajo su cantidad.'
                    : `No se puede emitir: ${shortages} renglones necesitan revisión, mira los avisos bajo sus cantidades.`}
                </p>
              )}
              {!issued &&
                lines.length > 0 &&
                (dataIssues || (kind === 'invoice' && !validExchange)) && (
                  <div
                    className="document-data-issue inline-error no-print"
                    role="status"
                  >
                    <span>{`No se puede emitir: revisa los datos marcados en «Datos de la ${copy.singular}».`}</span>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => goToSection('document-customer')}
                    >
                      Revisar datos
                    </Button>
                  </div>
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
                      : pendingIssue
                        ? 'Reintentar emisión'
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
                    !!pendingIssue ||
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
                    disabled={
                      busy ||
                      savingDraft ||
                      !!pendingIssue ||
                      draftsLoading ||
                      !!error
                    }
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
              {priceReviewRequired && !issued && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || !!pendingIssue}
                  onClick={() => void updatePrices()}
                >
                  <RefreshCw size={17} />
                  Actualizar precios
                </Button>
              )}
            </div>
          </Card>
        </section>
        <fieldset
          className="document-saved-drafts"
          disabled={busy || !!issued || !!pendingIssue}
        >
          {drafts.length > 0 && (
            <Card className="form-card">
              <h2>Borradores de {copy.plural}</h2>
              <div className="saved-drafts">
                {drafts.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => requestReplace({ draft: item })}
                  >
                    <strong>
                      {item.reference} · {item.customer || 'Sin cliente'}
                    </strong>
                    <span>
                      {formattedDraftTotal(item)} · {formatDate(item.createdAt)}
                    </span>
                  </button>
                ))}
              </div>
            </Card>
          )}
        </fieldset>
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
      {replaceWith && (
        <ConfirmDialog
          open
          title="Cambios sin guardar"
          confirmLabel={
            'draft' in replaceWith
              ? 'Abrir otro borrador'
              : 'path' in replaceWith
                ? 'Salir sin guardar'
                : 'Descartar cambios'
          }
          onConfirm={replaceDocument}
          onCancel={() => setReplaceWith(null)}
        >
          <p>
            Hay cambios sin guardar en esta {copy.singular}. Si continúas, se
            perderán esos cambios.
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

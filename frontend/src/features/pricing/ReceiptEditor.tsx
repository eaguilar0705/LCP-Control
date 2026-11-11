import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { z } from 'zod'
import {
  Button,
  Dialog,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from '../../components/ui'
import { SupplierAutocomplete } from '../../components/SupplierAutocomplete'
import { useQuery } from '../../lib/useQuery'
import { useServices } from '../../services/useServices'
import { PurchaseAmounts } from './PurchaseAmounts'
import { purchaseAmounts } from './purchase-amount-model'
import { formatCurrency } from '../../lib/format'
import { errorMessage } from '../../lib/errors'
import { accountingExchangeRate } from '../../lib/exchangeRates'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { useAccess } from '../../app/AccessContext'
import { journalRpc } from '../accounting/journalService'
import { localDay } from '../reports/model'
import { JournalDetail } from '../accounting/JournalDetail'
import { accountCurrency } from '../accounting/journalModel'
import { matchesSearch } from '../../lib/search'
import { labels } from '../../lib/domain'
import { ReceiptInitialCount } from './ReceiptInitialCount'

interface ReceiptLine {
  product_id: string
  location: 'store' | 'warehouse'
  quantity: number
  unit_price: number
}
interface Product {
  id: string
  name: string
  sku: string
  store: number | null
  warehouse: number | null
  value: number | null
  average: number | null
}
interface ReceiptContext {
  systemRate: number | null
  receipt: {
    id: string
    revision: number
    incurred_on: string
    supplier: string
    reference: string
    note: string
    currency: 'NIO' | 'USD'
    exchange_rate: number
    shipping_amount: number
    goods_amount: number
    account: string
    bank_ledger_account: string | null
    lines: ReceiptLine[]
  }
  products: Product[]
  accounts: {
    code: string
    displayCode: string
    name: string
    bucket: string
  }[]
  history: {
    id: string
    revision: number
    actorName: string
    createdAt: string
    journalEntryId: string | null
  }[]
}
const money = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100
const draftSchema = z.object({
  date: z.string(),
  supplier: z.string(),
  reference: z.string(),
  note: z.string(),
  currency: z.enum(['NIO', 'USD']),
  rate: z.string(),
  shipping: z.string(),
  lines: z
    .array(
      z.object({
        product_id: z.string(),
        location: z.enum(['store', 'warehouse']),
        quantity: z.number(),
        unit_price: z.number(),
      }),
    )
    .min(1)
    .max(100),
  targets: z.record(z.string(), z.string()),
  costAccount: z.string(),
  counterpart: z.string(),
})

function readDraft(key: string) {
  try {
    return draftSchema.safeParse(
      JSON.parse(sessionStorage.getItem(key) ?? 'null'),
    ).data
  } catch {
    return undefined
  }
}

export function ReceiptEditor({
  id,
  onClose,
  onSaved,
}: {
  id: string
  onClose: () => void
  onSaved: () => void
}) {
  const { settingsService } = useServices()
  const load = useCallback(async () => {
    const [receipt, rate] = await Promise.all([
      journalRpc<Omit<ReceiptContext, 'systemRate'>>('receipt_edit_context', {
        p_id: id,
      }),
      settingsService.getExchangeRate(),
    ])
    return { ...receipt, systemRate: accountingExchangeRate(rate) }
  }, [id, settingsService])
  const query = useQuery(load)
  const [pending, setPending] = useState(false)
  return (
    <Dialog
      open
      title="Editar recepción de mercancía"
      className="pricing-purchase-dialog"
      dismissible={!pending}
      onClose={() => {
        if (!pending) onClose()
      }}
    >
      {query.error ? (
        <ErrorState message={query.error} retry={query.retry} />
      ) : query.loading || !query.data ? (
        <LoadingState />
      ) : (
        <ReceiptForm
          key={`${id}:${query.data.receipt.revision}`}
          context={query.data}
          onClose={onClose}
          onSaved={onSaved}
          onPending={setPending}
        />
      )}
    </Dialog>
  )
}
function ReceiptForm({
  context,
  onClose,
  onSaved,
  onPending,
}: {
  context: ReceiptContext
  onClose: () => void
  onSaved: () => void
  onPending: (v: boolean) => void
}) {
  const { receipt: r, products, accounts, systemRate } = context
  const { storageScope = 'anonymous' } = useAccess()
  const draftKey = `lcp:receipt-draft:${storageScope}:${r.id}:${r.revision}`
  const [draft] = useState(() => readDraft(draftKey))
  const [date, setDate] = useState(draft?.date ?? r.incurred_on),
    [supplier, setSupplier] = useState(draft?.supplier ?? r.supplier),
    [reference, setReference] = useState(draft?.reference ?? r.reference),
    [note, setNote] = useState(draft?.note ?? r.note)
  const [currency, setCurrency] = useState(draft?.currency ?? r.currency),
    [rate, setRate] = useState(
      draft?.rate ??
        (r.currency === 'USD'
          ? String(r.exchange_rate)
          : systemRate
            ? String(systemRate)
            : ''),
    ),
    [shipping, setShipping] = useState(
      draft?.shipping ?? String(r.shipping_amount),
    )
  const [lines, setLines] = useState(
    draft?.lines ?? r.lines.map((l) => ({ ...l })),
  )
  const [targets, setTargets] = useState<Record<string, string>>(
    draft?.targets ?? {},
  )
  const [costAccount, setCostAccount] = useState(draft?.costAccount ?? '5120'),
    [counterpart, setCounterpart] = useState(
      draft?.counterpart ??
        (r.account === 'pending'
          ? '1130'
          : r.account === 'credito'
            ? '2111'
            : r.currency === 'USD'
              ? ''
              : (r.bank_ledger_account ?? '1110-001')),
    )
  const [reviewedContext, setReview] = useState<ReceiptContext | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [journal, setJournal] = useState<string>()
  const review = reviewedContext === context
  const [search, setSearch] = useState('')
  const [count, setCount] = useState<{
    product: Product
    location: 'store' | 'warehouse'
  }>()
  useEffect(() => {
    try {
      sessionStorage.setItem(
        draftKey,
        JSON.stringify({
          date,
          supplier,
          reference,
          note,
          currency,
          rate,
          shipping,
          lines,
          targets,
          costAccount,
          counterpart,
        }),
      )
    } catch {
      // El formulario sigue disponible si el navegador bloquea el almacenamiento.
    }
  }, [
    draftKey,
    date,
    supplier,
    reference,
    note,
    currency,
    rate,
    shipping,
    lines,
    targets,
    costAccount,
    counterpart,
  ])
  const [operation] = useState(() =>
    createIdempotentOperation<Record<string, unknown>, unknown>(
      (input) => journalRpc('revise_purchase_receipt', { p_input: input }),
      {
        scope: storageScope,
        key: 'receipt-revision',
        label: 'Corrección de recepción',
      },
    ),
  )
  const affected = [
    ...new Set([
      ...r.lines.map((l) => l.product_id),
      ...lines.map((l) => l.product_id),
    ]),
  ].filter(Boolean)
  const productsById = new Map(products.map((p) => [p.id, p]))
  const matches = (id: string) => {
    const p = productsById.get(id)
    return !p || matchesSearch(`${p.sku} ${p.name}`, search)
  }
  const missingCounts = affected.flatMap((id) => {
    const product = productsById.get(id)
    if (!product) return []
    return (['store', 'warehouse'] as const)
      .filter((location) => product[location] === null)
      .map((location) => ({ product, location }))
  })
  const currentValue = (p: Product | undefined) =>
    p?.value ?? (p?.store === 0 && p.warehouse === 0 ? 0 : null)
  const exchangeRate = currency === 'NIO' ? 1 : Number(rate)
  const originalLines = new Map(r.lines.map((line) => [line.product_id, line]))
  const editedLines = new Map(lines.map((line) => [line.product_id, line]))
  const sharedCostChanged =
    currency !== r.currency ||
    exchangeRate !== Number(r.exchange_rate) ||
    Number(shipping) !== Number(r.shipping_amount)
  const target = (id: string) => {
    if (targets[id] !== undefined) return targets[id]
    const original = originalLines.get(id)
    const edited = editedLines.get(id)
    if (
      sharedCostChanged ||
      !original ||
      !edited ||
      original.location !== edited.location ||
      original.quantity !== edited.quantity ||
      Number(original.unit_price) !== edited.unit_price
    )
      return ''
    return String(currentValue(productsById.get(id)) ?? '')
  }
  const goods = money(lines.reduce((s, l) => s + l.quantity * l.unit_price, 0))
  const amounts = purchaseAmounts({
    goods,
    shipping: Number(shipping),
    currency,
    exchangeRate,
    systemRate,
  })
  const total = amounts?.nio ?? NaN
  const before =
    money(Number(r.goods_amount) * Number(r.exchange_rate)) +
    money(Number(r.shipping_amount) * Number(r.exchange_rate))
  const inventoryDelta = money(
    affected.reduce(
      (s, id) =>
        s +
        Number(target(id)) -
        Number(currentValue(productsById.get(id)) ?? 0),
      0,
    ),
  )
  const remainder = money(total - before - inventoryDelta)
  const uncertain = operation.isUncertain()
  function changeLine(i: number, patch: Partial<ReceiptLine>) {
    setLines((old) => old.map((l, n) => (n === i ? { ...l, ...patch } : l)))
    setReview(null)
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!uncertain && missingCounts.length) {
      setSearch('')
      setError(
        'Registra los conteos que faltan antes de revisar la corrección.',
      )
      return
    }
    if (
      !uncertain &&
      (lines.some(
        (line) =>
          !productsById.has(line.product_id) ||
          !Number.isInteger(line.quantity) ||
          line.quantity < 1 ||
          line.quantity > 1000000 ||
          !Number.isFinite(line.unit_price) ||
          line.unit_price < 0,
      ) ||
        new Set(lines.map((line) => line.product_id)).size !== lines.length)
    ) {
      setSearch('')
      setError('Revisa los productos y las cantidades de la recepción.')
      return
    }
    if (
      !uncertain &&
      affected.some(
        (id) =>
          target(id).trim() === '' ||
          !Number.isFinite(Number(target(id))) ||
          Number(target(id)) < 0 ||
          Number(target(id)) > 1000000000 ||
          money(Number(target(id))) !== Number(target(id)),
      )
    ) {
      setSearch('')
      setError('Revisa el valor final del inventario de cada perfume.')
      return
    }
    if (!uncertain && !review) {
      setReview(context)
      setError('')
      return
    }
    setBusy(true)
    setError('')
    onPending(true)
    try {
      if (uncertain) await operation.retryPending()
      else
        await operation.execute({
          shipmentId: r.id,
          expectedRevision: r.revision,
          incurredOn: date,
          supplier,
          reference,
          note,
          currency,
          exchangeRate,
          shippingAmount: Number(shipping),
          counterpart,
          costAccount,
          lines: lines.map((l) => ({
            productId: l.product_id,
            location: l.location,
            quantity: l.quantity,
            unitPrice: l.unit_price,
          })),
          impacts: affected.map((id) => {
            const p = productsById.get(id)!
            return {
              productId: id,
              expectedStore: p.store,
              expectedWarehouse: p.warehouse,
              expectedValueNio: currentValue(p),
              targetValueNio: Number(target(id)),
            }
          }),
        })
      onPending(false)
      try {
        sessionStorage.removeItem(draftKey)
      } catch {
        // La corrección ya se guardó en el servidor.
      }
      onSaved()
    } catch (e) {
      setError(errorMessage(e))
      onPending(operation.isUncertain())
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <form
        onSubmit={(event) => void save(event)}
        className="mixed-journal-form"
        onChange={() => setReview(null)}
      >
        <fieldset disabled={busy || uncertain}>
          <div className="journal-fields">
            <Input
              label="Fecha de recepción"
              type="date"
              required
              max={localDay(new Date())}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            <SupplierAutocomplete value={supplier} onChange={setSupplier} />
            <Input
              label="Factura o referencia"
              maxLength={200}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
            <Select
              label="Moneda de compra"
              value={currency}
              onChange={(e) => {
                setCurrency(e.target.value as 'NIO' | 'USD')
                if (e.target.value === 'USD' && r.currency !== 'USD')
                  setRate(systemRate ? String(systemRate) : '')
              }}
            >
              <option value="NIO">C$ Córdobas</option>
              <option value="USD">US$ Dólares</option>
            </Select>
            {currency === 'USD' && (
              <Input
                label="Tipo de cambio de la compra"
                type="number"
                required
                min="0.000001"
                max="1000"
                step="0.000001"
                value={rate}
                onChange={(e) => {
                  setRate(e.target.value)
                }}
              />
            )}
            {currency === 'USD' &&
              systemRate != null &&
              Number(rate) !== systemRate && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setRate(String(systemRate))
                    setReview(null)
                  }}
                >
                  Usar tipo de cambio actual
                </Button>
              )}
            <Input
              label="Envío de todo el pedido"
              type="number"
              min="0"
              step="0.01"
              required
              value={shipping}
              onChange={(e) => {
                setShipping(e.target.value)
              }}
            />
          </div>
          <Input
            label="Buscar perfume en la recepción"
            type="search"
            placeholder="Nombre o código"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault()
            }}
          />
          {search && !lines.some((line) => matches(line.product_id)) && (
            <p>No hay renglones de la recepción que coincidan.</p>
          )}
          {lines.map(
            (l, i) =>
              matches(l.product_id) && (
                <div className="receipt-edit-line" key={i}>
                  <Select
                    label={`Perfume ${i + 1}`}
                    required
                    value={l.product_id}
                    onChange={(e) =>
                      changeLine(i, { product_id: e.target.value })
                    }
                  >
                    <option value="">Seleccionar perfume</option>
                    {products.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.sku} · {p.name}
                      </option>
                    ))}
                  </Select>
                  <Select
                    label={`Ubicación ${i + 1}`}
                    value={l.location}
                    onChange={(e) =>
                      changeLine(i, {
                        location: e.target.value as 'store' | 'warehouse',
                      })
                    }
                  >
                    <option value="store">Tienda</option>
                    <option value="warehouse">Bodega</option>
                  </Select>
                  <Input
                    label={`Unidades ${i + 1}`}
                    type="number"
                    min="1"
                    max="1000000"
                    step="1"
                    required
                    value={l.quantity || ''}
                    onChange={(e) =>
                      changeLine(i, { quantity: Number(e.target.value) })
                    }
                  />
                  <Input
                    label={`Costo unitario ${i + 1}`}
                    type="number"
                    min="0"
                    step="0.000001"
                    required
                    value={l.unit_price}
                    onChange={(e) =>
                      changeLine(i, { unit_price: Number(e.target.value) })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={lines.length <= 1}
                    aria-label={`Quitar perfume ${i + 1}`}
                    onClick={() => {
                      setLines((old) => old.filter((_, j) => j !== i))
                      setReview(null)
                    }}
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              ),
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={lines.length >= 100}
            onClick={() => {
              setSearch('')
              setReview(null)
              setLines((old) => [
                ...old,
                {
                  product_id: '',
                  location: 'store',
                  quantity: 1,
                  unit_price: 0,
                },
              ])
            }}
          >
            <Plus size={16} />
            Agregar perfume
          </Button>
          <Input
            label="Nota"
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <h3>Inventario después de corregir</h3>
          {affected.map((id) => {
            if (!matches(id)) return null
            const p = products.find((p) => p.id === id)
            if (!p) return null
            const delta =
              lines
                .filter((l) => l.product_id === id)
                .reduce((s, l) => s + l.quantity, 0) -
              r.lines
                .filter((l) => l.product_id === id)
                .reduce((s, l) => s + l.quantity, 0)
            return (
              <div key={id} className="receipt-value-review">
                <strong>
                  {p.sku} · {p.name}
                </strong>
                {(p.store === null || p.warehouse === null) && (
                  <ul className="receipt-products">
                    {missingCounts
                      .filter((item) => item.product.id === id)
                      .map((item) => (
                        <li key={`${item.product.id}:${item.location}`}>
                          Falta el conteo en {labels.location[item.location]}{' '}
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={busy || uncertain}
                            onClick={() => {
                              onPending(true)
                              setCount(item)
                            }}
                          >
                            Registrar conteo
                          </Button>
                        </li>
                      ))}
                  </ul>
                )}
                <p>
                  {p.store === null || p.warehouse === null
                    ? 'Conteo pendiente'
                    : `Antes de corregir: ${p.store + p.warehouse} · Cambio de esta recepción: ${delta > 0 ? '+' : ''}${delta} · Después: ${p.store + p.warehouse + delta}`}
                  {currentValue(p) !== null &&
                    ` · Valor actual: ${formatCurrency(currentValue(p)!, 'NIO')}`}
                </p>
                <Input
                  label={`Valor final del inventario · ${p.sku} (C$)`}
                  type="number"
                  required
                  min="0"
                  max="1000000000"
                  step="0.01"
                  value={target(id)}
                  onChange={(e) =>
                    setTargets((old) => ({ ...old, [id]: e.target.value }))
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  disabled={currentValue(p) === null}
                  onClick={() => {
                    setTargets((old) => ({
                      ...old,
                      [id]: String(currentValue(p)),
                    }))
                    setReview(null)
                  }}
                >
                  Conservar valor actual
                </Button>
              </div>
            )
          })}
          <div className="journal-fields">
            <Select
              label="Cuenta para el costo ya consumido"
              value={costAccount}
              required
              onChange={(e) => setCostAccount(e.target.value)}
            >
              {accounts
                .filter((a) => a.bucket === 'cost' || a.bucket === 'expense')
                .map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.displayCode} · {a.name}
                  </option>
                ))}
            </Select>
            {r.account === 'pending' ? (
              <p className="accounting-note">
                El cargo de la compra queda fijo en Inventario de perfumes. La
                contrapartida de pago se revisa en Clasificar compra.
              </p>
            ) : (
              <Select
                label="Contrapartida de la diferencia"
                required
                value={counterpart}
                onChange={(e) => setCounterpart(e.target.value)}
              >
                <option value="">Seleccionar contrapartida</option>
                {accounts
                  .filter(
                    (a) =>
                      a.code !== '1130' &&
                      a.code !== '2190' &&
                      accountCurrency(a.code) !== 'USD',
                  )
                  .map((a) => (
                    <option key={a.code} value={a.code}>
                      {a.displayCode} · {a.name}
                    </option>
                  ))}
              </Select>
            )}
          </div>
        </fieldset>
        <PurchaseAmounts
          goods={goods}
          shipping={Number(shipping)}
          currency={currency}
          exchangeRate={exchangeRate}
          systemRate={systemRate}
        />
        <div className="day-closing">
          <p>
            Total anterior: <strong>{formatCurrency(before, 'NIO')}</strong> ·
            Corregido: <strong>{formatCurrency(total, 'NIO')}</strong>
          </p>
          <p>
            Cambio en inventario:{' '}
            <strong>{formatCurrency(inventoryDelta, 'NIO')}</strong> · Cambio en
            costo consumido: <strong>{formatCurrency(remainder, 'NIO')}</strong>
          </p>
        </div>
        {review && (
          <p className="accounting-note" role="status">
            La corrección queda registrada en la jornada actual. Revisa la
            distribución entre inventario y costo consumido antes de confirmar.
          </p>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <div className="form-actions">
          <Button type="submit" disabled={busy}>
            {busy
              ? 'Guardando…'
              : uncertain
                ? 'Verificar guardado'
                : review
                  ? 'Confirmar corrección'
                  : 'Revisar corrección'}
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
        {!!context.history.length && (
          <details className="day-history">
            <summary>
              Historial de correcciones ({context.history.length})
            </summary>
            {context.history.map((h) => (
              <article key={h.id}>
                <strong>Revisión {h.revision}</strong>
                <p>
                  {h.actorName} ·{' '}
                  {new Date(h.createdAt).toLocaleString('es-NI')}
                </p>
                {h.journalEntryId && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setJournal(h.journalEntryId!)}
                  >
                    Ver comprobante de corrección
                  </Button>
                )}
              </article>
            ))}
          </details>
        )}
        {journal && (
          <JournalDetail id={journal} onClose={() => setJournal(undefined)} />
        )}
      </form>
      {count && (
        <ReceiptInitialCount
          productId={count.product.id}
          productName={count.product.name}
          location={count.location}
          onClose={() => {
            setCount(undefined)
            onPending(false)
          }}
          onSaved={() => {
            setReview(null)
            setError('')
            setCount(undefined)
            onPending(false)
          }}
        />
      )}
    </>
  )
}

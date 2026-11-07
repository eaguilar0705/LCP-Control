import { useCallback, useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
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
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { useAccess } from '../../app/AccessContext'
import { journalRpc } from '../accounting/journalService'
import { localDay } from '../reports/model'
import { JournalDetail } from '../accounting/JournalDetail'
import { accountCurrency } from '../accounting/journalModel'

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
    return { ...receipt, systemRate: rate?.usdToNio ?? null }
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
  const [date, setDate] = useState(r.incurred_on),
    [supplier, setSupplier] = useState(r.supplier),
    [reference, setReference] = useState(r.reference),
    [note, setNote] = useState(r.note)
  const [currency, setCurrency] = useState(r.currency),
    [rate, setRate] = useState(
      r.currency === 'USD'
        ? String(r.exchange_rate)
        : systemRate
          ? String(systemRate)
          : '',
    ),
    [shipping, setShipping] = useState(String(r.shipping_amount))
  const [lines, setLines] = useState(r.lines.map((l) => ({ ...l })))
  const [targets, setTargets] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      r.lines.map((l) => [
        l.product_id,
        String(products.find((p) => p.id === l.product_id)?.value ?? ''),
      ]),
    ),
  )
  const [costAccount, setCostAccount] = useState('5120'),
    [counterpart, setCounterpart] = useState(
      r.account === 'pending'
        ? '1130'
        : r.account === 'credito'
          ? '2111'
          : r.currency === 'USD'
            ? ''
            : (r.bank_ledger_account ?? '1110-001'),
    )
  const [review, setReview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [journal, setJournal] = useState<string>()
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
  const exchangeRate = currency === 'NIO' ? 1 : Number(rate)
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
        Number(targets[id] ?? 0) -
        Number(products.find((p) => p.id === id)?.value ?? 0),
      0,
    ),
  )
  const remainder = money(total - before - inventoryDelta)
  const uncertain = operation.isUncertain()
  function changeLine(i: number, patch: Partial<ReceiptLine>) {
    setLines((old) => old.map((l, n) => (n === i ? { ...l, ...patch } : l)))
    setTargets({})
    setReview(false)
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (
      !uncertain &&
      affected.some((id) => targets[id] === undefined || targets[id] === '')
    ) {
      setError('Revisa el valor final del inventario de cada perfume.')
      return
    }
    if (!uncertain && !review) {
      setReview(true)
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
            const p = products.find((p) => p.id === id)!
            return {
              productId: id,
              expectedStore: p.store,
              expectedWarehouse: p.warehouse,
              expectedValueNio: p.value,
              targetValueNio: Number(targets[id]),
            }
          }),
        })
      onPending(false)
      onSaved()
    } catch (e) {
      setError(errorMessage(e))
      onPending(operation.isUncertain())
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      onSubmit={(event) => void save(event)}
      className="mixed-journal-form"
      onChange={() => setReview(false)}
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
              setTargets({})
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
                setTargets({})
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
                  setTargets({})
                  setReview(false)
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
              setTargets({})
            }}
          />
        </div>
        {lines.map((l, i) => (
          <div className="receipt-edit-line" key={i}>
            <Select
              label={`Perfume ${i + 1}`}
              required
              value={l.product_id}
              onChange={(e) => changeLine(i, { product_id: e.target.value })}
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
                setTargets({})
              }}
            >
              <Trash2 size={16} />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          disabled={lines.length >= 100}
          onClick={() =>
            setLines((old) => [
              ...old,
              { product_id: '', location: 'store', quantity: 1, unit_price: 0 },
            ])
          }
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
              <p>
                Existencias actuales: {(p.store ?? 0) + (p.warehouse ?? 0)} ·
                Después: {(p.store ?? 0) + (p.warehouse ?? 0) + delta} · Valor
                actual: {formatCurrency(Number(p.value ?? 0), 'NIO')}
              </p>
              <Input
                label={`Valor final del inventario · ${p.sku} (C$)`}
                type="number"
                required
                min="0"
                max="1000000000"
                step="0.01"
                value={targets[id] ?? ''}
                onChange={(e) =>
                  setTargets((old) => ({ ...old, [id]: e.target.value }))
                }
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  setTargets((old) => ({ ...old, [id]: String(p.value ?? 0) }))
                }
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
                {h.actorName} · {new Date(h.createdAt).toLocaleString('es-NI')}
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
  )
}

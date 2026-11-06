import { useCallback, useState, type FormEvent } from 'react'
import {
  Button,
  Dialog,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from '../../components/ui'
import { useQuery } from '../../lib/useQuery'
import { useAccess } from '../../app/AccessContext'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { errorMessage } from '../../lib/errors'
import { localDay } from '../reports/model'
import { journalRpc } from './journalService'
import { purchaseBanks } from '../pricing/purchaseService'
import { formatCurrency } from '../../lib/format'

interface Context {
  entry: {
    id: string
    revision: number
    kind: string
    occurred_on: string
    account: string
    amount: number
    currency: 'NIO' | 'USD'
    exchange_rate: number
    counterparty: string
    description: string
    reference: string
    bank_ledger_account: string | null
    document_id: string | null
    shipment_id: string | null
  }
  credits: {
    rows: {
      id: string
      kind: string
      reference: string
      counterparty: string
      documentId: string | null
      shipmentId: string | null
    }[]
  }
  history: {
    id: string
    revision: number
    actorName: string
    createdAt: string
  }[]
}
export function FinancePaymentEditor({
  id,
  onClose,
  onSaved,
}: {
  id: string
  onClose: () => void
  onSaved: () => void
}) {
  const load = useCallback(
    () => journalRpc<Context>('finance_correction_context', { p_id: id }),
    [id],
  )
  const query = useQuery(load),
    [pending, setPending] = useState(false)
  return (
    <Dialog
      open
      title="Editar cobro o pago"
      className="journal-dialog"
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
        <PaymentForm
          context={query.data}
          onSaved={onSaved}
          onClose={onClose}
          onPending={setPending}
        />
      )}
    </Dialog>
  )
}
function PaymentForm({
  context,
  onClose,
  onSaved,
  onPending,
}: {
  context: Context
  onClose: () => void
  onSaved: () => void
  onPending: (v: boolean) => void
}) {
  const { entry: e } = context,
    { storageScope = 'anonymous' } = useAccess()
  const [date, setDate] = useState(e.occurred_on),
    [kind, setKind] = useState(e.kind),
    [account, setAccount] = useState(e.account),
    [bank, setBank] = useState(e.bank_ledger_account ?? '')
  const [currency, setCurrency] = useState(e.currency),
    [rate, setRate] = useState(String(e.exchange_rate)),
    [amount, setAmount] = useState(String(e.amount)),
    [party, setParty] = useState(e.counterparty)
  const [description, setDescription] = useState(e.description),
    [reference, setReference] = useState(e.reference),
    [source, setSource] = useState(e.document_id ?? e.shipment_id ?? '')
  const [busy, setBusy] = useState(false),
    [review, setReview] = useState(false),
    [error, setError] = useState('')
  const [operation] = useState(() =>
    createIdempotentOperation<Record<string, unknown>, unknown>(
      (input) => journalRpc('correct_finance_entry', { p_input: input }),
      {
        scope: storageScope,
        key: 'finance-correction',
        label: 'Edición de cobro o pago',
      },
    ),
  )
  const selected = context.credits.rows.find((r) => r.id === source)
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!operation.isUncertain() && !review) {
      setReview(true)
      return
    }
    setBusy(true)
    setError('')
    onPending(true)
    try {
      if (operation.isUncertain()) await operation.retryPending()
      else
        await operation.execute({
          entryId: e.id,
          expectedRevision: e.revision,
          occurredOn: date,
          kind,
          account,
          toAccount: null,
          bankLedgerAccount: account === 'banco' ? bank : null,
          amount: Number(amount),
          currency,
          exchangeRate: currency === 'NIO' ? 1 : Number(rate),
          counterparty: party,
          description,
          reference,
          documentId:
            kind === 'collection' ? (selected?.documentId ?? null) : null,
          shipmentId:
            kind === 'supplier_payment' ? (selected?.shipmentId ?? null) : null,
        })
      onPending(false)
      onSaved()
    } catch (f) {
      setError(errorMessage(f))
      onPending(operation.isUncertain())
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      onSubmit={(event) => void save(event)}
      onChange={() => setReview(false)}
      className="mixed-journal-form"
    >
      <fieldset disabled={busy || operation.isUncertain()}>
        <div className="journal-fields">
          <Input
            label="Fecha del movimiento"
            type="date"
            max={localDay(new Date())}
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <Select
            label="Tipo de abono"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value)
              setSource('')
            }}
          >
            <option value="supplier_payment">Pago a proveedor</option>
            <option value="collection">Cobro a cliente</option>
          </Select>
          <Select
            label="Documento vinculado"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="">Saldo inicial sin documento</option>
            {context.credits.rows
              .filter(
                (r) =>
                  r.kind ===
                    (kind === 'collection' ? 'receivable' : 'payable') &&
                  (r.documentId || r.shipmentId),
              )
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.reference} · {r.counterparty}
                </option>
              ))}
          </Select>
          <Select
            label="Moneda del abono"
            value={currency}
            onChange={(e) => {
              setCurrency(e.target.value as 'NIO' | 'USD')
              setBank('')
            }}
          >
            <option value="NIO">C$ Córdobas</option>
            <option value="USD">US$ Dólares</option>
          </Select>
          <Input
            label="Importe del abono"
            type="number"
            required
            min="0.01"
            max="1000000000"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          {currency === 'USD' && (
            <Input
              label="Tipo de cambio del abono"
              type="number"
              required
              min="0.000001"
              max="1000"
              step="0.000001"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          )}
          <Select
            label="Cuenta del abono"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          >
            <option value="caja">Caja</option>
            <option value="banco">Banco</option>
          </Select>
          {account === 'banco' && (
            <Select
              label="Banco del abono"
              required
              value={bank}
              onChange={(e) => setBank(e.target.value)}
            >
              <option value="">Seleccionar banco</option>
              {purchaseBanks
                .filter((b) => b.currency === currency)
                .map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.name}
                  </option>
                ))}
            </Select>
          )}
          <Input
            label="Cliente o proveedor"
            disabled={!!selected}
            maxLength={200}
            value={selected?.counterparty ?? party}
            onChange={(e) => setParty(e.target.value)}
          />
          <Input
            label="Referencia del abono"
            maxLength={200}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
        <Input
          label="Concepto del abono"
          required
          maxLength={300}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </fieldset>
      {review && (
        <p role="status">
          Anterior: {formatCurrency(Number(e.amount), e.currency)} · Corregido:{' '}
          {formatCurrency(Number(amount), currency)}. Revisa la cuenta y el
          documento vinculado.
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
            : operation.isUncertain()
              ? 'Verificar guardado'
              : review
                ? 'Confirmar edición'
                : 'Revisar edición'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy || operation.isUncertain()}
          onClick={onClose}
        >
          Cancelar
        </Button>
      </div>
      {!!context.history.length && (
        <details className="day-history">
          <summary>Historial de ediciones ({context.history.length})</summary>
          {context.history.map((h) => (
            <p key={h.id}>
              Revisión {h.revision} · {h.actorName} ·{' '}
              {new Date(h.createdAt).toLocaleString('es-NI')}
            </p>
          ))}
        </details>
      )}
    </form>
  )
}

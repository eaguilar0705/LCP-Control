import { useCallback, useState } from 'react'
import {
  Button,
  ConfirmDialog,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from '../../components/ui'
import { useQuery } from '../../lib/useQuery'
import { errorMessage, AppError } from '../../lib/errors'
import { formatCurrency, formatDate } from '../../lib/format'
import {
  labels,
  type DocumentRecord,
  type PaymentMethod,
} from '../../lib/domain'
import {
  invoiceReturnDetail,
  recordSalesReturn,
  type SalesReturnInput,
} from './salesReturns'
import {
  rememberOperationReference,
  forgetOperationReference,
  getOperationReferences,
} from '../../lib/operationRecovery'

export function SalesReturnDialog({
  document,
  scope,
  onClose,
  onSaved,
}: {
  document: DocumentRecord
  scope: string
  onClose: () => void
  onSaved: (number: string) => void
}) {
  const load = useCallback(
    () => invoiceReturnDetail(document.id),
    [document.id],
  )
  const { data, error, loading, retry } = useQuery(load)
  const [quantities, setQuantities] = useState<Record<string, number>>({})
  const [restock, setRestock] = useState(true)
  const [reason, setReason] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [pending, setPending] = useState<SalesReturnInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  async function submit() {
    if (busy || !data) return
    const input = pending ?? {
      requestId: crypto.randomUUID(),
      documentId: document.id,
      reason: reason.trim(),
      refundMethod: method,
      items: data.items
        .filter((i) => quantities[i.id] > 0)
        .map((i) => ({ itemId: i.id, quantity: quantities[i.id], restock })),
    }
    if (!input.reason || !input.items.length) {
      setFailure('Indica un motivo y las cantidades que se devuelven.')
      return
    }
    if (
      getOperationReferences(scope).some(
        (r) => r.kind === 'sales-return' && r.requestId !== input.requestId,
      )
    ) {
      setFailure(
        'Hay una solicitud anterior por verificar. Consulta el aviso de recuperación antes de registrar otra operación.',
      )
      return
    }
    setBusy(true)
    setFailure('')
    setPending(input)
    try {
      rememberOperationReference(scope, 'sales-return', input.requestId)
      const result = await recordSalesReturn(input)
      forgetOperationReference(scope, 'sales-return', input.requestId)
      setPending(null)
      onSaved(result.number)
    } catch (e) {
      if (
        e instanceof AppError &&
        (e.kind === 'validation' ||
          (!pending &&
            ['unauthorized', 'rate_limited', 'configuration'].includes(e.kind)))
      ) {
        forgetOperationReference(scope, 'sales-return', input.requestId)
        setPending(null)
      }
      setFailure(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ConfirmDialog
      open
      title={`Devolución · ${document.number}`}
      confirmLabel={
        pending ? 'Verificar guardado' : 'Registrar nota de crédito'
      }
      busyLabel="Guardando…"
      busy={busy}
      error={failure}
      onConfirm={() => void submit()}
      onCancel={onClose}
    >
      {loading && <LoadingState />}
      {error && <ErrorState message={error} retry={retry} />}
      {data && (
        <fieldset disabled={busy || !!pending} className="sales-return-fields">
          {data.items.map((i) => (
            <Input
              key={i.id}
              label={`${i.description} · disponibles: ${i.quantity - i.returned}`}
              type="number"
              min="0"
              step="1"
              max={i.quantity - i.returned}
              value={quantities[i.id] ?? ''}
              onChange={(e) =>
                setQuantities((current) => ({
                  ...current,
                  [i.id]: Number(e.target.value),
                }))
              }
            />
          ))}
          <strong>
            Total de la nota:{' '}
            {formatCurrency(
              data.items.reduce(
                (sum, i) => sum + (quantities[i.id] || 0) * i.unitPrice,
                0,
              ),
              document.currency,
            )}
          </strong>
          <Input
            label="Motivo de devolución"
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Select
            label="Destino del producto"
            value={restock ? 'stock' : 'damaged'}
            onChange={(e) => setRestock(e.target.value === 'stock')}
          >
            <option value="stock">Volver al inventario</option>
            <option value="damaged">Dañado · no vuelve a existencias</option>
          </Select>
          <Select
            label="Reembolso del dinero ya cobrado"
            value={method}
            onChange={(e) => setMethod(e.target.value as PaymentMethod)}
          >
            {Object.entries(labels.payment)
              .filter(
                ([id]) =>
                  id === 'cash' ||
                  id.endsWith(document.currency === 'USD' ? '_usd' : '_nio'),
              )
              .map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
          </Select>
          <p>
            El saldo a crédito se reduce primero. El excedente ya pagado se
            reembolsa en {document.currency === 'NIO' ? 'córdobas' : 'dólares'}.
          </p>
          {!!data.returns.length && (
            <section aria-label="Notas de crédito anteriores">
              <h3>Notas de crédito</h3>
              {data.returns.map((r) => (
                <p key={r.id}>
                  <strong>{r.number}</strong> · {formatDate(r.date)} ·{' '}
                  {formatCurrency(r.amount, document.currency)} · {r.reason}
                </p>
              ))}
            </section>
          )}
        </fieldset>
      )}
      {pending && (
        <Button type="button" variant="ghost" onClick={onClose}>
          Cerrar y consultar confirmación en Inicio
        </Button>
      )}
    </ConfirmDialog>
  )
}

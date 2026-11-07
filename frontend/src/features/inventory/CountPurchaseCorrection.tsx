import { useCallback, useState } from 'react'
import { Button, Dialog, ErrorState, LoadingState } from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { useQuery } from '../../lib/useQuery'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { errorMessage } from '../../lib/errors'
import { formatCurrency, formatDate } from '../../lib/format'
import { journalRpc } from '../accounting/journalService'
import { ReceiptEditor } from '../pricing/ReceiptEditor'

interface Context {
  movementId: string
  shipmentId: string | null
  productName: string
  quantity: number
  valueNio: number
  occurredOn: string
}

export function CountPurchaseCorrection({
  movementId,
  onClose,
  onChanged,
}: {
  movementId: string
  onClose(): void
  onChanged(): void
}) {
  const { storageScope = 'anonymous' } = useAccess()
  const load = useCallback(
    () =>
      journalRpc<Context>('count_purchase_context', { p_movement: movementId }),
    [movementId],
  )
  const { data, loading, error, retry } = useQuery(load)
  const [receiptId, setReceiptId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [operation] = useState(() =>
    createIdempotentOperation<
      { movementIds: string[]; expectedTotalNio: number },
      string
    >(
      (input) =>
        journalRpc('adopt_inventory_counts_as_purchase', { p_input: input }),
      {
        scope: storageScope,
        key: 'purchase',
        label: 'Regularización de compra',
      },
    ),
  )
  const uncertain = operation.isUncertain()
  async function save() {
    if (busy || !data || (!confirmed && !uncertain)) return
    setBusy(true)
    setFailure('')
    try {
      const id = uncertain
        ? await operation.retryPending()
        : await operation.execute({
            movementIds: [movementId],
            expectedTotalNio: data.valueNio,
          })
      setReceiptId(id)
      onChanged()
    } catch (e) {
      setFailure(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const editingId = receiptId ?? data?.shipmentId
  if (editingId)
    return (
      <ReceiptEditor
        id={editingId}
        onClose={onClose}
        onSaved={() => {
          onChanged()
          onClose()
        }}
      />
    )
  return (
    <Dialog
      open
      title="Registrar compra ya ingresada"
      dismissible={!busy && !uncertain}
      onClose={() => {
        if (!busy && !uncertain) onClose()
      }}
    >
      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} retry={retry} />
      ) : (
        data && (
          <>
            <p>
              <strong>{data.productName}</strong> · {data.quantity} unidades ·{' '}
              {formatDate(data.occurredOn)}
            </p>
            <p>
              Valor registrado:{' '}
              <strong>{formatCurrency(data.valueNio, 'NIO')}</strong>
            </p>
            <p>
              Las unidades ya están en inventario. Se retirará su registro como
              sobrante y se preparará la compra con cargo a Inventario de
              perfumes, sin volver a sumar existencias ni descontar caja o
              bancos. Después podrás corregir el costo y elegir la contrapartida
              de pago en Contabilidad.
            </p>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy || uncertain}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              Este ingreso fue una compra nueva, no un sobrante de conteo.
            </label>
            {failure && (
              <p role="alert" className="inline-error">
                {failure}
              </p>
            )}
            <div className="form-actions">
              <Button
                disabled={busy || (!confirmed && !uncertain)}
                onClick={() => void save()}
              >
                {busy
                  ? 'Guardando…'
                  : uncertain
                    ? 'Verificar guardado'
                    : 'Registrar como compra sin duplicar unidades'}
              </Button>
              <Button
                variant="secondary"
                disabled={busy || uncertain}
                onClick={onClose}
              >
                Cancelar
              </Button>
            </div>
          </>
        )
      )}
    </Dialog>
  )
}

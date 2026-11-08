import { useCallback, useState, type FormEvent } from 'react'
import { useAccess } from '../../app/AccessContext'
import {
  Button,
  Dialog,
  ErrorState,
  Input,
  LoadingState,
} from '../../components/ui'
import type {
  InventoryAdjustmentVoidContext,
  VoidInventoryAdjustmentInput,
} from '../../lib/domain'
import { labels } from '../../lib/domain'
import { AppError, errorMessage } from '../../lib/errors'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { useQuery } from '../../lib/useQuery'
import { journalRpc } from '../accounting/journalService'

const quantity = (value: number | null) =>
  value === null ? 'Sin conteo' : String(value)
const money = (value: number | null) =>
  value === null
    ? 'Sin valor confirmado'
    : new Intl.NumberFormat('es-NI', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value)

export function InventoryAdjustmentVoidDialog({
  movementId,
  onClose,
  onVoided,
}: {
  movementId: string
  onClose(): void
  onVoided(): void
}) {
  const { storageScope = 'anonymous' } = useAccess()
  const load = useCallback(async () => {
    const context = await journalRpc<InventoryAdjustmentVoidContext>(
      'inventory_adjustment_void_context',
      { p_movement: movementId },
    )
    if (
      !context ||
      context.movementId !== movementId ||
      typeof context.productName !== 'string' ||
      !['store', 'warehouse'].includes(context.location) ||
      typeof context.canVoid !== 'boolean' ||
      (context.canVoid &&
        (typeof context.stateToken !== 'string' ||
          !context.stateToken ||
          [
            context.currentQuantity,
            context.resultingQuantity,
            context.currentValueNio,
            context.resultingValueNio,
          ].some((value) => value === null || !Number.isFinite(value))))
    )
      throw new AppError(
        'unexpected',
        'No se recibió la vista previa completa de la anulación. Vuelve a consultar.',
      )
    return context
  }, [movementId])
  const { data, loading, error, retry } = useQuery(load)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [operation] = useState(() =>
    createIdempotentOperation<
      Omit<VoidInventoryAdjustmentInput, 'requestId'>,
      unknown
    >((input) => journalRpc('void_inventory_adjustment', { p_input: input }), {
      scope: storageScope,
      key: 'inventory-adjustment-void',
      label: 'Anulación de ajuste de inventario',
    }),
  )
  const uncertain = operation.isUncertain()
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || (!uncertain && (!data?.canVoid || data.voidedAt))) return
    if (
      !uncertain &&
      (reason.trim().length < 3 || reason.trim().length > 500)
    ) {
      setFailure('Escribe el motivo de anulación (de 3 a 500 caracteres).')
      return
    }
    setBusy(true)
    setFailure('')
    try {
      if (uncertain) await operation.retryPending()
      else
        await operation.execute({
          movementId,
          stateToken: data!.stateToken,
          reason: reason.trim(),
        })
      operation.reset()
      onVoided()
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      title="Anular ajuste de inventario"
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
          <form onSubmit={(event) => void submit(event)}>
            <p>
              <strong>{data.productName}</strong> · {data.sku} ·{' '}
              {labels.location[data.location]}
            </p>
            <p>
              Ajuste registrado: {quantity(data.beforeQuantity)} →{' '}
              {quantity(data.afterQuantity)} unidades.
            </p>
            <div
              className="inventory-adjustment-void-preview"
              tabIndex={0}
              role="region"
              aria-label="Vista previa de la reversión"
            >
              <table>
                <caption>Vista previa de la reversión</caption>
                <thead>
                  <tr>
                    <th scope="col">Concepto</th>
                    <th scope="col">Actual</th>
                    <th scope="col">Después de anular</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Existencias</th>
                    <td>{quantity(data.currentQuantity)}</td>
                    <td>{quantity(data.resultingQuantity)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Valor de inventario (C$)</th>
                    <td>{money(data.currentValueNio)}</td>
                    <td>{money(data.resultingValueNio)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              Se registrará un movimiento inverso y se revertirá el efecto
              contable del ajuste. El ajuste original, la anulación y su motivo
              se conservarán en el historial.
            </p>
            {data.canVoid && !data.voidedAt ? (
              <fieldset disabled={busy || uncertain} className="form-fields">
                <Input
                  label="Motivo de anulación"
                  required
                  minLength={3}
                  maxLength={500}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </fieldset>
            ) : (
              <p role="status">
                {data.blockedReason || 'Este ajuste no se puede anular.'}
                {data.voidReason ? ` Motivo: ${data.voidReason}` : ''}
              </p>
            )}
            {failure && (
              <p role="alert" className="inline-error">
                {failure}
              </p>
            )}
            {failure && !uncertain && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setFailure('')
                  retry()
                }}
              >
                Actualizar vista previa
              </Button>
            )}
            <div className="form-actions">
              {(data.canVoid || uncertain) && (
                <Button type="submit" disabled={busy}>
                  {busy
                    ? 'Anulando…'
                    : uncertain
                      ? 'Verificar guardado'
                      : 'Confirmar anulación'}
                </Button>
              )}
              <Button
                type="button"
                variant="secondary"
                disabled={busy || uncertain}
                onClick={onClose}
              >
                {data.canVoid ? 'Cancelar' : 'Cerrar'}
              </Button>
            </div>
          </form>
        )
      )}
    </Dialog>
  )
}

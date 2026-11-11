import { useState, type FormEvent } from 'react'
import { Button, Dialog, Input } from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { errorMessage } from '../../lib/errors'
import {
  labels,
  type InventoryLocation,
  type MovementRequest,
} from '../../lib/domain'
import { refreshQueries } from '../../lib/queryRefresh'
import { useServices } from '../../services/useServices'

export function ReceiptInitialCount({
  productId,
  productName,
  location,
  onClose,
  onSaved,
}: {
  productId: string
  productName: string
  location: InventoryLocation
  onClose: () => void
  onSaved: () => void
}) {
  const { inventoryService } = useServices()
  const { storageScope = 'anonymous' } = useAccess()
  const [operation] = useState(() =>
    createIdempotentOperation<Omit<MovementRequest, 'requestId'>, string>(
      inventoryService.recordMovement,
      {
        scope: storageScope,
        key: 'inventory-movement',
        label: 'Conteo inicial',
      },
    ),
  )
  const [quantity, setQuantity] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const uncertain = operation.isUncertain()
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (uncertain) await operation.retryPending()
      else
        await operation.execute({
          productId,
          location,
          type: 'ADJUSTMENT',
          quantity: Number(quantity),
          expectedQuantity: null,
          note: 'Conteo físico al revisar recepción',
        })
      refreshQueries()
      onSaved()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      title="Registrar conteo inicial"
      dismissible={!busy && !uncertain}
      onClose={onClose}
    >
      <form
        className="mixed-journal-form"
        onSubmit={(event) => void save(event)}
      >
        <p>
          {productName} · {labels.location[location]}
        </p>
        <Input
          label="Unidades contadas"
          type="number"
          min="0"
          max="1000000"
          step="1"
          required
          disabled={busy || uncertain}
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
        />
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {busy
            ? 'Guardando…'
            : uncertain
              ? 'Verificar guardado'
              : 'Guardar conteo'}
        </Button>
      </form>
    </Dialog>
  )
}

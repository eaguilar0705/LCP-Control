import { ProductSelect } from '../../components/ProductSelect'
import { useState, type FormEvent } from 'react'
import { Button, Dialog, Input, Select } from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { useServices } from '../../services/useServices'
import {
  labels,
  type InventoryItem,
  type MovementRequest,
} from '../../lib/domain'
import { can, type Capability } from '../../lib/permissions'
import { errorMessage } from '../../lib/errors'
import { createIdempotentOperation } from '../../lib/idempotentOperation'

// `title` y `done` se escriben enteros: «Dañado» y «Ajuste» no concuerdan con
// «de inventario … registrada» como sí lo hacen «Entrada» y «Salida».
const actions: {
  type: MovementRequest['type']
  label: string
  title: string
  done: string
  capability: Capability
}[] = [
  {
    type: 'ENTRY',
    label: 'Entrada',
    title: 'Entrada de inventario',
    done: 'Entrada registrada',
    capability: 'inventory.create_entry',
  },
  {
    type: 'EXIT',
    label: 'Salida',
    title: 'Salida de inventario',
    done: 'Salida registrada',
    capability: 'inventory.create_exit',
  },
  {
    type: 'DAMAGED',
    label: 'Dañado',
    title: 'Producto dañado',
    done: 'Producto dañado registrado',
    capability: 'inventory.create_damage',
  },
  {
    type: 'ADJUSTMENT',
    label: 'Ajuste',
    title: 'Ajuste de inventario',
    done: 'Ajuste registrado',
    capability: 'inventory.adjust',
  },
]

export function InventoryMovements({
  items,
  onRecorded,
}: {
  items: InventoryItem[]
  onRecorded: () => void
}) {
  const { role, demo } = useAccess()
  const { inventoryService } = useServices()
  const [operation] = useState(() =>
    createIdempotentOperation<Omit<MovementRequest, 'requestId'>, string>(
      inventoryService.recordMovement,
    ),
  )
  const [action, setAction] = useState<(typeof actions)[number] | null>(null)
  const [productId, setProductId] = useState('')
  const [location, setLocation] = useState<MovementRequest['location']>('store')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const item = items.find(({ product }) => product.id === productId)
  const quantity = item?.quantities[location]
  if (demo) return null

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !action || !can(role, action.capability)) return
    const fields = new FormData(event.currentTarget)
    const nextQuantity = Number(fields.get('quantity'))
    const note = String(fields.get('note') ?? '').trim()
    if (
      !item ||
      !Number.isInteger(nextQuantity) ||
      nextQuantity < (action.type === 'ADJUSTMENT' ? 0 : 1) ||
      nextQuantity > 1000000 ||
      !note ||
      note.length > 2000
    ) {
      setError('Selecciona un producto, una cantidad válida y el motivo.')
      return
    }
    if (quantity == null && action.type !== 'ADJUSTMENT') {
      setError(
        'Registra primero el conteo inicial mediante Ajuste. Solicítalo al administrador.',
      )
      return
    }
    // Una salida o una merma mayor que lo contado dejaría el inventario en
    // negativo: la base lo rechaza y el movimiento se pierde. Se detiene aquí,
    // diciendo cuántas unidades hay, en lugar de devolver el error del servidor.
    if (
      quantity != null &&
      (action.type === 'EXIT' || action.type === 'DAMAGED') &&
      nextQuantity > quantity
    ) {
      setError(
        `Solo hay ${quantity} ${quantity === 1 ? 'unidad' : 'unidades'} en ${labels.location[location]}. No puedes sacar más de lo contado.`,
      )
      return
    }
    setBusy(true)
    setError('')
    try {
      await operation.execute({
        productId,
        location,
        type: action.type,
        quantity: nextQuantity,
        note,
      })
      setMessage(`${action.done}. Inventario actualizado.`)
      setAction(null)
      operation.reset()
      onRecorded()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="movement-section">
      <div className="movement-buttons">
        {actions
          .filter((entry) => can(role, entry.capability))
          .map((entry) => (
            <Button
              key={entry.type}
              variant="secondary"
              disabled={!items.length || busy}
              onClick={() => {
                operation.reset()
                setAction(entry)
                setProductId(items.length === 1 ? items[0].product.id : '')
                setError('')
                setMessage('')
              }}
            >
              {entry.label}
            </Button>
          ))}
      </div>
      <p className="workspace-disclaimer">
        Los movimientos confirmados actualizan las existencias. Ajuste establece
        el conteo total de la ubicación.
      </p>
      {message && (
        <p role="status" className="page-feedback">
          {message}
        </p>
      )}
      {action && (
        <Dialog
          open
          title={action.title}
          onClose={() => {
            if (!busy) setAction(null)
          }}
        >
          <form onSubmit={submit} className="movement-form">
            <fieldset disabled={busy} className="form-fields">
              <ProductSelect
                label="Producto del movimiento"
                products={items.map(({ product }) => product)}
                value={productId}
                onChange={setProductId}
              />
              <Select
                label="Ubicación"
                value={location}
                onChange={(event) =>
                  setLocation(event.target.value as MovementRequest['location'])
                }
              >
                {Object.entries(labels.location).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </Select>
              {item && <p>Existencias actuales: {quantity ?? 'Sin conteo'}</p>}
              <Input
                label={
                  action.type === 'ADJUSTMENT' ? 'Conteo total' : 'Cantidad'
                }
                name="quantity"
                type="number"
                required
                min={action.type === 'ADJUSTMENT' ? 0 : 1}
                max={1000000}
                step={1}
              />
              <Input label="Motivo" name="note" required maxLength={2000} />
            </fieldset>
            {error && (
              <p role="alert" className="inline-error">
                {error}
              </p>
            )}
            <div className="form-actions">
              <Button type="submit" disabled={busy}>
                {busy ? 'Registrando…' : 'Confirmar movimiento'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => setAction(null)}
              >
                Cancelar
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  )
}

import { useCallback, useState, type FormEvent } from 'react'
import { Minus, Plus, Package, ArrowRight } from 'lucide-react'
import {
  Button,
  Card,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { can, type Capability } from '../../lib/permissions'
import {
  labels,
  type InventoryLocation,
  type MovementRequest,
  type Product,
} from '../../lib/domain'
import { useQuery } from '../../lib/useQuery'
import { useServices } from '../../services/useServices'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { errorMessage } from '../../lib/errors'
import { EntryCostNotice } from '../inventory/EntryCostNotice'

const actions: {
  type: MovementRequest['type']
  label: string
  permission: Capability
}[] = [
  {
    type: 'ENTRY',
    label: 'Agregar unidades',
    permission: 'inventory.create_entry',
  },
  {
    type: 'EXIT',
    label: 'Descontar unidades',
    permission: 'inventory.create_exit',
  },
  {
    type: 'ADJUSTMENT',
    label: 'Registrar conteo total',
    permission: 'inventory.adjust',
  },
]

export function ProductStockEditor({
  product,
  disabled = false,
}: {
  product: Product
  disabled?: boolean
}) {
  const { demo, role } = useAccess()
  const { inventoryService } = useServices()
  const load = useCallback(
    () => inventoryService.getInventory(true),
    [inventoryService],
  )
  const { data, loading, error: loadError, retry } = useQuery(load)
  const [operation] = useState(() =>
    createIdempotentOperation<Omit<MovementRequest, 'requestId'>, string>(
      inventoryService.recordMovement,
    ),
  )
  const [location, setLocation] = useState<InventoryLocation>('store')
  const [type, setType] = useState<MovementRequest['type']>('ENTRY')
  const [quantity, setQuantity] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const item = data?.find((i) => i.product.id === product.id)
  const before = item?.quantities[location] ?? null
  const initial = before === null
  const movementType = initial ? 'ADJUSTMENT' : type
  const action = actions.find((a) => a.type === movementType)!
  const available = actions.filter((a) => can(role, a.permission) || demo)
  const amount = Number(quantity)
  const after =
    movementType === 'ADJUSTMENT'
      ? amount
      : before === null
        ? null
        : before + (movementType === 'ENTRY' ? amount : -amount)
  const valid =
    quantity.trim() !== '' &&
    Number.isInteger(amount) &&
    amount >= (movementType === 'ADJUSTMENT' ? 0 : 1) &&
    amount <= 1000000 &&
    after !== null &&
    after >= 0 &&
    after <= 1000000
  const locked = busy || disabled || loading || !item || !item.product.active

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (locked || demo || !can(role, action.permission)) return
    if (!valid || !note.trim() || note.trim().length > 2000) {
      setError(
        'Revisa la cantidad y escribe el motivo. Las existencias no pueden quedar negativas.',
      )
      return
    }
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await operation.execute({
        productId: product.id,
        location,
        type: movementType,
        quantity: amount,
        note: note.trim(),
      })
      operation.reset()
      setQuantity('')
      setNote('')
      setMessage(
        `Cantidad guardada en ${labels.location[location]}. El movimiento quedó en el historial.`,
      )
      retry()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="form-card product-stock-editor">
      <div className="section-heading">
        <div>
          <span className="section-kicker">TIENDA Y BODEGA</span>
          <h2>Cantidades del perfume</h2>
        </div>
        <Package size={25} />
      </div>
      <p className="muted">
        Suma o descuenta unidades aquí. Cada cambio se guarda con su motivo,
        fecha y responsable.
      </p>
      {loading ? (
        <LoadingState />
      ) : loadError ? (
        <ErrorState message={loadError} retry={retry} />
      ) : !item ? (
        <p>No pudimos encontrar las existencias de este perfume.</p>
      ) : (
        <>
          <div className="stock-location-cards">
            {(['store', 'warehouse'] as const).map((place) => (
              <div key={place}>
                <span>{labels.location[place]}</span>
                <strong>{item.quantities[place] ?? '—'}</strong>
                <small>
                  {item.quantities[place] === null
                    ? 'Sin conteo registrado'
                    : 'Unidades disponibles'}
                </small>
              </div>
            ))}
          </div>
          {!item.product.active && (
            <p className="page-feedback">
              Reactiva y guarda el perfume antes de cambiar sus cantidades.
            </p>
          )}
          {available.length > 0 && (
            <form onSubmit={submit}>
              <fieldset disabled={locked} className="form-fields">
                <div className="form-grid">
                  <Select
                    label="Ubicación de las cantidades"
                    value={location}
                    onChange={(e) => {
                      setLocation(e.target.value as InventoryLocation)
                      setError('')
                    }}
                  >
                    <option value="store">Tienda</option>
                    <option value="warehouse">Bodega</option>
                  </Select>
                  <Select
                    label="Cómo cambiar las cantidades"
                    value={movementType}
                    disabled={initial}
                    onChange={(e) => {
                      setType(e.target.value as MovementRequest['type'])
                      setError('')
                    }}
                  >
                    {available.map((a) => (
                      <option key={a.type} value={a.type}>
                        {a.label}
                      </option>
                    ))}
                  </Select>
                </div>
                {initial && (
                  <p className="stock-help">
                    Primero registra el total que contaste en esta ubicación.
                    Cero significa que no hay unidades.
                  </p>
                )}
                {movementType === 'ENTRY' && <EntryCostNotice />}
                <div className="stock-adjustment-row">
                  <div className="quantity-stepper">
                    <Button
                      type="button"
                      variant="secondary"
                      aria-label="Reducir cantidad en una unidad"
                      disabled={
                        !Number.isInteger(amount) ||
                        amount <= (movementType === 'ADJUSTMENT' ? 0 : 1)
                      }
                      onClick={() => setQuantity(String(amount - 1))}
                    >
                      <Minus size={18} />
                    </Button>
                    <Input
                      label={
                        movementType === 'ADJUSTMENT'
                          ? 'Conteo total del perfume'
                          : 'Unidades a mover'
                      }
                      type="number"
                      required
                      min={movementType === 'ADJUSTMENT' ? 0 : 1}
                      max={1000000}
                      step={1}
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      aria-label="Aumentar cantidad en una unidad"
                      disabled={!Number.isInteger(amount) || amount >= 1000000}
                      onClick={() => setQuantity(String(amount + 1))}
                    >
                      <Plus size={18} />
                    </Button>
                  </div>
                  <div className="stock-preview">
                    <span>{before ?? 'Sin conteo'}</span>
                    <ArrowRight size={18} />
                    <strong>{valid ? after : 'Revisar cantidad'}</strong>
                    <small>{labels.location[location]} · al guardar</small>
                  </div>
                </div>
                <Input
                  label="Motivo del cambio de cantidad"
                  required
                  maxLength={2000}
                  placeholder="Compra recibida, corrección de conteo…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </fieldset>
              {error && (
                <p role="alert" className="inline-error">
                  {error}
                </p>
              )}
              <div className="form-actions">
                <Button
                  type="submit"
                  disabled={locked || demo || !can(role, action.permission)}
                >
                  {busy ? 'Guardando cantidades…' : 'Guardar cantidades'}
                </Button>
              </div>
            </form>
          )}
        </>
      )}
      {message && (
        <p role="status" className="page-feedback">
          {message}
        </p>
      )}
    </Card>
  )
}

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
import { InventoryReceiptDialog } from './InventoryReceiptDialog'
import { InventoryTransfers } from './InventoryTransfers'
import { InventoryAdjustmentAccounting } from './InventoryAdjustmentAccounting'
import { useInventoryAdjustmentAccounting } from './useInventoryAdjustmentAccounting'

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
    type: 'ADJUSTMENT',
    label: 'Ajustar existencias',
    title: 'Ajuste de inventario',
    done: 'Ajuste registrado',
    capability: 'inventory.adjust',
  },
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
]

export function InventoryMovements({
  items,
  onRecorded,
}: {
  items: InventoryItem[]
  onRecorded: () => void
}) {
  const { role, demo, storageScope = 'anonymous' } = useAccess()
  const { inventoryService } = useServices()
  const [operation] = useState(() =>
    createIdempotentOperation<Omit<MovementRequest, 'requestId'>, string>(
      inventoryService.recordMovement,
      {
        scope: storageScope,
        key: 'inventory-movement',
        label: 'Movimiento de inventario',
      },
    ),
  )
  const [action, setAction] = useState<(typeof actions)[number] | null>(null)
  const [productId, setProductId] = useState('')
  const [location, setLocation] = useState<MovementRequest['location']>('store')
  const [quantityText, setQuantityText] = useState('')
  const [noteText, setNoteText] = useState('')
  const [purchase, setPurchase] = useState<{
    productId: string
    location: MovementRequest['location']
    quantity: number
    note: string
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const uncertain = operation.isUncertain()
  const item = items.find(({ product }) => product.id === productId)
  const quantity = item?.quantities[location]
  const countedQuantity =
    quantityText.trim() !== '' && Number.isInteger(Number(quantityText))
      ? Number(quantityText)
      : null
  const adjustmentAccounting = useInventoryAdjustmentAccounting(
    `${action?.type ?? ''}:${productId}:${location}:${quantity == null ? 'initial' : 'counted'}`,
    action?.type === 'ADJUSTMENT' && quantity != null,
    quantity ?? null,
    countedQuantity,
  )
  if (demo) return null

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !action || !can(role, action.capability)) return
    if (uncertain) {
      setBusy(true)
      setError('')
      try {
        await operation.retryPending()
        setMessage(`${action.done}. Inventario actualizado.`)
        setAction(null)
        operation.reset()
        onRecorded()
      } catch (failure) {
        setError(errorMessage(failure))
      } finally {
        setBusy(false)
      }
      return
    }
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
    if (action.type === 'ADJUSTMENT' && quantity != null) {
      if (nextQuantity === quantity) {
        setError('La cantidad ya coincide con las existencias.')
        return
      }
      if (!adjustmentAccounting.valid) {
        setError(
          adjustmentAccounting.kind === 'loss'
            ? 'Una pérdida real debe disminuir las existencias actuales.'
            : 'Selecciona una cuenta de contrapartida disponible para la corrección.',
        )
        return
      }
    }
    // La entrada se recibe primero; sólo la revisión contable habilita el stock.
    if (action.type === 'ENTRY') {
      setError('')
      setPurchase({ productId, location, quantity: nextQuantity, note })
      return
    }
    if (quantity == null && action.type !== 'ADJUSTMENT') {
      setError(
        'Solicita al Superadmin que registre el conteo inicial mediante Ajustar existencias.',
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
        ...(action.type === 'ADJUSTMENT'
          ? {
              expectedQuantity: quantity ?? null,
              ...(quantity != null
                ? {
                    adjustmentKind: adjustmentAccounting.kind,
                    ...(adjustmentAccounting.kind === 'correction'
                      ? { counterAccount: adjustmentAccounting.counterAccount }
                      : {}),
                  }
                : {}),
            }
          : {}),
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
        <InventoryTransfers items={items} onRecorded={onRecorded} />
        {actions
          .filter((entry) => can(role, entry.capability))
          .map((entry) => (
            <Button
              key={entry.type}
              variant={entry.type === 'ADJUSTMENT' ? 'primary' : 'secondary'}
              disabled={!items.length || busy || uncertain}
              onClick={() => {
                operation.reset()
                setAction(entry)
                setProductId(items.length === 1 ? items[0].product.id : '')
                setQuantityText('')
                setNoteText(entry.type === 'ADJUSTMENT' ? 'Conteo físico' : '')
                setError('')
                setMessage('')
                adjustmentAccounting.reset()
              }}
            >
              {entry.label}
            </Button>
          ))}
      </div>

      {message && (
        <p role="status" className="page-feedback">
          {message}
        </p>
      )}
      {action && !purchase && (
        <Dialog
          open
          title={action.title}
          dismissible={!busy && !uncertain}
          onClose={() => {
            if (!busy && !uncertain) setAction(null)
          }}
        >
          <form onSubmit={submit} className="movement-form">
            {action.type === 'ADJUSTMENT' && (
              <p>
                Escribe el total contado, no la diferencia. No incluyas unidades
                de recepciones pendientes en este conteo. Para ingresar una
                compra usa Recibir mercadería. Al cambiar un conteo existente,
                elige si corriges una cantidad o reconoces una pérdida real.
              </p>
            )}
            {action.type === 'ENTRY' && (
              <p>
                Esta entrada continuará como recepción pendiente de revisión
                contable. Las unidades estarán disponibles para vender después
                de la revisión.
              </p>
            )}
            <fieldset disabled={busy || uncertain} className="form-fields">
              <ProductSelect
                label="Producto del movimiento"
                products={items.map(({ product }) => product)}
                value={productId}
                onChange={(nextProductId) => {
                  setProductId(nextProductId)
                  adjustmentAccounting.reset()
                  setError('')
                }}
              />
              <Select
                label="Ubicación"
                value={location}
                onChange={(event) => {
                  setLocation(event.target.value as MovementRequest['location'])
                  adjustmentAccounting.reset()
                  setError('')
                }}
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
                value={quantityText}
                onChange={(event) => setQuantityText(event.target.value)}
              />
              {action.type === 'ADJUSTMENT' && item && (
                <p role="status">
                  {labels.location[location]}: {quantity ?? 'Sin conteo'} →{' '}
                  {quantityText.trim() !== '' &&
                  Number.isInteger(Number(quantityText)) &&
                  Number(quantityText) >= 0 &&
                  Number(quantityText) <= 1000000
                    ? `${Number(quantityText)} unidades al guardar`
                    : 'Indica el conteo total'}
                </p>
              )}
              {action.type === 'ADJUSTMENT' && quantity != null && (
                <InventoryAdjustmentAccounting
                  accounting={adjustmentAccounting}
                />
              )}
              <Input
                label="Motivo"
                name="note"
                required
                maxLength={2000}
                value={noteText}
                onChange={(event) => setNoteText(event.target.value)}
              />
            </fieldset>
            {error && !uncertain && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setError('')
                  onRecorded()
                }}
              >
                Actualizar existencias
              </Button>
            )}
            {error && (
              <p role="alert" className="inline-error">
                {error}
              </p>
            )}
            <div className="form-actions">
              <Button type="submit" disabled={busy}>
                {busy
                  ? 'Registrando…'
                  : uncertain
                    ? 'Verificar guardado'
                    : action.type === 'ENTRY'
                      ? 'Continuar con la recepción'
                      : action.type === 'ADJUSTMENT'
                        ? 'Guardar ajuste'
                        : 'Confirmar movimiento'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy || uncertain}
                onClick={() => setAction(null)}
              >
                Cancelar
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {purchase && (
        <InventoryReceiptDialog
          items={items}
          initialProduct={purchase.productId}
          initialLocation={purchase.location}
          initialQuantity={purchase.quantity}
          initialNote={purchase.note}
          onClose={() => setPurchase(null)}
          onRecorded={(message) => {
            setMessage(message)
            setPurchase(null)
            setAction(null)
            operation.reset()
            onRecorded()
          }}
        />
      )}
    </section>
  )
}

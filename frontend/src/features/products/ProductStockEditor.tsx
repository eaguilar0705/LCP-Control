import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Minus, Plus, Package, ArrowRight, ClipboardCheck } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
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
import { InventoryAdjustmentAccounting } from '../inventory/InventoryAdjustmentAccounting'
import { useInventoryAdjustmentAccounting } from '../inventory/useInventoryAdjustmentAccounting'

type StockAction = MovementRequest['type'] | 'ADD'

const actions: {
  type: StockAction
  label: string
  permission: Capability
}[] = [
  {
    type: 'ADD',
    label: 'Agregar unidades',
    permission: 'inventory.adjust',
  },
  {
    type: 'ADJUSTMENT',
    label: 'Ajustar existencias (conteo físico)',
    permission: 'inventory.adjust',
  },
  {
    type: 'ENTRY',
    label: 'Registrar compra',
    permission: 'inventory.create_entry',
  },
  {
    type: 'EXIT',
    label: 'Descontar unidades',
    permission: 'inventory.create_exit',
  },
]

export function ProductStockEditor({
  product,
  disabled = false,
  purchaseDisabled = false,
  onPurchase,
  onPendingChange,
}: {
  product: Product
  disabled?: boolean
  purchaseDisabled?: boolean
  onPurchase?: (location: InventoryLocation) => void
  onPendingChange?: (pending: boolean) => void
}) {
  const { demo, role, base, storageScope = 'anonymous' } = useAccess()
  const navigation = useLocation()
  const requestedLocation = new URLSearchParams(navigation.search).get(
    'countLocation',
  )
  const countLocation =
    requestedLocation === 'store' || requestedLocation === 'warehouse'
      ? requestedLocation
      : null
  const { inventoryService } = useServices()
  const load = useCallback(
    () => inventoryService.getInventory(true),
    [inventoryService],
  )
  const { data, loading, error: loadError, retry } = useQuery(load)
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
  const [selection, setSelection] = useState<{
    navigationKey: string
    location: InventoryLocation
  }>(() => ({
    navigationKey: navigation.key,
    location: countLocation ?? 'store',
  }))
  const location =
    selection.navigationKey === navigation.key
      ? selection.location
      : (countLocation ?? selection.location)
  const canAdjust = can(role, 'inventory.adjust') || demo
  const defaultAction: StockAction = canAdjust
    ? countLocation || navigation.hash === '#cantidades-perfume'
      ? 'ADJUSTMENT'
      : 'ADD'
    : 'ENTRY'
  const [typeSelection, setTypeSelection] = useState<{
    navigationKey: string
    type: StockAction
  }>(() => ({
    navigationKey: navigation.key,
    type: defaultAction,
  }))
  const type =
    typeSelection.navigationKey === navigation.key
      ? typeSelection.type
      : defaultAction
  const [quantity, setQuantity] = useState('')
  const [note, setNote] = useState(canAdjust ? 'Conteo físico' : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const uncertain = operation.isUncertain()
  useEffect(() => {
    onPendingChange?.(busy || uncertain)
  }, [busy, uncertain, onPendingChange])
  const item = data?.find((i) => i.product.id === product.id)
  const before = item?.quantities[location] ?? null
  const initial = before === null
  const countBlocked = initial && !canAdjust
  const movementType = initial ? 'ADJUSTMENT' : type
  const requiresPurchase = movementType === 'ENTRY' && !!onPurchase
  const manualAdjustment =
    movementType === 'ADJUSTMENT' ||
    movementType === 'ADD' ||
    (movementType === 'EXIT' && canAdjust)
  const action = actions.find((a) => a.type === movementType)!
  const available = actions.filter((a) => can(role, a.permission) || demo)
  const amount = Number(quantity)
  const after =
    movementType === 'ADJUSTMENT'
      ? amount
      : before === null
        ? null
        : before +
          (movementType === 'ENTRY' || movementType === 'ADD'
            ? amount
            : -amount)
  const valid =
    quantity.trim() !== '' &&
    Number.isInteger(amount) &&
    amount >= (movementType === 'ADJUSTMENT' ? 0 : 1) &&
    amount <= 1000000 &&
    after !== null &&
    after >= 0 &&
    after <= 1000000
  const locked = busy || disabled || loading || !item || !item.product.active
  const adjustmentAccounting = useInventoryAdjustmentAccounting(
    `${navigation.key}:${product.id}:${location}:${movementType}:${initial ? 'initial' : 'counted'}`,
    manualAdjustment && !initial,
    before,
    valid ? after : null,
    movementType === 'ADD',
  )

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (locked || demo || !can(role, action.permission)) return
    if (!uncertain && requiresPurchase) {
      if (!purchaseDisabled) onPurchase?.(location)
      return
    }
    if (!uncertain && (!valid || !note.trim() || note.trim().length > 2000)) {
      setError(
        'Revisa la cantidad y escribe el motivo. Las existencias no pueden quedar negativas.',
      )
      return
    }
    if (!uncertain && manualAdjustment && !initial) {
      if (after === before) {
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
    setBusy(true)
    setError('')
    setMessage('')
    try {
      if (uncertain) await operation.retryPending()
      else
        await operation.execute({
          productId: product.id,
          location,
          type:
            movementType === 'ADD'
              ? 'ADJUSTMENT'
              : manualAdjustment
                ? 'ADJUSTMENT'
                : movementType,
          quantity: manualAdjustment ? after! : amount,
          ...(manualAdjustment
            ? {
                expectedQuantity: before,
                ...(!initial
                  ? {
                      adjustmentKind: adjustmentAccounting.kind,
                      ...(adjustmentAccounting.kind === 'correction' &&
                      adjustmentAccounting.requiresCounterAccount
                        ? {
                            counterAccount: adjustmentAccounting.counterAccount,
                          }
                        : {}),
                    }
                  : {}),
              }
            : {}),
          note: note.trim(),
        })
      operation.reset()
      setQuantity('')
      setNote(
        movementType === 'ADJUSTMENT'
          ? 'Conteo físico'
          : movementType === 'ADD'
            ? 'Corrección de existencias'
            : '',
      )
      adjustmentAccounting.reset()
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
        Para ingresar mercadería pendiente de revisión contable, usa{' '}
        <Link to={`${base}/inventory`}>Recibir mercadería en Inventario</Link>.
        No incluyas unidades de recepciones pendientes en el conteo. Al cambiar
        un conteo existente, los aumentos usan automáticamente la cuenta de
        orden de ajustes de inventario; para las deducciones, elige si corriges
        una cantidad o reconoces una pérdida real.
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
              <fieldset disabled={locked || uncertain} className="form-fields">
                <div className="form-grid">
                  <Select
                    label="Ubicación de las cantidades"
                    value={location}
                    onChange={(e) => {
                      setSelection({
                        navigationKey: navigation.key,
                        location: e.target.value as InventoryLocation,
                      })
                      setError('')
                      adjustmentAccounting.reset()
                    }}
                  >
                    <option value="store">Tienda</option>
                    <option value="warehouse">Bodega</option>
                  </Select>
                  {initial ? (
                    <div className="stock-initial-count" role="status">
                      <span>Cómo cambiar las cantidades</span>
                      <div>
                        <ClipboardCheck size={20} aria-hidden="true" />
                        <strong>Registrar conteo inicial</strong>
                      </div>
                      <small>
                        {countBlocked
                          ? 'Solicita a un SuperAdmin que registre el conteo inicial de esta ubicación.'
                          : `Indica cuántas unidades hay físicamente en ${labels.location[location]}.`}
                      </small>
                    </div>
                  ) : (
                    <Select
                      label="Cómo cambiar las cantidades"
                      value={movementType}
                      onChange={(e) => {
                        const nextType = e.target.value as StockAction
                        if (
                          !note ||
                          note === 'Conteo físico' ||
                          note === 'Corrección de existencias'
                        )
                          setNote(
                            nextType === 'ADJUSTMENT'
                              ? 'Conteo físico'
                              : nextType === 'ADD'
                                ? 'Corrección de existencias'
                                : '',
                          )
                        setTypeSelection({
                          navigationKey: navigation.key,
                          type: nextType,
                        })
                        setQuantity('')
                        setError('')
                        adjustmentAccounting.reset()
                      }}
                    >
                      {available.map((a) => (
                        <option key={a.type} value={a.type}>
                          {a.type === 'EXIT' && !canAdjust
                            ? 'Descontar unidades (pérdida real)'
                            : a.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </div>

                {!requiresPurchase && !countBlocked && (
                  <>
                    {movementType === 'ADJUSTMENT' && (
                      <p className="muted">
                        Escribe el total contado, no la diferencia.
                      </p>
                    )}
                    {movementType === 'ADD' && (
                      <p className="muted">
                        Escribe solo las unidades que vas a agregar. Si hay 2 y
                        agregas 1, el total será 3. Para unidades compradas, usa
                        Registrar compra.
                      </p>
                    )}
                    {movementType === 'EXIT' && (
                      <p className="muted">
                        {canAdjust
                          ? 'Escribe las unidades a descontar y elige la contrapartida. Para corregir sin pérdida, usa tu cuenta de orden.'
                          : 'Esta salida se registra como pérdida real de inventario. Para corregir cantidades sin pérdida, solicita el ajuste a un Superadmin.'}
                      </p>
                    )}
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
                              : movementType === 'ADD'
                                ? 'Unidades a agregar'
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
                          disabled={
                            !Number.isInteger(amount) || amount >= 1000000
                          }
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
                    {manualAdjustment && !initial && canAdjust && (
                      <InventoryAdjustmentAccounting
                        accounting={adjustmentAccounting}
                        productId={product.id}
                        before={before}
                        after={valid ? after : null}
                      />
                    )}
                    <Input
                      label="Motivo del cambio de cantidad"
                      required
                      maxLength={2000}
                      placeholder="Conteo físico, corrección de existencias…"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </>
                )}
              </fieldset>
              {error && (
                <p role="alert" className="inline-error">
                  {error}
                </p>
              )}
              {!countBlocked && (
                <div className="form-actions">
                  {error && !uncertain && (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={locked}
                      onClick={() => {
                        setError('')
                        retry()
                      }}
                    >
                      Actualizar existencias
                    </Button>
                  )}
                  {requiresPurchase ? (
                    <Button
                      type="button"
                      disabled={locked || demo || purchaseDisabled}
                      title={
                        purchaseDisabled
                          ? 'Guarda los datos del perfume antes de registrar una compra.'
                          : undefined
                      }
                      onClick={() => onPurchase?.(location)}
                    >
                      Registrar compra
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      disabled={locked || demo || !can(role, action.permission)}
                    >
                      {busy
                        ? 'Guardando cantidades…'
                        : uncertain
                          ? 'Verificar guardado'
                          : movementType === 'ADJUSTMENT'
                            ? 'Guardar ajuste'
                            : 'Guardar cantidades'}
                    </Button>
                  )}
                </div>
              )}
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

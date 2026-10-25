import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button,
  ConfirmDialog,
  Dialog,
  ErrorState,
  LoadingState,
} from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { can } from '../../lib/permissions'
import { useQuery } from '../../lib/useQuery'
import { useServices } from '../../services/useServices'
import { OpeningCostDialog, PurchaseDialog } from '../pricing/CostPanel'
import {
  labels,
  type InventoryLocation,
  type MovementRequest,
} from '../../lib/domain'
import { createIdempotentOperation } from '../../lib/idempotentOperation'
import { errorMessage } from '../../lib/errors'
import './product-cost-dialog.css'

export function ProductCostDialog({
  productId,
  initialLocation,
  purchase,
  onClose,
  onRecorded,
}: {
  productId: string
  initialLocation?: InventoryLocation
  purchase?: { quantity: number; note: string }
  onClose: () => void
  onRecorded: (message: string) => void
}) {
  const { demo, role } = useAccess()
  if (demo || !can(role, 'product.edit_cost')) return null
  return (
    <CostLoader
      productId={productId}
      initialLocation={initialLocation}
      purchase={purchase}
      onClose={onClose}
      onRecorded={onRecorded}
    />
  )
}

function CostLoader({
  productId,
  initialLocation,
  purchase,
  onClose,
  onRecorded,
}: {
  productId: string
  initialLocation?: InventoryLocation
  purchase?: { quantity: number; note: string }
  onClose: () => void
  onRecorded: (message: string) => void
}) {
  const { base, storageScope = 'anonymous' } = useAccess()
  const navigate = useNavigate()
  const { inventoryService, productService, settingsService } = useServices()
  const [operation] = useState(() =>
    createIdempotentOperation<
      Omit<MovementRequest, 'requestId'> & { expectedQuantity: null },
      string
    >(inventoryService.recordMovement, {
      scope: storageScope,
      key: 'inventory-movement',
      label: 'Conteo de ubicación vacía',
    }),
  )
  const [confirmLocation, setConfirmLocation] =
    useState<InventoryLocation | null>(null)
  const [pendingLocation, setPendingLocation] =
    useState<InventoryLocation | null>(null)
  const [countRecorded, setCountRecorded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const uncertain = operation.isUncertain()
  const locked = busy || uncertain
  const load = useCallback(async () => {
    const [inventory, pricing, cost, rate] = await Promise.all([
      inventoryService.getInventory(true),
      productService.listPricing(productId),
      productService.getProductCost(productId),
      settingsService.getExchangeRate(),
    ])
    return {
      item: inventory.find((item) => item.product.id === productId),
      pricing,
      cost,
      rate: rate?.usdToNio ?? null,
    }
  }, [inventoryService, productService, settingsService, productId])
  const { data, loading, error, retry } = useQuery(load)
  const item = data?.item
  const counted =
    item && item.quantities.store !== null && item.quantities.warehouse !== null

  function close() {
    if (busy || operation.isUncertain()) return
    if (countRecorded) onRecorded('Existencias actualizadas.')
    else onClose()
  }

  function openCountEditor() {
    if (locked) return
    const missing = (['store', 'warehouse'] as const).find(
      (location) => item?.quantities[location] === null,
    )
    const location =
      initialLocation && item?.quantities[initialLocation] === null
        ? initialLocation
        : (missing ?? initialLocation ?? 'store')
    close()
    navigate(
      `${base}/products/${productId}/edit?countLocation=${location}#cantidades-perfume`,
    )
  }

  async function registerEmpty(location: InventoryLocation | null) {
    if (busy) return
    const target = location ?? pendingLocation
    if (!target) return
    if (!uncertain && item?.quantities[target] !== null) {
      setFailure('Las existencias cambiaron. Actualiza el inventario.')
      return
    }
    setPendingLocation(target)
    setBusy(true)
    setFailure('')
    try {
      if (uncertain) await operation.retryPending()
      else
        await operation.execute({
          productId,
          location: target,
          type: 'ADJUSTMENT',
          quantity: 0,
          expectedQuantity: null,
          note: `${labels.location[target]} verificada sin unidades al registrar el costo o la compra del perfume.`,
        })
      operation.reset()
      setPendingLocation(null)
      setCountRecorded(true)
      retry()
    } catch (error) {
      setFailure(errorMessage(error))
      if (!operation.isUncertain()) setPendingLocation(null)
    } finally {
      setBusy(false)
    }
  }

  if (loading || error || !item || !item.product.active || !counted) {
    return (
      <>
        <Dialog
          open
          title="Agregar costo"
          className="product-cost-count-dialog"
          dismissible={!locked}
          onClose={close}
        >
          {loading ? (
            <LoadingState />
          ) : error ? (
            <ErrorState message={error} retry={locked ? undefined : retry} />
          ) : !item ? (
            <p>No se encontró este perfume en el inventario.</p>
          ) : !item.product.active ? (
            <p>Reactiva y guarda el perfume antes de registrar su costo.</p>
          ) : (
            <div className="product-cost-count-content">
              <p>Si está vacía, registra 0 para continuar.</p>
              <div className="product-cost-location-list">
                {(['store', 'warehouse'] as const).map((location) => {
                  const quantity = item.quantities[location]
                  return (
                    <div className="product-cost-location" key={location}>
                      <div>
                        <span>{labels.location[location]}</span>
                        <strong>
                          {quantity === null
                            ? 'Sin conteo'
                            : `${quantity} ${quantity === 1 ? 'unidad' : 'unidades'}`}
                        </strong>
                      </div>
                      {quantity === null && (
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={locked}
                          onClick={() => {
                            setFailure('')
                            setConfirmLocation(location)
                          }}
                        >
                          Registrar {labels.location[location]} en 0
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
              {failure && (
                <p className="inline-error" role="alert">
                  {failure}
                </p>
              )}
              {busy && <p role="status">Guardando conteo…</p>}
              <div className="form-actions">
                {uncertain && !busy ? (
                  <Button
                    type="button"
                    onClick={() => void registerEmpty(null)}
                  >
                    Verificar guardado
                  </Button>
                ) : (
                  <Button
                    type="button"
                    disabled={locked}
                    onClick={openCountEditor}
                  >
                    Registrar conteo
                  </Button>
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
                    Actualizar existencias
                  </Button>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  disabled={locked}
                  onClick={close}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          )}
        </Dialog>
        {confirmLocation && (
          <ConfirmDialog
            open
            title="Confirmar ubicación vacía"
            confirmLabel="Registrar en 0"
            onCancel={() => setConfirmLocation(null)}
            onConfirm={() => {
              const location = confirmLocation
              setConfirmLocation(null)
              void registerEmpty(location)
            }}
          >
            <p>
              Confirma que no hay unidades de «{item?.product.name}» en{' '}
              {labels.location[confirmLocation]}. Se guardará el conteo en 0 en
              el historial; el costo o la compra se registran después.
            </p>
          </ConfirmDialog>
        )}
      </>
    )
  }
  if (
    data.cost === null &&
    (item.quantities.store ?? 0) + (item.quantities.warehouse ?? 0) > 0
  ) {
    return (
      <OpeningCostDialog
        item={item}
        pricing={data.pricing.rows.find((row) => row.productId === productId)}
        catalogRate={data.rate}
        notice={
          purchase
            ? `Registra primero el costo de las unidades que ya tienes. Después continuarás con la entrada de ${purchase.quantity} unidades.`
            : undefined
        }
        onClose={close}
        onRecorded={purchase ? () => retry() : onRecorded}
      />
    )
  }
  return (
    <PurchaseDialog
      inventory={[item]}
      pricing={data.pricing.rows}
      catalogRate={data.rate}
      initialProduct={productId}
      initialLocation={initialLocation}
      initialQuantity={purchase?.quantity}
      initialNote={purchase?.note}
      onClose={close}
      onRecorded={onRecorded}
    />
  )
}

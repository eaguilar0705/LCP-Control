import { useCallback } from 'react'
import { Button, Dialog, ErrorState, LoadingState } from '../../components/ui'
import { useAccess } from '../../app/AccessContext'
import { can } from '../../lib/permissions'
import { useQuery } from '../../lib/useQuery'
import { useServices } from '../../services/useServices'
import { OpeningCostDialog, PurchaseDialog } from '../pricing/CostPanel'

export function ProductCostDialog({
  productId,
  onClose,
  onRecorded,
}: {
  productId: string
  onClose: () => void
  onRecorded: (message: string) => void
}) {
  const { demo, role } = useAccess()
  if (demo || !can(role, 'product.edit_cost')) return null
  return (
    <CostLoader
      productId={productId}
      onClose={onClose}
      onRecorded={onRecorded}
    />
  )
}

function CostLoader({
  productId,
  onClose,
  onRecorded,
}: {
  productId: string
  onClose: () => void
  onRecorded: (message: string) => void
}) {
  const { inventoryService, productService, settingsService } = useServices()
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
  if (loading || error || !item || !item.product.active || !counted) {
    return (
      <Dialog open title="Agregar costo" onClose={onClose}>
        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState message={error} retry={retry} />
        ) : !item ? (
          <p>No se encontró este perfume en el inventario.</p>
        ) : !item.product.active ? (
          <p>Reactiva y guarda el perfume antes de registrar su costo.</p>
        ) : (
          <>
            <p>Falta el conteo de Tienda o Bodega.</p>

            <Button
              type="button"
              onClick={() => {
                onClose()
                requestAnimationFrame(() => {
                  const section = document.getElementById('cantidades-perfume')
                  section?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start',
                  })
                  section?.focus()
                })
              }}
            >
              Registrar conteo
            </Button>
          </>
        )}
      </Dialog>
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
        onClose={onClose}
        onRecorded={onRecorded}
      />
    )
  }
  return (
    <PurchaseDialog
      inventory={[item]}
      pricing={data.pricing.rows}
      catalogRate={data.rate}
      initialProduct={productId}
      onClose={onClose}
      onRecorded={onRecorded}
    />
  )
}

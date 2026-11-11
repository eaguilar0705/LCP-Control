import { useCallback } from 'react'
import { Button, Input } from '../../components/ui'
import { useQuery } from '../../lib/useQuery'
import { useServices } from '../../services/useServices'
import { formatCurrency } from '../../lib/format'
import { inventoryAdjustmentValue } from './inventoryAdjustmentValue'
import './inventory-adjustment-preview.css'

export function InventoryAdjustmentPreview({
  productId,
  before,
  after,
  inventoryAccount,
}: {
  productId: string
  before: number | null
  after: number | null
  inventoryAccount?: { code: string; displayCode?: string; name: string }
}) {
  const { productService } = useServices()
  const load = useCallback(
    async () => ({
      productId,
      cost: await productService.getProductCost(productId),
    }),
    [productId, productService],
  )
  const query = useQuery(load)
  const current = query.data?.productId === productId ? query.data : null
  const preview = inventoryAdjustmentValue(before, after, current?.cost ?? null)
  const unitCost = current?.cost ?? null
  return (
    <div className="inventory-adjustment-preview">
      <Input
        label="Cuenta de inventario (automática)"
        readOnly
        value={`${inventoryAccount?.displayCode ?? inventoryAccount?.code ?? '1130'} · ${inventoryAccount?.name ?? 'Inventario de perfumes'}`}
      />
      <p className="muted">
        Esta cuenta aumenta al agregar unidades y disminuye al descontarlas. En
        contrapartida elige la otra cuenta del asiento.
      </p>
      {query.error ? (
        <div>
          <p role="alert" className="inline-error">
            No pudimos consultar el costo para mostrar el valor del cambio.
          </p>
          <Button type="button" variant="secondary" onClick={query.retry}>
            Actualizar costo
          </Button>
        </div>
      ) : !current ? (
        <p role="status">Consultando el costo del perfume…</p>
      ) : unitCost === null || !Number.isFinite(unitCost) || unitCost < 0 ? (
        <p role="status">
          Costo por confirmar. Completa Costo de inventario antes de ajustar las
          cantidades.
        </p>
      ) : preview && preview.units !== 0 ? (
        <div className="inventory-adjustment-value" role="status">
          <p>
            <strong>
              {preview.units > 0 ? 'Se agregan' : 'Se descuentan'}{' '}
              {Math.abs(preview.units)}{' '}
              {Math.abs(preview.units) === 1 ? 'unidad' : 'unidades'}
            </strong>{' '}
            · Total: {before} → {after}
          </p>
          <p>
            Costo por unidad: <strong>{formatCurrency(unitCost, 'NIO')}</strong>
          </p>
          <p>
            Valor estimado que {preview.units > 0 ? 'aumenta' : 'disminuye'}{' '}
            Inventario:{' '}
            <strong>{formatCurrency(preview.amountNio, 'NIO')}</strong>
          </p>
          <small>
            Se valora solo la diferencia de unidades. El importe definitivo usa
            el costo al guardar.
          </small>
        </div>
      ) : (
        <p className="muted">
          Indica las unidades para revisar el valor del cambio.
        </p>
      )}
    </div>
  )
}

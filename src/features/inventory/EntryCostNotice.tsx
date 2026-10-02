import { useAccess } from '../../app/AccessContext'
import { can } from '../../lib/permissions'

/**
 * Una entrada manual no trae costo. Si el perfume ya tiene costo promedio, la
 * base la rechaza: esas unidades dejarían sin valor el promedio. La mercadería
 * con costo se registra como compra, que actualiza existencias y costo en una
 * sola operación, desde «Costo de inventario» en la ficha del perfume.
 */
export function EntryCostNotice() {
  const { role } = useAccess()
  return (
    <p className="stock-help entry-cost-notice">
      Si el perfume ya tiene costo, regístralo como compra.{' '}
      {can(role, 'product.edit_cost')
        ? 'Hazlo en Editar perfume → Costo de inventario.'
        : 'Pídele a Administración que la registre.'}
    </p>
  )
}

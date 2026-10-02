import { Link, useInRouterContext } from 'react-router-dom'
import { useAccess } from '../../app/AccessContext'
import { can } from '../../lib/permissions'

/**
 * Una entrada manual no trae costo. Si el perfume ya tiene costo promedio, la
 * base la rechaza: esas unidades dejarían sin valor el promedio. La mercadería
 * con costo se registra como compra, que actualiza existencias y costo en una
 * sola operación.
 */
export function EntryCostNotice() {
  const { role, base } = useAccess()
  const owner = can(role, 'product.edit_cost')
  // Fuera de un enrutador (una prueba aislada del formulario) basta el texto.
  const routed = useInRouterContext()
  return (
    <p className="stock-help entry-cost-notice">
      Si el perfume ya tiene costo, regístralo como compra.{' '}
      {owner && routed ? (
        <Link className="text-link" to={`${base}/prices?apartado=costo`}>
          Registrar compra
        </Link>
      ) : owner ? (
        'Regístrala en Precios → Costo de inventario.'
      ) : (
        'Pídele a Administración que la registre.'
      )}
    </p>
  )
}

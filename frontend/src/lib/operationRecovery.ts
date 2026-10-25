import { AppError } from './errors'

export const operationLabels = {
  invoice: 'Factura',
  proforma: 'Proforma',
  'sales-return': 'Devolución',
  purchase: 'Compra',
  'purchase-correction': 'Corrección de compra',
  'finance-entry': 'Cobro o pago',
  expense: 'Gasto',
  'inventory-movement': 'Movimiento de inventario',
  'inventory-transfer': 'Traslado',
  'price-tier-create': 'Lista de precios',
  'price-list-prices': 'Precios',
  journal: 'Comprobante',
  'opening-cost': 'Costo inicial',
  'business-import': 'Importación',
  'inventory-valuation': 'Conciliación de inventario',
  'business-day-open': 'Apertura',
  'business-day-close': 'Cierre',
  'business-day-reopen': 'Reapertura',
} as const
export type OperationKind = keyof typeof operationLabels
export interface OperationReference {
  scope: string
  kind: OperationKind
  requestId: string
}
const storageKey = 'lcp:pending-operation-ids:v1'
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
let references: OperationReference[] = []
let loaded = false
let revision = 0
const listeners = new Set<() => void>()
export const operationReferencesRevision = () => revision
function notify() {
  revision++
  listeners.forEach((listener) => listener())
}
export function isOperationKind(kind: string): kind is OperationKind {
  return Object.hasOwn(operationLabels, kind)
}
function valid(reference: unknown): reference is OperationReference {
  if (!reference || typeof reference !== 'object') return false
  const r = reference as OperationReference
  return (
    typeof r.scope === 'string' &&
    r.scope.startsWith('user:') &&
    uuid.test(r.scope.slice(5)) &&
    typeof r.kind === 'string' &&
    isOperationKind(r.kind) &&
    typeof r.requestId === 'string' &&
    uuid.test(r.requestId)
  )
}
function read() {
  if (loaded) return
  loaded = true
  if (typeof window === 'undefined') return
  try {
    const content = localStorage.getItem(storageKey)
    const saved: unknown =
      content && content.length <= 200000 ? JSON.parse(content) : []
    references = Array.isArray(saved)
      ? saved
          .filter(valid)
          .map(({ scope, kind, requestId }) => ({ scope, kind, requestId }))
      : []
  } catch {
    /* No se leen credenciales ni formularios desde el almacenamiento. */
  }
}
function persist(next: OperationReference[]) {
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      throw new AppError(
        'configuration',
        'No pudimos conservar el identificador de la operación. Habilita el almacenamiento del navegador antes de guardar.',
      )
    }
  }
  references = next
  notify()
}
export function subscribeOperationReferences(listener: () => void) {
  read()
  listeners.add(listener)
  const changed = (event: StorageEvent) => {
    if (event.key !== storageKey) return
    loaded = false
    read()
    notify()
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', changed)
  return () => {
    listeners.delete(listener)
    if (typeof window !== 'undefined')
      window.removeEventListener('storage', changed)
  }
}
export function getOperationReferences(scope: string) {
  read()
  return references.filter((r) => r.scope === scope)
}
export function rememberOperationReference(
  scope: string,
  kind: OperationKind,
  requestId: string,
) {
  const reference = { scope, kind, requestId }
  if (!valid(reference)) return
  read()
  if (
    references.some(
      (r) => r.scope === scope && r.kind === kind && r.requestId === requestId,
    )
  )
    return
  persist([...references, reference])
}
export function forgetOperationReference(
  scope: string,
  kind: OperationKind,
  requestId: string,
) {
  read()
  const next = references.filter(
    (r) => r.scope !== scope || r.kind !== kind || r.requestId !== requestId,
  )
  if (next.length === references.length) return
  // Si el navegador deja de permitir escrituras, el identificador sigue visible
  // para verificarlo después; nunca convertir un éxito real en otra operación.
  try {
    persist(next)
  } catch {
    /* Se conserva la referencia pendiente. */
  }
}

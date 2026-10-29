import { useAccess } from '../../app/AccessContext'
import { can } from '../../lib/permissions'
import type { FinanceLedger } from './finance'

/** Sólo Administración escribe, y nunca en la vista local ni sin la actualización. */
export function useWritable(ledger: FinanceLedger) {
  const { demo, role } = useAccess()
  return !demo && can(role, 'finance.read') && ledger.available
}
export function useCanVoid() {
  const { demo, role } = useAccess()
  return !demo && can(role, 'operation.void')
}

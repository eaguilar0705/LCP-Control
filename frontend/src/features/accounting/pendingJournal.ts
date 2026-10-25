import type { JournalLine } from './journalModel'

export interface JournalSubmission {
  occurredOn: string
  kind:
    | 'opening'
    | 'income'
    | 'expense'
    | 'deposit'
    | 'transfer'
    | 'card_settlement'
    | 'adjustment'
  description: string
  reference: string
  currency: 'NIO' | 'USD'
  exchangeRate: number
  lines: JournalLine[]
  gross?: number
  commissionRate?: number
  withholdingRate?: number
  withholdingBase?: 'gross' | 'net_commission'
  bankAccount?: string
  requestId: string
}

// No se persisten importes en el navegador. La solicitud original sobrevive
// a la navegación de la pestaña hasta recibir una respuesta definitiva.
const pending = new Map<string, JournalSubmission>()
const listeners = new Set<() => void>()
let revision = 0

export const pendingJournalRevision = () => revision
export function subscribePendingJournal(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const getPendingJournal = (scope: string) => pending.get(scope) ?? null
export function setPendingJournal(
  scope: string,
  input: JournalSubmission | null,
) {
  if (input) pending.set(scope, structuredClone(input))
  else pending.delete(scope)
  revision++
  listeners.forEach((listener) => listener())
}

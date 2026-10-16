import { createIdempotentOperation } from '../../lib/idempotentOperation'
import type {
  DocumentKind,
  DocumentRecord,
  NewDocument,
} from '../../lib/domain'
import type { DocumentDraft } from './document'

type DocumentOperation = ReturnType<
  typeof createIdempotentOperation<
    Omit<NewDocument, 'requestId'>,
    DocumentRecord
  >
>
export interface PendingDocument {
  kind: DocumentKind
  operation: DocumentOperation
  payload: Omit<NewDocument, 'requestId'>
  draft: DocumentDraft
  requestIdSeed?: string
  status: 'sending' | 'uncertain' | 'confirmed'
}

// Sólo memoria del proceso de esta pestaña: permite volver con Atrás/Adelante
// sin perder el requestId. Cada usuario tiene su propio espacio; nada se escribe
// en localStorage, sessionStorage ni en el historial del navegador.
const pending = new Map<string, Map<DocumentKind, PendingDocument>>()
const listeners = new Set<() => void>()
let revision = 0

function notify() {
  revision += 1
  listeners.forEach((listener) => listener())
}
export const subscribePendingDocuments = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const pendingDocumentsRevision = () => revision
export const pendingDocuments = (scope: string) => [
  ...(pending.get(scope)?.values() ?? []),
]
export const pendingDocument = (scope: string, kind: DocumentKind) =>
  pending.get(scope)?.get(kind)

export function rememberDocument(scope: string, attempt: PendingDocument) {
  const scoped = pending.get(scope) ?? new Map<DocumentKind, PendingDocument>()
  scoped.set(attempt.kind, attempt)
  pending.set(scope, scoped)
  notify()
}
export function documentAttemptStatus(
  scope: string,
  kind: DocumentKind,
  operation: DocumentOperation,
  status: PendingDocument['status'],
) {
  const attempt = pendingDocument(scope, kind)
  if (!attempt || attempt.operation !== operation) return
  rememberDocument(scope, { ...attempt, status })
}
export function forgetDocument(
  scope: string,
  kind: DocumentKind,
  operation: DocumentOperation,
) {
  const scoped = pending.get(scope)
  if (scoped?.get(kind)?.operation !== operation) return
  scoped.delete(kind)
  if (!scoped.size) pending.delete(scope)
  notify()
}

import { AppError } from './errors'

const pendingMessage =
  'Hay un guardado pendiente de confirmar. Reintenta con los datos originales antes de cambiarlos.'
const confirmationMessage =
  'No pudimos confirmar el guardado. Reintenta con los mismos datos para verificarlo sin duplicarlo.'

export interface PendingOperationOptions {
  scope: string
  key: string
  label: string
}
interface PendingOperation {
  key: string
  label: string
  operation: { retryPending(): Promise<unknown> }
}
const pending = new Map<string, Map<string, PendingOperation>>()
const listeners = new Set<() => void>()
let revision = 0

export const pendingOperationsRevision = () => revision
export function subscribePendingOperations(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function listPendingOperations(scope: string): PendingOperation[] {
  return [...(pending.get(scope)?.values() ?? [])].map((entry) => ({
    key: entry.key,
    label: entry.label,
    // Solo se expone la confirmación; los datos y las credenciales no salen
    // del cierre original ni se comparten con otro usuario del navegador.
    operation: { retryPending: () => entry.operation.retryPending() },
  }))
}
function notifyPendingOperations() {
  revision++
  listeners.forEach((listener) => listener())
}

// Una respuesta perdida no autoriza otra compra, cobro o movimiento. Hasta
// confirmar el resultado se conserva la solicitud original, también al resetear.
export function createIdempotentOperation<T extends object, R>(
  send: (input: T & { requestId: string }) => Promise<R>,
  options?: PendingOperationOptions,
) {
  let current:
    | {
        signature: string
        requestId: string
        payload: T
        status: 'sending' | 'ambiguous' | 'confirmed' | 'rejected'
        promise?: Promise<R>
      }
    | undefined
  const operation: {
    reset(): void
    isUncertain(): boolean
    retryPending(): Promise<R>
    execute(payload: T, configuredRequestId?: string): Promise<R>
  } = {
    reset() {
      if (current && ['sending', 'ambiguous'].includes(current.status)) return
      current = undefined
    },
    isUncertain() {
      return (
        current !== undefined &&
        ['sending', 'ambiguous'].includes(current.status)
      )
    },
    retryPending() {
      if (!current || !['sending', 'ambiguous'].includes(current.status))
        return Promise.reject(
          new AppError(
            'validation',
            'No hay un guardado pendiente de confirmar.',
          ),
        )
      return operation.execute(
        structuredClone(current.payload),
        current.requestId,
      )
    },
    execute(payload: T, configuredRequestId?: string): Promise<R> {
      if (
        options &&
        pending.get(options.scope)?.get(options.key)?.operation &&
        pending.get(options.scope)?.get(options.key)?.operation !== operation
      )
        return Promise.reject(new AppError('validation', pendingMessage))
      const signature = JSON.stringify(payload)
      const changed =
        current &&
        (current.signature !== signature ||
          (configuredRequestId && current.requestId !== configuredRequestId))
      if (
        current &&
        changed &&
        ['sending', 'ambiguous'].includes(current.status)
      )
        return Promise.reject(new AppError('validation', pendingMessage))
      if (!current || changed)
        current = {
          signature,
          requestId: configuredRequestId ?? crypto.randomUUID(),
          payload: structuredClone(payload),
          status: 'rejected',
        }
      const attempt = current
      if (!attempt.promise) {
        const recovering = attempt.status === 'ambiguous'
        attempt.status = 'sending'
        const clearPending = () => {
          if (
            options &&
            pending.get(options.scope)?.get(options.key)?.operation ===
              operation
          ) {
            const entries = pending.get(options.scope)!
            entries.delete(options.key)
            if (!entries.size) pending.delete(options.scope)
            notifyPendingOperations()
          }
        }
        attempt.promise = Promise.resolve()
          .then(() =>
            send({
              ...structuredClone(attempt.payload),
              requestId: attempt.requestId,
            }),
          )
          .then((result) => {
            attempt.status = 'confirmed'
            clearPending()
            return result
          })
          .catch((error: unknown) => {
            attempt.promise = undefined
            const definitive =
              error instanceof AppError &&
              (error.kind === 'validation' ||
                (!recovering &&
                  ['unauthorized', 'rate_limited', 'configuration'].includes(
                    error.kind,
                  )))
            attempt.status = definitive ? 'rejected' : 'ambiguous'
            if (definitive) {
              clearPending()
              throw error
            }
            throw new AppError('network', confirmationMessage)
          })
        if (options && !pending.get(options.scope)?.has(options.key)) {
          const entries = pending.get(options.scope) ?? new Map()
          entries.set(options.key, {
            key: options.key,
            label: options.label,
            operation,
          })
          pending.set(options.scope, entries)
          notifyPendingOperations()
        }
      }
      return attempt.promise
    },
  }
  return operation
}

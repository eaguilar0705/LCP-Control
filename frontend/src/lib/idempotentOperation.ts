// Conserva el ID ante una respuesta perdida y comparte la promesa entre clics.
// Sin un ID fijo, cambiar los datos o reiniciar crea una operación nueva. El
// UUID de un borrador guardado permite reconocerlo incluso al recargar.
export function createIdempotentOperation<T extends object, R>(
  send: (input: T & { requestId: string }) => Promise<R>,
) {
  let current:
    | {
        signature: string
        requestId: string
        promise?: Promise<R>
      }
    | undefined
  return {
    reset() {
      current = undefined
    },
    execute(payload: T, configuredRequestId?: string): Promise<R> {
      const signature = JSON.stringify(payload)
      if (
        !current ||
        current.signature !== signature ||
        (configuredRequestId && current.requestId !== configuredRequestId)
      )
        current = {
          signature,
          requestId: configuredRequestId ?? crypto.randomUUID(),
        }
      const attempt = current
      if (!attempt.promise) {
        attempt.promise = Promise.resolve()
          .then(() => send({ ...payload, requestId: attempt.requestId }))
          .catch((error: unknown) => {
            attempt.promise = undefined
            throw error
          })
      }
      return attempt.promise
    },
  }
}

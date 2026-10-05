// Keep the operation ID when a response is lost. Concurrent clicks share one
// promise; changing the payload or explicitly starting over creates a new ID.
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
    execute(payload: T): Promise<R> {
      const signature = JSON.stringify(payload)
      if (!current || current.signature !== signature)
        current = { signature, requestId: crypto.randomUUID() }
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

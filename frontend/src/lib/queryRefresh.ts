const listeners = new Set<() => void>()
let revision = 0

export const queryRevision = () => revision
export function subscribeQueryRefresh(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A recovered server write can finish after the visible data was loaded. */
export function refreshQueries() {
  revision++
  listeners.forEach((listener) => listener())
}

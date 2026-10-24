const grants = new Map<string, { url: string; expires: number }>()
let generation = 0
let userId: string | null = null
const clearListeners = new Set<() => void>()

/** Sólo memoria; una firma pendiente no puede repoblar una sesión terminada. */
export const privateImageCache = {
  get(path: string) {
    return grants.get(path)
  },
  get generation() {
    return generation
  },
  set(path: string, grant: { url: string; expires: number }, expected: number) {
    if (expected === generation) grants.set(path, grant)
  },
  clear() {
    grants.clear()
    generation++
    for (const listener of clearListeners) listener()
  },
  onClear(listener: () => void) {
    clearListeners.add(listener)
    return () => {
      clearListeners.delete(listener)
    }
  },
  setSession(nextUserId: string | null) {
    if (nextUserId !== userId) {
      this.clear()
      userId = nextUserId
    }
  },
}

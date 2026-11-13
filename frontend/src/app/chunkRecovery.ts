const reloadKey = 'lcp:chunk-reload'

export function isChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : ''
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(
    message,
  )
}

export function recoverChunkLoad(error: unknown): boolean {
  if (!isChunkLoadError(error) || !window.navigator.onLine) return false
  try {
    // La URL compilada identifica esta versión. El marcador sobrevive a la
    // recarga, pero sólo en esta pestaña: un archivo ausente no causa un bucle.
    if (window.sessionStorage.getItem(reloadKey) === import.meta.url)
      return false
    window.sessionStorage.setItem(reloadKey, import.meta.url)
  } catch {
    // Sin almacenamiento no podemos limitar las recargas; queda el botón.
    return false
  }
  window.location.reload()
  return true
}

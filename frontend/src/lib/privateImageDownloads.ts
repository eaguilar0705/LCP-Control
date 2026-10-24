import { noStoreFetch } from './supabase'
import { privateImageCache } from './privateImageCache'

interface Download {
  controller: AbortController
  result: Promise<string>
  references: number
  url: string | null
  bytes: number
  retired: boolean
}

interface Limits {
  maxBytes?: number
  maxEntries?: number
  retryDelayMs?: number
}

/** Fotos compartidas sólo en memoria. Nunca guarda firmas ni archivos en disco. */
export class PrivateImageDownloads {
  private readonly entries = new Map<string, Download>()
  private readonly live = new Set<Download>()
  private bytes = 0
  private readonly maxBytes: number
  private readonly maxEntries: number
  private readonly retryDelayMs: number

  constructor(
    private readonly fetchImage: typeof fetch,
    limits: Limits = {},
  ) {
    this.maxBytes = limits.maxBytes ?? 24 * 1024 * 1024
    this.maxEntries = limits.maxEntries ?? 256
    this.retryDelayMs = limits.retryDelayMs ?? 300
  }

  acquire(source: string) {
    let entry = this.entries.get(source)
    if (!entry) {
      entry = {
        controller: new AbortController(),
        result: Promise.resolve(''),
        references: 0,
        url: null,
        bytes: 0,
        retired: false,
      }
      this.entries.set(source, entry)
      this.live.add(entry)
      entry.result = this.download(source, entry)
    }
    const current = entry
    current.references++
    // El orden del mapa conserva primero las fotos que hace más tiempo no se usan.
    this.entries.delete(source)
    this.entries.set(source, current)
    this.prune()
    let released = false
    return {
      result: current.result,
      release: () => {
        if (released) return
        released = true
        current.references--
        if (current.retired) {
          this.revoke(current)
          if (current.references === 0) this.live.delete(current)
        }
        this.prune()
      },
      invalidate: () => this.remove(source, current),
    }
  }

  clear() {
    this.entries.clear()
    for (const entry of this.live) {
      entry.retired = true
      entry.controller.abort()
      // Al terminar la sesión se revocan también las fotos aún montadas.
      this.revoke(entry, true)
    }
    this.live.clear()
  }

  private async download(source: string, entry: Download) {
    const signal = entry.controller.signal
    try {
      const response = await this.request(source, signal)
      const blob = await response.blob()
      // Una respuesta anterior al cierre de sesión no puede repoblar la caché.
      if (signal.aborted || this.entries.get(source) !== entry)
        throw new DOMException('Descarga cancelada', 'AbortError')
      if (!blob.size) throw new Error('Foto vacía')
      const url = URL.createObjectURL(blob)
      entry.url = url
      entry.bytes = blob.size
      this.bytes += blob.size
      this.prune()
      return url
    } catch (error) {
      this.remove(source, entry)
      throw error
    }
  }

  private async request(source: string, signal: AbortSignal) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response
      try {
        response = await this.fetchImage(source, {
          signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
        })
      } catch (error) {
        if (signal.aborted || attempt > 0) throw error
        await this.pause(signal)
        continue
      }
      if (response.ok) return response
      if (
        attempt === 0 &&
        (response.status === 408 ||
          response.status === 429 ||
          response.status >= 500)
      ) {
        await this.pause(signal)
        continue
      }
      throw new Error('Foto no disponible')
    }
    throw new Error('Foto no disponible')
  }

  private pause(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Descarga cancelada', 'AbortError'))
        return
      }
      const abort = () => {
        clearTimeout(timer)
        reject(new DOMException('Descarga cancelada', 'AbortError'))
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      }, this.retryDelayMs)
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  private revoke(entry: Download, force = false) {
    if (!entry.url || (!force && entry.references > 0)) return
    URL.revokeObjectURL(entry.url)
    this.bytes -= entry.bytes
    entry.url = null
    entry.bytes = 0
  }

  private remove(source: string, entry: Download) {
    if (this.entries.get(source) === entry) this.entries.delete(source)
    entry.retired = true
    entry.controller.abort()
    this.revoke(entry)
    if (entry.references === 0) this.live.delete(entry)
  }

  private prune() {
    for (const [source, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes)
        break
      // No se revoca una foto que otro componente todavía está mostrando.
      if (entry.references === 0) this.remove(source, entry)
    }
  }
}

export const privateImageDownloads = new PrivateImageDownloads(noStoreFetch)
privateImageCache.onClear(() => privateImageDownloads.clear())

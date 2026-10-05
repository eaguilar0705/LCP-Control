import { CameraError, type ScannerAdapter } from './adapter'
// The only module aware of html5-qrcode; dynamically loaded on camera request.
export function createHtml5Adapter(elementId: string): ScannerAdapter {
  const mount = document.getElementById(elementId)
  // The adapter owns this child; React only owns the outer mount. During async
  // teardown it can stay attached offscreen until the camera finishes starting.
  let host: HTMLDivElement | null = null
  let observer: MutationObserver | null = null
  let cancelling = false
  let reader: import('html5-qrcode').Html5Qrcode | null = null
  let started = false
  let starting: Promise<void> | null = null
  let stopping: Promise<void> | null = null
  return {
    async start(onDecode) {
      if (stopping) await stopping
      if (starting || started) return
      if (!window.isSecureContext) throw new CameraError('insecure')
      if (!navigator.mediaDevices?.getUserMedia)
        throw new CameraError('unavailable')
      if (mount && !mount.isConnected) return
      host = document.createElement('div')
      host.id = `${elementId}-reader`
      mount?.append(host)
      cancelling = false
      // html5-qrcode ignores the promise from video.play(). Handle only the
      // expected AbortError caused by our own asynchronous teardown, per video.
      const wrapped = new WeakSet<HTMLVideoElement>()
      observer = new MutationObserver(() => {
        host?.querySelectorAll('video').forEach((video) => {
          if (wrapped.has(video)) return
          wrapped.add(video)
          const play = video.play.bind(video)
          video.play = () =>
            play().catch((error) => {
              if (
                cancelling &&
                error instanceof DOMException &&
                error.name === 'AbortError'
              )
                return
              throw error
            })
        })
      })
      observer.observe(host, { childList: true, subtree: true })
      starting = (async () => {
        const { Html5Qrcode } = await import('html5-qrcode')
        reader = new Html5Qrcode(`${elementId}-reader`, { verbose: false })
        try {
          await reader.start(
            { facingMode: 'environment' },
            {
              fps: 8,
              // Las etiquetas del catálogo son CODE128: un código de una sola
              // dimensión necesita ancho, no un recuadro cuadrado. Limitar la
              // ventana a 280 px dejaba barras de dos píxeles y la lectura
              // fallaba en pantallas anchas aunque el código se viera centrado.
              qrbox: (width, height) => ({
                width: Math.max(200, Math.floor(width * 0.9)),
                height: Math.max(140, Math.floor(height * 0.6)),
              }),
              aspectRatio: 1.333,
            },
            onDecode,
            () => {
              /* Frame without a code is normal, not a device failure. */
            },
          )
          started = true
          const video = host?.querySelector('video')
          if (video && video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
            await new Promise<void>((resolve) => {
              const finish = () => {
                clearTimeout(timer)
                video.removeEventListener('playing', finish)
                resolve()
              }
              const timer = setTimeout(finish, 2000)
              video.addEventListener('playing', finish, { once: true })
            })
          }
        } catch (error) {
          const name = error instanceof Error ? error.name : String(error)
          if (/NotAllowed|Permission|denied/i.test(name))
            throw new CameraError('denied')
          if (/NotFound|DevicesNotFound|Overconstrained/i.test(name))
            throw new CameraError('unavailable')
          throw new CameraError('device')
        }
      })()
      try {
        await starting
      } finally {
        starting = null
      }
    },
    async stop() {
      if (stopping) return stopping
      cancelling = true
      if (host && (starting || started)) {
        const width = Math.max(host.getBoundingClientRect().width, 320)
        Object.assign(host.style, {
          position: 'fixed',
          left: '-10000px',
          top: '0',
          width: `${width}px`,
          pointerEvents: 'none',
        })
        host.setAttribute('aria-hidden', 'true')
        document.body.append(host)
      }
      stopping = (async () => {
        try {
          await starting
        } catch {
          /* Start failure still requires teardown. */
        }
        const streams = Array.from(host?.querySelectorAll('video') ?? [])
          .map((video) => video.srcObject)
          .filter(
            (stream): stream is MediaStream =>
              typeof MediaStream !== 'undefined' &&
              stream instanceof MediaStream,
          )
        try {
          // isScanning is set by the library's later `playing` event. Its state
          // machine is already stoppable as soon as start() resolves.
          if (started) await reader?.stop()
        } finally {
          // Defensive track teardown if the library's stop fails.
          streams.forEach((stream) =>
            stream.getTracks().forEach((track) => track.stop()),
          )
          host?.querySelectorAll('video').forEach((video) => {
            const stream = video.srcObject
            if (stream instanceof MediaStream)
              stream.getTracks().forEach((track) => track.stop())
            video.srcObject = null
          })
          try {
            reader?.clear()
          } finally {
            reader = null
            started = false
            host?.remove()
            host = null
            observer?.disconnect()
            observer = null
          }
        }
      })()
      try {
        await stopping
      } finally {
        stopping = null
      }
    },
  }
}

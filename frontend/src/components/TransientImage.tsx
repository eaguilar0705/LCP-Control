import { useCallback, useEffect, useRef, useState } from 'react'
import { Image as ImageIcon, ImageOff } from 'lucide-react'
import { privateImageDownloads } from '../lib/privateImageDownloads'
import './transient-image.css'

/** Las fotos privadas se muestran mediante blobs; sus firmas no llegan al img. */
export function TransientImage({
  src,
  alt,
  loading,
  onUnavailable,
}: {
  src: string
  alt: string
  loading?: 'lazy' | 'eager'
  onUnavailable?: () => void
}) {
  const container = useRef<HTMLSpanElement>(null)
  const lease = useRef<ReturnType<typeof privateImageDownloads.acquire> | null>(
    null,
  )
  const [visible, setVisible] = useState(
    loading !== 'lazy' || typeof IntersectionObserver === 'undefined',
  )
  const [download, setDownload] = useState({ source: '', url: '' })
  const [loaded, setLoaded] = useState('')
  const [failed, setFailed] = useState('')
  // El editor conserva la propiedad de su preview local y lo revoca él mismo.
  const local = src.startsWith('blob:') || src.startsWith('data:')
  const unavailable = useCallback(() => {
    setFailed(src)
    onUnavailable?.()
  }, [src, onUnavailable])
  useEffect(() => {
    if (visible || loading !== 'lazy' || !container.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [visible, loading])
  useEffect(() => {
    if (local || (!visible && loading === 'lazy')) return
    let active = true
    const acquired = privateImageDownloads.acquire(src)
    lease.current = acquired
    void acquired.result
      .then((url) => {
        if (active) {
          setFailed('')
          setDownload({ source: src, url })
        }
      })
      .catch((error: unknown) => {
        if (
          active &&
          !(error instanceof DOMException && error.name === 'AbortError')
        )
          unavailable()
      })
    return () => {
      active = false
      if (lease.current === acquired) lease.current = null
      acquired.release()
    }
  }, [src, local, visible, loading, unavailable])
  const imageUrl = local ? src : download.source === src ? download.url : ''
  const ready = !!imageUrl && loaded === imageUrl
  const broken = failed === src
  return (
    <span
      ref={container}
      className={`transient-image ${broken ? 'is-unavailable' : ready ? 'is-loaded' : 'is-loading'}`}
      aria-busy={!ready && !broken}
    >
      {!ready && !broken && (
        <span className="image-loading-placeholder" aria-hidden="true">
          <ImageIcon size={22} strokeWidth={1.4} />
        </span>
      )}
      {imageUrl && !broken && (
        <img
          src={imageUrl}
          alt={alt}
          loading={loading}
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(imageUrl)}
          onError={() => {
            lease.current?.invalidate()
            unavailable()
          }}
        />
      )}
      {broken && (
        <span className="photo-missing">
          <ImageOff size={22} aria-hidden="true" />
          <span>Foto no disponible</span>
        </span>
      )}
    </span>
  )
}

import { useEffect, useRef, useState } from 'react'
import { noStoreFetch } from '../lib/supabase'

/** Las concesiones HTTP nunca llegan al cargador nativo de imágenes. */
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
  const image = useRef<HTMLImageElement>(null)
  const [visible, setVisible] = useState(
    loading !== 'lazy' || typeof IntersectionObserver === 'undefined',
  )
  const [download, setDownload] = useState({ source: '', url: '' })
  // El editor conserva la propiedad de su preview local y lo revoca él mismo.
  const local = src.startsWith('blob:') || src.startsWith('data:')
  useEffect(() => {
    if (visible || loading !== 'lazy' || !image.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(image.current)
    return () => observer.disconnect()
  }, [visible, loading])
  useEffect(() => {
    if (local || (!visible && loading === 'lazy')) return
    const controller = new AbortController()
    let objectUrl = ''
    void noStoreFetch(src, {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Foto no disponible')
        const blob = await response.blob()
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setDownload({ source: src, url: objectUrl })
      })
      .catch(() => {
        if (!controller.signal.aborted) onUnavailable?.()
      })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [src, local, visible, loading, onUnavailable])
  return (
    <img
      ref={image}
      src={local ? src : download.source === src ? download.url : undefined}
      alt={alt}
      loading={loading}
      referrerPolicy="no-referrer"
      onError={onUnavailable}
    />
  )
}

import { useEffect, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { localPhoto, photoBlob, type Photo } from './storefront'
export function StorefrontPhoto({
  photo,
  name,
  preview,
}: {
  photo?: Photo
  name: string
  preview?: string
}) {
  const [resolved, setResolved] = useState({ key: '', url: '' })
  const [failed, setFailed] = useState<string | null>(null)
  const kind = photo?.kind,
    path = photo?.path
  const key = photo ? `${photo.kind}:${photo.path}` : ''
  const local = photo ? localPhoto(photo) : null
  useEffect(() => {
    if (!kind || !path || local || preview) return
    let active = true,
      url = ''
    void photoBlob({ kind, path })
      .then((blob) => {
        if (!active) return
        url = URL.createObjectURL(blob)
        setResolved({ key, url })
      })
      .catch(() => {
        if (active) setFailed(key)
      })
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [key, local, preview, kind, path])
  const src = preview || local || (resolved.key === key ? resolved.url : '')
  return (
    <div className="sf-photo">
      {src && failed !== key ? (
        <img
          src={src}
          alt={name}
          loading="lazy"
          onError={() => setFailed(key)}
        />
      ) : (
        <span>
          <ImageOff size={24} />
          {failed === key
            ? 'Fotografía no disponible'
            : photo
              ? 'Cargando fotografía…'
              : 'Fotografía pendiente'}
        </span>
      )}
    </div>
  )
}

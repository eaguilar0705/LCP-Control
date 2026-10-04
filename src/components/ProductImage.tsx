import { useCallback, useState } from 'react'
import { ImageOff } from 'lucide-react'
import type { Product } from '../lib/domain'
import { TransientImage } from './TransientImage'
export function ProductImage({
  product,
  large = false,
}: {
  product: Product
  large?: boolean
}) {
  const [failed, setFailed] = useState('')
  const unavailable = useCallback(
    () => setFailed(product.imageUrl ?? ''),
    [product.imageUrl],
  )
  return (
    <div className={`product-photo ${large ? 'product-photo-large' : ''}`}>
      {product.imageUrl && failed !== product.imageUrl ? (
        <TransientImage
          src={product.imageUrl}
          alt={`${product.brand} ${product.name}`}
          loading="lazy"
          onUnavailable={unavailable}
        />
      ) : (
        <div className="photo-missing">
          <ImageOff size={large ? 30 : 18} />
          {large && (
            <span>
              {product.imageUrl ? 'Foto no disponible' : 'Foto pendiente'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

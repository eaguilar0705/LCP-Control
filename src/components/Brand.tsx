import { useId } from 'react'

export function Brand({
  wordmark = false,
  gold = false,
  className = '',
}: {
  wordmark?: boolean
  gold?: boolean
  className?: string
}) {
  if (wordmark && gold) return <GoldWordmark className={className} />
  return (
    <img
      className={`${wordmark ? 'brand-wordmark' : 'brand-monogram'} ${className}`}
      src={`/brand/${wordmark ? 'wordmark-wine' : 'monogram-wine'}.jpeg`}
      alt="La Casa del Perfume"
    />
  )
}

// Render the supplied lettering as a luminance mask; the original asset stays
// intact. The white JPEG background becomes transparent on the wine surface.
function GoldWordmark({ className }: { className: string }) {
  const id = useId().replaceAll(':', '')
  return (
    <svg
      className={`brand-wordmark brand-wordmark-gold ${className}`}
      viewBox="0 0 1600 728"
      role="img"
      aria-label="La Casa del Perfume"
    >
      <defs>
        <filter id={`${id}-ink`} colorInterpolationFilters="sRGB">
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncR type="linear" slope="-1.6" intercept="1.5" />
            <feFuncG type="linear" slope="-1.6" intercept="1.5" />
            <feFuncB type="linear" slope="-1.6" intercept="1.5" />
          </feComponentTransfer>
        </filter>
        <mask
          id={`${id}-letters`}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="1600"
          height="728"
          style={{ maskType: 'luminance' }}
        >
          <image
            href="/brand/wordmark-wine.jpeg"
            width="1600"
            height="728"
            filter={`url(#${id}-ink)`}
          />
        </mask>
        <linearGradient id={`${id}-gold`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c39a53" />
          <stop offset=".45" stopColor="#f3dfaa" />
          <stop offset="1" stopColor="#d0a657" />
        </linearGradient>
      </defs>
      <rect
        width="1600"
        height="728"
        fill={`url(#${id}-gold)`}
        mask={`url(#${id}-letters)`}
      />
    </svg>
  )
}

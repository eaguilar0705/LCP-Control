import { marginRate } from '../../lib/pricing'

const percentFormat = new Intl.NumberFormat('es-NI', {
  style: 'percent',
  maximumFractionDigits: 1,
})
/**
 * Lo que queda del precio después del costo, escrito junto al precio que lo
 * produce. Cambiar el precio en una pantalla y descubrir el margen en otra es
 * como se termina vendiendo bajo costo sin enterarse. Bajo el 15 % se marca en
 * rojo; por debajo de cero se dice con todas las letras.
 */
export function PriceMargin({
  priceNio,
  costNio,
  show,
}: {
  priceNio: number | null
  costNio: number | null | undefined
  show: boolean
}) {
  const rate = show ? marginRate(priceNio, costNio) : null
  if (rate === null) return null
  return (
    <p
      className={`product-price-margin ${rate < 0.15 ? 'product-price-margin-thin' : ''}`}
    >
      {rate < 0
        ? `Bajo el costo promedio: pierde ${percentFormat.format(Math.abs(rate))}`
        : `Margen sobre el costo promedio: ${percentFormat.format(rate)}`}
    </p>
  )
}

import type { Product, ProductPricing } from '../../lib/domain'
import { priceTierLabels, priceTiers } from '../../lib/pricing'
import { formatDate } from '../../lib/format'
import { buildWorkbook, type Sheet } from '../../lib/xlsx'

/**
 * La plantilla es el catálogo con una fila por perfume y las columnas que lee
 * la carga. Trae lo que ya está guardado, así que también sirve de respaldo:
 * se descarga, se cambia lo necesario y se vuelve a cargar. El costo promedio
 * va sólo como referencia: la carga no lo importa, porque sale del inventario.
 */
export function pricingTemplate(
  products: Product[],
  pricing: ProductPricing[],
  now = new Date(),
): Sheet {
  const byProduct = new Map(pricing.map((row) => [row.productId, row]))
  const rows = products
    .filter((product) => product.active)
    .slice()
    .sort(
      (a, b) =>
        a.brand.localeCompare(b.brand, 'es') ||
        a.name.localeCompare(b.name, 'es') ||
        (a.size ?? 0) - (b.size ?? 0),
    )
    .map((product) => {
      const saved = byProduct.get(product.id)
      return [
        product.barcode,
        product.brand,
        product.name,
        product.size === null
          ? 'Por confirmar'
          : `${product.size} ${product.unit}`,
        saved?.averageCost ?? null,
        ...priceTiers.map((tier) => saved?.markups[tier] ?? null),
      ]
    })
  return {
    name: 'Porcentajes de ganancia',
    notes: [
      `Porcentajes de ganancia sobre el costo promedio · ${formatDate(now)}`,
      'Escribe el porcentaje de ganancia sobre el costo de cada lista. Precio de venta = costo promedio × (1 + % ÷ 100). Deja vacía la celda que no quieras cambiar.',
      'La columna del costo promedio es informativa y no se importa: el costo sale de las compras registradas. No cambies la columna Código. Este archivo tiene costos: guárdalo en un lugar privado.',
    ],
    columns: [
      { header: 'Código', width: 14 },
      { header: 'Marca', width: 20 },
      { header: 'Perfume', width: 36 },
      { header: 'Tamaño', width: 13 },
      {
        header: 'Costo promedio C$ (informativo, no se importa)',
        width: 22,
        format: 'number',
      },
      ...priceTiers.map((tier) => ({
        header: `% ${priceTierLabels[tier]}`,
        width: 15,
        format: 'number' as const,
      })),
    ],
    rows,
  }
}

function pricingTemplateName(now = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Managua',
  }).format(now)
  return `porcentajes-de-ganancia-${day}.xlsx`
}

export function downloadPricingTemplate(
  products: Product[],
  pricing: ProductPricing[],
) {
  const now = new Date()
  const blob = buildWorkbook([pricingTemplate(products, pricing, now)])
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = pricingTemplateName(now)
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

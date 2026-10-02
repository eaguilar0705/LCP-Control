import type { Product, ProductPricing } from '../../lib/domain'
import { priceTierLabels, priceTiers } from '../../lib/pricing'
import { formatDate } from '../../lib/format'
import { buildWorkbook, type Sheet } from '../../lib/xlsx'

/**
 * La plantilla es el catálogo con una fila por perfume y las columnas que lee
 * la carga. Trae lo que ya está guardado, así que también sirve de respaldo:
 * se descarga, se cambia lo necesario y se vuelve a cargar.
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
        saved?.purchasePrice ?? null,
        saved?.purchasePrice == null
          ? null
          : saved.purchaseCurrency === 'NIO'
            ? 'C$'
            : 'US$',
        ...priceTiers.map((tier) => saved?.markups[tier] ?? null),
      ]
    })
  return {
    name: 'Precios de compra',
    notes: [
      `Precio de compra y porcentajes de ganancia · ${formatDate(now)}`,
      'Precio de venta = precio de compra × (1 + % ÷ 100). Moneda: US$ o C$. Deja vacía la celda que no quieras cambiar.',
      'No cambies la columna Código. Este archivo tiene costos: guárdalo en un lugar privado.',
    ],
    columns: [
      { header: 'Código', width: 14 },
      { header: 'Marca', width: 20 },
      { header: 'Perfume', width: 36 },
      { header: 'Tamaño', width: 13 },
      { header: 'Precio de compra', width: 16, format: 'number' },
      { header: 'Moneda de compra', width: 12 },
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
  return `precios-de-compra-${day}.xlsx`
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

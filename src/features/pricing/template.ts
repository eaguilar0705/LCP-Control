import type { Product, ProductPricing } from '../../lib/domain'
import { currencySymbols, priceTierLabels, priceTiers } from '../../lib/pricing'
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
          : currencySymbols[saved.purchaseCurrency],
        ...priceTiers.map((tier) => saved?.markups[tier] ?? null),
      ]
    })
  return {
    name: 'Precios de compra',
    notes: [
      `Precios de compra y porcentajes de ganancia · ${formatDate(now)}`,
      'Escribe el precio de compra, su moneda (C$ o US$) y el porcentaje de ganancia de cada lista. Deja vacía la celda que no quieras cambiar.',
      'No cambies la columna Código: con ella se reconoce cada perfume. Este archivo tiene precios de compra: guárdalo en un lugar privado.',
    ],
    columns: [
      { header: 'Código', width: 14 },
      { header: 'Marca', width: 20 },
      { header: 'Perfume', width: 36 },
      { header: 'Tamaño', width: 13 },
      { header: 'Precio de compra', width: 17, format: 'money' },
      { header: 'Moneda', width: 9 },
      ...priceTiers.map((tier) => ({
        header: `% ${priceTierLabels[tier]}`,
        width: 15,
        format: 'number' as const,
      })),
    ],
    rows,
  }
}

export function pricingTemplateName(now = new Date()) {
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

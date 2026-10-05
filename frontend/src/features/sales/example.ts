import type { DocumentKind, DocumentRecord } from '../../lib/domain'
const sampleBrands = [
  'Lattafa',
  'Armaf',
  'Rasasi',
  'Afnan',
  'Al Haramain',
  'Maison Alhambra',
  'French Avenue',
  'Paris Corner',
]
const sampleNames = [
  'Asad',
  'Khamrah Qahwa',
  'Club de Nuit Milestone',
  'Hawas Ice',
  '9PM Rebel',
  "L'Aventure Intense",
  'Salvo Elixir',
  'Liquid Brun',
  'Emeer',
  'Badee Al Oud Honor & Glory',
]
/** Número de productos que ofrece la vista de ejemplo para revisar la impresión. */
export const exampleItemCounts = [3, 20, 30, 40] as const

export function exampleDocument(
  kind: DocumentKind,
  count: number = 3,
): DocumentRecord {
  const base = [
    ['Rasasi · Hawas Black · 100 ml', 2, 1450],
    ['Lattafa · Yara · 100 ml', 1, 1100],
    ['Armaf · Club de Nuit Intense Man · 105 ml', 1, 1650],
  ] as const
  const items: (readonly [string, number, number])[] = [...base]
  for (let i = items.length; i < count; i++)
    items.push([
      `${sampleBrands[i % sampleBrands.length]} · ${sampleNames[i % sampleNames.length]} · ${[100, 80, 105, 60][i % 4]} ml`,
      1 + (i % 3),
      950 + ((i * 175) % 1400),
    ])
  const shown = items.slice(0, Math.max(1, count))
  return {
    id: 'example',
    kind,
    previewKind: 'example',
    number: kind === 'invoice' ? 'FAC-EJEMPLO' : 'PRO-EJEMPLO',
    customerId: '',
    customerName: 'María López · cliente de ejemplo',
    customerPhone: null,
    issuer: { name: 'La Casa del Perfume', address: '', phone: '' },
    tier: 'emprendedor',
    currency: 'NIO',
    total: shown.reduce((sum, [, q, p]) => sum + q * p, 0),
    // El catálogo se cotiza en dólares; el ejemplo enseña también cómo sale
    // impreso el equivalente para un cliente que pide el cobro en dólares.
    catalogRate: 37,
    location: kind === 'invoice' ? 'store' : null,
    paymentMethod: kind === 'invoice' ? 'cash' : null,
    validUntil: kind === 'proforma' ? '2026-09-20' : null,
    createdAt: '2026-09-13T12:00:00-06:00',
    notes:
      'Precios y cliente de muestra. Los datos del negocio se completarán antes de utilizar el formato definitivo.',
    items: shown.map(([description, quantity, unitPrice], i) => ({
      id: String(i),
      productId: `example-${i}`,
      description,
      quantity,
      unitPrice,
      lineTotal: quantity * unitPrice,
    })),
  }
}

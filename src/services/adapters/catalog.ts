import type {
  Category,
  Gender,
  InventoryItem,
  PriceTier,
  Product,
  ProductPricing,
} from '../../lib/domain'
import type { DataProvider } from '../contracts'
import { DEMO_EXCHANGE_RATE, localWrites } from './local'
import { applyPricing } from '../../lib/pricing'
import {
  previousRange,
  type ReportRange,
  type ReportSource,
} from '../../features/reports/model'
// Catálogo sintético de la vista local y de las pruebas: marcas, nombres, códigos
// y precios inventados. Las listas reales viven sólo en Supabase, detrás de RLS;
// nunca se empaquetan para el navegador ni se versionan.
const brands: [string, Category][] = [
  ['Aurora Norte', 'arabian'],
  ['Brisa Serena', 'designer'],
  ['Casa Ámbar', 'arabian'],
  ['Estudio Nácar', 'designer'],
  ['Taller Índigo', 'niche'],
  ['Marca sin clasificar', 'unspecified'],
]
const lines: [string, Gender, number | null][] = [
  ['Cedro', 'male', 3.4],
  ['Jazmín', 'female', 3.4],
  ['Vainilla', 'unisex', 2.7],
  ['Cítrico', 'unspecified', 1],
  ['Nocturno', 'male', null],
]
const demoPrice = (dollars: number) => ({
  USD: dollars,
  NIO: Math.round(dollars * DEMO_EXCHANGE_RATE * 100) / 100,
})
export const catalogProducts: Product[] = brands.flatMap(
  ([brand, category], brandIndex) =>
    lines.map(([line, gender, size], lineIndex) => {
      const number = brandIndex * lines.length + lineIndex + 1
      const code = `DEMO-${String(number).padStart(4, '0')}`
      const usd = 24 + number
      const nio = demoPrice(usd).NIO
      return {
        id: code.toLowerCase(),
        barcode: code,
        barcodeKind: 'internal',
        manufacturerBarcode: null,
        name: `${line} ${String(number).padStart(2, '0')}`,
        brand,
        category,
        gender,
        size,
        unit: 'oz',
        price: nio,
        currency: 'NIO',
        prices: {
          emprendedor: demoPrice(usd),
          vip: demoPrice(usd - 1),
          premium: demoPrice(usd - 3),
        },
        minimumStock: null,
        active: true,
        availabilityNote: size === null ? 'Agotado en lista' : 'Por confirmar',
        // Un data: URL que el navegador no puede decodificar muestra «Foto no
        // disponible» sin salir a la red; el resto queda en «Foto pendiente».
        imageUrl: brandIndex % 2 === 0 ? 'data:,sin-foto' : null,
        imageSource: null,
      } satisfies Product
    }),
)
/**
 * Porcentajes de muestra: la vista local enseña listas calculadas desde el
 * costo promedio de muestra, una con porcentaje sólo en Emprendedor, una con
 * porcentajes y sin costo todavía (pendiente) y el resto a mano.
 */
const pricingSample = (
  number: number,
  emprendedor: number | null,
  vip: number | null,
  premium: number | null,
) => ({
  productId: `demo-${String(number).padStart(4, '0')}`,
  markups: { emprendedor, vip, premium },
})
export const catalogPricing = [
  pricingSample(3, 20, 15, 10),
  pricingSample(6, 25, 20, 10),
  pricingSample(11, 28.1, 24.44, 17.12),
  pricingSample(16, 100, 95, 85),
  pricingSample(21, 9.8, null, null),
]
/** El perfume de muestra que todavía no tiene costo promedio. */
export const DEMO_UNCOSTED = 'demo-0021'
/**
 * El catálogo de muestra con las listas calculadas ya al día: el mismo
 * resultado que dejaría la base después de registrar el costo.
 */
async function pricedCatalog(): Promise<Product[]> {
  const { demoAverageCost } = await import('./catalogSales')
  const markups = new Map(catalogPricing.map((row) => [row.productId, row]))
  return catalogProducts.map((product) => {
    const pricing = markups.get(product.id)
    const cost =
      product.id === DEMO_UNCOSTED ? null : demoAverageCost.get(product.id)
    if (!pricing || cost == null || !product.prices)
      return structuredClone(product)
    const prices = applyPricing(
      product.prices,
      pricing,
      cost,
      DEMO_EXCHANGE_RATE,
    )
    return {
      ...structuredClone(product),
      prices,
      price: prices.emprendedor.NIO,
    }
  })
}
/**
 * Existencias de muestra. La vista local las trae contadas para que el inicio,
 * el inventario y los reportes cuenten la misma historia: sin conteo no hay
 * inventario valorado, ni rotación, ni facturación que probar.
 */
const items: InventoryItem[] = catalogProducts.map((product, index) => ({
  product,
  quantities: { warehouse: 4 + ((index * 5) % 23), store: 3 + (index % 7) },
}))
export const catalogAdapter: DataProvider = {
  mode: 'demo',
  async getInventory() {
    const products = new Map(
      (await pricedCatalog()).map((product) => [product.id, product]),
    )
    return items.map((item) => ({
      product: products.get(item.product.id) ?? structuredClone(item.product),
      quantities: { ...item.quantities },
    }))
  },
  async findByBarcode(code) {
    return structuredClone(
      catalogProducts.find(
        (product) =>
          product.barcode === code || product.manufacturerBarcode === code,
      ) ?? null,
    )
  },
  async getReportSource(range: ReportRange): Promise<ReportSource> {
    // La importación es diferida: las ventas de muestra no viajan en el paquete
    // principal, sólo se generan si alguien abre los reportes locales.
    const { syntheticSales } = await import('./catalogSales')
    const sales = syntheticSales()
    const window = { from: previousRange(range).from, to: range.to }
    const inRange = (value: string) => {
      const day = value.slice(0, 10)
      return day >= window.from && day <= window.to
    }
    const documents = sales.documents.filter((document) =>
      inRange(document.createdAt),
    )
    const visible = new Set(documents.map((document) => document.id))
    return {
      documents,
      customers: sales.customers,
      movements: sales.movements.filter((movement) =>
        inRange(movement.createdAt),
      ),
      inventory: structuredClone(items),
      window,
      truncated: false,
      // Igual que la consulta real: sólo el tramo pedido, y los costos de venta
      // sólo de las facturas que viajan con él.
      accounting: {
        ...sales.accounting,
        shipments: sales.accounting.shipments.filter((row) =>
          inRange(row.incurredOn),
        ),
        expenses: sales.accounting.expenses.filter((row) =>
          inRange(row.incurredOn),
        ),
        saleCosts: sales.accounting.saleCosts.filter((row) =>
          visible.has(row.documentId),
        ),
        movementCosts: sales.accounting.movementCosts?.filter((row) =>
          inRange(row.createdAt),
        ),
      },
    }
  },
  async getTodaySummary() {
    return { count: 0, totals: { NIO: 0, USD: 0 } }
  },
  ...localWrites,
  async listProducts() {
    return pricedCatalog()
  },
  // La vista local enseña un historial y un costo inventados para que las dos
  // secciones nuevas del editor se puedan recorrer sin base de datos. El costo
  // es el mismo que usan los reportes locales, así que el margen que se lee en
  // el editor cuadra con el que se lee en el panel contable.
  async listPriceChanges(productId: string) {
    const prices = catalogProducts.find((row) => row.id === productId)?.prices
    if (!prices) return []
    const day = (back: number) =>
      new Date(Date.now() - back * 86400000).toISOString()
    const change = (
      tier: PriceTier,
      back: number,
      beforeUsd: number | null,
      afterUsd: number,
    ) => ({
      changedAt: day(back),
      actor: back > 30 ? 'Carga inicial del catálogo' : 'Dueño',
      tier,
      beforeUsd,
      afterUsd,
      beforeNio: beforeUsd === null ? null : demoPrice(beforeUsd).NIO,
      afterNio: demoPrice(afterUsd).NIO,
      catalogRate: DEMO_EXCHANGE_RATE,
    })
    const usd = prices.emprendedor.USD
    return [
      change('emprendedor', 12, usd - 2, usd),
      change('vip', 47, null, prices.vip.USD),
      change('premium', 47, null, prices.premium.USD),
      change('emprendedor', 47, null, usd - 2),
    ]
  },
  async getProductCost(productId: string) {
    if (productId === DEMO_UNCOSTED) return null
    const { demoAverageCost } = await import('./catalogSales')
    return demoAverageCost.get(productId) ?? null
  },
  async listPricing(productId?: string) {
    const { demoAverageCost } = await import('./catalogSales')
    const markups = new Map(
      catalogPricing.map((row) => [row.productId, row.markups]),
    )
    const rows: ProductPricing[] = catalogProducts
      .filter((product) => productId === undefined || product.id === productId)
      .map((product) => ({
        productId: product.id,
        averageCost:
          product.id === DEMO_UNCOSTED
            ? null
            : (demoAverageCost.get(product.id) ?? null),
        markups: structuredClone(
          markups.get(product.id) ?? {
            emprendedor: null,
            vip: null,
            premium: null,
          },
        ),
        updatedAt: null,
      }))
    return { available: true, rows }
  },
}

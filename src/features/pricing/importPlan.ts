import type {
  Currency,
  PriceTier,
  PricingInput,
  Product,
  ProductPricing,
} from '../../lib/domain'
import {
  applyPricing,
  emptyPricing,
  priceTierLabels,
  priceTiers,
  samePricing,
  tierQuote,
  type TierPrices,
} from '../../lib/pricing'
import { searchable } from '../../lib/search'
import type { SheetCell, SheetRows } from '../../lib/spreadsheet'
import { parseAmount } from '../reports/openingCostImport'

/**
 * Lee una hoja de precios de compra (la plantilla o una hecha a mano) contra el
 * catálogo. No escribe nada: resuelve cada fila a un perfume, valida los
 * números y arma lo que quedaría guardado, para que el dueño vea el resultado
 * completo —y los problemas— antes de confirmar.
 *
 * Una celda vacía significa «no cambiar»: se puede cargar sólo el precio de
 * compra, sólo los porcentajes o cualquier combinación.
 */

export type PricingColumn =
  'code' | 'brand' | 'name' | 'size' | 'purchasePrice' | 'currency' | PriceTier

export const MAX_PRICING_ROWS = 2000
/** Un precio que se mueve más que esto se marca para revisarlo. */
export const LARGE_CHANGE = 0.3

export interface PricingProblem {
  line: number
  text: string
  reason: string
}
export interface PlannedPricing {
  line: number
  product: Product
  before: PricingInput
  after: PricingInput
  prices: { before: TierPrices; after: TierPrices }
  /** Listas cuyo precio en córdobas cambia más de un 30 %. */
  largeChanges: PriceTier[]
}
export interface PricingPlan {
  headerLine: number
  columns: PricingColumn[]
  changes: PlannedPricing[]
  unchanged: number
  problems: PricingProblem[]
}
export class PricingFileError extends Error {}

/** Qué dato trae un encabezado, sin importar tildes, mayúsculas ni el orden. */
export function classifyHeader(value: SheetCell): PricingColumn | null {
  if (typeof value !== 'string') return null
  const text = searchable(value)
  if (!text) return null
  if (/%|porcentaje|ganancia|margen|markup|utilidad/.test(text)) {
    if (/emprendedor|mayorista|mayoreo/.test(text)) return 'emprendedor'
    if (/\bvip\b/.test(text)) return 'vip'
    if (/premium/.test(text)) return 'premium'
    return null
  }
  if (/^(cod(igo)?\b|sku\b|ean\b|upc\b|barcode|code\b)/.test(text))
    return 'code'
  if (/precio de compra|precio compra|\bcompra\b|\bcosto\b|\bcost\b/.test(text))
    return 'purchasePrice'
  if (/^(moneda|divisa|currency)\b/.test(text)) return 'currency'
  if (/^(marca|brand)\b/.test(text)) return 'brand'
  if (
    /^(perfume|nombre|producto|descripcion|articulo|name|product)\b/.test(text)
  )
    return 'name'
  if (/^(tamano|presentacion|size|contenido|volumen)\b/.test(text))
    return 'size'
  return null
}

function findHeader(rows: SheetRows) {
  for (let index = 0; index < Math.min(rows.length, 25); index++) {
    const columns = new Map<PricingColumn, number>()
    rows[index]?.forEach((cell, position) => {
      const column = classifyHeader(cell)
      if (column && !columns.has(column)) columns.set(column, position)
    })
    const identifies = columns.has('code') || columns.has('name')
    const prices =
      columns.has('purchasePrice') ||
      priceTiers.some((tier) => columns.has(tier))
    if (identifies && prices) return { index, columns }
  }
  return null
}

function cellText(cell: SheetCell | undefined): string {
  if (cell === null || cell === undefined || typeof cell === 'boolean')
    return ''
  return String(cell).trim()
}
function isEmpty(cell: SheetCell | undefined) {
  return cellText(cell) === ''
}
const COMBINING = /[\u0300-\u036f]/g
/** Código comparable: sin espacios ni mayúsculas. «lcp 0001» → «LCP0001». */
function codeKey(value: string) {
  return value
    .normalize('NFD')
    .replace(COMBINING, '')
    .replace(/[\s-]/g, '')
    .toUpperCase()
}
const CURRENCY_MARKS = /us\$|u\$s|c\$|usd|nio|\$|c[oó]rdobas?|d[oó]lar(es)?/gi
/**
 * Número de una celda: tal cual si Excel lo guardó como número; si es texto,
 * sin el símbolo de la moneda y aceptando «1,250.50» o «1.250,50».
 */
function readNumber(cell: SheetCell | undefined): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null
  const text = cellText(cell)
    .replace(CURRENCY_MARKS, '')
    .replace(/[\s\u00a0]/g, '')
  if (!text) return null
  const negative = /^-/.test(text)
  const value = parseAmount(text.replace(/^[-+]/, ''))
  return value === null ? null : negative ? -value : value
}
function readPercent(cell: SheetCell | undefined): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null
  return readNumber(cellText(cell).replace(/%$/, '').trim())
}
const round2 = (value: number) => Math.round(value * 100) / 100

export function readCurrency(cell: SheetCell | undefined): Currency | null {
  const text = searchable(cellText(cell)).replace(/\s|\./g, '')
  if (/^(c\$|nio|cordobas?|cs|c)$/.test(text)) return 'NIO'
  if (/^(us\$|usd|\$|dolar(es)?|us|u\$s?)$/.test(text)) return 'USD'
  return null
}

function sizeMatches(cell: SheetCell | undefined, product: Product) {
  if (isEmpty(cell)) return true
  if (typeof cell === 'number')
    return product.size !== null && Math.abs(cell - product.size) < 1e-6
  const text = searchable(cellText(cell))
  if (/por confirmar|pendiente/.test(text)) return product.size === null
  const match = /(\d+(?:[.,]\d+)?)\s*(oz|ml)?/.exec(text)
  if (!match || product.size === null) return false
  const size = Number(match[1].replace(',', '.'))
  return (
    Math.abs(size - product.size) < 1e-6 &&
    (!match[2] || match[2] === product.unit)
  )
}

function describeRow(row: SheetCell[]) {
  return row.map(cellText).filter(Boolean).join(' · ').slice(0, 120)
}

function largeChanges(before: TierPrices, after: TierPrices): PriceTier[] {
  return priceTiers.filter((tier) => {
    const old = before[tier]?.NIO
    const next = after[tier]?.NIO
    if (!old || !Number.isFinite(next) || old <= 0) return false
    return Math.abs(next - old) / old > LARGE_CHANGE
  })
}

export function planPricingImport({
  rows,
  products,
  pricing,
  rate,
  defaultCurrency,
}: {
  rows: SheetRows
  products: Product[]
  pricing: ProductPricing[]
  rate: number | null
  defaultCurrency: Currency
}): PricingPlan {
  const header = findHeader(rows)
  if (!header)
    throw new PricingFileError(
      'No encontramos los encabezados. La hoja necesita una fila con «Código» (o «Marca» y «Perfume») y «Precio de compra» o los porcentajes («% Emprendedor», «% VIP», «% Premium»). Descarga la plantilla para ver el formato.',
    )
  const { columns } = header
  const at = (row: SheetCell[], column: PricingColumn) => {
    const position = columns.get(column)
    return position === undefined ? undefined : row[position]
  }

  const byCode = new Map<string, Product>()
  const byName = new Map<string, Product[]>()
  for (const product of products) {
    for (const code of [product.barcode, product.manufacturerBarcode])
      if (code) byCode.set(codeKey(code), product)
    for (const key of [
      `${searchable(product.brand)}|${searchable(product.name)}`,
      `|${searchable(product.name)}`,
    ]) {
      const list = byName.get(key) ?? []
      list.push(product)
      byName.set(key, list)
    }
  }
  const current = new Map(pricing.map((row) => [row.productId, row]))
  const seen = new Map<string, number>()
  const plan: PricingPlan = {
    headerLine: header.index + 1,
    columns: [...columns.keys()],
    changes: [],
    unchanged: 0,
    problems: [],
  }

  rows.slice(header.index + 1).forEach((row, offset) => {
    const line = header.index + offset + 2
    if (!row || row.every(isEmpty)) return
    const text = describeRow(row)
    const problem = (reason: string) =>
      plan.problems.push({ line, text, reason })

    // ¿Qué perfume es?
    let product: Product | undefined
    const code = cellText(at(row, 'code'))
    if (code) {
      product = byCode.get(codeKey(code))
      if (!product)
        return problem(`No hay ningún perfume con el código «${code}».`)
    } else {
      const name = cellText(at(row, 'name'))
      if (!name) return problem('Falta el código o el nombre del perfume.')
      const brand = cellText(at(row, 'brand'))
      const candidates = (
        byName.get(`${brand ? searchable(brand) : ''}|${searchable(name)}`) ??
        []
      ).filter((item) => sizeMatches(at(row, 'size'), item))
      if (!candidates.length)
        return problem(
          `No encontramos «${[brand, name].filter(Boolean).join(' ')}» en el catálogo. Escribe su código.`,
        )
      if (candidates.length > 1)
        return problem(
          'Hay varios perfumes con ese nombre. Escribe el código para saber cuál es.',
        )
      product = candidates[0]
    }
    const earlier = seen.get(product.id)
    if (earlier !== undefined)
      return problem(
        `El perfume ya aparece en la fila ${earlier}. Deja una sola fila por perfume.`,
      )
    seen.set(product.id, line)

    // ¿Qué trae la fila?
    const reasons: string[] = []
    let purchasePrice: number | undefined
    const priceCell = at(row, 'purchasePrice')
    if (!isEmpty(priceCell)) {
      const value = readNumber(priceCell)
      if (value === null)
        reasons.push(
          `El precio de compra «${cellText(priceCell)}» no es un número.`,
        )
      else if (round2(value) <= 0)
        reasons.push('El precio de compra debe ser mayor que cero.')
      else if (value > 10000000)
        reasons.push('El precio de compra es demasiado alto.')
      else purchasePrice = round2(value)
    }
    let currency: Currency | undefined
    const currencyCell = at(row, 'currency')
    if (!isEmpty(currencyCell)) {
      const value = readCurrency(currencyCell)
      if (!value)
        reasons.push(
          `No reconocemos la moneda «${cellText(currencyCell)}»: escribe C$ o US$.`,
        )
      else currency = value
    }
    const markups: Partial<Record<PriceTier, number>> = {}
    for (const tier of priceTiers) {
      const cell = at(row, tier)
      if (isEmpty(cell)) continue
      const value = readPercent(cell)
      if (value === null)
        reasons.push(
          `El porcentaje de ${priceTierLabels[tier]} «${cellText(cell)}» no es un número.`,
        )
      else if (value < 0 || value > 1000)
        reasons.push(
          `El porcentaje de ${priceTierLabels[tier]} debe estar entre 0 y 1000.`,
        )
      else markups[tier] = round2(value)
    }
    const before: PricingInput =
      current.get(product.id) ?? emptyPricing(defaultCurrency)
    if (
      currency !== undefined &&
      purchasePrice === undefined &&
      before.purchasePrice !== null &&
      currency !== before.purchaseCurrency
    )
      reasons.push(
        'Para cambiar la moneda escribe también el precio de compra.',
      )
    if (reasons.length) return problem(reasons.join(' '))

    const after: PricingInput = {
      purchasePrice: purchasePrice ?? before.purchasePrice,
      purchaseCurrency:
        currency ??
        (purchasePrice !== undefined
          ? defaultCurrency
          : before.purchaseCurrency),
      markups: { ...before.markups, ...markups },
    }
    if (samePricing(before, after)) {
      plan.unchanged++
      return
    }
    const prices = product.prices ?? {
      emprendedor: { NIO: NaN, USD: NaN },
      vip: { NIO: NaN, USD: NaN },
      premium: { NIO: NaN, USD: NaN },
    }
    const next = applyPricing(prices, after, rate)
    const tooHigh = priceTiers.find((tier) => {
      const quote = tierQuote(after, tier, rate)
      return quote !== null && quote.price > 10000000
    })
    if (tooHigh)
      return problem(
        `El precio de venta de ${priceTierLabels[tooHigh]} saldría demasiado alto. Revisa el precio de compra y el porcentaje.`,
      )
    plan.changes.push({
      line,
      product,
      before,
      after,
      prices: { before: prices, after: next },
      largeChanges: largeChanges(prices, next),
    })
  })
  if (plan.changes.length > MAX_PRICING_ROWS)
    throw new PricingFileError(
      `El archivo cambia ${plan.changes.length} perfumes y se admiten hasta ${MAX_PRICING_ROWS} por carga. Divídelo en dos archivos.`,
    )
  return plan
}

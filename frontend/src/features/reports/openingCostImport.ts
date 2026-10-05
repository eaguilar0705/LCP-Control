import { totalStock } from '../inventory/model'
import { emptyAccounting } from './accounting'
import type { ReportSource } from './model'

interface OpeningCostRow {
  line: number
  code: string
  productId: string
  description: string
  stock: number
  unitCost: number
}
interface OpeningCostProblem {
  line: number
  text: string
  reason: string
}
interface OpeningCostParse {
  rows: OpeningCostRow[]
  problems: OpeningCostProblem[]
}

const HEADER = /c[oó]digo|barcode|costo|cost|precio|producto/i
const MAX_COST = 1_000_000_000

/**
 * Accepts both writings of a number in use here: «1,250.50» from a spreadsheet
 * exported in English and «1.250,50» from one exported in Spanish. When both
 * separators appear the rightmost one is the decimal point; when only one
 * appears it is a thousands separator solely if it groups the digits in threes.
 */
export function parseAmount(raw: string): number | null {
  const text = raw.replace(/[C$\s\u00a0]|NIO|USD/gi, '')
  if (!text) return null
  let normalized = text
  if (text.includes('.') && text.includes(',')) {
    const decimal = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ','
    normalized = text.replace(decimal === '.' ? /,/g : /\./g, '').replace(',', '.')
  } else if (text.includes(',')) {
    normalized = /^\d{1,3}(,\d{3})+$/.test(text) ? text.replace(/,/g, '') : text.replace(',', '.')
  } else if (/^\d{1,3}(\.\d{3})+$/.test(text)) {
    normalized = text.replace(/\./g, '')
  }
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null
  const value = Number(normalized)
  return Number.isFinite(value) && value <= MAX_COST
    ? Math.round(value * 1_000_000) / 1_000_000
    : null
}

/** The last column that reads as a number, once the whole tail has been ruled out. */
function readCost(rest: string): number | null {
  const whole = parseAmount(rest)
  if (whole !== null) return whole
  const fields = rest.split(/[\t;,]/).map((field) => field.trim()).filter(Boolean)
  for (let index = fields.length - 1; index >= 0; index--) {
    const value = parseAmount(fields[index])
    if (value !== null) return value
  }
  return null
}

/**
 * Reads a pasted «code, cost» list against the catalogue. Nothing is sent to
 * the database from here: every row is resolved to a product and checked for
 * the same conditions the opening-cost RPC enforces, so the operator sees the
 * whole outcome before a single write happens.
 */
export function parseOpeningCosts(text: string, source: ReportSource): OpeningCostParse {
  const byCode = new Map<string, (typeof source.inventory)[number]>()
  for (const item of source.inventory) {
    for (const code of [item.product.barcode, item.product.manufacturerBarcode])
      if (code) byCode.set(code.trim().toLocaleLowerCase('es'), item)
  }
  const costed = new Set(
    (source.accounting ?? emptyAccounting).costs
      .filter((row) => row.averageCostNio !== null)
      .map((row) => row.productId),
  )
  const rows: OpeningCostRow[] = []
  const problems: OpeningCostProblem[] = []
  const seen = new Set<string>()
  const lines = text.split(/\r?\n/)
  lines.forEach((raw, index) => {
    const line = index + 1
    if (!raw.trim()) return
    const match = /^\s*([^\t;,\s]+)[\t;,\s]*(.*?)\s*$/.exec(raw)
    const code = match?.[1] ?? ''
    const unitCost = match ? readCost(match[2]) : null
    if (index === 0 && unitCost === null && HEADER.test(raw)) return
    const text = raw.trim().slice(0, 120)
    const item = byCode.get(code.toLocaleLowerCase('es'))
    if (!item) {
      problems.push({ line, text, reason: 'No hay ningún producto con ese código.' })
      return
    }
    if (seen.has(item.product.id)) {
      problems.push({ line, text, reason: 'El producto ya aparece en otra fila de la lista.' })
      return
    }
    if (unitCost === null) {
      problems.push({ line, text, reason: 'No se pudo leer un costo en esta fila.' })
      return
    }
    if (costed.has(item.product.id)) {
      problems.push({
        line, text,
        reason: 'Ya tiene costo promedio. Actualízalo registrando la compra.',
      })
      return
    }
    const stock = totalStock(item)
    if (stock === null) {
      problems.push({ line, text, reason: 'Falta el conteo de tienda o de bodega.' })
      return
    }
    if (stock <= 0) {
      problems.push({ line, text, reason: 'No tiene existencias contadas que valorar.' })
      return
    }
    seen.add(item.product.id)
    rows.push({
      line, code, productId: item.product.id, stock, unitCost,
      description: `${item.product.brand} ${item.product.name}`,
    })
  })
  return { rows, problems }
}

// Read-only audit. No Supabase writes and no prices/customer data sent to OBF.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { brandTags, buildReport } from './openbeautyfacts_matching.mjs'

const args = process.argv.slice(2)
const option = (key, fallback) =>
  args.includes(key) ? args[args.indexOf(key) + 1] : fallback
const source = resolve(
  option('--catalog', 'private-data/database-import/products.json'),
)
const output = resolve(option('--output', 'private-data/openbeautyfacts'))
const offline = args.includes('--offline')
const fields =
  'code,product_name,product_name_en,product_name_es,product_name_fr,brands,quantity,product_quantity,product_quantity_unit,categories_tags'
const ua = 'LCP-Control/0.1 (https://github.com/diegourbiaviles1/LCP-Control)'
const input = JSON.parse(await readFile(source, 'utf8'))
if (!Array.isArray(input) || input.some((p) => !p.name || !p.brand))
  throw new Error('El catálogo debe ser un arreglo con name y brand.')
const products = input.map((p) => ({
  id: p.id,
  sku: p.sku ?? p.barcode,
  brand: p.brand,
  name: p.name,
  size: p.size,
  unit: p.unit ?? (Object.hasOwn(p, 'size_source') ? 'oz' : null),
}))
await mkdir(join(output, 'cache'), { recursive: true })
let lastRequest = 0
const brands = [...new Set(products.map((p) => p.brand))].sort()
const results = []
for (const brand of brands) {
  const tags = brandTags(brand)
  const cached = join(
    output,
    'cache',
    createHash('sha256').update(tags.join('|')).digest('hex') + '.json',
  )
  let result
  try {
    const saved = JSON.parse(await readFile(cached, 'utf8'))
    if (
      offline ||
      (saved.complete && Date.now() - Date.parse(saved.fetchedAt) < 86400000)
    )
      result = saved
  } catch {
    /* No cache yet. */
  }
  if (!result && offline)
    result = {
      brand,
      tags,
      complete: false,
      products: [],
      error: 'No hay consulta guardada.',
    }
  if (!result) {
    result = {
      brand,
      tags,
      fetchedAt: new Date().toISOString(),
      complete: false,
      products: [],
      count: null,
      pages: 0,
    }
    try {
      for (let page = 1; page <= 20; page++) {
        await pause(Math.max(0, 7200 - (Date.now() - lastRequest)))
        const url = new URL('https://world.openbeautyfacts.org/api/v2/search')
        url.search = new URLSearchParams({
          brands_tags: tags.join('|'),
          page: String(page),
          page_size: '100',
          fields,
          sort_by: 'product_name',
        }).toString()
        lastRequest = Date.now()
        const response = await fetch(url, {
          headers: { 'User-Agent': ua, Accept: 'application/json' },
          signal: AbortSignal.timeout(30000),
        })
        if (!response.ok)
          throw new Error(
            `Open Beauty Facts respondió HTTP ${response.status}; no equivale a cero resultados.`,
          )
        const body = await response.json()
        if (!Array.isArray(body.products) || !Number.isFinite(body.count))
          throw new Error('Respuesta inesperada de Open Beauty Facts.')
        result.count = body.count
        result.pages = page
        result.products.push(...body.products)
        if (result.products.length >= body.count) {
          result.complete = true
          break
        }
        if (!body.products.length)
          throw new Error('La paginación terminó antes del total anunciado.')
      }
      if (!result.complete)
        result.error = 'Límite de páginas alcanzado; consulta incompleta.'
    } catch (error) {
      result.error = error.message
    }
    await writeFile(cached, JSON.stringify(result, null, 2))
  }
  results.push(result)
  console.log(
    `${results.length}/${brands.length} ${brand}: ${result.products.length} fichas${result.complete ? '' : ' (incompleto: ' + result.error + ')'}`,
  )
  if (/HTTP (403|429)/.test(result.error ?? '')) {
    console.log(
      'Se detuvo la consulta para respetar la restricción del proveedor. Puede reanudarse usando la caché.',
    )
    break
  }
}
const supplementPath = option('--supplement', null)
const supplement = supplementPath
  ? JSON.parse(await readFile(resolve(supplementPath), 'utf8'))
  : null
if (supplement && !Array.isArray(supplement.products))
  throw new Error('El suplemento debe contener products.')
const report = buildReport(products, results, supplement)
report.catalogSource = source
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
const safe = (v) =>
  String(v ?? '')
    .replace(/\|/g, '/')
    .replace(/[\r\n]+/g, ' ')
const lines = [
  '# Códigos candidatos de Open Beauty Facts',
  '',
  `Consulta: ${report.generatedAt}. Catálogo: ${products.length} referencias de ${brands.length} marcas.`,
  '',
  'Fuente: [Open Beauty Facts](https://world.openbeautyfacts.org/). Datos bajo ODbL: atribución y compartir igual. Esta colección de candidatos se conserva separada del inventario privado.',
  '',
  'Los resultados son candidatos publicados por una base colaborativa. No se asignó ningún código. Confirma la caja/proveedor, tamaño, concentración, género y si se trata de un set antes de guardar un EAN/UPC.',
  '',
  `Marcas consultadas por completo: ${report.summary.completeBrands}/${brands.length}. Fichas públicas únicas: ${report.summary.publicRecords}. Referencias con candidatos: ${report.summary.withCandidates}. Sin candidato útil: ${report.summary.withoutCandidates}. Consulta incompleta: ${report.summary.unchecked}.`,
  ...(supplement
    ? [
        `Consulta adicional por categorías: ${supplement.products.length} de ${supplement.count} fichas. ${supplement.complete ? 'Completa' : 'Incompleta'}.`,
      ]
    : []),
  '',
  '| Código interno | Perfume | Presentación | Código candidato | Ficha pública | Revisión |',
  '|---|---|---|---|---|---|',
]
const csv = [
  [
    'sku',
    'marca',
    'perfume',
    'tamano',
    'unidad',
    'codigo_candidato',
    'nombre_obf',
    'presentacion_obf',
    'revision',
    'url',
  ],
]
for (const row of report.products) {
  for (const candidate of row.candidates.length ? row.candidates : [null]) {
    const note = candidate?.review ?? row.status
    lines.push(
      `| ${safe(row.sku)} | ${safe(row.brand)} ${safe(row.name)} | ${safe(row.size ?? 'Por confirmar')} ${safe(row.unit)} | ${candidate ? '[' + candidate.code + '](' + candidate.url + ')' : '—'} | ${safe(candidate?.name)} ${safe(candidate?.quantity)} | ${safe(note)} |`,
    )
    csv.push([
      row.sku,
      row.brand,
      row.name,
      row.size,
      row.unit,
      candidate?.code,
      candidate?.name,
      candidate?.quantity,
      note,
      candidate?.url,
    ])
  }
}
// Force spreadsheet text for formula-like strings; preserve leading zeroes in JSON/Markdown.
const csvCell = (v) =>
  '"' +
  String(v ?? '')
    .replace(/^[=+@-]/, "'$&")
    .replace(/"/g, '""') +
  '"'
await writeFile(
  join(output, 'candidatos.csv'),
  '\uFEFF' + csv.map((row) => row.map(csvCell).join(',')).join('\r\n'),
)
const comparable = report.products.flatMap((p) =>
  p.candidates
    .filter((c) => c.comparable)
    .map((c) => ({ product: p, candidate: c })),
)
const shortlist = [
  '# Coincidencias de nombre y tamaño para verificar',
  '',
  `Fuente: [Open Beauty Facts](https://world.openbeautyfacts.org/) · ODbL · Consulta ${report.generatedAt}.`,
  '',
  'No son códigos confirmados de nuestras cajas. Compara el EAN/UPC, concentración y presentación con la caja o el proveedor antes de registrarlos en Inventario → Editar. No se modificó Supabase.',
  '',
  '| SKU | Perfume | Presentación local | Código candidato | Observaciones |',
  '|---|---|---|---|---|',
  ...comparable.map(
    ({ product: p, candidate: c }) =>
      `| ${safe(p.sku)} | ${safe(p.brand)} ${safe(p.name)} | ${safe(p.size)} ${safe(p.unit)} | [${c.code}](${c.url}) | ${safe(c.review)} |`,
  ),
]
await writeFile(
  join(output, 'coincidencias-para-verificar.md'),
  shortlist.join('\n'),
)
await writeFile(join(output, 'informe.md'), lines.join('\n'))
console.log(JSON.stringify(report.summary))

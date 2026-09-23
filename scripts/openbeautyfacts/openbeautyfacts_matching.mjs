export const normalize = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll('ı', 'i')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
const aliases = {
  lataffa: ['lattafa', 'lataffa', 'lattafa-perfumes'],
  boss: ['boss', 'hugo-boss', 'hugo'],
  polo: ['polo', 'ralph-lauren', 'polo-ralph-lauren'],
  'dolce gabanna': ['dolce-gabbana', 'dolce-gabanna', 'd-g'],
  'issey miyaki': ['issey-miyake', 'issey-miyaki'],
  'emporio armani': ['emporio-armani', 'giorgio-armani', 'armani'],
  'paco rabanne': ['paco-rabanne', 'rabanne'],
  dior: ['dior', 'christian-dior'],
  ferragamo: ['ferragamo', 'salvatore-ferragamo'],
  'french avenue': ['french-avenue', 'fragrance-world'],
  tubees: ['tubees', 'tubbees', 'gulf-orchid'],
  benetton: ['benetton', 'united-colors-of-benetton'],
  'yves saint laurent': ['yves-saint-laurent', 'ysl'],
}
export function brandTags(brand) {
  return aliases[normalize(brand)] ?? [normalize(brand).replaceAll(' ', '-')]
}
export function validGtin(code) {
  if (!/^(?:\d{8}|\d{12,14})$/.test(String(code))) return false
  const digits = [...String(code)].map(Number)
  const check = digits.pop()
  return (
    (10 -
      (digits
        .reverse()
        .reduce((sum, n, i) => sum + n * (i % 2 === 0 ? 3 : 1), 0) %
        10)) %
      10 ===
      check && /[1-9]/.test(code)
  )
}
const stop = new Set(
  'eau de du le la l d pour for men man women woman homme femme erkek kadin edp edt parfum toilette perfume perfumes spray vaporisateur natural fl oz ml and the en a by'.split(
    ' ',
  ),
)
function tokens(name, brand) {
  const brandWords = new Set(brandTags(brand).flatMap((tag) => tag.split('-')))
  const withoutVolume = String(name).replace(
    /\d+(?:[.,]\d+)?\s*(ml|millilit(?:er|re)s?|fl\.?\s*oz|oz|l)\b/gi,
    ' ',
  )
  return new Set(
    normalize(withoutVolume)
      .split(' ')
      .filter((w) => w && !stop.has(w) && !brandWords.has(w)),
  )
}
function concentration(name) {
  const n = normalize(name)
  if (/\bedp\b|eau de parfum/.test(n)) return 'EDP'
  if (/\bedt\b|eau de toilette/.test(n)) return 'EDT'
  if (/\bextrait\b/.test(n)) return 'EXTRAIT'
  if (/\bparfum\b/.test(n)) return 'PARFUM'
  return null
}
function volumes(text) {
  const found = [
    ...String(text ?? '')
      .toLowerCase()
      .replace(/,/g, '.')
      .matchAll(
        /(\d+(?:\.\d+)?)\s*(ml|millilit(?:er|re)s?|fl\.?\s*oz|oz|l)\b/g,
      ),
  ]
  return found.map(
    ([, value, unit]) =>
      Number(value) *
      (unit === 'l' ? 1000 : unit.includes('oz') ? 29.5735295625 : 1),
  )
}
export function compareCandidate(product, candidate) {
  const code = String(candidate.code ?? '')
  if (!validGtin(code)) return null
  const name =
    candidate.product_name ||
    candidate.product_name_en ||
    candidate.product_name_es ||
    candidate.product_name_fr ||
    ''
  const local = tokens(product.name, product.brand)
  const remote = tokens(name, product.brand)
  const common = [...local].filter((w) => remote.has(w)).length
  if (!local.size || !common || common / local.size < 0.5) return null
  const notes = []
  const exact = local.size === remote.size && common === local.size
  if (!exact) notes.push('Variante o nombre diferente')
  const a = concentration(product.name),
    b = concentration(name)
  if (a && b && a !== b) notes.push('Concentración diferente')
  else if (!a || !b) notes.push('Confirmar concentración')
  const gender = (text) =>
    /\b(women|woman|femme|kadin)\b/.test(normalize(text))
      ? 'female'
      : /\b(men|man|homme|erkek)\b/.test(normalize(text))
        ? 'male'
        : null
  const localGender = gender(product.name),
    remoteGender = gender(name)
  const genderConflict =
    localGender && remoteGender && localGender !== remoteGender
  if (genderConflict) notes.push('Género diferente')
  const setPattern = /\b(set|gift|coffret|pcs|pieces|estuche)\b/
  if (
    setPattern.test(normalize(product.name)) !==
    setPattern.test(normalize(name))
  )
    notes.push('Set y unidad individual no coinciden')
  const localMl =
    product.size == null || !['ml', 'oz'].includes(product.unit)
      ? null
      : product.size * (product.unit === 'oz' ? 29.5735295625 : 1)
  const declared = volumes(candidate.quantity)
  const named = volumes(name)
  const structured = volumes(
    `${candidate.product_quantity ?? ''} ${candidate.product_quantity_unit ?? ''}`,
  )
  const sizes = [...declared, ...named, ...structured]
  const comparable =
    localMl !== null &&
    sizes.some((v) => Math.abs(v - localMl) <= Math.max(2, localMl * 0.025))
  const inconsistent =
    sizes.length > 1 && Math.max(...sizes) > Math.min(...sizes) * 1.1
  if (localMl === null || !sizes.length) notes.push('Tamaño pendiente')
  else if (!comparable) notes.push('Tamaño diferente')
  if (inconsistent) notes.push('Presentación contradictoria en la fuente')
  const strong =
    exact &&
    comparable &&
    !inconsistent &&
    !genderConflict &&
    !(a && b && a !== b)
  return {
    code,
    name,
    brand: candidate.brands ?? '',
    quantity: candidate.quantity ?? '',
    url: `https://world.openbeautyfacts.org/product/${code}`,
    score: Math.round(
      (common / local.size) * 60 + (exact ? 20 : 0) + (comparable ? 20 : 0),
    ),
    comparable: strong,
    review: [
      strong
        ? 'Nombre y tamaño comparables; verificar caja'
        : 'Revisar antes de usar',
      ...notes,
    ].join('. '),
  }
}
export function buildReport(products, results, supplement = null) {
  const byBrand = new Map(results.map((r) => [r.brand, r]))
  const rows = products.map((product) => {
    const result = byBrand.get(product.brand)
    const extra = (supplement?.products ?? []).filter((p) => {
      const description = ` ${normalize(p.brands)} ${normalize(p.product_name)} `
      return brandTags(product.brand).some((tag) =>
        description.includes(` ${normalize(tag)} `),
      )
    })
    const unique = new Map(
      [...extra, ...(result?.products ?? [])].map((p) => [String(p.code), p]),
    )
    const candidates = [...unique.values()]
      .map((c) => compareCandidate(product, c))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code))
    return {
      ...product,
      candidates,
      complete: !!result?.complete,
      status: !result?.complete
        ? 'Consulta incompleta'
        : candidates.length
          ? 'Pendiente de verificación'
          : 'Sin candidato útil en la consulta',
    }
  })
  return {
    generatedAt: new Date().toISOString(),
    provider: 'Open Beauty Facts',
    license: 'ODbL 1.0',
    attribution: 'https://world.openbeautyfacts.org/',
    summary: {
      completeBrands: results.filter((r) => r.complete).length,
      publicRecords: new Set([
        ...results.flatMap((r) => r.products.map((p) => p.code)),
        ...(supplement?.products ?? []).map((p) => p.code),
      ]).size,
      withCandidates: rows.filter((r) => r.candidates.length).length,
      withoutCandidates: rows.filter((r) => r.complete && !r.candidates.length)
        .length,
      unchecked: rows.filter((r) => !r.complete).length,
      comparable: rows.filter((r) => r.candidates.some((c) => c.comparable))
        .length,
    },
    queries: results.map(({ products, ...r }) => ({
      ...r,
      returned: products.length,
    })),
    products: rows,
    supplement: supplement
      ? {
          count: supplement.count,
          returned: supplement.products.length,
          complete: supplement.complete,
          query: supplement.query,
          fetchedAt: supplement.fetchedAt,
        }
      : null,
  }
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareCandidate,
  validGtin,
  brandTags,
  buildReport,
} from '../../scripts/openbeautyfacts/openbeautyfacts_matching.mjs'
const product = {
  sku: 'TEST',
  brand: 'Lataffa',
  name: 'Khamrah Qahwa',
  size: 3.4,
  unit: 'oz',
}
const candidate = {
  code: '6290360593661',
  product_name: 'Lattafa Khamrah Qahwa 100 ml',
  quantity: '100 ml',
  brands: 'Lattafa',
}
test('category supplement finds products whose brand tag is missing, without mixing brands', () => {
  const report = buildReport(
    [product, { ...product, brand: 'Otra marca' }],
    [
      { brand: 'Lataffa', complete: true, products: [] },
      { brand: 'Otra marca', complete: true, products: [] },
    ],
    { complete: true, count: 1, products: [candidate] },
  )
  assert.equal(report.products[0].candidates.length, 1)
  assert.equal(report.products[1].candidates.length, 0)
  assert.equal(report.summary.publicRecords, 1)
})
test('validates GTIN check digit without dropping leading zeroes', () => {
  assert.equal(validGtin('6290360593661'), true)
  assert.equal(validGtin('6290360593662'), false)
  assert.equal(validGtin('00000000'), false)
  assert.equal(validGtin('123'), false)
  assert.equal(validGtin('0614514152027'), true)
})
test('compares rounded bottle volumes and aliases but does not certify the barcode', () => {
  assert.ok(brandTags('Lataffa').includes('lattafa'))
  const result = compareCandidate(product, candidate)
  assert.equal(result.comparable, true)
  assert.match(result.review, /verificar caja/)
})
test('does not call a different flanker, concentration, gender or size comparable', () => {
  for (const change of [
    { product_name: 'Khamrah Qahwa Intense 100 ml' },
    { quantity: '50 ml', product_name: 'Khamrah Qahwa 50ml' },
  ])
    assert.equal(
      compareCandidate(product, { ...candidate, ...change }).comparable,
      false,
    )
  assert.equal(
    compareCandidate(
      { ...product, name: 'Khamrah Qahwa EDP' },
      { ...candidate, product_name: 'Khamrah Qahwa EDT' },
    ).comparable,
    false,
  )
  assert.equal(
    compareCandidate(
      { ...product, name: 'Khamrah Qahwa Women' },
      { ...candidate, product_name: 'Khamrah Qahwa Men' },
    ).comparable,
    false,
  )
  assert.equal(
    compareCandidate(product, { ...candidate, quantity: '100 ml, 100 L' })
      .comparable,
    false,
  )
})
test('preserves numeric perfume names and rejects invalid codes and unrelated products', () => {
  assert.equal(
    compareCandidate(
      { ...product, brand: 'Carolina Herrera', name: '212' },
      { ...candidate, product_name: '212 100ml' },
    ).comparable,
    true,
  )
  assert.equal(
    compareCandidate(
      { ...product, brand: 'Carolina Herrera', name: '212' },
      { ...candidate, product_name: '999 100ml' },
    ),
    null,
  )
  assert.equal(compareCandidate(product, { ...candidate, code: '123' }), null)
  assert.equal(
    compareCandidate(product, {
      ...candidate,
      product_name: 'Sunscreen SPF50',
    }),
    null,
  )
})
test('missing size and failed queries remain pending; duplicates are collapsed', () => {
  assert.equal(
    compareCandidate({ ...product, size: null }, candidate).comparable,
    false,
  )
  const report = buildReport(
    [product, { ...product, brand: 'Otra marca' }],
    [{ brand: 'Lataffa', complete: true, products: [candidate, candidate] }],
  )
  assert.equal(report.products[0].candidates.length, 1)
  assert.equal(report.summary.unchecked, 1)
  assert.equal(report.summary.withoutCandidates, 0)
})

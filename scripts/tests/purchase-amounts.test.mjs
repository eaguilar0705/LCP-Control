import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  server: { middlewareMode: true, hmr: false, ws: false },
})
const { purchaseAmounts } = await server.ssrLoadModule(
  '/src/features/pricing/purchase-amount-model.ts',
)
await server.close()
const nio = (systemRate, goods = 21360, shipping = 0) =>
  purchaseAmounts({
    goods,
    shipping,
    currency: 'NIO',
    exchangeRate: 1,
    systemRate,
  })

test('la compra de 12 × 940 + 12 × 840 conserva C$21,360 y su equivalente sin redondearlo de vuelta', () => {
  const result = nio(37, 12 * 940 + 12 * 840)
  assert.equal(result.total, 21360)
  assert.equal(result.nio, 21360)
  assert.equal(result.equivalent.currency, 'USD')
  assert.ok(Math.abs(result.equivalent.amount - 577.2972972972973) < 1e-10)
  assert.equal(result.equivalent.amount.toFixed(2), '577.30')
  assert.equal(nio(37).total, 21360)
  assert.notEqual(
    Number(result.equivalent.amount.toFixed(2)) * 37,
    result.total,
  )
})
test('NIO usa la tasa configurada, aunque su tasa contable sea 1; no fija 37', () => {
  for (const rate of [35.85, 36.6, 37, 38.5, 40.123456]) {
    const result = nio(rate)
    assert.equal(result.rate, rate)
    assert.ok(Math.abs(result.equivalent.amount * rate - 21360) < 0.000001)
    assert.equal(result.total, 21360)
  }
})
test('los costos USD no se redondean al dólar de venta ni se convierten usando el equivalente visual', () => {
  const result = purchaseAmounts({
    goods: 30.61,
    shipping: 0,
    currency: 'USD',
    exchangeRate: 37,
    systemRate: 37,
  })
  assert.equal(result.total, 30.61)
  assert.equal(result.nio, 1132.57)
  assert.equal(result.equivalent.amount, 1132.57)
})
test('USD conserva el redondeo contable por componente de mercadería y envío', () => {
  const result = purchaseAmounts({
    goods: 0.01,
    shipping: 0.01,
    currency: 'USD',
    exchangeRate: 0.5,
    systemRate: 37,
  })
  assert.equal(result.nio, 0.02)
  assert.equal(
    purchaseAmounts({
      goods: 0.5,
      shipping: 0,
      currency: 'USD',
      exchangeRate: 36.61,
      systemRate: 37,
    }).nio,
    18.31,
  )
})
test('una compra USD histórica conserva la tasa de su transacción', () => {
  const result = purchaseAmounts({
    goods: 100,
    shipping: 0,
    currency: 'USD',
    exchangeRate: 36.6,
    systemRate: 38.5,
  })
  assert.equal(result.nio, 3660)
  assert.equal(result.rate, 36.6)
})
test('sin tasa no se inventa una conversión ni se pierde el importe NIO original', () => {
  for (const rate of [null, undefined, 0, NaN, Infinity, -37]) {
    const result = nio(rate)
    assert.equal(result.total, 21360)
    assert.equal(result.equivalent, null)
  }
})
test('las sumas de medio centavo coinciden con PostgreSQL y no hay mínimo ficticio', () => {
  assert.equal(nio(37, 1.005).total, 1.01)
  assert.equal(nio(37, 0, 0).total, 0)
  assert.equal(nio(37, -1), null)
  assert.equal(nio(37, NaN), null)
})

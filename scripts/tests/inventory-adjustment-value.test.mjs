import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inventoryAdjustmentValue } from '../../frontend/src/features/inventory/inventoryAdjustmentValue.ts'

test('agregar una unidad de C$500 a dos unidades valora solo una, no el total de tres', () => {
  assert.deepEqual(inventoryAdjustmentValue(2, 3, 500), {
    units: 1,
    amountNio: 500,
  })
  assert.deepEqual(inventoryAdjustmentValue(2, 5, 500), {
    units: 3,
    amountNio: 1500,
  })
})
test('descontar unidades conserva el sentido del cambio y el importe de su diferencia', () => {
  assert.deepEqual(inventoryAdjustmentValue(3, 2, 500), {
    units: -1,
    amountNio: 500,
  })
  assert.deepEqual(inventoryAdjustmentValue(3, 0, 500), {
    units: -3,
    amountNio: 1500,
  })
})
test('la estimación respeta los medios centavos y los costos de seis decimales', () => {
  assert.deepEqual(inventoryAdjustmentValue(2, 3, 1.005), {
    units: 1,
    amountNio: 1.01,
  })
  assert.deepEqual(inventoryAdjustmentValue(0, 3, 333.333333), {
    units: 3,
    amountNio: 1000,
  })
})
test('costo cero y un conteo sin diferencia no inventan un cargo mínimo', () => {
  assert.deepEqual(inventoryAdjustmentValue(2, 3, 0), {
    units: 1,
    amountNio: 0,
  })
  assert.deepEqual(inventoryAdjustmentValue(2, 2, 500), {
    units: 0,
    amountNio: 0,
  })
})
test('los datos pendientes o inválidos no se presentan como una valoración de cero', () => {
  for (const args of [
    [null, 3, 500],
    [2, null, 500],
    [2, 3, null],
    [2.5, 3, 500],
    [2, -1, 500],
    [2, 1000001, 500],
    [2, 3, NaN],
    [2, 3, -1],
    [2, 3, Infinity],
  ]) {
    assert.equal(inventoryAdjustmentValue(...args), null)
  }
})
test('un importe fuera del rango monetario seguro permanece sin estimar', () => {
  assert.equal(inventoryAdjustmentValue(0, 1000000, 10000000000), null)
})

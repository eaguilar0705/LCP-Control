import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { storefrontSalesFixture } from './storefront-sales-fixture.mjs'

const f = await storefrontSalesFixture()
let checks = 0
const scenarios = []
const equal = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
  scenarios.push(message)
}
const available = async (expected, message) =>
  equal((await f.publication())?.content.availability, expected, message)
try {
  equal(
    await f.publication(),
    undefined,
    'Alta de inventario no publica sin aprobación',
  )
  await f.buy(2)
  equal(
    (await f.draft()).inventory_state,
    'available',
    'Compra registrada confirma existencias',
  )
  equal(
    await f.publication(),
    undefined,
    'Compra no publica automáticamente una referencia sin aprobar',
  )
  let d = await f.draft()
  d = await f.action('save', {
    ...d.content,
    price: 37.5,
    description: 'Descripción editorial',
    inventory_managed: true,
  })
  equal(
    await f.publication(),
    undefined,
    'Guardar borrador mantiene el perfume privado',
  )
  await f.action('publish')
  await available('available', 'Publicación aprobada anuncia existencias')
  equal(
    (await f.publication()).content.price,
    37.5,
    'Precio público independiente del precio de venta interno',
  )
  await f.action('save', {
    ...d.content,
    name: 'Cambio editorial pendiente',
    price: 49,
    inventory_managed: true,
  })
  const pending = await f.draft()
  const partial = f.saleInput(1)
  await f.call('create_document', partial)
  await available(
    'available',
    'Venta parcial conserva disponibilidad mientras queda una unidad',
  )
  await f.call('create_document', partial)
  await available(
    'available',
    'Reintentar la misma factura no descuenta inventario otra vez',
  )
  const last = await f.call('create_document', f.saleInput(1))
  await available(
    'unavailable',
    'Venta de última unidad marca No disponible sin intervención editorial',
  )
  equal(
    (await f.publication()).visible,
    true,
    'Perfume agotado permanece visible con el botón de selección deshabilitable',
  )
  equal(
    (await f.publication()).content.price,
    37.5,
    'Agotamiento conserva el precio publicado',
  )
  equal(
    (await f.draft()).revision,
    pending.revision,
    'Ventas no invalidan la revisión editorial',
  )
  equal(
    (await f.draft()).content.name,
    'Cambio editorial pendiente',
    'Ventas no sobrescriben cambios pendientes',
  )
  await assert.rejects(
    f.call('create_document', f.saleInput(1)),
    /existencias|disponible|insuficiente/i,
  )
  checks++
  await available('unavailable', 'Venta rechazada no cambia la disponibilidad')
  const detail = (
    await f.one('select public.invoice_return_detail($1) d', [last.id])
  ).d
  await f.call('record_sales_return', {
    requestId: crypto.randomUUID(),
    documentId: last.id,
    reason: 'Devolución de prueba aislada',
    refundMethod: 'cash',
    items: [{ itemId: detail.items[0].id, quantity: 1, restock: true }],
  })
  await available(
    'available',
    'Devolución con reposición vuelve a anunciar disponibilidad',
  )
  await f.call('create_document', f.saleInput(1))
  await f.buy(1, 'warehouse')
  await available(
    'available',
    'Reposición en Bodega también actualiza el catálogo',
  )
  await f.call('create_document', f.saleInput(1, 'warehouse'))
  await available(
    'unavailable',
    'Agotar Tienda y Bodega retira la disponibilidad',
  )
  await f.action('save', {
    ...(await f.draft()).content,
    inventory_managed: true,
    hide_unavailable: true,
  })
  await f.action('publish')
  equal(
    await f.publication(),
    undefined,
    'Opción ocultar agotados retira el perfume de la lectura pública',
  )
  await f.buy(1)
  await available(
    'available',
    'Compra posterior recupera la publicación aprobada oculta por agotamiento',
  )
  await f.action('hide')
  await f.buy(1)
  equal(
    await f.publication(),
    undefined,
    'Reposición respeta una ocultación editorial manual',
  )
  const report = { suite: 'storefront-sales', checks, passed: true, scenarios }
  await mkdir('output/storefront-review', { recursive: true })
  await writeFile(
    'output/storefront-review/sales-results.json',
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report))
} finally {
  await f.close()
}

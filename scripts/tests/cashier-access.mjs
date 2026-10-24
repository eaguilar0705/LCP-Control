import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
  warehouse,
  viewer,
  outsider,
} from './database-fixture.mjs'

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  cacheDir: fileURLToPath(
    new URL('../../output/cache/cashier-access', import.meta.url),
  ),
  server: { middlewareMode: true, hmr: false, ws: false },
})
const { can, roleLabels } = await server.ssrLoadModule(
  '/src/lib/permissions.ts',
)
await server.close()
let checks = 0
function equal(actual, expected, label) {
  assert.deepEqual(actual, expected, label)
  checks++
}
async function denied(promise) {
  await assert.rejects(promise, /privilege|permission/i)
  checks++
}
equal(roleLabels.operator, 'Caja')
equal(can('operator', 'sale.create'), true)
equal(
  can('operator', 'scanner.use'),
  true,
  'el lector se conserva dentro de facturación',
)
for (const capability of [
  'inventory.read',
  'inventory.create_entry',
  'inventory.create_exit',
  'inventory.create_damage',
  'inventory.adjust',
  'product.manage',
  'product.edit_cost',
  'finance.read',
  'pricing.manage',
  'supplier.read',
  'customer.read',
  'customer.manage',
  'proforma.create',
  'staff.manage',
  'settings.manage',
]) {
  equal(can('operator', capability), false, `Caja no recibe ${capability}`)
}
for (const role of ['admin', 'superadmin']) {
  equal(can(role, 'proforma.create'), true)
  equal(can(role, 'inventory.create_exit'), true)
}
equal(can('warehouse', 'inventory.create_entry'), true)
equal(can('viewer', 'inventory.read'), true)
equal(can(null, 'sale.create'), false)

const db = await database()
const product = crypto.randomUUID()
const call = (name, payload) => rpc(db, name, payload)
const invoice = (changes = {}) => ({
  requestId: crypto.randomUUID(),
  kind: 'invoice',
  customerName: 'Cliente de Caja',
  customerPhone: '50588887777',
  tier: 'emprendedor',
  currency: 'NIO',
  location: 'store',
  paymentMethod: 'cash',
  items: [{ productId: product, quantity: 1 }],
  ...changes,
})
const movement = (type) => ({
  requestId: crypto.randomUUID(),
  productId: product,
  type,
  quantity: 1,
  location: 'store',
  note: 'Movimiento aislado',
})
try {
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Administración','superadmin'),($2,'Caja','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer'),($5,'Otra caja','operator')",
    [admin, operator, warehouse, viewer, outsider],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Tienda aislada'); insert into public.brands(name) values('Marca aislada');",
  )
  await db.query(
    "insert into public.products(id,sku,name,brand_id) values($1,'CAJA-001','Perfume de prueba',(select id from public.brands limit 1))",
    [product],
  )
  await db.query(
    "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',10),($1,'warehouse',10)",
    [product],
  )
  await db.query(
    "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',500)",
    [product],
  )
  await db.query(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,250)',
    [product],
  )
  await db.exec(
    "insert into public.customers(name,active) values('Cliente activo',true),('Cliente archivado',false)",
  )
  await identity(db, admin)
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 0,
    openingUsd: 0,
  })
  const today = (
    await db.query(
      "select (now() at time zone 'America/Managua')::date::text as local_day",
    )
  ).rows[0].local_day
  await identity(db, operator)
  const request = invoice()
  const sold = await call('create_document', request)
  equal(
    (await call('create_document', request)).id,
    sold.id,
    'reintento de venta no duplica factura',
  )
  equal(
    (await db.query('select count(*)::int n from public.customers')).rows[0].n,
    2,
    'Caja puede elegir clientes activos y crear el de su factura',
  )
  equal(
    (await db.query('select count(*)::int n from public.product_costs')).rows[0]
      .n,
    0,
    'Caja no puede leer costos',
  )
  equal(
    (await db.query('select count(*)::int n from public.inventory_movements'))
      .rows[0].n,
    0,
    'Caja no puede leer siquiera movimientos propios de venta',
  )
  equal(
    (
      await db.query(
        'select quantity from public.inventory_balances where product_id=$1 and location=$2',
        [product, 'store'],
      )
    ).rows[0].quantity,
    9,
    'se conserva disponibilidad para facturar',
  )
  for (const type of ['ENTRY', 'EXIT', 'DAMAGED', 'ADJUSTMENT']) {
    await denied(call('record_inventory_movement', movement(type)))
    await denied(
      db.query('select private.record_inventory_movement($1::jsonb)', [
        JSON.stringify(movement(type)),
      ]),
    )
  }
  const proforma = invoice({
    kind: 'proforma',
    validUntil: today,
    paymentMethod: null,
    location: null,
  })
  await denied(call('create_document', proforma))
  await denied(
    db.query('select private.create_document($1::jsonb)', [
      JSON.stringify(proforma),
    ]),
  )
  await denied(
    call('save_customer', {
      id: crypto.randomUUID(),
      revision: 0,
      name: 'Fuera de caja',
      priceTier: 'emprendedor',
      active: true,
    }),
  )
  await identity(db, admin)
  await call('record_inventory_movement', movement('EXIT'))
  await identity(db, warehouse)
  await call('record_inventory_movement', movement('EXIT'))
  equal(
    (await db.query('select count(*)::int n from public.inventory_movements'))
      .rows[0].n,
    1,
    'Bodega mantiene historial propio',
  )
  await denied(call('create_document', invoice({ customerPhone: null })))
  await identity(db, outsider)
  const theirRequest = invoice({
    customerPhone: null,
    customerName: 'Cliente de otra caja',
  })
  await call('create_document', theirRequest)
  equal(
    (await db.query('select count(*)::int n from public.documents')).rows[0].n,
    1,
    'cada caja ve únicamente sus facturas',
  )
  await identity(db, admin)
  // Un usuario que antes tuvo permisos de administración no recupera una
  // proforma antigua al repetir la misma solicitud ya con rol Caja.
  const previous = invoice({
    kind: 'proforma',
    validUntil: today,
    paymentMethod: null,
    location: null,
    customerPhone: null,
  })
  const quote = await call('create_document', previous)
  await db.exec('reset role')
  await db.query(
    "update public.staff_members set role='operator' where user_id=$1",
    [admin],
  )
  await identity(db, admin)
  equal(
    (
      await db.query(
        'select count(*)::int n from public.documents where id=$1',
        [quote.id],
      )
    ).rows[0].n,
    0,
    'proformas antiguas no se exponen al cambiar a Caja',
  )
  equal(
    (
      await db.query(
        'select count(*)::int n from public.document_items where document_id=$1',
        [quote.id],
      )
    ).rows[0].n,
    0,
  )
  await denied(call('create_document', previous))
  equal(
    (await db.query('select count(*)::int n from public.inventory_movements'))
      .rows[0].n,
    0,
  )
  await identity(db, operator)
  equal(
    (
      await db.query(
        'select quantity from public.inventory_balances where product_id=$1 and location=$2',
        [product, 'store'],
      )
    ).rows[0].quantity,
    6,
    'intentos denegados no modificaron existencias',
  )
  await db.exec('reset role')
  equal(
    (await db.query('select count(*)::int n from public.documents')).rows[0].n,
    3,
    'dos facturas y una proforma autorizada, sin duplicados',
  )
  console.log(
    `PASS cashier access: ${checks} checks; Caja factura, administra solo su historial y no modifica inventario ni accede a proformas, costos o movimientos`,
  )
} finally {
  await db.close()
}

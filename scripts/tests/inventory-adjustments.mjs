import assert from 'node:assert/strict'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
  warehouse,
  viewer,
} from './database-fixture.mjs'

const db = await database()
const superadmin = '66666666-6666-4666-8666-666666666666'
const inactive = '77777777-7777-4777-8777-777777777777'
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000201'
const pending = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000202'
const legacy = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000203'
const uncosted = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000204'
let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const one = async (sql, values = []) => (await db.query(sql, values)).rows[0]
const owner = async (sql, values = []) => {
  await db.exec('reset role')
  try {
    return await one(sql, values)
  } finally {
    await db.exec('set role authenticated')
  }
}
const reject = async (input, expected) => {
  await assert.rejects(rpc(db, 'record_inventory_movement', input), expected)
  checks++
}
const adjustment = (quantity, expectedQuantity, extra = {}) => ({
  requestId: crypto.randomUUID(),
  productId: product,
  location: 'store',
  type: 'ADJUSTMENT',
  quantity,
  expectedQuantity,
  reference: 'CONTEO-FISICO',
  note: 'Existencias verificadas por el dueño mediante conteo físico',
  ...extra,
})
const movement = (id) =>
  owner(
    `select product_id,location,type,quantity,before_quantity,after_quantity,
     actor_id,reference,note from public.inventory_movements where id=$1`,
    [id],
  )
const balance = (id = product, location = 'store') =>
  owner(
    'select quantity from public.inventory_balances where product_id=$1 and location=$2',
    [id, location],
  )
const value = () =>
  owner(
    'select quantity,value_nio::text from private.inventory_value_balances where product_id=$1',
    [product],
  )

try {
  await db.exec(
    `insert into private.pending_staff(email,display_name,role) values
     ('owner@example.test','Dueño','superadmin'),
     ('inactive@example.test','Dueño inactivo','superadmin')`,
  )
  await db.query(
    "insert into auth.users(id,email) values($1,'owner@example.test'),($2,'inactive@example.test')",
    [superadmin, inactive],
  )
  await db.query(
    'update public.staff_members set active=false where user_id=$1',
    [inactive],
  )
  await db.query(
    `insert into public.staff_members(user_id,display_name,role,active) values
     ($1,'Admin','admin',true),($2,'Bodega','warehouse',true),
     ($3,'Caja','operator',true),($4,'Consulta','viewer',true)`,
    [admin, warehouse, operator, viewer],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Conteos aislados'); insert into public.brands(name) values('Marca de conteos');",
  )
  for (const [id, sku, quantity, cost] of [
    [product, 'COUNT-1', 10, 100],
    [pending, 'COUNT-2', null, null],
    [legacy, 'COUNT-3', 5, 50],
    [uncosted, 'COUNT-4', 0, null],
  ]) {
    await db.query(
      `insert into public.products(id,sku,name,brand_id)
       values($1,$2,'Perfume para conteo',(select id from public.brands limit 1))`,
      [id, sku],
    )
    await db.query(
      `insert into public.inventory_balances(product_id,location,quantity)
       values($1,'store',$2),($1,'warehouse',0)`,
      [id, quantity],
    )
    if (cost !== null)
      await db.query(
        'insert into public.product_costs(product_id,average_cost_nio) values($1,$2)',
        [id, cost],
      )
  }
  await identity(db, superadmin)
  const today = (
    await one(
      "select (now() at time zone 'America/Managua')::date::text as day",
    )
  ).day
  await rpc(db, 'record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: today,
    description: 'Inventario inicial antes del conteo',
    reference: 'CONTEO',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1130', debit: 1250, credit: 0 },
      { account: '3110-001', debit: 0, credit: 1250 },
    ],
  })

  const increase = adjustment(13, 10)
  const increased = await rpc(db, 'record_inventory_movement', increase)
  eq(await balance(), { quantity: 13 })
  eq(await movement(increased), {
    product_id: product,
    location: 'store',
    type: 'ADJUSTMENT',
    quantity: 13,
    before_quantity: 10,
    after_quantity: 13,
    actor_id: superadmin,
    reference: increase.reference,
    note: increase.note,
  })
  eq(await value(), { quantity: 13, value_nio: '1300.00' })
  eq(
    await owner(
      'select quantity,unit_cost_nio::text from private.inventory_count_gains where movement_id=$1',
      [increased],
    ),
    { quantity: 3, unit_cost_nio: '100.000000' },
  )

  const lowered = await rpc(db, 'record_inventory_movement', adjustment(8, 13))
  eq(await balance(), { quantity: 8 })
  eq((await movement(lowered)).before_quantity, 13)
  eq((await movement(lowered)).after_quantity, 8)
  eq(
    await owner(
      'select quantity,total_cost_nio::text from public.inventory_movement_costs where movement_id=$1',
      [lowered],
    ),
    { quantity: 5, total_cost_nio: '500.00' },
  )
  eq(await value(), { quantity: 8, value_nio: '800.00' })

  eq(await rpc(db, 'record_inventory_movement', increase), increased)
  eq(await balance(), { quantity: 8 }, 'El reintento no repite el ajuste')
  await reject({ ...increase, quantity: 14 }, /otros datos/)
  await reject({ ...increase, expectedQuantity: 9 }, /otro conteo esperado/)
  await reject(adjustment(0, 13), /Las existencias cambiaron/)
  eq(
    await balance(),
    { quantity: 8 },
    'Un conteo desactualizado no borra stock',
  )
  for (const quantity of [-1, 0.5, 1000001])
    await reject(
      adjustment(quantity, 8),
      /Cantidad inválida|cantidad debe ser entera/,
    )
  await reject(adjustment(0, 8, { note: '' }), /motivo/)

  const zeroed = await rpc(db, 'record_inventory_movement', adjustment(0, 8))
  eq((await movement(zeroed)).before_quantity, 8)
  eq((await movement(zeroed)).after_quantity, 0)
  eq(await value(), { quantity: 0, value_nio: '0.00' })
  eq(await balance(product, 'warehouse'), { quantity: 0 })
  eq(
    await owner(
      'select average_cost_nio::text from public.product_costs where product_id=$1',
      [product],
    ),
    { average_cost_nio: '100.000000' },
    'El conteo conserva el costo promedio y no inventa una compra',
  )
  const initial = await rpc(
    db,
    'record_inventory_movement',
    adjustment(7, null, { productId: pending }),
  )
  eq((await movement(initial)).before_quantity, null)
  eq((await movement(initial)).after_quantity, 7)
  eq(await balance(pending), { quantity: 7 })
  eq(
    await owner(
      'select count(*)::int n from public.product_costs where product_id=$1',
      [pending],
    ),
    { n: 0 },
    'Un conteo inicial mantiene el costo pendiente',
  )
  await reject(
    adjustment(8, 7, { productId: pending }),
    /Falta registrar el costo/,
  )
  await reject(
    adjustment(6, 7, { productId: pending }),
    /Falta registrar el costo/,
  )
  eq(
    await balance(pending),
    { quantity: 7 },
    'La falta de costo revierte el ajuste completo y conserva el inventario',
  )
  const book = (await one('select public.ledger_report($1,$1) r', [today])).r
  const account = (code) => book.accounts.find((row) => row.code === code)
  eq(
    account('4190').credit,
    300,
    'Sobrantes mantienen el reconocimiento contable',
  )
  eq(
    account('5150').debit,
    1300,
    'Faltantes mantienen el gasto y su costo histórico',
  )
  eq(
    account('1130').closing,
    250,
    'El inventario contable conserva las otras cinco unidades',
  )
  eq(await owner('select count(*)::int n from public.purchase_shipments'), {
    n: 0,
  })
  eq(
    await owner('select count(*)::int n from public.purchase_shipment_lines'),
    { n: 0 },
  )
  eq(
    await owner(
      "select count(*)::int n from public.inventory_movements where type='ADJUSTMENT'",
    ),
    { n: 4 },
    'Cada conteo crea exactamente un movimiento con trazabilidad',
  )

  for (const who of [admin, warehouse, operator, viewer, inactive]) {
    await identity(db, who)
    await reject(adjustment(9, 0), { code: '42501' })
    await assert.rejects(
      db.query('select private.record_inventory_movement($1::jsonb)', [
        JSON.stringify(adjustment(9, 0)),
      ]),
      { code: '42501' },
    )
    checks++
  }
  eq(await balance(), { quantity: 0 })
  await db.exec('reset role')
  await db.query(
    "update public.staff_members set role='admin' where user_id=$1",
    [superadmin],
  )
  await identity(db, superadmin)
  await reject(increase, { code: '42501' })
  await db.exec('reset role')
  await db.query(
    "update public.staff_members set role='superadmin' where user_id=$1",
    [superadmin],
  )

  // Las autorizaciones vigentes de entradas, salidas y mermas se conservan.
  for (const who of [admin, warehouse]) {
    await identity(db, who)
    for (const type of ['EXIT', 'DAMAGED']) {
      await rpc(db, 'record_inventory_movement', {
        ...adjustment(1, undefined),
        productId: legacy,
        type,
      })
    }
    await rpc(db, 'record_inventory_movement', {
      requestId: crypto.randomUUID(),
      productId: uncosted,
      location: 'store',
      type: 'ENTRY',
      quantity: 1,
      note: 'Entrada permitida por el flujo anterior sin costo confirmado',
    })
  }
  eq(await balance(legacy), { quantity: 1 })
  eq(await balance(uncosted), { quantity: 2 })
  console.log(
    `PASS ajustes de inventario: ${checks} comprobaciones de SuperAdmin activo, conteos, historial, concurrencia, reintentos y contabilidad sin compras`,
  )
} finally {
  await db.close()
}

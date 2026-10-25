import assert from 'node:assert/strict'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
  viewer,
} from './database-fixture.mjs'

const db = await database()
let checks = 0
const eq = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
}
const reject = async (input, message) => {
  await assert.rejects(rpc(db, 'record_inventory_movement', input), message)
  checks++
}
const id = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`
const zero = (n) => ({
  requestId: crypto.randomUUID(),
  productId: id(n),
  location: 'warehouse',
  type: 'ADJUSTMENT',
  quantity: 0,
  expectedQuantity: null,
  note: 'Bodega confirmada vacía desde registro de costo',
})
const balance = async (n) =>
  (
    await db.query(
      'select location,quantity from public.inventory_balances where product_id=$1 order by location',
      [id(n)],
    )
  ).rows
const cost = async (n) =>
  (
    await db.query(
      'select average_cost_nio from public.product_costs where product_id=$1',
      [id(n)],
    )
  ).rows[0]?.average_cost_nio ?? null
try {
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Admin','admin'),($2,'Caja','operator'),($3,'Consulta','viewer')",
    [admin, operator, viewer],
  )
  await db.exec(
    "insert into public.brands(name) values('Marca de prueba'); insert into public.products(id,sku,name,brand_id) select ('aaaaaaaa-aaaa-4aaa-8aaa-'||lpad(n::text,12,'0'))::uuid,'QA-'||n,'Perfume '||n,(select id from public.brands limit 1) from generate_series(1,6)n; insert into public.inventory_balances(product_id,location,quantity) select id,'store',5 from public.products; insert into public.inventory_balances(product_id,location,quantity) select id,'warehouse',null from public.products;",
  )
  await identity(db, admin)
  const first = zero(1)
  const movement = await rpc(db, 'record_inventory_movement', first)
  eq(await balance(1), [
    { location: 'store', quantity: 5 },
    { location: 'warehouse', quantity: 0 },
  ])
  eq(
    await cost(1),
    null,
    'Registrar ubicación vacía no inventa ni registra el costo',
  )
  eq(
    (await db.query('select count(*)::int n from public.opening_cost_records'))
      .rows[0].n,
    0,
  )
  const input = {
    requestId: crypto.randomUUID(),
    productId: id(1),
    unitCost: 100,
    currency: 'NIO',
    exchangeRate: 1,
    note: 'Costo confirmado de las cinco unidades existentes',
  }
  const opening = await rpc(db, 'set_opening_cost', input)
  eq(await cost(1), '100.000000')
  eq(
    (
      await db.query(
        'select quantity from public.opening_cost_records where id=$1',
        [opening],
      )
    ).rows[0].quantity,
    5,
  )
  eq(await rpc(db, 'set_opening_cost', input), opening)
  await rpc(db, 'record_inventory_movement', {
    requestId: crypto.randomUUID(),
    productId: id(1),
    location: 'warehouse',
    type: 'ADJUSTMENT',
    quantity: 2,
    expectedQuantity: 0,
    note: 'Dos unidades encontradas y contadas con respaldo',
  })
  eq(
    await rpc(db, 'record_inventory_movement', first),
    movement,
    'Una respuesta perdida recupera el cero original sin deshacer un conteo posterior',
  )
  eq((await balance(1))[1].quantity, 2)
  await reject({ ...first, expectedQuantity: 0 }, /otro conteo esperado/)
  const race = zero(2)
  await rpc(db, 'record_inventory_movement', {
    ...race,
    requestId: crypto.randomUUID(),
    quantity: 7,
    note: 'Conteo físico realizado por otra persona',
  })
  await reject(race, /Las existencias cambiaron/)
  eq(
    (await balance(2))[1].quantity,
    7,
    'No se borran las cantidades contadas durante la confirmación',
  )
  eq(
    (
      await db.query(
        'select count(*)::int n from public.inventory_movements where product_id=$1',
        [id(2)],
      )
    ).rows[0].n,
    1,
  )
  for (const expectedQuantity of ['0', false, {}, -1, 0.5, 1000001])
    await reject({ ...zero(3), expectedQuantity }, /conteo esperado/)
  eq((await balance(3))[1].quantity, null)
  const legacy = { ...zero(3) }
  delete legacy.expectedQuantity
  await rpc(db, 'record_inventory_movement', legacy)
  eq(
    (await balance(3))[1].quantity,
    0,
    'Los clientes anteriores conservan el contrato existente',
  )
  for (const who of [operator, viewer]) {
    await identity(db, who)
    await reject(zero(4), /privilege|permission|42501/i)
  }
  await identity(db, admin)
  eq((await balance(4))[1].quantity, null)
  const today = (
    await db.query(
      "select (now() at time zone 'America/Managua')::date::text as day",
    )
  ).rows[0].day
  const day = await rpc(db, 'open_business_day', {
    requestId: crypto.randomUUID(),
    expectedDay: today,
    openingNio: 0,
    openingUsd: 0,
  })
  await rpc(db, 'close_business_day', {
    requestId: crypto.randomUUID(),
    day: today,
    countedNio: 0,
    countedUsd: 0,
    expectedRevision: day.revision,
    expectedStateToken: day.stateToken,
    note: '',
  })
  await reject(zero(5), /jornada.*cerrada/i)
  eq(
    (await balance(5))[1].quantity,
    null,
    'El cierre de jornada también protege el atajo',
  )
  console.log(
    `PASS conteos esperados: ${checks} comprobaciones de ceros explícitos, costo de una ubicación, concurrencia, reintentos, compatibilidad y permisos`,
  )
} finally {
  await db.close()
}

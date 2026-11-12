import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
  warehouse,
  viewer,
} from './database-fixture.mjs'

const migration =
  '20261111230000_orden_automatica_para_aumentos_de_inventario.sql'
const db = await database({ beforeMigration: migration })
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000005101'
const uncosted = 'aaaaaaaa-aaaa-4aaa-8aaa-000000005102'
let checks = 0
const eq = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const owner = async (sql, args = []) => {
  await db.exec('reset role')
  try {
    return await one(sql, args)
  } finally {
    await identity(db, admin)
  }
}
const record = (input) => rpc(db, 'record_inventory_movement', input)
const increase = (quantity, expectedQuantity, extra = {}) => ({
  requestId: crypto.randomUUID(),
  productId: product,
  location: 'store',
  type: 'ADJUSTMENT',
  quantity,
  expectedQuantity,
  adjustmentKind: 'correction',
  note: 'Unidades encontradas por ajuste, sin compra',
  ...extra,
})
const reject = async (input, expected) => {
  await assert.rejects(record(input), expected)
  checks++
}
const state = () =>
  owner(
    `select b.quantity,v.value_nio::text,c.average_cost_nio::text
     from public.inventory_balances b
     left join private.inventory_value_balances v on v.product_id=b.product_id
     left join public.product_costs c on c.product_id=b.product_id
     where b.product_id=$1 and b.location='store'`,
    [product],
  )
const totals = () =>
  owner(`select (select count(*)::int from public.inventory_movements) movements,
    (select count(*)::int from public.journal_entries) journals`)
const journal = (movement) =>
  owner(
    `select jsonb_agg(jsonb_build_object('account',l.account,'debit',l.debit_nio,'credit',l.credit_nio)
       order by l.line_no) lines
     from private.inventory_adjustment_journals j join public.journal_lines l on l.entry_id=j.entry_id
     where j.movement_id=$1`,
    [movement],
  )

try {
  await db.query(
    `insert into public.staff_members(user_id,display_name,role) values
      ($1,'Dueño','superadmin'),($2,'Caja','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer')`,
    [admin, operator, warehouse, viewer],
  )
  await db.exec(`insert into public.business_settings(name) values('Aumentos automáticos QA');
    insert into public.brands(name) values('Marca QA');
    insert into public.ledger_accounts(code,name,parent,bucket,nature,postable,active)
    values('7000-001','Cuenta existente del dueño','7000','memorandum','debit',true,true);`)
  for (const [id, sku, cost] of [
    [product, 'AUTO-500', 500],
    [uncosted, 'AUTO-PENDING', null],
  ]) {
    await db.query(
      `insert into public.products(id,sku,name,brand_id)
       values($1,$2,'Perfume QA',(select id from public.brands limit 1))`,
      [id, sku],
    )
    await db.query(
      "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',2),($1,'warehouse',0)",
      [id],
    )
    if (cost !== null)
      await db.query(
        'insert into public.product_costs(product_id,average_cost_nio) values($1,$2)',
        [id, cost],
      )
  }
  await identity(db, admin)
  const today = (
    await one(
      "select (now() at time zone 'America/Managua')::date::text as day",
    )
  ).day
  await rpc(db, 'record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: today,
    description: 'Inventario inicial QA',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1130', debit: 1000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 1000 },
    ],
  })
  await rpc(db, 'open_business_day', {
    requestId: crypto.randomUUID(),
    expectedDay: today,
    openingNio: 0,
    openingUsd: 0,
  })
  const historical = await record(
    increase(3, 2, { counterAccount: '7000-001' }),
  )
  const originalJournal = await journal(historical)
  await db.exec('reset role')
  await db.exec(
    (
      await readFile(`backend/supabase/migrations/${migration}`, 'utf8')
    ).replace(/\r\n/g, '\n'),
  )
  await identity(db, admin)
  const automatic = await owner(
    `select a.code,a.name,a.bucket,a.postable,a.active from private.inventory_adjustment_defaults d
     join public.ledger_accounts a on a.code=d.increase_account`,
  )
  eq(automatic, {
    code: '7000-002',
    name: 'Ajustes de inventario',
    bucket: 'memorandum',
    postable: true,
    active: true,
  })
  eq(
    (await one("select name from public.ledger_accounts where code='7000-001'"))
      .name,
    'Cuenta existente del dueño',
    'No reemplaza una cuenta existente',
  )
  eq(await journal(historical), originalJournal, 'Conserva el histórico')
  await assert.rejects(
    db.query('select * from private.inventory_adjustment_defaults'),
    /permission denied/i,
  )
  checks++

  const input = increase(4, 3)
  const movement = await record(input)
  eq(await state(), {
    quantity: 4,
    value_nio: '2000.00',
    average_cost_nio: '500.000000',
  })
  eq((await journal(movement)).lines, [
    { account: '1130', debit: 500, credit: 0 },
    { account: automatic.code, debit: 0, credit: 500 },
  ])
  eq(
    await one(
      'select adjustment_kind,counter_account from public.inventory_movements where id=$1',
      [movement],
    ),
    { adjustment_kind: 'correction', counter_account: automatic.code },
  )
  const savedTotals = await totals()
  eq(await record(input), movement)
  eq(await totals(), savedTotals, 'Reintentar no duplica unidades ni asiento')
  await reject({ ...input, quantity: 5 }, /operación|solicitud/i)
  await reject(increase(5, 3), /existencias cambiaron/i)
  await reject(increase(3, 4), /deducción|contrapartida/i)
  await reject(increase(4, 4), /aumentar|cambiar/i)
  await reject(increase(5, 4, { counterAccount: null }), /contrapartida/i)
  await reject(increase(5, 4, { adjustmentKind: 'loss' }), /disminuir/i)
  await reject(increase(5, 4, { type: 'ENTRY' }), /tratamiento/i)
  await reject(increase(3, 2, { productId: uncosted }), /costo/i)
  eq(await totals(), savedTotals, 'Los rechazos son atómicos')

  for (const user of [operator, warehouse, viewer]) {
    await identity(db, user)
    await reject(increase(5, 4), /permission|privilege|permiso|SuperAdmin/i)
  }
  await identity(db, admin)
  await owner('update public.ledger_accounts set active=false where code=$1', [
    automatic.code,
  ])
  await reject(increase(5, 4), /cuenta de orden/i)
  eq(
    await record(input),
    movement,
    'Recupera un guardado aunque la cuenta esté inactiva',
  )
  await owner('update public.ledger_accounts set active=true where code=$1', [
    automatic.code,
  ])
  await record(increase(6, 4))
  const book = (await one('select public.ledger_report($1,$1) r', [today])).r
  const account = (code) => book.accounts.find((a) => a.code === code)
  eq(account(automatic.code).credit, 1500)
  eq(account('4190').credit, 0, 'Los aumentos no generan ingresos')
  eq(account('5150').debit, 0, 'Los aumentos no generan pérdidas')
  eq(
    book.accounts
      .filter((a) => a.postable)
      .reduce((s, a) => s + a.debit - a.credit, 0),
    0,
    'La balanza mantiene la partida doble',
  )
  await record(increase(5, 6, { counterAccount: '7000-001' }))
  await record(increase(4, 5, { adjustmentKind: 'loss' }))
  const context = (
    await db.query('select public.inventory_adjustment_void_context($1) r', [
      movement,
    ])
  ).rows[0].r
  eq(context.canVoid, true)
  const reversal = await rpc(db, 'void_inventory_adjustment', {
    requestId: crypto.randomUUID(),
    movementId: movement,
    stateToken: context.stateToken,
    reason: 'Anular la unidad agregada por equivocación',
  })
  eq((await journal(reversal.reversalMovementId)).lines, [
    { account: '1130', debit: 0, credit: 500 },
    { account: automatic.code, debit: 500, credit: 0 },
  ])
  eq((await state()).quantity, 3)
  eq((await one('select count(*)::int n from public.purchase_shipments')).n, 0)
  eq(await journal(historical), originalJournal)
  console.log(
    `PASS aumentos automáticos de inventario: ${checks} comprobaciones`,
  )
} finally {
  await db.close()
}

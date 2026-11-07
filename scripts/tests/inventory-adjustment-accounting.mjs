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

const migration = '20261107200000_ajustes_de_inventario_con_contrapartida.sql'
const db = await database({ beforeMigration: migration })
const superadmin = '66666666-6666-4666-8666-666666666666'
const inactive = '77777777-7777-4777-8777-777777777777'
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000701'
const historical = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000702'
const fractional = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000703'
let checks = 0
let today
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
const reject = async (
  input,
  expected = /cuenta|contrapartida|ajuste|pérdida|datos|solicitud/i,
) => {
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
  reference: 'CORRECCION-CONTEO',
  note: 'Corrección respaldada por el dueño: el ingreso tenía una cantidad equivocada',
  adjustmentKind: 'correction',
  counterAccount: '3110-001',
  ...extra,
})
const state = (id = product) =>
  owner(
    `select b.quantity,v.value_nio::text,c.average_cost_nio::text
   from public.inventory_balances b
   left join private.inventory_value_balances v on v.product_id=b.product_id
   left join public.product_costs c on c.product_id=b.product_id
   where b.product_id=$1 and b.location='store'`,
    [id],
  )
const ledger = async () =>
  (await one('select public.ledger_report($1,$1) r', [today])).r
const account = (book, code) => book.accounts.find((row) => row.code === code)
const digest = async () =>
  (await one('select public.report_digest($1,$1) r', [today])).r
const losses = async () => {
  const report = await digest()
  return {
    value: report.ledger.inventoryWriteOffNio,
    missing: report.ledger.missingWriteOffUnits,
    months: report.ledger.months.map((m) => ({
      month: m.month,
      value: m.inventoryWriteOffNio,
      missing: m.missingWriteOffUnits,
    })),
  }
}
const movements = () =>
  owner('select count(*)::int n from public.inventory_movements')
const journal = (movementId) =>
  owner(
    `select e.id,e.kind,e.created_by,e.voided_at,
   (select jsonb_agg(jsonb_build_object('account',l.account,'debit',l.debit_nio,'credit',l.credit_nio)
    order by l.line_no) from public.journal_lines l where l.entry_id=e.id) lines
   from private.inventory_adjustment_journals a join public.journal_entries e on e.id=a.entry_id
   where a.movement_id=$1`,
    [movementId],
  )

try {
  await db.exec(`insert into private.pending_staff(email,display_name,role) values
   ('correction-owner@example.test','Dueño de ajustes','superadmin'),
   ('correction-inactive@example.test','Dueño inactivo','superadmin')`)
  await db.query(
    `insert into auth.users(id,email) values
   ($1,'correction-owner@example.test'),($2,'correction-inactive@example.test')`,
    [superadmin, inactive],
  )
  await db.query(
    'update public.staff_members set active=false where user_id=$1',
    [inactive],
  )
  await db.query(
    `insert into public.staff_members(user_id,display_name,role) values
   ($1,'Admin','admin'),($2,'Bodega','warehouse'),($3,'Caja','operator'),($4,'Consulta','viewer')`,
    [admin, warehouse, operator, viewer],
  )
  await db.exec(`insert into public.business_settings(name) values('Ajustes contables aislados');
   insert into public.brands(name) values('Marca para corregir');
   insert into public.ledger_accounts(code,name,parent,bucket,nature,active)
   values('3110-099','Capital inactivo','3110','equity','credit',false)`)
  for (const [id, sku, quantity, cost] of [
    [product, 'CORRECTION-20', 20, 100],
    [historical, 'CORRECTION-LEGACY', 5, 50],
    [fractional, 'CORRECTION-CENTS', 3, 1033.333333],
  ]) {
    await db.query(
      `insert into public.products(id,sku,name,brand_id)
     values($1,$2,'Perfume de corrección',(select id from public.brands limit 1))`,
      [id, sku],
    )
    await db.query(
      `insert into public.inventory_balances(product_id,location,quantity)
     values($1,'store',$2),($1,'warehouse',0)`,
      [id, quantity],
    )
    await db.query(
      'insert into public.product_costs(product_id,average_cost_nio) values($1,$2)',
      [id, cost],
    )
  }
  await identity(db, superadmin)
  today = (
    await one(
      "select (now() at time zone 'America/Managua')::date::text as day",
    )
  ).day
  await rpc(db, 'record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: today,
    description: 'Inventario inicial antes de corregir conteos',
    reference: 'APERTURA',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1130', debit: 5350, credit: 0 },
      { account: '3110-001', debit: 0, credit: 5350 },
    ],
  })

  // A real pre-upgrade loss must retain its original history and accounting.
  const legacyInput = adjustment(4, 5, { productId: historical })
  delete legacyInput.adjustmentKind
  delete legacyInput.counterAccount
  const legacyId = await rpc(db, 'record_inventory_movement', legacyInput)
  const oldMovement = await owner(
    `select to_jsonb(m)-'adjustment_kind'-'counter_account' row
   from public.inventory_movements m where id=$1`,
    [legacyId],
  )
  const oldCost = await owner(
    'select to_jsonb(c) row from public.inventory_movement_costs c where movement_id=$1',
    [legacyId],
  )
  const beforeBook = await ledger()
  const beforeLosses = await losses()
  eq(beforeLosses.value, 50)
  await db.exec('reset role')
  await db.exec(
    await readFile(`backend/supabase/migrations/${migration}`, 'utf8'),
  )
  await identity(db, superadmin)
  eq(
    await owner(
      `select to_jsonb(m)-'adjustment_kind'-'counter_account' row
   from public.inventory_movements m where id=$1`,
      [legacyId],
    ),
    oldMovement,
    'La migración no reescribe el movimiento histórico',
  )
  eq(
    await owner(
      'select to_jsonb(c) row from public.inventory_movement_costs c where movement_id=$1',
      [legacyId],
    ),
    oldCost,
  )
  eq(
    await owner(
      'select adjustment_kind,counter_account from public.inventory_movements where id=$1',
      [legacyId],
    ),
    { adjustment_kind: null, counter_account: null },
  )
  eq(
    await ledger(),
    beforeBook,
    'El upgrade conserva el libro histórico completo',
  )
  eq(await losses(), beforeLosses, 'La pérdida anterior conserva sus resúmenes')
  eq(
    await rpc(db, 'record_inventory_movement', legacyInput),
    legacyId,
    'Reintento del cliente anterior sigue siendo idempotente',
  )

  const downInput = adjustment(15, 20)
  const down = await rpc(db, 'record_inventory_movement', downInput)
  eq(await state(), {
    quantity: 15,
    value_nio: '1500.00',
    average_cost_nio: '100.000000',
  })
  eq(
    await owner(
      `select adjustment_kind,counter_account,before_quantity,after_quantity,actor_id
   from public.inventory_movements where id=$1`,
      [down],
    ),
    {
      adjustment_kind: 'correction',
      counter_account: '3110-001',
      before_quantity: 20,
      after_quantity: 15,
      actor_id: superadmin,
    },
  )
  const downJournal = await journal(down)
  eq(downJournal.kind, 'adjustment')
  eq(downJournal.created_by, superadmin)
  eq(downJournal.voided_at, null)
  eq(
    [...downJournal.lines].sort((a, b) => a.account.localeCompare(b.account)),
    [
      { account: '1130', debit: 0, credit: 500 },
      { account: '3110-001', debit: 500, credit: 0 },
    ],
    'Corregir 20 a 15 reduce inventario contra la cuenta elegida',
  )
  let book = await ledger()
  eq(account(book, '1130').closing, 4800)
  eq(account(book, '5150').debit, 50)
  eq(account(book, '4190').credit, 0)
  eq(
    await losses(),
    beforeLosses,
    'La corrección no se presenta como pérdida ni como costo faltante',
  )

  const upInput = adjustment(18, 15)
  const up = await rpc(db, 'record_inventory_movement', upInput)
  eq(await state(), {
    quantity: 18,
    value_nio: '1800.00',
    average_cost_nio: '100.000000',
  })
  eq(
    [...(await journal(up)).lines].sort((a, b) =>
      a.account.localeCompare(b.account),
    ),
    [
      { account: '1130', debit: 300, credit: 0 },
      { account: '3110-001', debit: 0, credit: 300 },
    ],
    'El aumento invierte las patas, sin generar otros ingresos',
  )
  book = await ledger()
  eq(account(book, '1130').closing, 5100)
  eq(account(book, '4190').credit, 0)
  eq(account(book, '5150').debit, 50)
  eq(await losses(), beforeLosses)
  const detail = (
    await one('select public.get_journal_entry($1) r', [downJournal.id])
  ).r
  eq(detail.inventoryCorrection, true)
  eq(detail.inventoryMovementId, down)
  const page = (
    await one('select public.journal_entries_page($1,$1,0,100) r', [today])
  ).r
  const listed = page.entries.find((entry) => entry.id === downJournal.id)
  eq(listed.inventoryCorrection, true)
  eq(listed.inventoryMovementId, down)
  const bookEntry = book.entries.find((entry) => entry.id === downJournal.id)
  eq(bookEntry.inventoryCorrection, true)
  eq(bookEntry.inventoryMovementId, down)
  await assert.rejects(
    rpc(db, 'correct_journal_entry', {
      requestId: crypto.randomUUID(),
      entryId: downJournal.id,
      expectedRevision: detail.revision,
      occurredOn: today,
      description: 'Intento de cambiar el comprobante vinculado',
      reference: 'CAMBIO-INDEPENDIENTE',
      lines: downJournal.lines.map((line) => ({
        ...line,
        currency: 'NIO',
        exchangeRate: 1,
      })),
    }),
    /pertenece a una corrección de inventario|por separado/,
  )
  checks++
  await assert.rejects(
    db.query('select public.void_journal_entry($1,$2)', [
      downJournal.id,
      'Intento de anular separado del conteo original',
    ]),
    /pertenece a una corrección de inventario|por separado/,
  )
  checks++
  await assert.rejects(
    db.query('select public.count_purchase_context($1)', [up]),
    /ya tiene una contrapartida contable/,
  )
  checks++
  await assert.rejects(
    rpc(db, 'adopt_inventory_counts_as_purchase', {
      requestId: crypto.randomUUID(),
      movementIds: [up],
      expectedTotalNio: 300,
    }),
    /ya tiene una contrapartida contable/,
  )
  checks++
  eq(
    await journal(down),
    downJournal,
    'Rechazar la edición o anulación conserva el comprobante original',
  )
  eq((await state()).quantity, 18)
  eq(
    account(await ledger(), '1130').closing,
    5100,
    'Una corrección no puede adoptarse como compra y duplicar Inventario',
  )
  eq(await rpc(db, 'record_inventory_movement', downInput), down)
  eq(await rpc(db, 'record_inventory_movement', upInput), up)
  eq(
    (await state()).quantity,
    18,
    'Reintentar el conteo anterior no deshace el posterior',
  )
  eq(
    (await journal(down)).id,
    downJournal.id,
    'El reintento no duplica el comprobante',
  )
  await reject({ ...downInput, counterAccount: '2111' })
  await reject({
    ...downInput,
    adjustmentKind: 'loss',
    counterAccount: undefined,
  })
  await reject({
    ...downInput,
    adjustmentKind: undefined,
    counterAccount: undefined,
  })
  await reject(
    { ...downInput, expectedQuantity: 19 },
    /conteo|datos|solicitud/i,
  )

  const lossInput = adjustment(16, 18, {
    adjustmentKind: 'loss',
    counterAccount: undefined,
  })
  const loss = await rpc(db, 'record_inventory_movement', lossInput)
  eq(await state(), {
    quantity: 16,
    value_nio: '1600.00',
    average_cost_nio: '100.000000',
  })
  eq(
    await owner(
      'select adjustment_kind,counter_account from public.inventory_movements where id=$1',
      [loss],
    ),
    { adjustment_kind: 'loss', counter_account: null },
  )
  book = await ledger()
  eq(account(book, '1130').closing, 4900)
  eq(
    account(book, '5150').debit,
    250,
    'La pérdida real conserva 5150, además de la pérdida histórica',
  )
  eq(account(book, '4190').credit, 0)
  eq((await losses()).value, 250)
  eq((await losses()).missing, 0)
  eq((await losses()).months, [
    { month: today.slice(0, 7), value: 250, missing: 0 },
  ])
  eq(await rpc(db, 'record_inventory_movement', lossInput), loss)
  await reject({
    ...lossInput,
    adjustmentKind: 'correction',
    counterAccount: '3110-001',
  })

  const priorCount = await movements()
  for (const counterAccount of [
    undefined,
    null,
    '',
    'NO-EXISTE',
    '1000',
    '3110-099',
    '1130',
    '5150',
    '4190',
    '4110',
    '5120',
    '5130-001',
    '6000',
    '1110-002',
    '1120-002',
    '1120-004',
    '1120-006',
  ]) {
    await reject(adjustment(15, 16, { counterAccount }))
  }
  await reject(adjustment(15, 16, { adjustmentKind: 'otro' }))
  await reject(
    adjustment(15, 16, { adjustmentKind: 'loss', counterAccount: '3110-001' }),
  )
  await reject(
    adjustment(17, 16, { adjustmentKind: 'loss', counterAccount: undefined }),
  )
  await reject(
    adjustment(16, 16, { adjustmentKind: 'loss', counterAccount: undefined }),
  )
  await reject(adjustment(15, 16, { note: '' }), /motivo/)
  await reject(adjustment(15, 18), /Las existencias cambiaron/)
  eq(
    await movements(),
    priorCount,
    'Validaciones fallidas no dejan movimientos parciales',
  )
  eq(await state(), {
    quantity: 16,
    value_nio: '1600.00',
    average_cost_nio: '100.000000',
  })

  // Activo y pasivo también son contrapartidas válidas; no sólo Capital.
  for (const counterAccount of ['1120-001', '2111']) {
    await rpc(
      db,
      'record_inventory_movement',
      adjustment(17, 16, { counterAccount }),
    )
    await rpc(
      db,
      'record_inventory_movement',
      adjustment(16, 17, { counterAccount }),
    )
    eq((await state()).quantity, 16)
    eq(account(await ledger(), counterAccount).closing, 0)
  }

  // Clientes anteriores y mermas conservan su contabilización de siempre.
  await identity(db, warehouse)
  await rpc(db, 'record_inventory_movement', {
    requestId: crypto.randomUUID(),
    productId: historical,
    location: 'store',
    type: 'DAMAGED',
    quantity: 1,
    expectedQuantity: 4,
    note: 'Perfume realmente dañado',
  })
  await identity(db, superadmin)
  const oldClientDown = adjustment(2, 3, { productId: historical })
  delete oldClientDown.adjustmentKind
  delete oldClientDown.counterAccount
  await rpc(db, 'record_inventory_movement', oldClientDown)
  const oldClientUp = {
    ...oldClientDown,
    requestId: crypto.randomUUID(),
    quantity: 3,
    expectedQuantity: 2,
  }
  await rpc(db, 'record_inventory_movement', oldClientUp)
  eq((await state(historical)).quantity, 3)
  book = await ledger()
  eq(account(book, '5150').debit, 350)
  eq(account(book, '4190').credit, 50)
  eq((await losses()).value, 350)
  eq((await losses()).missing, 0)

  // Los centavos de la última unidad se conservan, no se recalculan a partir
  // del promedio a seis decimales ni terminan en un gasto por redondeo.
  const centsFirst = await rpc(
    db,
    'record_inventory_movement',
    adjustment(2, 3, { productId: fractional }),
  )
  eq((await state(fractional)).value_nio, '2066.67')
  eq(
    (await journal(centsFirst)).lines.find((l) => l.account === '1130').credit,
    1033.33,
  )
  const centsLast = await rpc(
    db,
    'record_inventory_movement',
    adjustment(0, 2, { productId: fractional }),
  )
  eq((await state(fractional)).value_nio, '0.00')
  eq((await state(fractional)).quantity, 0)
  eq(
    (await journal(centsLast)).lines.find((l) => l.account === '1130').credit,
    2066.67,
  )
  eq(
    account(await ledger(), '1130').closing,
    1750,
    'Mayor y existencias valorizadas conservan el mismo importe exacto',
  )
  eq((await losses()).value, 350)
  eq(account(await ledger(), '4190').credit, 50)

  // Dos confirmaciones con la misma lectura no pueden pisarse.
  const beforeRace = await movements()
  const race = await Promise.allSettled([
    rpc(db, 'record_inventory_movement', adjustment(17, 16)),
    rpc(db, 'record_inventory_movement', adjustment(15, 16)),
  ])
  eq(race.filter((r) => r.status === 'fulfilled').length, 1)
  eq(race.filter((r) => r.status === 'rejected').length, 1)
  assert.match(
    race.find((r) => r.status === 'rejected').reason.message,
    /Las existencias cambiaron/,
  )
  checks++
  eq((await movements()).n, beforeRace.n + 1)
  const afterRace = await state()
  eq(Number(afterRace.value_nio), afterRace.quantity * 100)
  eq(account(await ledger(), '1130').closing, Number(afterRace.value_nio) + 150)
  eq((await losses()).value, 350)
  eq((await losses()).missing, 0)

  const beforePermissions = await movements()
  for (const who of [admin, warehouse, operator, viewer, inactive]) {
    await identity(db, who)
    await reject(adjustment(14, afterRace.quantity), { code: '42501' })
    await reject(
      adjustment(14, afterRace.quantity, {
        adjustmentKind: 'loss',
        counterAccount: undefined,
      }),
      { code: '42501' },
    )
    await assert.rejects(
      db.query('select private.record_inventory_movement($1::jsonb)', [
        JSON.stringify(adjustment(14, afterRace.quantity)),
      ]),
      { code: '42501' },
    )
    checks++
  }
  await identity(db, superadmin)
  eq(
    await movements(),
    beforePermissions,
    'Usuarios sin autorización no crean movimientos ni comprobantes',
  )
  eq(await state(), afterRace)
  eq(
    await owner('select count(*)::int n from public.purchase_shipments'),
    { n: 0 },
    'Corregir no inventa una compra',
  )
  eq(
    await owner(`select count(*)::int n from private.inventory_adjustment_journals a
   join public.inventory_movements m on m.id=a.movement_id where m.adjustment_kind is distinct from 'correction'`),
    { n: 0 },
  )
  eq((await ledger()).missingCosts, 0)
  console.log(
    `PASS ajustes con contrapartida: ${checks} comprobaciones de corrección, pérdida, historial, centavos, cuentas, permisos, reintentos y concurrencia`,
  )
} finally {
  await db.close()
}

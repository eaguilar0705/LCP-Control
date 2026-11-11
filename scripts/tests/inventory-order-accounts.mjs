import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  database,
  identity,
  rpc,
  admin,
  outsider as superadmin,
  warehouse,
  operator,
  viewer,
} from './database-fixture.mjs'

const migration = '20261111000000_cuentas_de_orden_para_ajustes.sql'
const db = await database({ beforeMigration: migration })
const day = '2026-11-10'
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000001101'
const historical = 'aaaaaaaa-aaaa-4aaa-8aaa-000000001102'
const orderCode = '7000-001'
let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const rejects = async (work, expected) => {
  await assert.rejects(work, expected)
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
const ledger = async () =>
  (await one('select public.ledger_report($1,$1) r', [day])).r
const digest = async () =>
  (await one('select public.report_digest($1,$1) r', [day])).r
const account = (book, code) => book.accounts.find((a) => a.code === code)
const result = (book) =>
  -book.accounts
    .filter(
      (a) =>
        a.postable && ['revenue', 'cost', 'expense', 'tax'].includes(a.bucket),
    )
    .reduce((sum, a) => sum + a.debit - a.credit, 0)
const trial = (book) => {
  const rows = book.accounts.filter((a) => a.postable)
  eq(
    rows.reduce((s, a) => s + a.debit - a.credit, 0),
    0,
  )
  eq(
    rows.reduce((s, a) => s + a.closing, 0),
    0,
  )
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
const counts = () =>
  owner(`select (select count(*)::int from public.inventory_movements) movements,
   (select count(*)::int from public.journal_entries) journals`)
const change = (input) =>
  rpc(db, 'change_ledger_account', { requestId: crypto.randomUUID(), ...input })
const list = async () => (await one('select public.ledger_accounts_list() r')).r
const adjustment = (quantity, expectedQuantity, extra = {}) => ({
  requestId: crypto.randomUUID(),
  productId: product,
  location: 'store',
  type: 'ADJUSTMENT',
  quantity,
  expectedQuantity,
  note: 'Corrección de la cantidad contra la cuenta de orden del dueño',
  adjustmentKind: 'correction',
  counterAccount: orderCode,
  ...extra,
})
const record = (input) => rpc(db, 'record_inventory_movement', input)
const journal = async (movement) =>
  owner(
    `select e.id,e.kind,
   (select jsonb_agg(jsonb_build_object('account',l.account,'debit',l.debit_nio,'credit',l.credit_nio)
     order by l.account) from public.journal_lines l where l.entry_id=e.id) lines
   from private.inventory_adjustment_journals j join public.journal_entries e on e.id=j.entry_id
   where j.movement_id=$1`,
    [movement],
  )
const voidContext = async (id) =>
  (await one('select public.inventory_adjustment_void_context($1) r', [id])).r
const voidInput = (context) => ({
  requestId: crypto.randomUUID(),
  movementId: context.movementId,
  stateToken: context.stateToken,
  reason: 'Anular corrección errónea conservando la cuenta de orden original',
})

try {
  await db.exec(`create or replace function pg_catalog.now() returns timestamptz language sql stable
   as $$select '2026-11-10T20:00:00Z'::timestamptz$$`)
  await db.query(
    `insert into public.staff_members(user_id,display_name,role) values
   ($1,'Dueño','superadmin'),($2,'Administrador','admin'),($3,'Bodega','warehouse'),
   ($4,'Caja','operator'),($5,'Consulta','viewer')`,
    [superadmin, admin, warehouse, operator, viewer],
  )
  await db.exec(`insert into public.business_settings(name) values('Cuenta de orden QA');
   insert into public.brands(name) values('Marca de cuenta de orden')`)
  for (const [id, sku, quantity, cost] of [
    [product, 'ORDER-300', 5, 300],
    [historical, 'ORDER-HISTORY', 2, 50],
  ]) {
    await db.query(
      `insert into public.products(id,sku,name,brand_id)
     values($1,$2,'Perfume de orden',(select id from public.brands limit 1))`,
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
  await rpc(db, 'record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: day,
    description: 'Inventario inicial de las cuentas de orden',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1130', debit: 1600, credit: 0 },
      { account: '3110-001', debit: 0, credit: 1600 },
    ],
  })
  await rpc(db, 'open_business_day', {
    requestId: crypto.randomUUID(),
    expectedDay: day,
    openingNio: 0,
    openingUsd: 0,
  })
  const historicalId = await record(
    adjustment(1, 2, {
      productId: historical,
      adjustmentKind: 'loss',
      counterAccount: undefined,
    }),
  )
  const beforeBook = await ledger()
  const beforeLosses = (await digest()).ledger
  const historicalSnapshot = await owner(
    `select to_jsonb(m) movement,
   (select to_jsonb(c) from public.inventory_movement_costs c where c.movement_id=m.id) cost
   from public.inventory_movements m where m.id=$1`,
    [historicalId],
  )
  eq(beforeLosses.inventoryWriteOffNio, 50)

  await db.exec('reset role')
  await db.exec(
    await readFile(`backend/supabase/migrations/${migration}`, 'utf8'),
  )
  await identity(db, superadmin)
  const upgraded = await ledger()
  eq(
    upgraded.accounts.filter((a) => a.code !== '7000'),
    beforeBook.accounts,
    'La migración conserva los saldos de las cuentas existentes',
  )
  eq(upgraded.entries, beforeBook.entries)
  eq((await digest()).ledger, beforeLosses)
  eq(
    await owner(
      `select to_jsonb(m) movement,
   (select to_jsonb(c) from public.inventory_movement_costs c where c.movement_id=m.id) cost
   from public.inventory_movements m where m.id=$1`,
      [historicalId],
    ),
    historicalSnapshot,
  )
  eq(
    (await list())
      .filter((a) => a.bucket === 'memorandum')
      .map((a) => ({
        code: a.code,
        name: a.name,
        postable: a.postable,
        nature: a.nature,
      })),
    [
      {
        code: '7000',
        name: 'Cuentas de orden',
        postable: false,
        nature: 'debit',
      },
    ],
    'Solo se crea la cuenta mayor, sin elegir ni crear una cuenta de movimiento por el dueño',
  )

  const create = {
    requestId: crypto.randomUUID(),
    action: 'create',
    code: orderCode,
    name: 'Cuenta de orden de ajustes',
    parent: '7000',
  }
  let created = await rpc(db, 'change_ledger_account', create)
  eq(
    [created.bucket, created.nature, created.postable, created.active],
    ['memorandum', 'debit', true, true],
  )
  eq(await rpc(db, 'change_ledger_account', create), created)
  await rejects(
    () =>
      rpc(db, 'change_ledger_account', {
        ...create,
        name: 'Cambiar reintento',
      }),
    /solicitud.*cambió/,
  )
  created = await change({
    action: 'rename',
    code: orderCode,
    name: 'Cuenta de orden de ajustes',
    newCode: '7000-010',
    expectedRevision: created.revision,
  })
  eq(created.display_code, '7000-010')
  eq((await list()).find((a) => a.code === orderCode).displayCode, '7000-010')
  await rejects(
    () =>
      change({
        action: 'rename',
        code: orderCode,
        name: 'Cambio obsoleto',
        newCode: '7000-011',
        expectedRevision: 0,
      }),
    /cuenta cambió/,
  )
  for (const input of [
    { code: '8000-001', parent: '7000' },
    { code: '7000-002', parent: '5130' },
    { code: '1130-007', parent: '7000' },
  ])
    await rejects(
      () => change({ action: 'create', name: 'Cuenta inválida', ...input }),
      /Revisa|mismo tipo/,
    )

  // Los dos flujos de importación conservan el tipo heredado del nuevo mayor.
  await rpc(db, 'save_ledger_account', {
    code: '7000-002',
    name: 'Orden importada',
    parent: '7000',
  })
  const imported = {
    version: 1,
    requestId: crypto.randomUUID(),
    sourceHash: '7'.repeat(64),
    filename: 'Cuentas de orden.xlsx',
    occurredOn: day,
    products: [],
    stocks: [],
    accounts: [{ code: '7000-003', name: 'Orden de Excel', parent: '7000' }],
    openingBalances: [],
    customers: [],
    suppliers: [],
    business: null,
  }
  const importResult = (
    await one('select public.import_business_excel($1::jsonb,false) r', [
      JSON.stringify(imported),
    ])
  ).r
  eq(importResult.accounts, 1)
  eq(
    (await list())
      .filter((a) => ['7000-002', '7000-003'].includes(a.code))
      .map((a) => a.bucket),
    ['memorandum', 'memorandum'],
  )

  const downInput = adjustment(4, 5)
  const down = await record(downInput)
  eq(await state(), {
    quantity: 4,
    value_nio: '1200.00',
    average_cost_nio: '300.000000',
  })
  eq(
    (await journal(down)).lines,
    [
      { account: '1130', debit: 0, credit: 300 },
      { account: orderCode, debit: 300, credit: 0 },
    ],
    'Un perfume de C$300 reduce inventario y aumenta la cuenta de orden',
  )
  let book = await ledger()
  eq(account(book, orderCode).closing, 300)
  eq(account(book, orderCode).displayCode, '7000-010')
  eq(account(book, '1130').closing, account(beforeBook, '1130').closing - 300)
  eq(account(book, '5150').debit, 50)
  eq(account(book, '4190').credit, 0)
  eq(
    result(book),
    result(beforeBook),
    'La cuenta de orden no cambia ingresos, costos ni gastos',
  )
  eq((await digest()).ledger, beforeLosses)
  trial(book)
  const savedCounts = await counts()
  eq(await record(downInput), down)
  eq(
    await counts(),
    savedCounts,
    'El reintento no duplica el movimiento ni el comprobante',
  )
  await rejects(
    () => record({ ...downInput, counterAccount: '7000-002' }),
    /clasificación|contrapartida/,
  )
  for (const counterAccount of ['7000', '5150', '1130', '4110', '7000-999']) {
    await rejects(
      () => record(adjustment(3, 4, { counterAccount })),
      /contrapartida|cuenta/i,
    )
  }
  eq(await counts(), savedCounts)
  eq((await state()).quantity, 4)

  const up = await record(adjustment(5, 4))
  eq((await journal(up)).lines, [
    { account: '1130', debit: 300, credit: 0 },
    { account: orderCode, debit: 0, credit: 300 },
  ])
  eq((await state()).value_nio, '1500.00')
  eq(account(await ledger(), orderCode).closing, 0)
  eq((await digest()).ledger, beforeLosses)
  trial(await ledger())

  const upContext = await voidContext(up)
  eq(upContext.canVoid, true)
  const voidUpRequest = voidInput(upContext)
  const voidUp = await rpc(db, 'void_inventory_adjustment', voidUpRequest)
  eq((await state()).quantity, 4)
  eq((await journal(voidUp.reversalMovementId)).lines, [
    { account: '1130', debit: 0, credit: 300 },
    { account: orderCode, debit: 300, credit: 0 },
  ])
  eq(await rpc(db, 'void_inventory_adjustment', voidUpRequest), voidUp)
  const downContext = await voidContext(down)
  eq(downContext.canVoid, true)
  const voidDown = await rpc(
    db,
    'void_inventory_adjustment',
    voidInput(downContext),
  )
  eq((await journal(voidDown.reversalMovementId)).lines, [
    { account: '1130', debit: 300, credit: 0 },
    { account: orderCode, debit: 0, credit: 300 },
  ])
  eq(await state(), {
    quantity: 5,
    value_nio: '1500.00',
    average_cost_nio: '300.000000',
  })
  eq(account(await ledger(), orderCode).closing, 0)
  eq((await digest()).ledger, beforeLosses)

  // Anular conserva la contrapartida original incluso si ya está inactiva.
  const inactiveDown = await record(adjustment(4, 5))
  created = (await list()).find((a) => a.code === orderCode)
  await change({
    action: 'deactivate',
    code: orderCode,
    expectedRevision: created.revision,
  })
  await rejects(() => record(adjustment(3, 4)), /contrapartida activa/)
  const inactiveContext = await voidContext(inactiveDown)
  eq(inactiveContext.canVoid, true)
  await rpc(db, 'void_inventory_adjustment', voidInput(inactiveContext))
  eq((await state()).quantity, 5)
  eq(account(await ledger(), orderCode).closing, 0)
  created = (await list()).find((a) => a.code === orderCode)
  await change({
    action: 'activate',
    code: orderCode,
    expectedRevision: created.revision,
  })

  const beforeRace = await counts()
  const race = await Promise.allSettled([
    record(adjustment(4, 5)),
    record(adjustment(6, 5)),
  ])
  eq(race.filter((r) => r.status === 'fulfilled').length, 1)
  eq(race.filter((r) => r.status === 'rejected').length, 1)
  assert.match(
    race.find((r) => r.status === 'rejected').reason.message,
    /Las existencias cambiaron/,
  )
  checks++
  eq((await counts()).movements, beforeRace.movements + 1)
  eq((await counts()).journals, beforeRace.journals + 1)
  const afterRace = await state()
  eq(Number(afterRace.value_nio), afterRace.quantity * 300)
  book = await ledger()
  eq(account(book, orderCode).closing, 1500 - Number(afterRace.value_nio))
  eq(result(book), result(beforeBook))
  eq((await digest()).ledger, beforeLosses)
  trial(book)

  const beforePermissions = await counts()
  for (const who of [admin, warehouse, operator, viewer]) {
    await identity(db, who)
    await rejects(
      () => record(adjustment(afterRace.quantity - 1, afterRace.quantity)),
      { code: '42501' },
    )
  }
  await identity(db, warehouse)
  await rejects(
    () =>
      change({
        action: 'create',
        code: '7000-004',
        parent: '7000',
        name: 'No autorizada',
      }),
    { code: '42501' },
  )
  await identity(db, superadmin)
  eq(await counts(), beforePermissions)
  eq(await state(), afterRace)

  const orderBeforeLoss = account(await ledger(), orderCode).closing
  await record(
    adjustment(afterRace.quantity - 1, afterRace.quantity, {
      adjustmentKind: 'loss',
      counterAccount: undefined,
    }),
  )
  book = await ledger()
  eq(account(book, orderCode).closing, orderBeforeLoss)
  eq(
    account(book, '5150').debit,
    350,
    'Elegir pérdida real conserva el gasto a costo',
  )
  eq((await digest()).ledger.inventoryWriteOffNio, 350)
  trial(book)
  console.log(
    `PASS cuentas de orden: ${checks} comprobaciones de catálogo, importación, ajustes, historial, costos, balanza, pérdidas, anulación, permisos y concurrencia`,
  )
} finally {
  await db.close()
}

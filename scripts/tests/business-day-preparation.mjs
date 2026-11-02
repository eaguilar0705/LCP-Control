import assert from 'node:assert/strict'
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

const db = await database()
let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const reject = async (promise, pattern) => {
  await assert.rejects(promise, pattern)
  checks++
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const call = (name, input) => rpc(db, name, input)
const state = async (date = null) =>
  (await one('select public.get_business_day($1) r', [date])).r
const history = async (date) =>
  (await one('select public.get_business_day_history($1) r', [date])).r
const today = '2026-11-02'
const preparation = (overrides = {}) => ({
  requestId: crypto.randomUUID(),
  day: today,
  expectedPreparationRevision: 0,
  openingNio: 1000,
  openingUsd: 20,
  ...overrides,
})
try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.preparation_now')::timestamptz$$",
  )
  await db.query(
    "select set_config('lcp.preparation_now','2026-11-02T15:00:00Z',false)",
  )
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Administrador','admin'),($2,'Caja','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer'),($5,'Propietario','superadmin')",
    [admin, operator, warehouse, viewer, outsider],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Negocio aislado')",
  )
  await db.exec(
    "insert into public.brands(name) values('Marca aislada'); insert into public.products(id,sku,name,brand_id) values('aaaaaaaa-aaaa-4aaa-8aaa-000000000001','QA-001','Producto aislado',(select id from public.brands limit 1)); insert into public.inventory_balances(product_id,location,quantity) values('aaaaaaaa-aaaa-4aaa-8aaa-000000000001','store',20); insert into public.product_prices(product_id,tier_code,currency,amount) values('aaaaaaaa-aaaa-4aaa-8aaa-000000000001','emprendedor','NIO',250); insert into public.product_costs(product_id,average_cost_nio) values('aaaaaaaa-aaaa-4aaa-8aaa-000000000001',100)",
  )
  const first = preparation()
  for (const uid of [operator, warehouse, viewer]) {
    await identity(db, uid)
    await reject(
      call('prepare_business_day', first),
      /permission|insufficient/i,
    )
  }
  await identity(db, '', 'anon')
  await reject(call('prepare_business_day', first), /permission/)
  await identity(db, admin)
  for (const changes of [
    { openingNio: -1 },
    { openingUsd: 0.001 },
    { openingNio: 100000001 },
    { expectedPreparationRevision: null },
    { day: '2026-11-01' },
    { day: '2026-11-03' },
  ]) {
    await reject(
      call('prepare_business_day', preparation(changes)),
      /importe|valor|monto|número|decimales|100000000|cambió|hoy/i,
    )
  }
  let day = await call('prepare_business_day', first)
  eq(day.status, 'not_opened')
  eq(day.openDay, null)
  eq(day.openingNio, null)
  eq(day.openingDraft.openingNio, 1000)
  eq(day.openingDraft.revision, 1)
  eq(await call('prepare_business_day', first), day, 'un reintento no duplica')
  await reject(
    call('prepare_business_day', { ...first, openingNio: 2000 }),
    /solicitud.*cambió/,
  )
  await reject(call('prepare_business_day', preparation()), /cambió/)
  await reject(
    call(
      'prepare_business_day',
      preparation({ expectedPreparationRevision: 1 }),
    ),
    /coinciden/,
  )
  const confirmation = await one(
    'select public.get_operation_confirmation($1,$2) r',
    ['business-day-prepare', first.requestId],
  )
  eq(confirmation.r.status, 'confirmed')
  const retired = preparation({
    expectedPreparationRevision: 1,
    openingNio: 1200,
  })
  eq(
    (
      await one('select public.retire_unconfirmed_operation($1,$2) r', [
        'business-day-prepare',
        retired.requestId,
      ])
    ).r.status,
    'retired',
  )
  await reject(call('prepare_business_day', retired), /descartada/)
  eq((await state()).openingDraft.revision, 1)
  await identity(db, outsider)
  const second = preparation({
    expectedPreparationRevision: 1,
    openingNio: 1500,
    openingUsd: 30,
  })
  day = await call('prepare_business_day', second)
  eq(day.openingDraft.revision, 2)
  const preparations = await history(today)
  eq(
    preparations.map((e) => e.event),
    ['prepare', 'prepare'],
  )
  eq(preparations[0].openingCorrection.before, {
    openingNio: 1000,
    openingUsd: 20,
  })
  eq(preparations[0].actorId, outsider)
  await db.exec('reset role')
  eq(
    await one(
      'select (select count(*) from public.business_days) days,(select count(*) from public.documents) invoices,(select count(*) from public.inventory_movements) movements,(select count(*) from public.journal_entries) journals',
    ),
    { days: 0, invoices: 0, movements: 0, journals: 0 },
    'preparar dinero no abre ni registra operaciones contables',
  )
  await identity(db, operator)
  eq(
    (await state()).openingDraft,
    null,
    'el vendedor no consulta efectivo preparado',
  )
  await reject(
    db.query('select * from private.business_day_opening_preparations'),
    /permission/,
  )
  await identity(db, admin)
  const opening = {
    requestId: crypto.randomUUID(),
    expectedDay: today,
    expectedOpeningDraftRevision: 1,
    openingNio: 1000,
    openingUsd: 20,
  }
  await reject(call('open_business_day', opening), /preparado cambió/)
  day = await call('open_business_day', {
    ...opening,
    expectedOpeningDraftRevision: 2,
    openingNio: 1500,
    openingUsd: 30,
  })
  eq(day.status, 'open')
  eq(day.openingNio, 1500)
  eq(day.openingDraft, null)
  await reject(
    call(
      'prepare_business_day',
      preparation({ expectedPreparationRevision: 2, openingNio: 1800 }),
    ),
    /ya está registrada/,
  )
  const closed = await call('close_business_day', {
    requestId: crypto.randomUUID(),
    day: today,
    expectedRevision: day.revision,
    expectedStateToken: day.stateToken,
    countedNio: 1400,
    countedUsd: 25,
    note: 'Diferencia encontrada durante el conteo',
  })
  const originalClosure = (await history(today))[0]
  eq(closed.report.differenceNio, -100)
  const correction = {
    requestId: crypto.randomUUID(),
    day: today,
    expectedRevision: closed.revision,
    openingNio: 1400,
    openingUsd: 25,
    reason: 'Corregir transcripción del efectivo inicial',
  }
  const corrected = await call('correct_business_day', correction)
  eq(corrected.status, 'closed')
  eq(corrected.closedAt, closed.closedAt)
  eq(corrected.openedAt, closed.openedAt)
  eq(corrected.report.countedNio, 1400)
  eq(corrected.report.countedUsd, 25)
  eq(corrected.report.expectedNio, 1400)
  eq(corrected.report.expectedUsd, 25)
  eq(corrected.report.differenceNio, 0)
  eq(corrected.report.differenceUsd, 0)
  eq(corrected.report.invoices, closed.report.invoices)
  eq(corrected.revision, closed.revision + 1)
  const events = await history(today)
  eq(
    events.map((e) => e.event),
    ['correct', 'close', 'prepare', 'prepare'],
  )
  eq(
    events.find((e) => e.id === originalClosure.id),
    originalClosure,
    'el cierre original es inmutable',
  )
  eq(events[0].report.openingNio, 1400)
  eq(events[0].report.countedNio, 1400)
  eq(events[0].report.differenceNio, 0)
  eq(await call('correct_business_day', correction), corrected)
  await reject(
    call('correct_business_day', {
      ...correction,
      requestId: crypto.randomUUID(),
      openingNio: 1000,
    }),
    /cambió/,
  )
  await reject(
    call('create_document', {
      requestId: crypto.randomUUID(),
      kind: 'invoice',
      currency: 'NIO',
      tier: 'emprendedor',
      location: 'store',
      paymentMethod: 'cash',
      customerName: 'Cliente aislado',
      notes: '',
      items: [
        { productId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', quantity: 1 },
      ],
    }),
    /cerrada/,
  )
  await db.query(
    "select set_config('lcp.preparation_now','2026-11-03T15:00:00Z',false)",
  )
  const historical = await call('correct_business_day', {
    ...correction,
    requestId: crypto.randomUUID(),
    expectedRevision: corrected.revision,
    openingNio: 1300,
  })
  eq(historical.status, 'closed')
  eq(historical.report.countedNio, 1400)
  eq(historical.report.expectedNio, 1300)
  eq(historical.report.differenceNio, 100)
  eq(historical.closedAt, closed.closedAt)
  eq(
    (await history(today)).find((e) => e.id === originalClosure.id),
    originalClosure,
  )
  const tomorrow = await state()
  eq(tomorrow.status, 'not_opened')
  eq(tomorrow.openingDraft, null)
  eq(
    tomorrow.openingSuggestion.countedNio,
    1400,
    'se sugiere el conteo físico, no el importe esperado',
  )
  const nextPreparation = preparation({
    day: tomorrow.day,
    openingNio: 900,
    openingUsd: 0,
  })
  eq(
    (await call('prepare_business_day', nextPreparation)).openingDraft.revision,
    1,
  )
  const nextOpen = await call('open_business_day', {
    requestId: crypto.randomUUID(),
    expectedDay: tomorrow.day,
    expectedOpeningDraftRevision: 1,
    openingNio: 900,
    openingUsd: 0,
  })
  eq(nextOpen.openingNio, 900)
  eq((await state(today)).status, 'closed')
  console.log(
    `PASS apertura preparada y corrección cerrada: ${checks} verificaciones, permisos, concurrencia, recuperación, historial y cambio de día`,
  )
} finally {
  await db.close()
}

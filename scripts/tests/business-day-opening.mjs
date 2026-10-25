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
const eq = (actual, expected, why) => {
  assert.deepEqual(actual, expected, why)
  checks++
}
const state = async (day = null) =>
  (await db.query('select public.get_business_day($1) r', [day])).rows[0].r
const clock = (day) =>
  db.query("select set_config('lcp.opening_now',$1,false)", [
    day + 'T18:00:00Z',
  ])
const call = (name, input) => rpc(db, name, input)
const counts = async () => {
  await db.exec('reset role')
  const result = (
    await db.query(
      "select jsonb_build_object('days',(select count(*) from public.business_days),'events',(select count(*) from private.business_day_events),'finance',(select count(*) from public.finance_entries),'journal',(select count(*) from public.journal_entries)) r",
    )
  ).rows[0].r
  await db.exec('set role authenticated')
  return result
}
async function close(day, nio, usd) {
  return call('close_business_day', {
    requestId: crypto.randomUUID(),
    day: day.day,
    expectedRevision: day.revision,
    expectedStateToken: day.stateToken,
    countedNio: nio,
    countedUsd: usd,
    note: 'Conteo físico de prueba comprobado',
  })
}
try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.opening_now')::timestamptz$$",
  )
  await clock('2026-10-23')
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Admin','admin'),($2,'Caja','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer'),($5,'Propietario','superadmin')",
    [admin, operator, warehouse, viewer, outsider],
  )
  await identity(db, admin)
  eq(
    (await state()).openingSuggestion,
    null,
    'Primera apertura no inventa efectivo',
  )
  let day = await call('open_business_day', {
    requestId: crypto.randomUUID(),
    expectedDay: '2026-10-23',
    openingNio: 50,
    openingUsd: 0,
  })
  day = await close(day, 50, 0)
  await clock('2026-10-24')
  day = await call('open_business_day', {
    requestId: crypto.randomUUID(),
    expectedDay: '2026-10-24',
    openingNio: 1000,
    openingUsd: 10,
  })
  day = await close(day, 1200, 15)
  day = await call('reopen_business_day', {
    requestId: crypto.randomUUID(),
    day: day.day,
    expectedRevision: day.revision,
    reason: 'Cierre accidental para la prueba aislada',
  })
  day = await close(day, 1250, 20)
  await clock('2026-10-25')
  const before = await counts()
  const suggestion = (await state()).openingSuggestion
  eq(suggestion.day, '2026-10-24')
  eq(
    suggestion.countedNio,
    1250,
    'Se sugiere el conteo real y no el efectivo esperado',
  )
  eq(suggestion.countedUsd, 20)
  eq(suggestion.revision, 3, 'Se utiliza el último cierre después de reabrir')
  eq(
    (await state('2026-10-24')).openingSuggestion,
    null,
    'No aparece al consultar días anteriores',
  )
  eq(
    await counts(),
    before,
    'Consultar sugerencia no abre ni crea movimientos financieros',
  )
  for (const uid of [operator, warehouse, viewer]) {
    await identity(db, uid)
    eq(
      (await state()).openingSuggestion,
      null,
      'No se expone efectivo al personal operativo',
    )
    eq(
      (
        await db.query(
          "select has_function_privilege('authenticated','private.previous_cash_closing(date)','execute') allowed",
        )
      ).rows[0].allowed,
      false,
    )
  }
  await identity(db, outsider)
  eq(
    (await state()).openingSuggestion,
    suggestion,
    'Superadmin también puede usar la sugerencia',
  )
  await identity(db, admin)
  // Un cierre heredado sin conteo verificable no autoriza tomar un cierre más
  // viejo ni sustituir lo contado por el esperado.
  await db.exec(
    "reset role; update public.business_days set report=report-'countedUsd' where day='2026-10-24'; set role authenticated;",
  )
  eq((await state()).openingSuggestion, null)
  await db.exec(
    "reset role; update public.business_days set report=jsonb_set(report,'{countedUsd}','20'::jsonb) where day='2026-10-24'; set role authenticated;",
  )
  const opening = {
    requestId: crypto.randomUUID(),
    expectedDay: '2026-10-25',
    openingNio: 900,
    openingUsd: 0,
  }
  day = await call('open_business_day', opening)
  eq(day.openingNio, 900, 'El usuario puede cambiar el importe sugerido')
  eq(day.openingUsd, 0)
  eq(
    day.openingSuggestion,
    null,
    'Una jornada abierta no vuelve a sugerir una apertura',
  )
  eq(
    await call('open_business_day', opening),
    day,
    'Reintento conserva una sola apertura',
  )
  eq(
    (await counts()).finance,
    before.finance,
    'Abrir caja no es un aporte de dinero ni una venta',
  )
  eq((await counts()).journal, before.journal)
  console.log(
    `PASS apertura rápida: ${checks} comprobaciones, conteo real, reapertura, roles, sólo lectura e idempotencia`,
  )
} finally {
  await db.close()
}

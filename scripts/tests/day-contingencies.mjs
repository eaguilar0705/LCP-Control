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
  outsider,
} from './database-fixture.mjs'

// Pruebas sin red ni credenciales: el reloj sólo se reemplaza dentro de la
// base desechable para cruzar medianoche y reproducir respuestas perdidas.
const db = await database()
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const reject = async (work, pattern) => {
  await assert.rejects(work, pattern)
  checks++
}
const call = (name, input) => rpc(db, name, input)
const clock = (timestamp) =>
  db.query("select set_config('lcp.test_now',$1,false)", [timestamp])
const state = async (day = null) =>
  (await db.query('select public.get_business_day($1) r', [day])).rows[0].r
const history = async (day) =>
  (await db.query('select public.get_business_day_history($1) r', [day]))
    .rows[0].r
const opening = (changes = {}) => ({
  requestId: crypto.randomUUID(),
  expectedDay: '2026-10-16',
  openingNio: 1000,
  openingUsd: 20,
  ...changes,
})
const closing = (day, changes = {}) => ({
  requestId: crypto.randomUUID(),
  day: day.day,
  countedNio: day.report.expectedNio,
  countedUsd: day.report.expectedUsd,
  note: '',
  expectedRevision: day.revision,
  expectedStateToken: day.stateToken,
  ...changes,
})
const reopening = (day, changes = {}) => ({
  requestId: crypto.randomUUID(),
  day: day.day,
  reason: 'Cierre accidental antes de terminar las ventas',
  expectedRevision: day.revision,
  ...changes,
})
const expense = (changes = {}) => ({
  requestId: crypto.randomUUID(),
  incurredOn: '2026-10-16',
  category: 'renta',
  description: 'Gasto aislado de contingencias',
  amount: 100,
  account: 'caja',
  currency: 'NIO',
  exchangeRate: 1,
  ...changes,
})
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const invoice = () => ({
  requestId: crypto.randomUUID(),
  kind: 'invoice',
  customerName: 'Cliente aislado',
  tier: 'emprendedor',
  currency: 'NIO',
  location: 'store',
  paymentMethod: 'cash',
  notes: '',
  items: [{ productId: product, quantity: 1 }],
})

try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.test_now')::timestamptz$$",
  )
  await clock('2026-10-16T11:00:00Z') // 05:00 en Managua: no horario rígido.
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Administración','admin'),($2,'Ventas','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer'),($5,'Propietario','superadmin')",
    [admin, operator, warehouse, viewer, outsider],
  )
  await db.exec(`insert into public.business_settings(name) values('Contingencias aisladas');
   insert into public.brands(name) values('Marca aislada');`)
  await db.query(
    "insert into public.products(id,sku,name,brand_id) values($1,'PRUEBA-01','Perfume aislado',(select id from public.brands limit 1))",
    [product],
  )
  await db.query(
    "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',250)",
    [product],
  )
  await db.query(
    "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',10),($1,'warehouse',0)",
    [product],
  )
  await identity(db, admin)
  equal((await state()).status, 'not_opened')
  equal(await history('2026-10-16'), [])
  await reject(call('create_document', invoice()), /cerrada/)
  await reject(
    call('open_business_day', opening({ expectedDay: '2026-10-15' })),
    /fecha cambió/,
  )
  await reject(
    call('open_business_day', opening({ expectedDay: null })),
    /fecha cambió/,
  )
  for (const person of [operator, warehouse, viewer]) {
    await identity(db, person)
    await reject(call('open_business_day', opening()), /privilege|permission/)
    await reject(history('2026-10-16'), /privilege|permission/)
  }
  await identity(db, admin)
  const openRequest = opening()
  const duplicateOpen = await Promise.all([
    call('open_business_day', openRequest),
    call('open_business_day', openRequest),
  ])
  equal(duplicateOpen[0], duplicateOpen[1])
  let day = duplicateOpen[0]
  equal(day.revision, 0)
  equal(day.reopenCount, 0)
  equal(day.openingNio, 1000)
  equal(day.openingUsd, 20)
  equal(new Date(day.serverNow).toISOString(), '2026-10-16T11:00:00.000Z')
  const originalOpenedAt = day.openedAt
  const beforeToken = day.stateToken
  await clock('2026-10-16T11:00:10Z')
  day = await state()
  equal(day.stateToken, beforeToken, 'El reloj no invalida el reporte')
  await db.exec("set timezone='UTC'")
  equal(
    (await state()).stateToken,
    beforeToken,
    'Cambiar la zona de la conexión no altera el estado de la jornada',
  )
  await db.exec("set timezone='America/Managua'")
  await reject(
    call('open_business_day', { ...openRequest, openingNio: 2 }),
    /cambió/,
  )
  await reject(call('open_business_day', opening()), /jornada pendiente/)
  for (const person of [operator, warehouse, viewer]) {
    await identity(db, person)
    const restricted = await state()
    equal(restricted.report, null)
    equal(restricted.openingNio, null)
    equal(restricted.stateToken, '')
    await reject(
      call('close_business_day', closing(day)),
      /privilege|permission/,
    )
    await reject(
      call('reopen_business_day', reopening(day)),
      /privilege|permission/,
    )
  }
  await identity(db, admin)
  const staleClose = closing(day)
  await clock('2026-10-16T11:01:00Z')
  await call('record_expense', expense())
  equal((await state()).report.expectedNio, 900)
  await reject(call('close_business_day', staleClose), /movimientos.*cambiaron/)
  day = await state()
  await reject(
    call('close_business_day', closing(day, { countedNio: 899 })),
    /motivo.*diferencia/,
  )
  await reject(
    call('close_business_day', closing(day, { note: 'a'.repeat(1001) })),
    /1000 caracteres/,
  )
  const firstCloseRequest = closing(day)
  day = await call('close_business_day', firstCloseRequest)
  equal(day.status, 'closed')
  equal(day.revision, 1)
  equal(day.report.differenceNio, 0)
  equal(await call('close_business_day', firstCloseRequest), day)
  await reject(
    call('close_business_day', {
      ...firstCloseRequest,
      note: 'Cambio del envío',
    }),
    /solicitud.*cambió/,
  )
  await reject(call('create_document', invoice()), /cerrada/)
  await reject(call('record_expense', expense()), /jornada está cerrada/)
  let events = await history(day.day)
  equal(events.length, 1)
  equal(events[0].event, 'close')
  equal(events[0].report.countedNio, 900)
  equal(events[0].report.openingNio, 1000)
  const firstReport = events[0].report
  for (const reason of ['', 'corto', 'a'.repeat(1001)]) {
    await reject(
      call('reopen_business_day', reopening(day, { reason })),
      /entre 10 y 1000/,
    )
  }
  await reject(
    call('reopen_business_day', reopening(day, { expectedRevision: 0 })),
    /jornada cambió/,
  )
  await reject(
    call(
      'reopen_business_day',
      reopening(day, { expectedRevision: undefined }),
    ),
    /jornada cambió/,
  )
  const reopenRequest = reopening(day)
  await identity(db, outsider) // Superadmin también puede corregir el cierre.
  day = await call('reopen_business_day', reopenRequest)
  equal(day.status, 'open')
  equal(day.revision, 2)
  equal(day.reopenCount, 1)
  equal(day.openedAt, originalOpenedAt)
  equal(day.openingNio, 1000)
  equal(day.report.expectedNio, 900)
  equal(day.report.countedNio, undefined)
  equal(await call('reopen_business_day', reopenRequest), day)
  await reject(
    call('reopen_business_day', {
      ...reopenRequest,
      reason: 'Otra observación',
    }),
    /solicitud.*cambió/,
  )
  await identity(db, admin)
  // Una respuesta del primer cierre que se reenvía tras reabrir no cierra otra vez.
  equal((await call('close_business_day', firstCloseRequest)).status, 'open')
  equal((await history(day.day)).length, 2)
  await reject(
    call(
      'close_business_day',
      closing(day, {
        expectedRevision: undefined,
        expectedStateToken: undefined,
      }),
    ),
    /jornada cambió/,
  )
  await reject(
    call('close_business_day', closing(day, { expectedStateToken: undefined })),
    /movimientos.*cambiaron/,
  )
  await reject(
    call('close_business_day', closing(day, { expectedRevision: 0 })),
    /jornada cambió/,
  )
  await clock('2026-10-16T11:02:00Z')
  await identity(db, operator)
  const sale = invoice()
  await call('create_document', sale)
  equal((await state()).status, 'open')
  await identity(db, admin)
  day = await state()
  equal(day.report.invoices, 1)
  equal(day.report.expectedNio, 1150)
  const secondCloseRequest = closing(day)
  day = await call('close_business_day', secondCloseRequest)
  equal(day.revision, 3)
  equal(day.report.countedNio, 1150)
  events = await history(day.day)
  equal(
    events.map((event) => event.event),
    ['close', 'reopen', 'close'],
  )
  equal(
    events.map((event) => event.revision),
    [3, 2, 1],
  )
  equal(events[2].report, firstReport, 'El reporte original se conserva fiel')
  equal(events[1].actorName, 'Propietario')
  equal(events[1].report, null)
  // El reintento de la reapertura original después de cerrar es sólo lectura.
  await identity(db, outsider)
  equal((await call('reopen_business_day', reopenRequest)).status, 'closed')
  equal((await history(day.day)).length, 3)
  await identity(db, admin)
  await reject(call('reopen_business_day', reopenRequest), /solicitud.*cambió/)
  await reject(
    call(
      'reopen_business_day',
      reopening(day, { requestId: openRequest.requestId }),
    ),
    /identificador.*apertura/,
  )
  await reject(
    db.query('update private.business_day_events set reason=$1', ['Cambio']),
    /permission/,
  )
  await reject(
    db.query('select * from private.business_day_events'),
    /permission/,
  )
  const thirdReopen = reopening(day)
  day = await call('reopen_business_day', thirdReopen)
  equal(day.reopenCount, 2)
  equal(day.revision, 4)
  // 23:59:59 de Managua sigue perteneciendo a la misma jornada.
  await clock('2026-10-17T05:59:59Z')
  equal((await state()).today, '2026-10-16')
  const beforeMidnightClose = closing(await state())
  day = await call('close_business_day', beforeMidnightClose)
  equal(day.revision, 5)
  const oldOpeningPayload = { ...openRequest }
  await clock('2026-10-17T06:00:01Z')
  equal((await state()).today, '2026-10-17')
  equal((await state()).status, 'not_opened')
  await reject(
    call('reopen_business_day', reopening(day)),
    /Sólo se puede reabrir/,
  )
  equal((await call('open_business_day', oldOpeningPayload)).day, '2026-10-16')
  await reject(call('open_business_day', opening()), /fecha cambió/)
  const nextOpening = opening({ expectedDay: '2026-10-17' })
  day = await call('open_business_day', nextOpening)
  equal(day.day, '2026-10-17')
  // No se hereda automáticamente dinero: se cuenta el efectivo físico de hoy.
  equal(day.openingNio, 1000)
  equal(day.report.invoices, 0)
  await clock('2026-10-18T06:00:01Z')
  const pending = await state()
  equal(pending.today, '2026-10-18')
  equal(pending.status, 'not_opened')
  equal(pending.openDay, '2026-10-17')
  await reject(
    call('open_business_day', opening({ expectedDay: '2026-10-18' })),
    /jornada pendiente/,
  )
  await reject(call('create_document', invoice()), /cerrada/)
  day = await state('2026-10-17')
  await reject(call('close_business_day', closing(day)), /cierre tardío/)
  await reject(
    call('close_business_day', closing(day, { note: 'Corto' })),
    /cierre tardío/,
  )
  day = await call(
    'close_business_day',
    closing(day, { note: 'Se olvidó confirmar el cierre anoche' }),
  )
  equal(day.status, 'closed')
  equal(day.day, '2026-10-17')
  events = await history(day.day)
  equal(events[0].day, '2026-10-17')
  equal(new Date(events[0].createdAt).toISOString(), '2026-10-18T06:00:01.000Z')
  await reject(
    call('reopen_business_day', reopening(day)),
    /Sólo se puede reabrir/,
  )
  await call('open_business_day', opening({ expectedDay: '2026-10-18' }))
  // No hay reejecución de cierres ni aperturas al recuperar respuestas viejas.
  equal((await call('open_business_day', nextOpening)).status, 'closed')
  equal((await state()).status, 'open')
  await reject(history(null), /fecha/)
  await identity(db, '', 'anon')
  await reject(state(), /permission/)
  await reject(history('2026-10-16'), /permission/)
  await reject(call('reopen_business_day', reopening(day)), /permission/)

  // Simula un cierre existente al momento de aplicar la migración: se ejecuta
  // exactamente el bloque de backfill, no se reconstruyen sus cifras.
  await db.exec('reset role')
  const beforeBackfill = (
    await db.query(
      "select report,closing_request,closing_payload,closed_at from public.business_days where day='2026-10-17'",
    )
  ).rows[0]
  await db.exec(
    "delete from private.business_day_events where day='2026-10-17'; update public.business_days set revision=0 where day='2026-10-17'",
  )
  const migration = await readFile(
    'backend/supabase/migrations/20261016184008_contingencias_de_jornadas.sql',
    'utf8',
  )
  const backfill = migration.slice(
    migration.indexOf('update public.business_days set revision=1'),
    migration.indexOf('create or replace function private.get_business_day'),
  )
  // Sólo la fila elegida emula datos anteriores; no se vuelve a aplicar el
  // backfill sobre cierres nuevos que ya tienen su historial.
  await db.exec(
    backfill
      .replace('where closed_at is not null;', "where day='2026-10-17';")
      .replace('where b.closed_at is not null;', "where b.day='2026-10-17';"),
  )
  const backfilled = (
    await db.query(
      "select report,request_id,request_payload,created_at,revision from private.business_day_events where day='2026-10-17'",
    )
  ).rows[0]
  equal(backfilled.report, beforeBackfill.report)
  equal(backfilled.request_id, beforeBackfill.closing_request)
  equal(backfilled.request_payload, beforeBackfill.closing_payload)
  equal(backfilled.created_at, beforeBackfill.closed_at)
  equal(backfilled.revision, 1)
  console.log(`Contingencias de jornadas: ${checks} verificaciones correctas.`)
} finally {
  await db.close()
}

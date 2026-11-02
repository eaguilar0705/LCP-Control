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
const eq = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
}
const reject = async (fn, pattern) => {
  await assert.rejects(fn, pattern)
  checks++
}
const call = (name, input) => rpc(db, name, input)
const one = async (sql, values = []) => (await db.query(sql, values)).rows[0]
const state = async (day = null) =>
  (await one('select public.get_business_day($1) r', [day])).r
const history = async (day) =>
  (await one('select public.get_business_day_history($1) r', [day])).r
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.correction_now')::timestamptz$$",
  )
  await db.query(
    "select set_config('lcp.correction_now','2026-11-02T15:00:00Z',false)",
  )
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Administrador','admin'),($2,'Caja','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer'),($5,'Propietario','superadmin')",
    [admin, operator, warehouse, viewer, outsider],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Negocio aislado'); insert into public.brands(name) values('Marca aislada')",
  )
  await db.query(
    "insert into public.products(id,sku,name,brand_id) values($1,'QA-001','Perfume de auditoría',(select id from public.brands limit 1));",
    [product],
  )
  await db.query(
    "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',200),($1,'warehouse',0)",
    [product],
  )
  await db.query(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,100)',
    [product],
  )
  await db.query(
    "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',250),($1,'emprendedor','USD',10)",
    [product],
  )
  await identity(db, admin)
  await call('record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: '2026-11-02',
    description: 'Apertura de auditoría aislada',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1110-001', debit: 2000, credit: 0 },
      { account: '1130', debit: 20000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 22000 },
    ],
  })
  const sale = () => ({
    requestId: crypto.randomUUID(),
    kind: 'invoice',
    customerName: 'Cliente de auditoría',
    tier: 'emprendedor',
    currency: 'NIO',
    location: 'store',
    paymentMethod: 'cash',
    notes: '',
    items: [{ productId: product, quantity: 1 }],
  })
  await reject(call('create_document', sale()), /cerrada/)
  const opening = {
    requestId: crypto.randomUUID(),
    expectedDay: '2026-11-02',
    openingNio: 1000,
    openingUsd: 20,
  }
  let day = await call('open_business_day', opening)
  const invoiceInput = sale(),
    invoice = await call('create_document', invoiceInput)
  await call('record_expense', {
    requestId: crypto.randomUUID(),
    incurredOn: day.day,
    category: 'renta',
    description: 'Pago registrado después de abrir',
    amount: 100,
    account: 'caja',
    currency: 'NIO',
    exchangeRate: 1,
  })
  day = await state()
  eq(day.report.expectedNio, 1150)
  const ledgerBefore = (
    await one('select public.ledger_report($1,$1) r', [day.day])
  ).r
  const correction = {
    requestId: crypto.randomUUID(),
    day: day.day,
    expectedRevision: day.revision,
    openingNio: 1500,
    openingUsd: 15,
    reason: 'Corregir el conteo ingresado al abrir',
  }
  for (const uid of [operator, warehouse, viewer]) {
    await identity(db, uid)
    await reject(
      call('correct_business_day', correction),
      /permission|insufficient/i,
    )
  }
  await identity(db, '', 'anon')
  await reject(call('correct_business_day', correction), /permission/)
  await identity(db, admin)
  for (const changes of [
    { openingNio: -1 },
    { openingUsd: -1 },
    { openingNio: 0.001 },
    { openingNio: 100000001 },
    { reason: 'corto' },
    { expectedRevision: 99 },
    { day: '2026-11-03' },
    { requestId: opening.requestId },
    { openingNio: 1000, openingUsd: 20 },
  ])
    await reject(
      call('correct_business_day', { ...correction, ...changes }),
      /importe|monto|valor|motivo|apertura|jornada|identificador|coinciden|número|decimales|100000000|moneda/i,
    )
  const corrected = await call('correct_business_day', correction)
  eq(corrected.openingNio, 1500)
  eq(corrected.openingUsd, 15)
  eq(corrected.report.expectedNio, 1650)
  eq(corrected.report.expectedUsd, 15)
  eq(corrected.report.invoices, 1)
  eq(corrected.revision, day.revision + 1)
  eq(
    (await one('select public.ledger_report($1,$1) r', [day.day])).r,
    ledgerBefore,
    'corregir el conteo no crea ni cambia asientos',
  )
  eq(
    await call('create_document', invoiceInput),
    invoice,
    'la factura conserva el número y el reintento no duplica',
  )
  eq(await call('correct_business_day', correction), corrected)
  eq((await history(day.day)).length, 1)
  const entry = (await history(day.day))[0]
  eq(entry.openingCorrection, {
    before: { openingNio: 1000, openingUsd: 20 },
    after: { openingNio: 1500, openingUsd: 15 },
  })
  eq(entry.reason, correction.reason)
  eq(entry.actorId, admin)
  await reject(
    call('correct_business_day', { ...correction, openingNio: 1600 }),
    /solicitud.*cambi/,
  )
  const confirmed = (
    await one('select public.get_operation_confirmation($1,$2) r', [
      'business-day-correct',
      correction.requestId,
    ])
  ).r
  eq(confirmed.status, 'confirmed')
  const retired = {
    ...correction,
    requestId: crypto.randomUUID(),
    expectedRevision: corrected.revision,
    openingNio: 1600,
  }
  eq(
    (
      await one('select public.retire_unconfirmed_operation($1,$2) r', [
        'business-day-correct',
        retired.requestId,
      ])
    ).r.status,
    'retired',
  )
  await reject(call('correct_business_day', retired), /descartada/)
  eq(
    (await state()).openingNio,
    1500,
    'el retiro revierte toda la escritura tardía',
  )
  await identity(db, outsider)
  const ownerCorrection = {
    ...correction,
    requestId: crypto.randomUUID(),
    expectedRevision: corrected.revision,
    openingNio: 1400,
  }
  day = await call('correct_business_day', ownerCorrection)
  const beforeSalesRevision = day.revision
  const receipts = []
  await identity(db, operator)
  for (let i = 0; i < 60; i++) {
    await db.query("select set_config('lcp.correction_now',$1,false)", [
      new Date(
        Date.parse('2026-11-02T15:00:00Z') + (i + 1) * 60000,
      ).toISOString(),
    ])
    const input = sale(),
      saved = await call('create_document', input)
    eq(
      await call('create_document', input),
      saved,
      'reintentar una venta conserva su factura',
    )
    receipts.push(saved)
  }
  eq(new Set(receipts.map((r) => r.id)).size, 60)
  eq(new Set(receipts.map((r) => r.number)).size, 60)
  await identity(db, admin)
  day = await state()
  eq(day.report.invoices, 61)
  eq(
    day.revision,
    beforeSalesRevision,
    'las ventas no invalidan una corrección de apertura por revisión',
  )
  const lastBeforeClose = await call('correct_business_day', {
    ...correction,
    requestId: crypto.randomUUID(),
    expectedRevision: day.revision,
    openingNio: 1300,
  })
  const closed = await call('close_business_day', {
    requestId: crypto.randomUUID(),
    day: day.day,
    expectedRevision: lastBeforeClose.revision,
    expectedStateToken: lastBeforeClose.stateToken,
    countedNio: lastBeforeClose.report.expectedNio,
    countedUsd: lastBeforeClose.report.expectedUsd,
    note: '',
  })
  const originalClosure = (await history(day.day))[0]
  await reject(
    call('correct_business_day', {
      ...correction,
      requestId: crypto.randomUUID(),
      expectedRevision: closed.revision,
    }),
    /cerrada/,
  )
  eq(
    await call('correct_business_day', correction),
    closed,
    'un reintento ya confirmado funciona después del cierre',
  )
  const reopened = await call('reopen_business_day', {
    requestId: crypto.randomUUID(),
    day: day.day,
    expectedRevision: closed.revision,
    reason: 'Reabrir para corregir una apertura equivocada',
  })
  const last = await call('correct_business_day', {
    ...correction,
    requestId: crypto.randomUUID(),
    expectedRevision: reopened.revision,
    openingNio: 1200,
  })
  eq(
    (await history(day.day)).find((e) => e.id === originalClosure.id),
    originalClosure,
    'el cierre anterior conserva sus importes originales',
  )
  eq(last.report.invoices, 61)
  const integrity = await one(
    "select (select count(*) from public.documents) docs,(select count(*) from public.document_items) items,(select count(*) from public.document_item_costs) costs,(select quantity from public.inventory_balances where product_id=$1 and location='store') stock",
    [product],
  )
  eq(integrity, { docs: 61, items: 61, costs: 61, stock: 139 })
  const ledger = (await one('select public.ledger_report($1,$1) r', [day.day]))
    .r
  eq(ledger.missingCosts, 0)
  eq(ledger.missingSales, 0)
  const totals = ledger.accounts
    .filter((a) => a.postable)
    .reduce(
      (a, b) => ({ debit: a.debit + b.debit, credit: a.credit + b.credit }),
      { debit: 0, credit: 0 },
    )
  eq(totals.debit, totals.credit, 'la contabilidad sigue cuadrando')
  await db.query(
    "select set_config('lcp.correction_now','2026-11-03T15:00:00Z',false)",
  )
  eq(
    (
      await call('correct_business_day', {
        ...correction,
        requestId: crypto.randomUUID(),
        expectedRevision: last.revision,
        openingNio: 1100,
      })
    ).openingNio,
    1100,
    'se puede corregir una jornada aún abierta de ayer antes de cerrarla',
  )
  console.log(
    `PASS corrección de apertura: ${checks} verificaciones, 61 facturas completas, permisos, historial, recuperación y contabilidad`,
  )
} finally {
  await db.close()
}

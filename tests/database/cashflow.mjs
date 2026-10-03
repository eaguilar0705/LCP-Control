// Flujo y arqueo contra todas las migraciones reales en PostgreSQL desechable.
import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

const db = new PGlite()
const admin = '11111111-1111-4111-8111-111111111111'
const operator = '22222222-2222-4222-8222-222222222222'
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const base = '2026-09-30'
const day = '2026-10-01'
let checks = 0
async function check(name, action) {
  await action()
  checks++
  console.log(`OK ${name}`)
}
async function identity(uid, role = 'authenticated') {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid])
  await db.exec(`set role ${role}`)
}
async function rpc(name, input) {
  return (await db.query(`select public.${name}($1::jsonb) as result`, [JSON.stringify(input)])).rows[0].result
}
async function flow(from = day, to = day) {
  return (await db.query('select public.finance_cashflow($1,$2) as result', [from, to])).rows[0].result
}
async function closings() {
  return (await db.query('select public.list_cash_closings($1,$1) as result', [day])).rows[0].result
}
const entry = (changes = {}) => ({
  requestId: crypto.randomUUID(), occurredOn: day, kind: 'capital', account: 'caja', toAccount: null,
  amount: 100, currency: 'NIO', exchangeRate: 1, counterparty: '', description: 'Movimiento', reference: '', ...changes,
})
const expense = (changes = {}) => ({
  requestId: crypto.randomUUID(), incurredOn: day, category: 'renta', description: 'Renta',
  amount: 50, currency: 'NIO', exchangeRate: 1, reference: '', account: 'caja', ...changes,
})
const shipment = (changes = {}) => ({
  requestId: crypto.randomUUID(), incurredOn: day, supplier: 'Proveedor', agency: '', reference: '', note: '',
  currency: 'NIO', exchangeRate: 1, shippingAmount: 0, account: 'credito',
  lines: [{ productId: product, location: 'store', quantity: 2, unitPrice: 30 }], ...changes,
})
const invoice = (changes = {}) => ({
  requestId: crypto.randomUUID(), kind: 'invoice', customerName: 'Cliente', tier: 'emprendedor',
  currency: 'NIO', location: 'store', paymentMethod: 'cash', notes: '',
  items: [{ productId: product, quantity: 1 }], ...changes,
})
async function sale(changes = {}) {
  const doc = await rpc('create_document', invoice(changes))
  await db.exec('reset role')
  await db.query("update public.documents set created_at=$2::timestamp at time zone 'America/Managua' where id=$1", [doc.id, `${day} 12:00:00`])
  await identity(admin)
  return doc.id
}
const closing = (changes = {}) => ({
  requestId: crypto.randomUUID(), closedOn: day, countedNio: 520, countedUsd: 20, exchangeRate: 35, note: '', ...changes,
})

try {
  await db.exec(`create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[],owner uuid references auth.users(id),owner_id text);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid references auth.users(id),owner_id text,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated,anon;
    grant select,insert,delete on storage.objects to authenticated;
    create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
  `)
  await db.query('insert into auth.users(id) values($1),($2)', [admin, operator])
  for (const file of (await readdir('supabase/migrations')).sort())
    if (file.endsWith('.sql') && !file.includes('harden_platform_function_grants'))
      await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'))
  await db.query("insert into public.staff_members(user_id,display_name,role) values($1,'Admin','admin'),($2,'Operator','operator')", [admin, operator])
  await db.exec("insert into public.business_settings(name) values('Pruebas de flujo'); insert into public.brands(name) values('Marca');")
  for (const id of [product, other]) {
    await db.query("insert into public.products(id,sku,name,brand_id) values($1::uuid,$1::text,'Perfume',(select id from public.brands limit 1))", [id])
    await db.query("insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',115),($1,'emprendedor','USD',10)", [id])
    await db.query("insert into public.inventory_balances(product_id,location,quantity) values($1,'store',20),($1,'warehouse',0)", [id])
  }
  await identity(admin)
  await check('without an explicit cash basis no zero balance or closing is invented', async () => {
    await rpc('record_finance_entry', entry({ occurredOn: '2026-09-29' }))
    const report = await flow()
    assert.deepEqual(report.opening, { caja: null, banco: null })
    assert.deepEqual(report.closing, { caja: null, banco: null })
    await assert.rejects(rpc('record_cash_closing', closing()), /saldo inicial/)
    const zeroOpening = await rpc('record_finance_entry', entry({ kind: 'opening', occurredOn: base, amount: 0 }))
    assert.equal((await flow()).closing.caja, 0)
    await db.query("select public.void_finance_entry($1,'Reemplazar apertura de prueba')", [zeroOpening])
    await rpc('record_finance_entry', entry({ kind: 'opening', occurredOn: base, amount: 1000 }))
    assert.equal((await flow()).closing.caja, 1000)
    assert.equal((await flow()).closing.banco, null)
    await rpc('record_finance_entry', entry({ kind: 'opening', occurredOn: base, account: 'banco', amount: 500 }))
    const aroundOpening = await flow('2026-09-29', base)
    assert.equal(aroundOpening.rows.some((row) => row.day === '2026-09-29'), false)
    assert.deepEqual(aroundOpening.totals, { inflowNio: 0, outflowNio: 0, netNio: 0 })
  })
  await check('cash movements preserve historical rates, exclude credit and show both transfer legs', async () => {
    for (const id of [product, other]) await rpc('set_opening_cost', { requestId: crypto.randomUUID(), productId: id, unitCost: 50, currency: 'NIO', exchangeRate: 1, note: 'Costo inicial' })
    await sale({ currency: 'USD', exchangeRate: 35 })
    await sale({ paymentMethod: 'bac_nio' })
    const credit = await sale({ paymentMethod: 'pending', items: [{ productId: product, quantity: 2 }] })
    await rpc('record_finance_entry', entry({ kind: 'collection', documentId: credit, amount: 100 }))
    await rpc('record_expense', expense())
    await rpc('record_expense', expense({ category: 'prestamo_bancario', account: 'banco', amount: 40 }))
    await rpc('record_shipment', shipment({ account: 'banco', currency: 'USD', exchangeRate: 36, shippingAmount: 5, lines: [{ productId: product, location: 'store', quantity: 2, unitPrice: 10 }] }))
    const purchase = await rpc('record_shipment', shipment())
    await rpc('record_finance_entry', entry({ kind: 'supplier_payment', shipmentId: purchase, amount: 30 }))
    await rpc('record_finance_entry', entry({ kind: 'transfer', toAccount: 'banco', amount: 200 }))
    await rpc('record_finance_entry', entry({ amount: 75 }))
    await rpc('record_finance_entry', entry({ kind: 'withdrawal', amount: 25 }))
    await rpc('record_finance_entry', entry({ kind: 'loan', account: 'banco', amount: 300 }))
    const report = await flow()
    assert.deepEqual(report.opening, { caja: 1000, banco: 500 })
    assert.deepEqual(report.closing, { caja: 1220, banco: 175 })
    assert.deepEqual(report.totals, { inflowNio: 940, outflowNio: 1045, netNio: -105 })
    assert.equal(report.rows.filter((row) => row.category === 'transfer').length, 2)
    assert.equal(report.rows.find((row) => row.category === 'purchases').outflowNio, 900)
    assert.equal(report.missingSales, 0)
    await db.query('select public.set_exchange_rate($1)', [99])
    assert.deepEqual((await flow()).closing, report.closing)
  })
  let closeId
  let original
  await check('closing stores the original expectation and is idempotent across retries', async () => {
    original = closing()
    closeId = await rpc('record_cash_closing', original)
    assert.equal(await rpc('record_cash_closing', original), closeId)
    await assert.rejects(rpc('record_cash_closing', { ...original, countedNio: 1 }), /otros datos/)
    await assert.rejects(rpc('record_cash_closing', closing()), /arqueo vigente/)
    const row = (await closings())[0]
    assert.equal(row.expectedNio, 1220)
    assert.equal(row.countedTotalNio, 1220)
    assert.equal(row.differenceNio, 0)
    assert.equal(row.changed, false)
  })
  await check('retroactive operations flag the old snapshot and void preserves its audit', async () => {
    await rpc('record_expense', expense({ amount: 10, description: 'Gasto olvidado' }))
    const row = (await closings())[0]
    assert.equal(row.expectedNio, 1220)
    assert.equal(row.currentExpectedNio, 1210)
    assert.equal(row.changed, true)
    assert.equal(await rpc('record_cash_closing', original), closeId)
    await assert.rejects(db.query("select public.void_cash_closing($1,'')", [closeId]), /motivo/)
    await db.query("select public.void_cash_closing($1,'Rehacer tras gasto retroactivo')", [closeId])
    await db.query("select public.void_cash_closing($1,'Rehacer tras gasto retroactivo')", [closeId])
    await assert.rejects(db.query("select public.void_cash_closing($1,'Otro motivo')", [closeId]), /otro motivo/)
    assert.equal((await closings())[0].voidReason, 'Rehacer tras gasto retroactivo')
    await assert.rejects(rpc('record_cash_closing', closing({ countedNio: 510, exchangeRate: null })), /tasa de cambio/)
    await assert.rejects(rpc('record_cash_closing', closing({ countedNio: 500 })), /diferencia/)
    await assert.rejects(rpc('record_cash_closing', closing({ countedNio: 0.001, note: 'Diferencia' })), /numérico/)
    await assert.rejects(rpc('record_cash_closing', closing({ closedOn: '2999-01-01' })), /Fecha/)
    const replacement = await rpc('record_cash_closing', closing({ countedNio: 1210, countedUsd: 0, exchangeRate: null }))
    assert.notEqual(replacement, closeId)
  })
  await check('an incomplete invoice cannot be partially counted as cash or closed', async () => {
    const doc = await sale({ items: [{ productId: product, quantity: 1 }, { productId: other, quantity: 1 }] })
    await db.exec('reset role')
    await db.query('delete from public.document_item_costs where document_id=$1 and product_id=$2', [doc, other])
    await identity(admin)
    const report = await flow()
    assert.equal(report.closing.caja, null)
    assert.equal(report.closing.banco, 175)
    assert.equal(report.missingSales, 1)
    assert.equal(report.rows.find((row) => row.category === 'sales' && row.account === 'caja').inflowNio, 350)
    const rows = await closings()
    assert.equal(rows[0].currentExpectedNio, null)
    assert.equal(rows[0].currentMissingSales, 1)
    assert.equal(rows[0].changed, true)
    await assert.rejects(rpc('record_cash_closing', closing({ closedOn: '2026-10-02' })), /histórico completo/)
  })
  await check('RLS, RPC guards and grants independently deny operational roles and direct writes', async () => {
    await identity(operator)
    assert.equal((await db.query('select * from public.cash_closings')).rows.length, 0)
    await assert.rejects(flow(), /insufficient/)
    await assert.rejects(closings(), /insufficient/)
    await assert.rejects(rpc('record_cash_closing', closing()), /insufficient/)
    await assert.rejects(db.query("select public.void_cash_closing($1,'Motivo')", [closeId]), /insufficient/)
    await identity('', 'anon')
    await assert.rejects(flow(), /permission denied/)
    await assert.rejects(db.query('select * from public.cash_closings'), /permission denied/)
    await identity(admin)
    await assert.rejects(db.query('delete from public.cash_closings'), /permission denied/)
    await assert.rejects(db.query('update public.cash_closings set expected_nio=0'), /permission denied/)
    await assert.rejects(db.query('select private.cashflow_balance($1)', [day]), /permission denied/)
    await assert.rejects(flow('2026-10-02', day), /período válido/)
    const longRange = await flow('2024-01-01', day)
    assert.ok(longRange.available)
    assert.ok(Array.isArray(await closings('2024-01-01', day)))
    await assert.rejects(flow('2000-01-01', day), /período válido/)
  })
  console.log(`${checks} cashflow PostgreSQL checks passed. No deployed database was accessed.`)
} finally {
  await db.close()
}

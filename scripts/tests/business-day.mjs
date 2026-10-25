import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
const db = new PGlite()
const admin = '11111111-1111-4111-8111-111111111111',
  operator = '22222222-2222-4222-8222-222222222222',
  warehouse = '33333333-3333-4333-8333-333333333333',
  viewer = '44444444-4444-4444-8444-444444444444',
  outsider = '55555555-5555-4555-8555-555555555555'
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  legacy = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  empty = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  unknown = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
async function identity(uid, role = 'authenticated') {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid])
  await db.exec(`set role ${role}`)
}
async function rpc(name, input) {
  return (
    await db.query(`select public.${name}($1::jsonb) result`, [
      JSON.stringify(input),
    ])
  ).rows[0].result
}
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
  await db.query('insert into auth.users(id) values($1),($2),($3),($4),($5)', [
    admin,
    operator,
    warehouse,
    viewer,
    outsider,
  ])
  for (const file of (await readdir('backend/supabase/migrations')).sort()) {
    if (
      file.endsWith('.sql') &&
      !file.includes('harden_platform_function_grants')
    ) {
      await db.exec(
        await readFile(`backend/supabase/migrations/${file}`, 'utf8'),
      )
    }
  }
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Admin','admin'),($2,'Operator','operator'),($3,'Warehouse','warehouse'),($4,'Viewer','viewer')",
    [admin, operator, warehouse, viewer],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Pruebas contables'); insert into public.brands(name) values('Marca');",
  )
  for (const id of [product, legacy, empty, unknown]) {
    await db.query(
      "insert into public.products(id,sku,name,brand_id) values($1::uuid,$1::text,'Perfume',(select id from public.brands limit 1))",
      [id],
    )
    await db.query(
      "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',115),($1,'emprendedor','USD',10)",
      [id],
    )
    await db.query(
      "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',$2),($1,'warehouse',$3)",
      [id, id === empty ? 0 : 10, id === unknown ? null : 0],
    )
  }
  await db.query(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,100)',
    [product],
  )
  await identity(admin)

  const today = (
    await db.query(
      "select (now() at time zone 'America/Managua')::date::text as day",
    )
  ).rows[0].day
  const invoice = () => ({
    requestId: crypto.randomUUID(),
    kind: 'invoice',
    customerName: 'Cliente de prueba',
    tier: 'emprendedor',
    currency: 'NIO',
    location: 'store',
    paymentMethod: 'cash',
    notes: '',
    items: [{ productId: product, quantity: 2 }],
  })
  await assert.rejects(rpc('create_document', invoice()), /cerrada/)
  await identity(operator)
  await assert.rejects(
    rpc('open_business_day', {
      requestId: crypto.randomUUID(),
      openingNio: 100,
      openingUsd: 10,
    }),
  )
  await identity(admin)
  const open = {
    requestId: crypto.randomUUID(),
    openingNio: 100,
    openingUsd: 10,
  }
  assert.equal((await rpc('open_business_day', open)).status, 'open')
  assert.equal((await rpc('open_business_day', open)).status, 'open')
  await assert.rejects(
    rpc('open_business_day', { ...open, openingNio: 200 }),
    /cambi/,
  )
  await identity(operator)
  const doc = await rpc('create_document', invoice())
  // Venta heredada anterior a la guardia de costo: sólo el dueño de la base
  // desechable prepara el snapshot nulo que debe seguir mostrándose pendiente.
  await db.exec('reset role')
  await db.query(
    'update public.document_item_costs set unit_cost_nio=null where document_id=$1',
    [doc.id],
  )
  await db.query('delete from public.product_costs where product_id=$1', [
    product,
  ])
  await identity(operator)
  const hidden = (await db.query('select public.get_business_day(null) result'))
    .rows[0].result
  assert.equal(hidden.report, null)
  await identity(admin)
  const yesterday = (
    await db.query(
      "select ((now() at time zone 'America/Managua')::date-1)::text as day",
    )
  ).rows[0].day
  const voucher = (changes = {}) => ({
    requestId: crypto.randomUUID(),
    occurredOn: today,
    kind: 'expense',
    description: 'Gasto de prueba',
    reference: 'TEST',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '5130-002', debit: 10, credit: 0 },
      { account: '1110-001', debit: 0, credit: 10 },
    ],
    ...changes,
  })
  await assert.rejects(
    rpc('record_journal_entry', voucher()),
    /saldos iniciales/,
  )
  const opening = voucher({
    kind: 'opening',
    occurredOn: yesterday,
    lines: [
      { account: '1110-001', debit: 100, credit: 0 },
      { account: '1130', debit: 5000, credit: 0 },
      { account: '1142', debit: 1000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 6100 },
    ],
  })
  const openingId = await rpc('record_journal_entry', opening)
  assert.equal(await rpc('record_journal_entry', opening), openingId)
  await assert.rejects(
    rpc(
      'record_journal_entry',
      voucher({
        lines: [
          { account: '5130-002', debit: 12, credit: 0 },
          { account: '1110-001', debit: 0, credit: 10 },
        ],
      }),
    ),
    /debe y el haber/,
  )
  await assert.rejects(
    rpc(
      'record_journal_entry',
      voucher({
        lines: [
          { account: '1000', debit: 10, credit: 0 },
          { account: '1110-001', debit: 0, credit: 10 },
        ],
      }),
    ),
    /Cuenta no disponible/,
  )
  const expenseId = await rpc('record_journal_entry', voucher())
  const withExpense = (
    await db.query('select public.get_business_day(null) result')
  ).rows[0].result
  assert.equal(withExpense.report.expectedNio, 320)
  await db.query('select public.void_journal_entry($1,$2)', [
    expenseId,
    'Prueba anulada',
  ])
  const card = voucher({
    kind: 'card_settlement',
    gross: 1000,
    commissionRate: 4.5,
    withholdingRate: 1.5,
    withholdingBase: 'gross',
    bankAccount: '1120-001',
    lines: [
      { account: '1120-001', debit: 940, credit: 0 },
      { account: '5140-001', debit: 45, credit: 0 },
      { account: '1340', debit: 15, credit: 0 },
      { account: '1142', debit: 0, credit: 1000 },
    ],
  })
  const cardId = await rpc('record_journal_entry', card)
  const detail = (
    await db.query('select public.get_journal_entry($1) result', [cardId])
  ).rows[0].result
  assert.equal(detail.lines.find((l) => l.account === '1340').debit, 15)
  await assert.rejects(
    rpc('record_journal_entry', {
      ...card,
      requestId: crypto.randomUUID(),
      commissionRate: 7,
    }),
    /no coinciden/,
  )
  await db.query('select public.void_journal_entry($1,$2)', [
    cardId,
    'Prueba anulada',
  ])
  const report = (
    await db.query('select public.ledger_report($1,$2) result', [today, today])
  ).rows[0].result
  assert.equal(report.startOn, yesterday)
  assert.equal(report.missingCosts, 1)
  const account = (code) => report.accounts.find((a) => a.code === code)
  assert.equal(account('1110-001').closing, 330)
  assert.equal(account('4110').credit, 230)
  assert.equal(account('3110-001').closing, -6100)
  assert.equal(account('5130-002').debit, 0)
  assert.equal(
    report.accounts.reduce((sum, a) => sum + a.debit - a.credit, 0),
    0,
  )
  await identity(operator)
  await assert.rejects(rpc('record_journal_entry', voucher()))
  await assert.rejects(
    db.query('select public.ledger_report($1,$2)', [today, today]),
  )
  assert.equal(
    (await db.query('select * from public.journal_entries')).rows.length,
    0,
  )
  await identity(admin)
  const state = (await db.query('select public.get_business_day(null) result'))
    .rows[0].result
  assert.equal(state.report.invoices, 1)
  assert.equal(state.report.units, 2)
  assert.equal(state.report.products[0].units, 2)
  assert.equal(state.report.expectedNio, 330)
  assert.equal(state.report.expectedUsd, 10)
  await assert.rejects(
    rpc('close_business_day', {
      requestId: crypto.randomUUID(),
      day: today,
      countedNio: 299,
      countedUsd: 10,
      note: '',
    }),
    /motivo/,
  )
  const purchase = (unitPrice) => ({
    requestId: crypto.randomUUID(),
    incurredOn: today,
    supplier: 'Proveedor de prueba',
    agency: 'Agencia',
    reference: 'COMPRA-TEST',
    note: 'Prueba local',
    currency: 'NIO',
    exchangeRate: 1,
    shippingAmount: 100,
    account: 'credito',
    lines: [{ productId: empty, location: 'store', quantity: 10, unitPrice }],
  })
  await rpc('record_shipment', purchase(105))
  await rpc('record_shipment', purchase(85))
  assert.equal(
    Number(
      (
        await db.query(
          'select average_cost_nio from public.product_costs where product_id=$1',
          [empty],
        )
      ).rows[0].average_cost_nio,
    ),
    105,
  )
  const tax = (
    await db.query(
      'select sum(tax_nio) tax,sum(net_revenue_nio) revenue from public.document_item_costs where document_id=$1',
      [doc.id],
    )
  ).rows[0]
  assert.equal(Number(tax.tax), 0)
  assert.equal(Number(tax.revenue), 230)
  const close = {
    requestId: crypto.randomUUID(),
    day: today,
    countedNio: 330,
    countedUsd: 10,
    note: '',
  }
  const closed = await rpc('close_business_day', close)
  assert.equal(closed.status, 'closed')
  assert.equal(closed.report.differenceNio, 0)
  assert.deepEqual(
    (await rpc('close_business_day', close)).report,
    closed.report,
  )
  await assert.rejects(rpc('create_document', invoice()), /cerrada/)
  await db.exec('reset role')
  await assert.rejects(
    db.query('delete from public.documents where id=$1', [doc.id]),
    /cerrada/,
  )
  await identity(admin)
  await assert.rejects(
    rpc('open_business_day', { ...open, requestId: crypto.randomUUID() }),
    /cerrada/,
  )
  await assert.rejects(rpc('record_journal_entry', voucher()), /cerrada/)
  await assert.rejects(
    rpc('record_inventory_movement', {
      requestId: crypto.randomUUID(),
      productId: product,
      location: 'store',
      type: 'DAMAGED',
      quantity: 1,
      note: 'Prueba de jornada cerrada',
    }),
    /cerrada/,
  )
  await identity(outsider)
  await assert.rejects(db.query('select public.get_business_day(null)'))
  console.log(
    'PASS business day: invoice gate, roles, opening/closing replay, cash in both currencies, differences and frozen day',
  )
} finally {
  await db.close()
}

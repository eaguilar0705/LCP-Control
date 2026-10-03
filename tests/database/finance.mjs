// Caja, bancos y deudas sobre las migraciones reales, en PostgreSQL desechable.
import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

const db = new PGlite()
const admin = '11111111-1111-4111-8111-111111111111'
const operator = '22222222-2222-4222-8222-222222222222'
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
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
// Día de Managua (UTC-6, sin horario de verano).
const today = new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10)
const entry = (changes = {}) => ({
  requestId: crypto.randomUUID(), occurredOn: today, kind: 'opening', account: 'caja', toAccount: null,
  amount: 1000, currency: 'NIO', exchangeRate: 1, counterparty: '', description: 'Arqueo', reference: '', ...changes,
})
const expense = (changes = {}) => ({
  requestId: crypto.randomUUID(), incurredOn: today, category: 'renta', description: 'Renta',
  amount: 100, currency: 'NIO', exchangeRate: 1, reference: '', ...changes,
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
  await db.exec("insert into public.business_settings(name) values('Pruebas de caja'); insert into public.brands(name) values('Marca');")
  await db.query("insert into public.products(id,sku,name,brand_id) values($1::uuid,$1::text,'Perfume',(select id from public.brands limit 1))", [product])
  await db.query("insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',115),($1,'emprendedor','USD',10)", [product])
  await db.query("insert into public.inventory_balances(product_id,location,quantity) values($1,'store',20),($1,'warehouse',0)", [product])
  await identity(admin)

  await check('owner records idempotent movements and voids them with a reason', async () => {
    const input = entry()
    const id = await rpc('record_finance_entry', input)
    assert.equal(await rpc('record_finance_entry', input), id)
    await assert.rejects(rpc('record_finance_entry', { ...input, amount: 2 }), /otros datos/)
    const transfer = await rpc('record_finance_entry', entry({ kind: 'transfer', toAccount: 'banco', amount: 200 }))
    await assert.rejects(db.query("select public.void_finance_entry($1,'')", [transfer]), /motivo/)
    await db.query("select public.void_finance_entry($1,'Duplicado')", [transfer])
    const row = (await db.query('select voided_at,void_reason from public.finance_entries where id=$1', [transfer])).rows[0]
    assert.ok(row.voided_at)
    assert.equal(row.void_reason, 'Duplicado')
  })
  await check('invalid accounts, transfers and future dates are rejected', async () => {
    await assert.rejects(rpc('record_finance_entry', entry({ kind: 'loan', account: 'prestamos' })), /Cuenta/)
    await assert.rejects(rpc('record_finance_entry', entry({ kind: 'transfer', toAccount: 'caja' })), /destino/)
    await assert.rejects(rpc('record_finance_entry', entry({ kind: 'capital', toAccount: 'banco' })), /destino/)
    await assert.rejects(rpc('record_finance_entry', entry({ occurredOn: '2999-01-01' })), /Fecha/)
    await assert.rejects(rpc('record_finance_entry', entry({ amount: 0 })), /monto/)
    await rpc('record_finance_entry', entry({ account: 'prestamos', amount: 5000 }))
  })
  await check('expenses and shipments keep where the money came from', async () => {
    await rpc('record_expense', expense({ account: 'banco' }))
    await rpc('record_expense', expense({ category: 'agua_luz', description: 'Luz', amount: 50 }))
    const expenses = (await db.query('select category,account from public.expense_records order by category')).rows
    assert.deepEqual(expenses.map((row) => [row.category, row.account]), [['agua_luz', 'caja'], ['renta', 'banco']])
    await assert.rejects(rpc('record_expense', expense({ account: 'credito' })), /check/)
    await rpc('set_opening_cost', { requestId: crypto.randomUUID(), productId: product, unitCost: 50, currency: 'NIO', exchangeRate: 1, note: 'Costo inicial' })
    await rpc('record_shipment', {
      requestId: crypto.randomUUID(), incurredOn: today, supplier: 'Proveedor', agency: '', reference: '',
      note: '', currency: 'NIO', exchangeRate: 1, shippingAmount: 0, account: 'credito',
      lines: [{ productId: product, location: 'store', quantity: 2, unitPrice: 60 }],
    })
    assert.equal((await db.query('select account from public.purchase_shipments')).rows[0].account, 'credito')
  })
  await check('sales store no tax and are summed by how they were paid', async () => {
    const invoice = (paymentMethod, quantity) => ({
      requestId: crypto.randomUUID(), kind: 'invoice', customerName: 'Cliente',
      tier: 'emprendedor', currency: 'NIO', location: 'store', paymentMethod, notes: '', taxRate: 15,
      items: [{ productId: product, quantity }],
    })
    await rpc('create_document', invoice('cash', 1))
    await rpc('create_document', invoice('pending', 2))
    await rpc('create_document', invoice('bac_nio', 3))
    assert.equal(Number((await db.query('select sum(tax_nio) as tax from public.document_item_costs')).rows[0].tax), 0)
    const sales = (await db.query('select public.finance_sales($1,$1) as result', [today])).rows[0].result
    assert.deepEqual(
      { caja: Number(sales.caja), banco: Number(sales.banco), cobrar: Number(sales.cobrar), missing: Number(sales.missing) },
      { caja: 115, banco: 345, cobrar: 230, missing: 0 },
    )
  })
  await check('other roles cannot read or write the cash book', async () => {
    await identity(operator)
    assert.equal((await db.query('select * from public.finance_entries')).rows.length, 0)
    assert.equal((await db.query('select public.finance_sales($1,$1) as result', [today])).rows[0].result, null)
    await assert.rejects(rpc('record_finance_entry', entry()), /insufficient/)
    await identity(admin)
  })
  console.log(`${checks} finance PostgreSQL checks passed. No deployed database was accessed.`)
} finally {
  await db.close()
}

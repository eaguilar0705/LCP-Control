// Eliminación de facturas: permisos, devolución al inventario, costo promedio,
// bitácora y reversión completa si algo falla. PostgreSQL local y desechable.
import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

const db = new PGlite()
const admin = '11111111-1111-4111-8111-111111111111'
const operator = '22222222-2222-4222-8222-222222222222'
const warehouse = '33333333-3333-4333-8333-333333333333'
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
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
const remove = async (id, reason = '') =>
  (await db.query('select public.delete_invoice($1,$2) as result', [id, reason])).rows[0].result
async function asOwner(sql, params = []) {
  const uid = (await db.query("select current_setting('request.jwt.claim.sub',true) as uid")).rows[0].uid
  await db.exec('reset role')
  const result = await db.query(sql, params)
  if (uid) await identity(uid)
  return result.rows
}
const stock = async (id = product) =>
  (await asOwner("select quantity from public.inventory_balances where product_id=$1 and location='store'", [id]))[0].quantity
const average = async (id = product) => {
  const value = (await asOwner('select average_cost_nio from public.product_costs where product_id=$1', [id]))[0]?.average_cost_nio
  return value == null ? null : Number(value)
}
const invoice = (changes = {}) => ({
  requestId: crypto.randomUUID(), kind: 'invoice', customerName: 'Cliente de prueba',
  tier: 'emprendedor', currency: 'NIO', location: 'store', paymentMethod: 'cash', notes: '',
  taxRate: 15, items: [{ productId: product, quantity: 2 }, { productId: second, quantity: 1 }], ...changes,
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
    create table auth.sessions(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id) on delete cascade);
  `)
  await db.query('insert into auth.users(id) values($1),($2),($3)', [admin, operator, warehouse])
  for (const file of (await readdir('supabase/migrations')).sort())
    if (file.endsWith('.sql') && !file.includes('harden_platform_function_grants'))
      await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'))
  await db.query("insert into public.staff_members(user_id,display_name,role) values($1,'Admin','admin'),($2,'Ventas','operator'),($3,'Bodega','warehouse')", [admin, operator, warehouse])
  await db.exec("insert into public.business_settings(name) values('Pruebas'); insert into public.brands(name) values('Marca');")
  for (const id of [product, second]) {
    await db.query("insert into public.products(id,sku,name,brand_id) values($1::uuid,$1::text,'Perfume',(select id from public.brands limit 1))", [id])
    await db.query("insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',115),($1,'emprendedor','USD',10)", [id])
    await db.query("insert into public.inventory_balances(product_id,location,quantity) values($1,'store',10),($1,'warehouse',0)", [id])
  }
  await identity(admin)
  await rpc('set_opening_cost', { requestId: crypto.randomUUID(), productId: product, unitCost: 50, currency: 'NIO', exchangeRate: 1, note: 'Costo inicial' })

  await identity(operator)
  const doc = await rpc('create_document', invoice())
  const proforma = await rpc('create_document', invoice({ kind: 'proforma', location: undefined, paymentMethod: undefined, validUntil: '2099-01-01' }))
  assert.equal(await stock(), 8)

  await check('only administration can delete an invoice', async () => {
    await identity('', 'anon')
    await assert.rejects(remove(doc.id), /permission denied/)
    for (const id of [operator, warehouse]) {
      await identity(id)
      await assert.rejects(remove(doc.id), /insufficient_privilege/)
    }
  })

  await identity(admin)
  await check('proformas are not deleted through this function', async () => {
    await assert.rejects(remove(proforma.id), /Sólo se pueden eliminar facturas/)
  })

  await check('a missing count rolls the whole deletion back', async () => {
    await asOwner("update public.inventory_balances set quantity=null where product_id=$1 and location='store'", [second])
    await assert.rejects(remove(doc.id), /falta el conteo/)
    assert.equal((await asOwner('select count(*)::int as n from public.documents where id=$1', [doc.id]))[0].n, 1)
    assert.equal(await stock(), 8)
    await asOwner("update public.inventory_balances set quantity=9 where product_id=$1 and location='store'", [second])
  })

  await check('deleting returns the units, re-averages the cost and removes the sale', async () => {
    // El promedio se movió después de la venta: el regreso lo pondera con el
    // costo que la venta había congelado (50), no con el promedio actual.
    await asOwner('update public.product_costs set average_cost_nio=60 where product_id=$1', [product])
    assert.equal(await remove(doc.id, 'Cliente devolvió todo'), doc.number)
    assert.equal(await stock(), 10)
    assert.equal(await stock(second), 10)
    assert.equal(await average(), 58)
    assert.equal(await average(second), null)
    const left = await asOwner(
      `select (select count(*)::int from public.documents where id=$1) as documents,
              (select count(*)::int from public.document_items where document_id=$1) as items,
              (select count(*)::int from public.document_item_costs where document_id=$1) as costs`, [doc.id])
    assert.deepEqual(left[0], { documents: 0, items: 0, costs: 0 })
    const moves = await asOwner("select type,quantity,before_quantity,after_quantity,document_id,note from public.inventory_movements where product_id=$1 order by created_at,type desc", [product])
    assert.deepEqual(moves.map((m) => [m.type, m.quantity, m.before_quantity, m.after_quantity, m.document_id]), [
      ['SALE', 2, 10, 8, null],
      ['ADJUSTMENT', 2, 8, 10, null],
    ])
    assert.match(moves[1].note, /FAC-\d+ eliminada: Cliente devolvió todo/)
    await assert.rejects(remove(doc.id), /ya no existe/)
  })

  await check('the deleted invoice is kept in a private log and numbers are never reused', async () => {
    const log = await asOwner('select number,kind,reason,actor_id,snapshot from private.document_deletions')
    assert.equal(log.length, 1)
    assert.equal(log[0].number, doc.number)
    assert.equal(log[0].reason, 'Cliente devolvió todo')
    assert.equal(log[0].actor_id, admin)
    assert.equal(log[0].snapshot.items.length, 2)
    assert.equal(log[0].snapshot.costs.length, 2)
    await assert.rejects(db.query('select * from private.document_deletions'), /permission denied/)
    await identity(operator)
    const next = await rpc('create_document', invoice({ items: [{ productId: product, quantity: 1 }] }))
    assert.notEqual(next.number, doc.number)
  })
  console.log(`${checks} invoice deletion checks passed`)
} finally {
  await db.close()
}

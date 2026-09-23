import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

// Eliminación de clientes y proveedores: permisos, revisiones, conservación de
// documentos y bitácora. Aplica todas las migraciones sobre un PostgreSQL local.
const db = new PGlite()
const [admin, operator, warehouse] = [1, 2, 3].map(
  (n) => `${n}`.repeat(8) + '-1111-4111-8111-111111111111',
)
async function identity(id, role = 'authenticated') {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id])
  await db.exec(`set role ${role}`)
}
async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0]
}
let checks = 0
async function check(name, fn) {
  await fn()
  console.log(`OK ${name}`)
  checks++
}
const customerId = 'aaaaaaaa-1111-4111-8111-111111111111'
const billedId = 'bbbbbbbb-1111-4111-8111-111111111111'
const supplierId = 'cccccccc-1111-4111-8111-111111111111'
const saveCustomer = (id, name, revision = 0) =>
  db.query('select public.save_customer($1)', [
    {
      id,
      revision,
      name,
      phone: '',
      priceTier: 'emprendedor',
      active: true,
    },
  ])
try {
  await db.exec(`create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[],owner uuid references auth.users(id),owner_id text);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid references auth.users(id),owner_id text,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated,anon; grant select,insert,delete on storage.objects to authenticated;
    create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
    create table auth.sessions(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id) on delete cascade);
  `)
  for (const [id, email] of [
    [admin, 'admin'],
    [operator, 'sales'],
    [warehouse, 'stock'],
  ])
    await db.query('insert into auth.users values($1,$2)', [
      id,
      `${email}@example.test`,
    ])
  for (const f of (await readdir('supabase/migrations')).sort())
    if (f.endsWith('.sql') && !f.includes('harden_platform_function_grants'))
      await db.exec(await readFile(`supabase/migrations/${f}`, 'utf8'))
  for (const [id, role] of [
    [admin, 'admin'],
    [operator, 'operator'],
    [warehouse, 'warehouse'],
  ])
    await db.query(
      'insert into public.staff_members(user_id,display_name,role) values($1,$2,$2)',
      [id, role],
    )

  await identity(admin)
  await saveCustomer(customerId, 'Cliente sin compras')
  await saveCustomer(billedId, 'Cliente con proforma')
  await db.query('select public.save_supplier($1)', [
    { id: supplierId, revision: 0, name: 'Proveedor', active: true },
  ])
  await db.exec('reset role')
  await db.query(
    `insert into public.documents(kind,number,request_id,request_payload,customer_id,customer_name,issuer,tier_code,currency,total,valid_until,created_by)
     values('proforma','PRO-TEST-1',gen_random_uuid(),'{}',$1,'Cliente con proforma','{}','emprendedor','NIO',100,'2099-01-01',$2)`,
    [billedId, admin],
  )

  await check('anonymous, sales and inventory roles cannot delete', async () => {
    await identity('', 'anon')
    await assert.rejects(
      db.query('select public.delete_customer($1,1)', [customerId]),
      /permission denied/,
    )
    for (const id of [operator, warehouse]) {
      await identity(id)
      await assert.rejects(
        db.query('select public.delete_customer($1,1)', [customerId]),
        /insufficient_privilege/,
      )
      await assert.rejects(
        db.query('select public.delete_supplier($1,1)', [supplierId]),
        /insufficient_privilege/,
      )
    }
  })

  await identity(admin)
  await check('a stale revision is rejected', async () => {
    await assert.rejects(
      db.query('select public.delete_customer($1,99)', [customerId]),
      /Otro usuario/,
    )
    await assert.rejects(
      db.query('select public.delete_supplier($1,99)', [supplierId]),
      /Otro usuario/,
    )
  })

  await check('a customer without documents is deleted', async () => {
    const { outcome } = await one(
      'select public.delete_customer($1,1) as outcome',
      [customerId],
    )
    assert.equal(outcome, 'deleted')
    assert.equal(
      (await db.query('select 1 from public.customers where id=$1', [customerId]))
        .rows.length,
      0,
    )
    await assert.rejects(
      db.query('select public.delete_customer($1,1)', [customerId]),
      /ya no existe/,
    )
  })

  await check('a customer with documents is archived, never deleted', async () => {
    const { outcome } = await one(
      'select public.delete_customer($1,1) as outcome',
      [billedId],
    )
    assert.equal(outcome, 'archived')
    const row = await one(
      'select active,revision from public.customers where id=$1',
      [billedId],
    )
    assert.deepEqual(row, { active: false, revision: 2 })
    await db.exec('reset role')
    assert.equal(
      (await one('select count(*)::int as n from public.documents')).n,
      1,
    )
  })

  await identity(admin)
  await check('a supplier is deleted and every action is logged', async () => {
    const { outcome } = await one(
      'select public.delete_supplier($1,1) as outcome',
      [supplierId],
    )
    assert.equal(outcome, 'deleted')
    await db.exec('reset role')
    const log = await db.query(
      'select kind,contact_name,outcome,actor_id from private.contact_deletions order by id',
    )
    assert.deepEqual(log.rows, [
      {
        kind: 'customer',
        contact_name: 'Cliente sin compras',
        outcome: 'deleted',
        actor_id: admin,
      },
      {
        kind: 'customer',
        contact_name: 'Cliente con proforma',
        outcome: 'archived',
        actor_id: admin,
      },
      {
        kind: 'supplier',
        contact_name: 'Proveedor',
        outcome: 'deleted',
        actor_id: admin,
      },
    ])
  })

  await check('the deletion log is private', async () => {
    await identity(admin)
    await assert.rejects(
      db.query('select * from private.contact_deletions'),
      /permission denied/,
    )
  })
  console.log(`${checks} contact checks passed`)
} finally {
  await db.close()
}

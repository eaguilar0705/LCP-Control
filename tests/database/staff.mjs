import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
const db = new PGlite()
const [superadmin, admin, operator, target, outsider] = [1, 2, 3, 4, 5].map(
  (n) => `${n}`.repeat(8) + '-1111-4111-8111-111111111111',
)
async function identity(id, role = 'authenticated') {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id])
  await db.exec(`set role ${role}`)
}
const remove = (email, id, role) =>
  db.query('select public.delete_staff_account($1,$2,$3)', [email, id, role])
let checks = 0
async function check(name, fn) {
  await fn()
  console.log(`OK ${name}`)
  checks++
}
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
    [superadmin, 'owner'],
    [admin, 'admin'],
    [operator, 'sales'],
    [target, 'target'],
    [outsider, 'outsider'],
  ]) {
    await db.query('insert into auth.users values($1,$2)', [
      id,
      `${email}@example.test`,
    ])
  }
  for (const f of (await readdir('supabase/migrations')).sort()) {
    if (f.endsWith('.sql') && !f.includes('harden_platform_function_grants'))
      await db.exec(await readFile(`supabase/migrations/${f}`, 'utf8'))
  }
  for (const [id, role] of [
    [superadmin, 'superadmin'],
    [admin, 'admin'],
    [operator, 'operator'],
    [target, 'admin'],
  ]) {
    await db.query(
      'insert into public.staff_members(user_id,display_name,role) values($1,$2,$2)',
      [id, role],
    )
  }
  await db.query('insert into auth.sessions(user_id) values($1)', [target])
  await check(
    'anonymous, sales and unregistered users cannot delete accounts',
    async () => {
      await identity('', 'anon')
      await assert.rejects(
        remove('target@example.test', target, 'admin'),
        /permission denied/,
      )
      for (const id of [operator, outsider]) {
        await identity(id)
        await assert.rejects(
          remove('target@example.test', target, 'admin'),
          /insufficient_privilege/,
        )
      }
    },
  )
  await identity(admin)
  await check(
    'admin cannot delete own account, a SuperAdmin or a changed target',
    async () => {
      await assert.rejects(
        remove('admin@example.test', admin, 'admin'),
        /propia cuenta/,
      )
      await assert.rejects(
        remove('owner@example.test', superadmin, 'superadmin'),
        /insufficient_privilege/,
      )
      await assert.rejects(
        remove('target@example.test', null, 'admin'),
        /cambió/,
      )
      await assert.rejects(
        remove('target@example.test', target, 'operator'),
        /cambió/,
      )
    },
  )
  await check(
    'pending ordinary users are deleted and can no longer activate',
    async () => {
      await db.query(
        "select public.save_staff_account('pending@example.test','Pendiente','operator',true)",
      )
      await remove('pending@example.test', null, 'operator')
      await db.exec('reset role')
      await assert.rejects(
        db.query(
          "insert into auth.users values(gen_random_uuid(),'pending@example.test')",
        ),
        /no autorizada/,
      )
    },
  )
  await check('admin cannot remove a pending SuperAdmin', async () => {
    await identity(superadmin)
    await db.query(
      "select public.save_staff_account('next-owner@example.test','Pendiente','superadmin',true)",
    )
    await identity(admin)
    await assert.rejects(
      remove('next-owner@example.test', null, 'superadmin'),
      /insufficient_privilege/,
    )
    await identity(superadmin)
    await remove('next-owner@example.test', null, 'superadmin')
  })
  await check('unrelated Storage files cause a full rollback', async () => {
    await db.exec('reset role')
    await db.query(
      "insert into storage.objects(bucket_id,name,owner,owner_id) values('other','keep.txt',$1::uuid,$1::uuid::text)",
      [target],
    )
    await identity(admin)
    await assert.rejects(
      remove('target@example.test', target, 'admin'),
      /fuera del catálogo/,
    )
    await db.exec('reset role')
    assert.equal(
      (await db.query('select * from auth.users where id=$1', [target])).rows
        .length,
      1,
    )
    assert.equal(
      (
        await db.query(
          'select * from private.staff_deletions where target_id=$1',
          [target],
        )
      ).rows.length,
      0,
    )
    await db.query('delete from storage.objects where owner=$1', [target])
  })
  await check(
    'admin deletes ordinary credentials, staff and sessions; old tokens lose access',
    async () => {
      await identity(admin)
      await remove('target@example.test', target, 'admin')
      await db.exec('reset role')
      for (const [table, col] of [
        ['auth.users', 'id'],
        ['public.staff_members', 'user_id'],
        ['auth.sessions', 'user_id'],
      ]) {
        assert.equal(
          (await db.query(`select * from ${table} where ${col}=$1`, [target]))
            .rows.length,
          0,
        )
      }
      assert.equal(
        (
          await db.query(
            'select * from private.staff_deletions where target_id=$1',
            [target],
          )
        ).rows.length,
        1,
      )
      await identity(target)
      await assert.rejects(
        db.query('select * from public.list_staff_accounts()'),
        /insufficient_privilege/,
      )
      await assert.rejects(
        remove('admin@example.test', admin, 'admin'),
        /insufficient_privilege/,
      )
    },
  )
  await check(
    'SuperAdmin can delete another SuperAdmin, but never itself',
    async () => {
      await identity(superadmin)
      await assert.rejects(
        remove('owner@example.test', superadmin, 'superadmin'),
        /propia cuenta/,
      )
      await db.query(
        "select public.save_staff_account('admin@example.test','Admin','superadmin',true)",
      )
      await remove('admin@example.test', admin, 'superadmin')
      assert.equal(
        (
          await db.query('select * from public.list_staff_accounts()')
        ).rows.filter((r) => r.role === 'superadmin' && r.active).length,
        1,
      )
    },
  )
  console.log(
    `${checks} staff PostgreSQL checks passed. No deployed database was accessed.`,
  )
} finally {
  await db.close()
}

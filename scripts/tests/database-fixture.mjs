import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
export const admin = '11111111-1111-4111-8111-111111111111',
  operator = '22222222-2222-4222-8222-222222222222',
  warehouse = '33333333-3333-4333-8333-333333333333',
  viewer = '44444444-4444-4444-8444-444444444444',
  outsider = '55555555-5555-4555-8555-555555555555'
export async function database() {
  const db = new PGlite()
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
    grant select on storage.objects to anon;
    create function storage.allow_only_operation(text) returns boolean language sql stable as $$
      select coalesce(current_setting('storage.operation',true),'')=$1
    $$;
    create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
  `)
    await db.query(
      'insert into auth.users(id) values($1),($2),($3),($4),($5)',
      [admin, operator, warehouse, viewer, outsider],
    )
    for (const file of (await readdir('backend/supabase/migrations')).sort()) {
      if (
        file.endsWith('.sql') &&
        !file.includes('harden_platform_function_grants')
      ) {
        await db.exec(
          (
            await readFile(`backend/supabase/migrations/${file}`, 'utf8')
          ).replace(/\r\n/g, '\n'),
        )
      }
    }

    return db
  } catch (error) {
    await db.close()
    throw error
  }
}
export async function identity(db, id, role = 'authenticated') {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id])
  await db.exec('set role ' + role)
}
export async function rpc(db, name, input) {
  return (
    await db.query('select public.' + name + '($1::jsonb) result', [
      JSON.stringify(input),
    ])
  ).rows[0].result
}

// @vitest-environment node
/**
 * La pantalla y la base calculan el mismo precio al centavo.
 *
 * El editor enseña el precio de venta antes de guardar y la base lo vuelve a
 * calcular al guardarlo. Si redondearan distinto, el dueño vería C$ 18,30 y la
 * factura cobraría C$ 18,31. Esta prueba carga las migraciones en PGlite y
 * compara `markupPrice` y `convertPrice` con `private.markup_price` y
 * `private.convert_price` en miles de casos al azar (con semilla fija) y en los
 * bordes de medio centavo.
 */
import { readFile, readdir } from 'node:fs/promises'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { convertPrice, markupPrice } from '@/lib/pricing'

const db = new PGlite()

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = seeded(20260926)
/** Un entero al azar entre min y max, dividido entre 10^decimals. */
const amount = (min: number, max: number, decimals: number) =>
  Math.floor(min + random() * (max - min + 1)) / 10 ** decimals

beforeAll(async () => {
  await db.exec(`create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[],owner uuid,owner_id text);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid,owner_id text,unique(bucket_id,name));
    create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
    create table auth.sessions(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id) on delete cascade);`)
  for (const file of (await readdir('supabase/migrations')).sort())
    if (
      file.endsWith('.sql') &&
      !file.includes('harden_platform_function_grants')
    )
      await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'))
}, 60_000)
afterAll(() => db.close())

it('marks up exactly like PostgreSQL', async () => {
  const cases: [number, number][] = [
    [500, 20],
    [10.05, 10],
    [33.33, 12.5],
    [0.01, 0],
    [0.01, 49.99],
    [0.01, 50],
    [9999999.99, 0.01],
    [10000000, 1000],
  ]
  for (let index = 0; index < 3000; index++)
    cases.push([amount(1, 2_000_000, 2), amount(0, 100_000, 2)])
  const { rows } = await db.query<{ price: string }>(
    'select private.markup_price(c,p)::text as price from unnest($1::numeric[],$2::numeric[]) as t(c,p)',
    [cases.map(([cost]) => cost), cases.map(([, percent]) => percent)],
  )
  const mismatches = cases.filter(
    ([cost, percent], index) =>
      markupPrice(cost, percent) !== Number(rows[index].price),
  )
  expect(mismatches).toEqual([])
})

it('converts between córdobas and dollars exactly like PostgreSQL', async () => {
  const cases: [number, number][] = [
    [0.5, 36.61],
    [600, 36.6],
    [0.01, 2],
    [16.39, 36.6],
    [1, 36.624],
    [12.5, 0.4],
  ]
  for (let index = 0; index < 3000; index++)
    cases.push([amount(1, 50_000_000, 2), amount(30_000_000, 40_000_000, 6)])
  // Tasas con pocos decimales producen más empates exactos de medio centavo.
  for (let index = 0; index < 1000; index++)
    cases.push([amount(1, 500_000, 2), amount(3000, 4000, 2)])
  for (const direction of ['NIO', 'USD'] as const) {
    const from = direction === 'NIO' ? 'USD' : 'NIO'
    const { rows } = await db.query<{ price: string }>(
      'select private.convert_price(a,$3,$4,r)::text as price from unnest($1::numeric[],$2::numeric[]) as t(a,r)',
      [
        cases.map(([value]) => value),
        cases.map(([, rate]) => rate),
        from,
        direction,
      ],
    )
    const mismatches = cases.filter(
      ([value, rate], index) =>
        convertPrice(value, from, direction, rate) !==
        Number(rows[index].price),
    )
    expect(mismatches).toEqual([])
  }
})

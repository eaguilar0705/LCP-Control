// Precio de venta desde el precio de compra: precio = compra × (1 + % / 100)
// por lista, en la moneda de la compra; la otra moneda sale de la tasa. El
// costo promedio queda para la contabilidad y ya no mueve precios.
// PostgreSQL local y desechable.
import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

const NEW_MIGRATION = '20261002120000_purchase_price_pricing.sql'
const admin = '11111111-1111-4111-8111-111111111111'
const operator = '22222222-2222-4222-8222-222222222222'
const usd = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const nio = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const legacy = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
let db
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
async function asOwner(sql, params = []) {
  const uid = (
    await db.query(
      "select current_setting('request.jwt.claim.sub',true) as uid",
    )
  ).rows[0].uid
  await db.exec('reset role')
  try {
    return (await db.query(sql, params)).rows
  } finally {
    if (uid) await identity(uid)
  }
}
const rpc = async (name, input) =>
  (
    await db.query(`select public.${name}($1::jsonb) as result`, [
      JSON.stringify(input),
    ])
  ).rows[0].result
const saveProduct = (payload) => rpc('save_catalog_product', payload)
const savePricing = (rows) => rpc('save_product_pricing', rows)
const setRate = (rate) =>
  db.query('select public.set_exchange_rate($1)', [rate])
const revision = async (id) =>
  (await asOwner('select revision from public.products where id=$1', [id]))[0]
    .revision
async function prices(id) {
  const rows = await asOwner(
    'select tier_code,currency,amount from public.product_prices where product_id=$1',
    [id],
  )
  const result = {}
  for (const row of rows)
    (result[row.tier_code] ??= {})[row.currency] = Number(row.amount)
  return result
}
async function average(id) {
  const row = (
    await asOwner(
      'select average_cost_nio from public.product_costs where product_id=$1',
      [id],
    )
  )[0]
  return row?.average_cost_nio == null ? null : Number(row.average_cost_nio)
}
const pricingRow = async (id) =>
  (
    await asOwner('select * from public.product_pricing where product_id=$1', [
      id,
    ])
  )[0] ?? null
const history = async (id) =>
  (await db.query('select * from public.list_price_changes($1)', [id])).rows
const count = (id, store, warehouse) =>
  asOwner(
    "update public.inventory_balances set quantity=case location when 'store' then $2::int else $3::int end where product_id=$1",
    [id, store, warehouse],
  )
const markups = (emprendedor, vip, premium) => ({
  markups: { emprendedor, vip, premium },
})
const product = (id, changes = {}) => ({
  id,
  revision: 0,
  name: `Perfume ${id.slice(0, 4)}`,
  brand: 'Marca',
  size: 100,
  unit: 'ml',
  category: 'arabian',
  gender: 'unisex',
  manufacturerBarcode: '',
  minimumStock: 0,
  active: true,
  imagePath: null,
  prices: {
    emprendedor: { USD: 35, NIO: 0 },
    vip: { USD: 34, NIO: 0 },
    premium: { USD: 32, NIO: 0 },
  },
  ...changes,
})
const opening = (productId, unitCost, changes = {}) => ({
  requestId: crypto.randomUUID(),
  productId,
  unitCost,
  currency: 'NIO',
  exchangeRate: 1,
  note: 'Costo de la factura del proveedor',
  ...changes,
})
const shipment = (lines, changes = {}) => ({
  requestId: crypto.randomUUID(),
  incurredOn: '2026-09-26',
  supplier: 'Proveedor',
  agency: '',
  reference: 'PED-100',
  note: '',
  currency: 'NIO',
  exchangeRate: 1,
  shippingAmount: 0,
  lines,
  ...changes,
})

async function bootstrap(until) {
  db = new PGlite()
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
  await db.query('insert into auth.users(id) values($1),($2)', [
    admin,
    operator,
  ])
  for (const file of (await readdir('supabase/migrations')).sort()) {
    if (
      !file.endsWith('.sql') ||
      file.includes('harden_platform_function_grants')
    )
      continue
    if (until && file >= until) break
    await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'))
  }
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Dueña','admin'),($2,'Ventas','operator')",
    [admin, operator],
  )
  await db.exec("insert into public.business_settings(name) values('Pruebas');")
}

const withPurchase = (purchasePrice, purchaseCurrency, e, v, p) => ({
  purchasePrice,
  purchaseCurrency,
  markups: { emprendedor: e, vip: v, premium: p },
})
const saveOne = async (id, pricing) =>
  savePricing([{ productId: id, revision: await revision(id), pricing }])

// --- La migración no cambia precios y aparta los precios de compra viejos ---
try {
  await bootstrap(NEW_MIGRATION)
  await identity(admin)
  await setRate(36.6)
  await saveProduct(product(legacy))
  await count(legacy, 4, 0)
  await asOwner(
    `insert into public.product_pricing(product_id,purchase_price,purchase_currency,markup_emprendedor,markup_vip,markup_premium,updated_by)
     values($1,500,'NIO',20,null,null,$2)`,
    [legacy, admin],
  )
  await asOwner(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,100)',
    [legacy],
  )
  const before = await prices(legacy)
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub','',false)")
  await db.exec(await readFile(`supabase/migrations/${NEW_MIGRATION}`, 'utf8'))
  await identity(admin)
  await check(
    'the migration keeps every published price and sets old purchase prices aside',
    async () => {
      assert.deepEqual(await prices(legacy), before)
      const row = await pricingRow(legacy)
      assert.equal(row.purchase_price, null)
      assert.equal(Number(row.markup_emprendedor), 20)
      const retired = await asOwner(
        'select purchase_price from private.retired_purchase_prices where product_id=$1',
        [legacy],
      )
      assert.equal(Number(retired[0].purchase_price), 500)
      assert.equal(await average(legacy), 100)
    },
  )
  await db.close()
} catch (error) {
  await db?.close()
  throw error
}

// --- El modelo nuevo, de punta a punta -------------------------------------
try {
  await bootstrap()
  await identity(admin)
  await setRate(36.6)
  for (const id of [usd, nio]) await saveProduct(product(id))
  await count(usd, 5, 8)
  await count(nio, 2, 0)

  await check(
    'a USD purchase price plus each list percentage gives the sale price',
    async () => {
      await saveOne(usd, withPurchase(20, 'USD', 25, 20, null))
      assert.deepEqual(await prices(usd), {
        emprendedor: { USD: 25, NIO: 915 },
        vip: { USD: 24, NIO: 878.4 },
        premium: { USD: 32, NIO: 1171.2 },
      })
      const row = await pricingRow(usd)
      assert.equal(Number(row.purchase_price), 20)
      assert.equal(row.purchase_currency, 'USD')
    },
  )

  await check(
    'a córdoba purchase price fixes the córdoba price and converts the dollar',
    async () => {
      await saveOne(nio, withPurchase(500, 'NIO', 20, 30, 50))
      assert.deepEqual(await prices(nio), {
        emprendedor: { NIO: 600, USD: 16.39 },
        vip: { NIO: 650, USD: 17.76 },
        premium: { NIO: 750, USD: 20.49 },
      })
    },
  )

  await check(
    'percentages without a purchase price stay pending and keep the published price',
    async () => {
      const id = crypto.randomUUID()
      await saveProduct(product(id))
      const before = await prices(id)
      await saveOne(id, withPurchase(null, 'USD', 40, 40, 40))
      assert.deepEqual(await prices(id), before)
      await saveOne(id, withPurchase(10, 'USD', 40, 40, 40))
      assert.equal((await prices(id)).vip.USD, 14)
    },
  )

  await check(
    'saving only percentages keeps the saved purchase price',
    async () => {
      await saveOne(usd, markups(30, 20, null))
      const row = await pricingRow(usd)
      assert.equal(Number(row.purchase_price), 20)
      assert.equal((await prices(usd)).emprendedor.USD, 26)
    },
  )

  await check('inventory cost changes no longer move prices', async () => {
    const before = await prices(usd)
    await rpc('set_opening_cost', opening(usd, 400))
    await rpc(
      'record_shipment',
      shipment([
        { productId: usd, location: 'store', quantity: 3, unitPrice: 900 },
      ]),
    )
    assert.ok((await average(usd)) > 400)
    assert.deepEqual(await prices(usd), before)
  })

  await check(
    'a new rate moves only the currency the purchase was not made in',
    async () => {
      await setRate(37)
      assert.deepEqual((await prices(usd)).emprendedor, { USD: 26, NIO: 962 })
      assert.deepEqual((await prices(nio)).emprendedor, {
        NIO: 600,
        USD: 16.22,
      })
      // Premium de `usd` es a mano: queda el dólar.
      assert.deepEqual((await prices(usd)).premium, { USD: 32, NIO: 1184 })
    },
  )

  await check(
    'the perfume form saves the purchase price with the rest of the data',
    async () => {
      const id = crypto.randomUUID()
      await saveProduct(
        product(id, { pricing: withPurchase(50, 'USD', 10, null, null) }),
      )
      assert.equal((await prices(id)).emprendedor.USD, 55)
      assert.equal(Number((await pricingRow(id)).purchase_price), 50)
    },
  )

  await check(
    'the history says the price came from the purchase price',
    async () => {
      const rows = await history(usd)
      const latest = rows.find(
        (row) => row.tier === 'emprendedor' && !row.automatic,
      )
      assert.equal(Number(latest.purchase_price), 20)
      assert.equal(latest.purchase_currency, 'USD')
      assert.equal(latest.average_cost, null)
      assert.equal(Number(latest.markup), 30)
    },
  )

  await check('invalid purchase prices roll back the save', async () => {
    const before = await pricingRow(usd)
    for (const bad of [0, -5, 10.123, 'diez'])
      await assert.rejects(
        saveOne(usd, withPurchase(bad, 'USD', 30, 20, null)),
        /precio de compra/,
      )
    await assert.rejects(
      saveOne(usd, withPurchase(10, 'EUR', 30, 20, null)),
      /moneda/,
    )
    assert.deepEqual(await pricingRow(usd), before)
  })

  await check(
    'clearing the purchase price and every percentage leaves manual prices',
    async () => {
      const before = await prices(nio)
      await saveOne(nio, withPurchase(null, 'NIO', null, null, null))
      assert.equal(await pricingRow(nio), null)
      // A mano manda el dólar: queda el último y el córdoba sale de la tasa.
      const after = await prices(nio)
      for (const tier of ['emprendedor', 'vip', 'premium'])
        assert.equal(after[tier].USD, before[tier].USD)
      assert.equal(after.emprendedor.NIO, 600.14)
    },
  )

  await check('sales staff cannot read or save purchase prices', async () => {
    await identity(operator)
    const rows = (await db.query('select * from public.product_pricing')).rows
    assert.equal(rows.length, 0)
    await assert.rejects(
      savePricing([
        {
          productId: usd,
          revision: 0,
          pricing: withPurchase(1, 'USD', 1, 1, 1),
        },
      ]),
    )
    await identity(admin)
  })

  console.log(`${checks} purchase-price checks passed`)
} finally {
  await db.close()
}

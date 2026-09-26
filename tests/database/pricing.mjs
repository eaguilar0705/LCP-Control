// Precio de compra y porcentaje de ganancia por lista: permisos, cálculo en las
// dos monedas, cambio de tasa, validaciones, carga de varios perfumes a la vez
// (todo o nada) e historial. PostgreSQL local y desechable.
import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

const db = new PGlite()
const admin = '11111111-1111-4111-8111-111111111111'
const operator = '22222222-2222-4222-8222-222222222222'
const cordobas = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const dollars = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const manual = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const disposable = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
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
  const result = await db.query(sql, params)
  if (uid) await identity(uid)
  return result.rows
}
const saveProduct = async (payload) =>
  (
    await db.query('select public.save_catalog_product($1::jsonb) as id', [
      JSON.stringify(payload),
    ])
  ).rows[0].id
const savePricing = async (rows) =>
  (
    await db.query('select public.save_product_pricing($1::jsonb) as count', [
      JSON.stringify(rows),
    ])
  ).rows[0].count
const setRate = (rate) =>
  db.query('select public.set_exchange_rate($1)', [rate])
const revision = async (id) =>
  (await asOwner('select revision from public.products where id=$1', [id]))[0]
    .revision
/** Precios del perfume como { lista: { USD, NIO } }, en números. */
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
const pricingRow = async (id) =>
  (
    await asOwner('select * from public.product_pricing where product_id=$1', [
      id,
    ])
  )[0] ?? null
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
const pricing = (
  purchasePrice,
  purchaseCurrency,
  emprendedor,
  vip,
  premium,
) => ({
  purchasePrice,
  purchaseCurrency,
  markups: { emprendedor, vip, premium },
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
  await db.query('insert into auth.users(id) values($1),($2)', [
    admin,
    operator,
  ])
  for (const file of (await readdir('supabase/migrations')).sort())
    if (
      file.endsWith('.sql') &&
      !file.includes('harden_platform_function_grants')
    )
      await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'))
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Dueña','admin'),($2,'Ventas','operator')",
    [admin, operator],
  )
  await db.exec("insert into public.business_settings(name) values('Pruebas');")

  await identity(admin)
  await setRate(36.6)
  for (const id of [cordobas, dollars, manual]) await saveProduct(product(id))

  await check(
    'the migration leaves every existing price untouched',
    async () => {
      assert.deepEqual(await prices(manual), {
        emprendedor: { USD: 35, NIO: 1281 },
        vip: { USD: 34, NIO: 1244.4 },
        premium: { USD: 32, NIO: 1171.2 },
      })
      assert.equal(
        (
          await asOwner('select count(*)::int as n from public.product_pricing')
        )[0].n,
        0,
      )
    },
  )

  await check(
    'purchase price in córdobas: C$ 500 + 20 % sells at C$ 600 and the dollar follows the rate',
    async () => {
      // Los dólares del formulario no cuentan en una lista con porcentaje.
      await saveProduct(
        product(cordobas, {
          revision: await revision(cordobas),
          prices: {
            emprendedor: { USD: 1, NIO: 0 },
            vip: { USD: 1, NIO: 0 },
            premium: { USD: 1, NIO: 0 },
          },
          pricing: pricing(500, 'NIO', 20, 15, 10),
        }),
      )
      assert.deepEqual(await prices(cordobas), {
        emprendedor: { NIO: 600, USD: 16.39 },
        vip: { NIO: 575, USD: 15.71 },
        premium: { NIO: 550, USD: 15.03 },
      })
      const row = await pricingRow(cordobas)
      assert.equal(Number(row.purchase_price), 500)
      assert.equal(row.purchase_currency, 'NIO')
      assert.equal(row.updated_by, admin)
    },
  )

  await check(
    'purchase price in dollars computes the dollar and converts the córdoba',
    async () => {
      await saveProduct(
        product(dollars, {
          revision: await revision(dollars),
          pricing: pricing(20, 'USD', 25, 20, 10),
        }),
      )
      assert.deepEqual(await prices(dollars), {
        emprendedor: { USD: 25, NIO: 915 },
        vip: { USD: 24, NIO: 878.4 },
        premium: { USD: 22, NIO: 805.2 },
      })
    },
  )

  await check('cents are rounded half up, the same as the app', async () => {
    // 10.05 × 1.10 = 11.055 → 11.06; 33.33 × 1.125 = 37.49625 → 37.50.
    assert.equal(
      Number(
        (await asOwner('select private.markup_price(10.05,10) as v'))[0].v,
      ),
      11.06,
    )
    assert.equal(
      Number(
        (await asOwner('select private.markup_price(33.33,12.5) as v'))[0].v,
      ),
      37.5,
    )
    assert.equal(
      Number((await asOwner('select private.markup_price(500,0) as v'))[0].v),
      500,
    )
  })

  await check(
    'a list without percentage keeps its manual dollar price',
    async () => {
      await saveProduct(
        product(manual, {
          revision: await revision(manual),
          prices: {
            emprendedor: { USD: 99, NIO: 0 },
            vip: { USD: 30, NIO: 0 },
            premium: { USD: 29, NIO: 0 },
          },
          pricing: pricing(400, 'NIO', 25, null, null),
        }),
      )
      assert.deepEqual(await prices(manual), {
        emprendedor: { NIO: 500, USD: 13.66 },
        vip: { USD: 30, NIO: 1098 },
        premium: { USD: 29, NIO: 1061.4 },
      })
    },
  )

  await check(
    'a percentage without purchase price computes nothing',
    async () => {
      const id = crypto.randomUUID()
      await saveProduct(
        product(id, { pricing: pricing(null, 'NIO', 20, 20, 20) }),
      )
      assert.deepEqual(await prices(id), {
        emprendedor: { USD: 35, NIO: 1281 },
        vip: { USD: 34, NIO: 1244.4 },
        premium: { USD: 32, NIO: 1171.2 },
      })
      assert.equal(Number((await pricingRow(id)).markup_vip), 20)
    },
  )

  await check(
    'a new rate keeps córdoba purchases fixed in córdobas and dollar purchases fixed in dollars',
    async () => {
      await setRate(37)
      assert.deepEqual(await prices(cordobas), {
        emprendedor: { NIO: 600, USD: 16.22 },
        vip: { NIO: 575, USD: 15.54 },
        premium: { NIO: 550, USD: 14.86 },
      })
      assert.deepEqual(await prices(dollars), {
        emprendedor: { USD: 25, NIO: 925 },
        vip: { USD: 24, NIO: 888 },
        premium: { USD: 22, NIO: 814 },
      })
      assert.deepEqual(await prices(manual), {
        emprendedor: { NIO: 500, USD: 13.51 },
        vip: { USD: 30, NIO: 1110 },
        premium: { USD: 29, NIO: 1073 },
      })
    },
  )

  await check('invoices charge the computed price', async () => {
    await asOwner(
      'update public.inventory_balances set quantity=5 where product_id=$1',
      [cordobas],
    )
    const document = (
      await db.query('select public.create_document($1::jsonb) as d', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          kind: 'invoice',
          customerName: 'Cliente',
          tier: 'emprendedor',
          currency: 'NIO',
          location: 'store',
          paymentMethod: 'cash',
          notes: '',
          items: [{ productId: cordobas, quantity: 2 }],
        }),
      ])
    ).rows[0].d
    assert.equal(Number(document.items[0].unit_price), 600)
    assert.equal(Number(document.total), 1200)
  })

  await check(
    'invalid purchase prices and percentages roll back the whole save',
    async () => {
      const before = {
        prices: await prices(dollars),
        revision: await revision(dollars),
        row: await pricingRow(dollars),
      }
      const invalid = [
        [pricing(-1, 'USD', 25, 20, 10), /precio de compra/],
        [pricing(0, 'USD', 25, 20, 10), /precio de compra/],
        [pricing(12.345, 'USD', 25, 20, 10), /precio de compra/],
        [pricing('20', 'USD', 25, 20, 10), /precio de compra/],
        [pricing(20, 'EUR', 25, 20, 10), /moneda/],
        [pricing(20, 'USD', 1000.01, 20, 10), /porcentaje/],
        [pricing(20, 'USD', 25, -1, 10), /porcentaje/],
        [pricing(20, 'USD', 25, 20, 10.555), /porcentaje/],
        [pricing(10000000, 'USD', 100, 20, 10), /demasiado alto/],
        [
          { purchasePrice: 20, purchaseCurrency: 'USD', markups: [] },
          /porcentaje/,
        ],
      ]
      for (const [value, message] of invalid) {
        await assert.rejects(
          saveProduct(
            product(dollars, { revision: before.revision, pricing: value }),
          ),
          message,
        )
        await assert.rejects(
          savePricing([
            { productId: dollars, revision: before.revision, pricing: value },
          ]),
          message,
        )
      }
      await assert.rejects(
        saveProduct(
          product(dollars, { revision: before.revision, pricing: 'x' }),
        ),
        /porcentajes/,
      )
      assert.deepEqual(await prices(dollars), before.prices)
      assert.equal(await revision(dollars), before.revision)
      assert.deepEqual(await pricingRow(dollars), before.row)
    },
  )

  await check(
    'an older screen that does not send pricing keeps the stored rule',
    async () => {
      await saveProduct(
        product(cordobas, {
          revision: await revision(cordobas),
          name: 'Perfume renombrado',
          prices: {
            emprendedor: { USD: 1, NIO: 0 },
            vip: { USD: 1, NIO: 0 },
            premium: { USD: 1, NIO: 0 },
          },
        }),
      )
      assert.equal((await prices(cordobas)).emprendedor.NIO, 600)
      assert.equal(Number((await pricingRow(cordobas)).markup_emprendedor), 20)
    },
  )

  await check('sales staff cannot read or change purchase prices', async () => {
    await identity(operator)
    assert.equal(
      (await db.query('select * from public.product_pricing')).rows.length,
      0,
    )
    await assert.rejects(
      savePricing([
        {
          productId: dollars,
          revision: 1,
          pricing: pricing(1, 'USD', 1, 1, 1),
        },
      ]),
      (error) => error.code === '42501',
    )
    await assert.rejects(
      db.query('select * from public.list_price_changes($1)', [cordobas]),
      (error) => error.code === '42501',
    )
    await assert.rejects(
      db.query('select * from private.markup_rules'),
      (error) => error.code === '42501',
    )
    // El precio de venta sigue a la vista, como siempre.
    assert.equal(
      (
        await db.query(
          "select amount from public.product_prices where product_id=$1 and tier_code='emprendedor' and currency='NIO'",
          [cordobas],
        )
      ).rows[0].amount,
      '600.00',
    )
    await identity(admin, 'anon')
    await assert.rejects(
      db.query('select * from public.product_pricing'),
      (error) => error.code === '42501',
    )
    await identity(admin)
  })

  await check(
    'several perfumes are saved together, all or nothing',
    async () => {
      const revisions = {
        dollars: await revision(dollars),
        manual: await revision(manual),
      }
      const before = await prices(dollars)
      await assert.rejects(
        savePricing([
          {
            productId: dollars,
            revision: revisions.dollars,
            pricing: pricing(30, 'USD', 10, 10, 10),
          },
          {
            productId: manual,
            revision: revisions.manual,
            pricing: pricing(400, 'NIO', 25, 2000, 10),
          },
        ]),
        /«Perfume cccc»: Cada porcentaje/,
      )
      assert.deepEqual(await prices(dollars), before)
      assert.equal(
        await savePricing([
          {
            productId: dollars,
            revision: revisions.dollars,
            pricing: pricing(30, 'USD', 10, 10, 10),
          },
          {
            productId: manual,
            revision: revisions.manual,
            pricing: pricing(400, 'NIO', 25, 20, 10),
          },
        ]),
        2,
      )
      assert.deepEqual(await prices(dollars), {
        emprendedor: { USD: 33, NIO: 1221 },
        vip: { USD: 33, NIO: 1221 },
        premium: { USD: 33, NIO: 1221 },
      })
      assert.deepEqual(await prices(manual), {
        emprendedor: { NIO: 500, USD: 13.51 },
        vip: { NIO: 480, USD: 12.97 },
        premium: { NIO: 440, USD: 11.89 },
      })
      assert.equal(await revision(dollars), revisions.dollars + 1)
      assert.equal(await revision(manual), revisions.manual + 1)
    },
  )

  await check(
    'a stale revision, a repeated perfume or a missing one saves nothing',
    async () => {
      const current = await revision(dollars)
      await assert.rejects(
        savePricing([
          {
            productId: dollars,
            revision: current - 1,
            pricing: pricing(1, 'USD', 1, 1, 1),
          },
        ]),
        /Otro usuario cambió «Perfume bbbb»/,
      )
      await assert.rejects(
        savePricing([
          {
            productId: dollars,
            revision: current,
            pricing: pricing(1, 'USD', 1, 1, 1),
          },
          {
            productId: dollars.toUpperCase(),
            revision: current,
            pricing: pricing(2, 'USD', 1, 1, 1),
          },
        ]),
        /dos veces/,
      )
      await assert.rejects(
        savePricing([
          {
            productId: crypto.randomUUID(),
            revision: 1,
            pricing: pricing(1, 'USD', 1, 1, 1),
          },
        ]),
        /ya no existe/,
      )
      await assert.rejects(
        savePricing([
          {
            productId: 'no-es-un-id',
            revision: 1,
            pricing: pricing(1, 'USD', 1, 1, 1),
          },
        ]),
        /Revisa los perfumes/,
      )
      await assert.rejects(savePricing([]), /entre 1 y 2000/)
      assert.equal(await revision(dollars), current)
      assert.equal(Number((await pricingRow(dollars)).purchase_price), 30)
    },
  )

  await check(
    'clearing the purchase price and percentages keeps the last prices as manual ones',
    async () => {
      await savePricing([
        {
          productId: manual,
          revision: await revision(manual),
          pricing: pricing(null, 'NIO', null, null, null),
        },
      ])
      assert.equal(await pricingRow(manual), null)
      // Los dólares quedan; los córdobas vuelven a salir de la tasa.
      assert.deepEqual(await prices(manual), {
        emprendedor: { USD: 13.51, NIO: 499.87 },
        vip: { USD: 12.97, NIO: 479.89 },
        premium: { USD: 11.89, NIO: 439.93 },
      })
      await setRate(36.6)
      assert.equal((await prices(manual)).emprendedor.NIO, 494.47)
    },
  )

  await check(
    'price history tells the percentage, the purchase price and córdoba-only changes',
    async () => {
      // Comprado en córdobas: sube de 500 a 510 con el mismo 20 %. A 36,6 el
      // dólar pasa de 16,39 a 16,72; el cambio se registra con su porcentaje.
      await savePricing([
        {
          productId: cordobas,
          revision: await revision(cordobas),
          pricing: pricing(510, 'NIO', 20, 15, 10),
        },
      ])
      const history = (
        await db.query('select * from public.list_price_changes($1)', [
          cordobas,
        ])
      ).rows
      const latest = history.find((row) => row.tier === 'emprendedor')
      assert.equal(Number(latest.after_nio), 612)
      assert.equal(Number(latest.before_nio), 600)
      assert.equal(Number(latest.markup), 20)
      assert.equal(Number(latest.purchase_price), 510)
      assert.equal(latest.purchase_currency, 'NIO')
      assert.equal(latest.actor, 'Dueña')
      // Un porcentaje que cambia sin mover el precio también queda: compra 510 → 612 y 20 % → 0 % deja la venta en C$ 612.
      await savePricing([
        {
          productId: cordobas,
          revision: await revision(cordobas),
          pricing: pricing(612, 'NIO', 0, 15, 10),
        },
      ])
      const same = (
        await db.query('select * from public.list_price_changes($1)', [
          cordobas,
        ])
      ).rows[0]
      assert.equal(same.tier, 'emprendedor')
      assert.equal(Number(same.before_nio), Number(same.after_nio))
      assert.equal(Number(same.markup), 0)
      // Una lista a mano no trae porcentaje ni precio de compra.
      const manualRows = (
        await db.query('select * from public.list_price_changes($1)', [manual])
      ).rows
      assert.ok(manualRows.length > 0)
      assert.ok(
        manualRows.some(
          (row) => row.markup === null && row.purchase_price === null,
        ),
      )
    },
  )

  await check(
    'removing a perfume created by mistake also removes its purchase price',
    async () => {
      await saveProduct(
        product(disposable, { pricing: pricing(100, 'NIO', 50, 40, 30) }),
      )
      assert.ok(await pricingRow(disposable))
      const result = (
        await db.query('select public.remove_catalog_product($1,$2) as r', [
          disposable,
          await revision(disposable),
        ])
      ).rows[0].r
      assert.equal(result, 'deleted')
      assert.equal(await pricingRow(disposable), null)
      assert.equal(
        (
          await asOwner(
            'select count(*)::int as n from public.products where id=$1',
            [disposable],
          )
        )[0].n,
        0,
      )
    },
  )

  console.log(`${checks} pricing checks passed`)
} finally {
  await db.close()
}

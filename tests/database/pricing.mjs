// Precios calculados desde el costo promedio del inventario y un porcentaje de
// ganancia por perfume y por lista: el caso del Excel del cliente, pedidos,
// costo inicial, existencias en cero, monedas, cambio de tasa, entradas sin
// costo, facturas eliminadas, atomicidad, validaciones, permisos, historial y
// la migración desde el precio de compra. PostgreSQL local y desechable.
import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

const NEW_MIGRATION = '20260927120000_cost_based_pricing.sql'
const admin = '11111111-1111-4111-8111-111111111111'
const operator = '22222222-2222-4222-8222-222222222222'
const excel = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const pending = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const disposable = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const empty = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
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
async function stock(id) {
  return Object.fromEntries(
    (
      await asOwner(
        'select location,quantity from public.inventory_balances where product_id=$1',
        [id],
      )
    ).map((row) => [row.location, row.quantity]),
  )
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
const invoice = (items, changes = {}) => ({
  requestId: crypto.randomUUID(),
  kind: 'invoice',
  customerName: 'Cliente',
  tier: 'emprendedor',
  currency: 'NIO',
  location: 'store',
  paymentMethod: 'cash',
  notes: '',
  items,
  ...changes,
})
const movement = (productId, type, quantity, changes = {}) => ({
  requestId: crypto.randomUUID(),
  productId,
  location: 'store',
  type,
  quantity,
  note: 'Movimiento de prueba',
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

// --- La migración, sobre datos del modelo anterior -------------------------
try {
  await bootstrap(NEW_MIGRATION)
  await identity(admin)
  await setRate(36.6)
  for (const id of [excel, other, pending]) await saveProduct(product(id))
  // Modelo anterior: precio de compra a mano y porcentajes. `excel` además
  // tiene costo promedio contable; `pending` todavía no.
  await asOwner(
    `insert into public.product_pricing(product_id,purchase_price,purchase_currency,markup_emprendedor,markup_vip,markup_premium,updated_by)
     values($1,500,'NIO',20,15,null,$3),($2,20,'USD',25,null,null,$3)`,
    [excel, pending, admin],
  )
  await asOwner(
    "update public.product_prices set amount=case currency when 'NIO' then 600 else 16.39 end where product_id=$1 and tier_code='emprendedor'",
    [excel],
  )
  await asOwner(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,16.281061)',
    [excel],
  )
  const before = { excel: await prices(excel), pending: await prices(pending) }
  const beforeRevision = await revision(excel)
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub','',false)")
  await db.exec(await readFile(`supabase/migrations/${NEW_MIGRATION}`, 'utf8'))
  await identity(admin)

  await check(
    'the migration moves percentages with a known cost onto the average cost and leaves the rest untouched',
    async () => {
      assert.deepEqual(await prices(excel), {
        emprendedor: { NIO: 19.54, USD: 0.53 },
        vip: { NIO: 18.72, USD: 0.51 },
        premium: before.excel.premium,
      })
      // Sin costo promedio no se inventa nada: el precio publicado se queda.
      assert.deepEqual(await prices(pending), before.pending)
      assert.deepEqual(await prices(other), before.pending)
      // El precio de compra se conserva como dato histórico, sin borrarse.
      assert.equal(Number((await pricingRow(excel)).purchase_price), 500)
      assert.equal(Number((await pricingRow(pending)).purchase_price), 20)
      assert.equal(await revision(excel), beforeRevision + 1)
      const rows = await history(excel)
      const moved = rows.find((row) => row.tier === 'emprendedor')
      assert.equal(moved.automatic, true)
      assert.equal(moved.cause, 'migration')
      assert.equal(moved.actor, 'Sistema')
      assert.equal(Number(moved.before_nio), 600)
      assert.equal(Number(moved.after_nio), 19.54)
      assert.equal(Number(moved.average_cost), 16.281061)
      assert.equal(Number(moved.markup), 20)
      assert.equal(moved.purchase_price, null)
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
  for (const id of [excel, other, pending, empty])
    await saveProduct(product(id))
  await count(excel, 5, 8)
  await count(other, 2, 0)
  await count(pending, 3, 0)
  await count(empty, 0, 0)

  await check(
    'the average cost keeps six decimals and only the price is rounded, half up',
    async () => {
      const value = async (sql) =>
        Number((await asOwner(`select ${sql} as v`))[0].v)
      assert.equal(await value('private.markup_price(16.281061,25)'), 20.35)
      assert.equal(await value('private.markup_price(10.05,10)'), 11.06)
      assert.equal(await value('private.markup_price(33.33,12.5)'), 37.5)
      assert.equal(await value('private.markup_price(0.123456,1000)'), 1.36)
      assert.equal(await value('private.markup_price(18.004,12.5)'), 20.25)
    },
  )

  await check(
    'Formulas.xlsx: 13 units at 15.675 plus 20 at 16.675 average 16.281060… and sell at 20.35 with 25 %',
    async () => {
      await rpc('set_opening_cost', opening(excel, 15.675))
      assert.equal(await average(excel), 15.675)
      // Emprendedor 25 %, VIP 20 %, Premium a mano.
      await savePricing([
        {
          productId: excel,
          revision: await revision(excel),
          pricing: markups(25, 20, null),
        },
      ])
      assert.deepEqual(await prices(excel), {
        emprendedor: { NIO: 19.59, USD: 0.54 },
        vip: { NIO: 18.81, USD: 0.51 },
        premium: { USD: 32, NIO: 1171.2 },
      })
      const revisionBefore = await revision(excel)
      await rpc(
        'record_shipment',
        shipment([
          {
            productId: excel,
            location: 'warehouse',
            quantity: 20,
            unitPrice: 16.675,
          },
        ]),
      )
      assert.deepEqual(await stock(excel), { store: 5, warehouse: 28 })
      assert.equal(await average(excel), 16.281061)
      assert.deepEqual(await prices(excel), {
        emprendedor: { NIO: 20.35, USD: 0.56 },
        vip: { NIO: 19.54, USD: 0.53 },
        premium: { USD: 32, NIO: 1171.2 },
      })
      // El perfume cambió: quien lo tenga abierto debe volver a leerlo.
      assert.equal(await revision(excel), revisionBefore + 1)
      const latest = (await history(excel)).filter((row) => row.automatic)
      assert.deepEqual(
        latest
          .slice(0, 2)
          .map((row) => [
            row.tier,
            Number(row.after_nio),
            row.cause,
            row.cause_reference,
          ]),
        [
          ['emprendedor', 20.35, 'purchase', 'PED-100'],
          ['vip', 19.54, 'purchase', 'PED-100'],
        ],
      )
      assert.equal(Number(latest[0].average_cost), 16.281061)
      assert.equal(Number(latest[0].markup), 25)
      assert.equal(latest[0].actor, 'Dueña')
    },
  )

  await check(
    'each perfume and each of its lists keeps its own percentage',
    async () => {
      await rpc('set_opening_cost', opening(other, 100))
      await savePricing([
        {
          productId: other,
          revision: await revision(other),
          pricing: markups(10, 30, 50),
        },
      ])
      const excelBefore = await prices(excel)
      assert.deepEqual(
        [
          (await prices(other)).emprendedor.NIO,
          (await prices(other)).vip.NIO,
          (await prices(other)).premium.NIO,
        ],
        [110, 130, 150],
      )
      // Cambiar VIP no mueve Emprendedor ni Premium, ni al otro perfume.
      await savePricing([
        {
          productId: other,
          revision: await revision(other),
          pricing: markups(10, 35, 50),
        },
      ])
      const after = await prices(other)
      assert.deepEqual(
        [after.emprendedor.NIO, after.vip.NIO, after.premium.NIO],
        [110, 135, 150],
      )
      assert.deepEqual(await prices(excel), excelBefore)
      const row = await pricingRow(other)
      assert.deepEqual(
        [row.markup_emprendedor, row.markup_vip, row.markup_premium].map(
          Number,
        ),
        [10, 35, 50],
      )
      assert.equal(row.purchase_price, null)
    },
  )

  await check(
    'a purchase only updates the calculated lists of the perfume it brings',
    async () => {
      const before = { excel: await prices(excel), other: await prices(other) }
      await rpc(
        'record_shipment',
        shipment([
          { productId: other, location: 'store', quantity: 2, unitPrice: 130 },
        ]),
      )
      assert.equal(await average(other), 115)
      const after = await prices(other)
      assert.deepEqual(
        [after.emprendedor.NIO, after.vip.NIO, after.premium.NIO],
        [126.5, 155.25, 172.5],
      )
      assert.deepEqual(await prices(excel), before.excel)
    },
  )

  await check(
    'a USD purchase with its weight charge converts once and weights store and warehouse together',
    async () => {
      // 4 unidades a US$ 3 + US$ 2 de envío (0.50 por unidad) a 36.5:
      // costo puesto 3.5 × 36.5 = 127.75; con las 4 existentes a 115 → 121.375.
      await rpc(
        'record_shipment',
        shipment(
          [
            {
              productId: other,
              location: 'warehouse',
              quantity: 4,
              unitPrice: 3,
            },
          ],
          {
            currency: 'USD',
            exchangeRate: 36.5,
            shippingAmount: 2,
            reference: 'PED-USD',
          },
        ),
      )
      assert.equal(await average(other), 121.375)
      assert.equal((await prices(other)).emprendedor.NIO, 133.51)
      assert.equal((await prices(other)).emprendedor.USD, 3.65)
    },
  )

  await check(
    'selling every unit and receiving a new purchase starts the average again from its cost',
    async () => {
      await rpc('create_document', invoice([{ productId: other, quantity: 4 }]))
      await rpc(
        'create_document',
        invoice([{ productId: other, quantity: 4 }], { location: 'warehouse' }),
      )
      assert.deepEqual(await stock(other), { store: 0, warehouse: 0 })
      // Vender no mueve el promedio ni los precios.
      assert.equal(await average(other), 121.375)
      assert.equal((await prices(other)).emprendedor.NIO, 133.51)
      await rpc(
        'record_shipment',
        shipment([
          { productId: other, location: 'store', quantity: 1, unitPrice: 200 },
        ]),
      )
      assert.equal(await average(other), 200)
      assert.equal((await prices(other)).emprendedor.NIO, 220)
    },
  )

  await check(
    'the first purchase of a perfume with no stock sets its cost and its prices',
    async () => {
      await savePricing([
        {
          productId: empty,
          revision: await revision(empty),
          pricing: markups(40, null, null),
        },
      ])
      // Sin costo todavía: la lista queda pendiente y conserva su precio.
      assert.deepEqual((await prices(empty)).emprendedor, {
        USD: 35,
        NIO: 1281,
      })
      await rpc(
        'record_shipment',
        shipment(
          [{ productId: empty, location: 'store', quantity: 3, unitPrice: 50 }],
          { shippingAmount: 6 },
        ),
      )
      assert.equal(await average(empty), 52)
      assert.deepEqual((await prices(empty)).emprendedor, {
        NIO: 72.8,
        USD: 1.99,
      })
    },
  )

  await check(
    'percentages without a known cost stay pending: the published price is kept and never invented',
    async () => {
      await savePricing([
        {
          productId: pending,
          revision: await revision(pending),
          pricing: markups(20, 20, 20),
        },
      ])
      assert.deepEqual(await prices(pending), {
        emprendedor: { USD: 35, NIO: 1281 },
        vip: { USD: 34, NIO: 1244.4 },
        premium: { USD: 32, NIO: 1171.2 },
      })
      // El formulario del perfume sigue pidiendo el dólar de una lista pendiente.
      await assert.rejects(
        saveProduct(
          product(pending, {
            revision: await revision(pending),
            prices: { emprendedor: {}, vip: { USD: 34 }, premium: { USD: 32 } },
            pricing: markups(20, 20, 20),
          }),
        ),
        /no se calculan desde el costo promedio/,
      )
      // Un pedido se niega a promediar contra existencias sin costo y lo dice.
      await assert.rejects(
        rpc(
          'record_shipment',
          shipment([
            {
              productId: pending,
              location: 'store',
              quantity: 1,
              unitPrice: 50,
            },
          ]),
        ),
        /Carga primero el costo inicial[\s\S]*Precios → Costo de inventario/,
      )
      // Completado por el flujo autorizado, el precio sale del costo al instante.
      await rpc(
        'set_opening_cost',
        opening(pending, 1000, { currency: 'USD', exchangeRate: 0.05 }),
      )
      assert.equal(await average(pending), 50)
      assert.deepEqual((await prices(pending)).vip, { NIO: 60, USD: 1.64 })
      const automatic = (await history(pending)).find((row) => row.automatic)
      assert.equal(automatic.cause, 'opening_cost')
    },
  )

  await check(
    'a manual entry cannot dilute a known average; exits and count corrections leave cost and prices alone',
    async () => {
      const before = {
        average: await average(excel),
        prices: await prices(excel),
        stock: await stock(excel),
      }
      await assert.rejects(
        rpc('record_inventory_movement', movement(excel, 'ENTRY', 3)),
        /ya tiene costo promedio[\s\S]*Registrar compra/,
      )
      assert.deepEqual(await stock(excel), before.stock)
      await rpc('record_inventory_movement', movement(excel, 'EXIT', 1))
      await rpc('record_inventory_movement', movement(excel, 'DAMAGED', 1))
      await rpc(
        'record_inventory_movement',
        movement(excel, 'ADJUSTMENT', 6, { note: 'Recuento' }),
      )
      assert.equal(await average(excel), before.average)
      assert.deepEqual(await prices(excel), before.prices)
      // Ni siquiera el dueño de la base puede dejar en blanco un costo conocido.
      await assert.rejects(
        asOwner(
          'update public.product_costs set average_cost_nio=null where product_id=$1',
          [excel],
        ),
        /no se puede borrar/,
      )
      assert.equal(await average(excel), before.average)
    },
  )

  await check(
    'a new rate moves only the other currency: cost, percentage and córdoba price stay',
    async () => {
      const before = {
        excel: await prices(excel),
        average: await average(excel),
        row: await pricingRow(excel),
      }
      await setRate(37)
      const after = await prices(excel)
      assert.deepEqual(after.emprendedor, { NIO: 20.35, USD: 0.55 })
      assert.deepEqual(after.vip, { NIO: 19.54, USD: 0.53 })
      // La lista a mano conserva su dólar y mueve el córdoba.
      assert.deepEqual(after.premium, { USD: 32, NIO: 1184 })
      assert.equal(await average(excel), before.average)
      assert.deepEqual(await pricingRow(excel), before.row)
      assert.equal(before.excel.emprendedor.NIO, 20.35)
      await setRate(36.6)
    },
  )

  await check(
    'issued invoices keep their amounts; the new price applies to later ones',
    async () => {
      await count(excel, 10, 28)
      const first = await rpc(
        'create_document',
        invoice([{ productId: excel, quantity: 2 }]),
      )
      assert.equal(Number(first.total), 40.7)
      await rpc(
        'record_shipment',
        shipment([
          { productId: excel, location: 'store', quantity: 2, unitPrice: 100 },
        ]),
      )
      const later = await rpc(
        'create_document',
        invoice([{ productId: excel, quantity: 1 }]),
      )
      const unit = (await prices(excel)).emprendedor.NIO
      assert.ok(unit > 20.35)
      assert.equal(Number(later.items[0].unit_price), unit)
      const stored = await asOwner(
        'select total from public.documents where id=$1',
        [first.id],
      )
      assert.equal(Number(stored[0].total), 40.7)
    },
  )

  await check(
    'deleting an invoice re-averages with the whole stock and reprices in the same operation',
    async () => {
      await count(other, 3, 7)
      await asOwner('select 1') // la cuenta de arriba no toca el costo
      const avgBefore = await average(other)
      const doc = await rpc(
        'create_document',
        invoice([{ productId: other, quantity: 2 }]),
      )
      // El costo cambia después de la venta.
      await rpc(
        'record_shipment',
        shipment([
          { productId: other, location: 'store', quantity: 2, unitPrice: 260 },
        ]),
      )
      const avgMid = await average(other)
      assert.equal(avgMid, Number(((avgBefore * 8 + 260 * 2) / 10).toFixed(6)))
      await db.query('select public.delete_invoice($1,$2)', [
        doc.id,
        'Devolución',
      ])
      // 10 unidades (tienda y bodega) al promedio vigente + 2 al costo congelado.
      const expected = Number(((avgMid * 10 + avgBefore * 2) / 12).toFixed(6))
      assert.equal(await average(other), expected)
      const expectedPrice = Math.round(expected * 1.1 * 100 + 1e-9) / 100
      assert.equal((await prices(other)).emprendedor.NIO, expectedPrice)
      const automatic = (await history(other)).find((row) => row.automatic)
      assert.equal(automatic.cause, 'invoice_deleted')
      assert.equal(automatic.cause_reference, doc.number)
    },
  )

  await check(
    'a purchase that cannot price its perfume rolls back entirely',
    async () => {
      const before = {
        stock: await stock(other),
        average: await average(other),
        prices: await prices(other),
      }
      const shipments = (
        await asOwner(
          'select count(*)::int as n from public.purchase_shipments',
        )
      )[0].n
      await savePricing([
        {
          productId: other,
          revision: await revision(other),
          pricing: markups(1000, 35, 50),
        },
      ])
      const priced = await prices(other)
      await assert.rejects(
        rpc(
          'record_shipment',
          shipment([
            {
              productId: other,
              location: 'store',
              quantity: 1,
              unitPrice: 999999999,
            },
          ]),
        ),
        /demasiado alto/,
      )
      assert.deepEqual(await stock(other), before.stock)
      assert.equal(await average(other), before.average)
      assert.deepEqual(await prices(other), priced)
      assert.equal(
        (
          await asOwner(
            'select count(*)::int as n from public.purchase_shipments',
          )
        )[0].n,
        shipments,
      )
      // Sin tasa no hay dólar que calcular: tampoco se guarda nada.
      await asOwner('delete from public.exchange_rates')
      await assert.rejects(
        rpc(
          'record_shipment',
          shipment([
            { productId: other, location: 'store', quantity: 1, unitPrice: 10 },
          ]),
        ),
        /tipo de cambio/,
      )
      assert.deepEqual(await stock(other), before.stock)
      assert.equal(await average(other), before.average)
      await setRate(36.6)
      await savePricing([
        {
          productId: other,
          revision: await revision(other),
          pricing: markups(10, 35, 50),
        },
      ])
    },
  )

  await check(
    'an older screen that sends a purchase price is refused with a clear message',
    async () => {
      const before = {
        prices: await prices(excel),
        revision: await revision(excel),
        row: await pricingRow(excel),
      }
      const legacy = {
        purchasePrice: 500,
        purchaseCurrency: 'NIO',
        markups: { emprendedor: 20, vip: 15, premium: null },
      }
      await assert.rejects(
        savePricing([
          { productId: excel, revision: before.revision, pricing: legacy },
        ]),
        /precio de compra ya no se guarda/,
      )
      await assert.rejects(
        saveProduct(
          product(excel, { revision: before.revision, pricing: legacy }),
        ),
        /precio de compra ya no se guarda/,
      )
      // Un payload viejo con el precio de compra vacío sí se entiende.
      await savePricing([
        {
          productId: excel,
          revision: before.revision,
          pricing: {
            ...legacy,
            purchasePrice: null,
            markups: { emprendedor: 25, vip: 20, premium: null },
          },
        },
      ])
      assert.deepEqual(await prices(excel), before.prices)
    },
  )

  await check('invalid percentages roll back the whole save', async () => {
    const before = {
      prices: await prices(excel),
      revision: await revision(excel),
      row: await pricingRow(excel),
    }
    for (const value of [
      markups(1000.01, 20, null),
      markups(25, -1, null),
      markups(25, 20, 10.555),
      markups('25', 20, null),
      { markups: [] },
    ]) {
      await assert.rejects(
        savePricing([
          { productId: excel, revision: before.revision, pricing: value },
        ]),
        /porcentaje/,
      )
      await assert.rejects(
        saveProduct(
          product(excel, { revision: before.revision, pricing: value }),
        ),
        /porcentaje/,
      )
    }
    assert.deepEqual(await prices(excel), before.prices)
    assert.equal(await revision(excel), before.revision)
    assert.deepEqual(await pricingRow(excel), before.row)
  })

  await check(
    'several perfumes are saved together, all or nothing, and a stale revision saves nothing',
    async () => {
      const revisions = {
        excel: await revision(excel),
        other: await revision(other),
      }
      const before = { excel: await prices(excel), other: await prices(other) }
      await assert.rejects(
        savePricing([
          {
            productId: excel,
            revision: revisions.excel,
            pricing: markups(30, 20, null),
          },
          {
            productId: other,
            revision: revisions.other,
            pricing: markups(10, 2000, 50),
          },
        ]),
        /«Perfume bbbb»: Cada porcentaje/,
      )
      assert.deepEqual(await prices(excel), before.excel)
      await assert.rejects(
        savePricing([
          {
            productId: excel,
            revision: revisions.excel - 1,
            pricing: markups(30, 20, null),
          },
        ]),
        /Otro usuario cambió «Perfume aaaa»/,
      )
      assert.equal(
        await savePricing([
          {
            productId: excel,
            revision: revisions.excel,
            pricing: markups(30, 20, null),
          },
          {
            productId: other,
            revision: revisions.other,
            pricing: markups(12, 35, 50),
          },
        ]),
        2,
      )
      assert.equal(await revision(excel), revisions.excel + 1)
      assert.equal(await revision(other), revisions.other + 1)
      assert.notDeepEqual(await prices(excel), before.excel)
    },
  )

  await check(
    'the history tells manual saves from automatic ones, with percentage and cost base',
    async () => {
      const rows = await history(excel)
      const manual = rows.find(
        (row) => !row.automatic && row.tier === 'emprendedor',
      )
      assert.equal(manual.actor, 'Dueña')
      assert.equal(Number(manual.markup), 30)
      assert.ok(Number(manual.average_cost) > 16)
      assert.equal(manual.cause, null)
      const automatic = rows.filter((row) => row.automatic)
      assert.ok(automatic.length >= 2)
      assert.ok(
        automatic.every((row) =>
          ['purchase', 'opening_cost'].includes(row.cause),
        ),
      )
      // Una lista a mano no trae porcentaje ni costo.
      const premium = rows.filter((row) => row.tier === 'premium')
      assert.ok(
        premium.every(
          (row) => row.markup === null && row.average_cost === null,
        ),
      )
    },
  )

  await check(
    'only administration reads costs and percentages or saves them',
    async () => {
      await identity(operator)
      assert.equal(
        (await db.query('select * from public.product_pricing')).rows.length,
        0,
      )
      assert.equal(
        (await db.query('select * from public.product_costs')).rows.length,
        0,
      )
      await assert.rejects(
        savePricing([
          { productId: excel, revision: 1, pricing: markups(1, 1, 1) },
        ]),
        (error) => error.code === '42501',
      )
      await assert.rejects(
        db.query('select * from public.list_price_changes($1)', [excel]),
        (error) => error.code === '42501',
      )
      await assert.rejects(
        db.query('select * from private.markup_rules'),
        (error) => error.code === '42501',
      )
      await assert.rejects(
        rpc(
          'record_shipment',
          shipment([
            { productId: excel, location: 'store', quantity: 1, unitPrice: 1 },
          ]),
        ),
        /insufficient_privilege/,
      )
      // El precio de venta sigue a la vista, como siempre.
      assert.ok(
        (
          await db.query(
            "select amount from public.product_prices where product_id=$1 and tier_code='emprendedor' and currency='NIO'",
            [excel],
          )
        ).rows.length,
      )
      await identity(admin, 'anon')
      await assert.rejects(
        db.query('select * from public.product_pricing'),
        (error) => error.code === '42501',
      )
      await identity(admin)
    },
  )

  await check(
    'clearing every percentage keeps the last prices as manual ones',
    async () => {
      const before = await prices(other)
      await savePricing([
        {
          productId: other,
          revision: await revision(other),
          pricing: markups(null, null, null),
        },
      ])
      assert.equal(await pricingRow(other), null)
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(await prices(other)).map(([tier, value]) => [
            tier,
            value.USD,
          ]),
        ),
        Object.fromEntries(
          Object.entries(before).map(([tier, value]) => [tier, value.USD]),
        ),
      )
      // A partir de aquí un pedido cambia el costo, pero no el precio.
      const manualPrices = await prices(other)
      await rpc(
        'record_shipment',
        shipment([
          { productId: other, location: 'store', quantity: 1, unitPrice: 999 },
        ]),
      )
      assert.deepEqual(await prices(other), manualPrices)
    },
  )

  await check(
    'removing a perfume created by mistake also removes its percentages',
    async () => {
      await saveProduct(product(disposable, { pricing: markups(50, 40, 30) }))
      assert.ok(await pricingRow(disposable))
      const result = (
        await db.query('select public.remove_catalog_product($1,$2) as r', [
          disposable,
          await revision(disposable),
        ])
      ).rows[0].r
      assert.equal(result, 'deleted')
      assert.equal(await pricingRow(disposable), null)
    },
  )

  console.log(`${checks} pricing checks passed`)
} finally {
  await db.close()
}

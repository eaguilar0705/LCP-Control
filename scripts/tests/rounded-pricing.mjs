import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
} from './database-fixture.mjs'
const db = await database()
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  server: { middlewareMode: true, hmr: false, ws: false },
  ssr: { noExternal: ['@lcp/contracts'] },
})
const { roundedMarkupPrices, tierQuote } = await server.ssrLoadModule(
  '/src/lib/pricing.ts',
)
let checks = 0
const eq = (a, b, m) => {
  assert.deepEqual(a, b, m)
  checks++
}
const rejected = async (p, re) => {
  await assert.rejects(p, re)
  checks++
}
const one = async (s, args = []) => (await db.query(s, args)).rows[0]
const call = (name, input) =>
  rpc(db, name, { requestId: crypto.randomUUID(), ...input })
const id1 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  id2 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'
const price = async (id, tier) =>
  (
    await one(
      'select jsonb_object_agg(currency,amount) r from public.product_prices where product_id=$1 and tier_code=$2',
      [id, tier],
    )
  ).r
const snapshot = async (table) =>
  (
    await one(
      `select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text)::text,'')) h from ${table} x`,
    )
  ).h
const input = (id, cost, currency = 'NIO') => ({
  id,
  revision: 0,
  name: id === id1 ? 'Mandaryn Sky' : 'Club de Nuit Intense',
  brand: 'Armaf',
  category: 'arabian',
  gender: 'unisex',
  size: 3.4,
  unit: 'oz',
  manufacturerBarcode: '',
  minimumStock: 0,
  active: true,
  imagePath: null,
  prices: {
    emprendedor: { USD: 31, NIO: 1147 },
    vip: { USD: 29, NIO: 1073 },
    premium: { USD: 27, NIO: 999 },
    menudeo: { USD: 42, NIO: 1554 },
  },
  pricing: {
    purchasePrice: cost,
    purchaseCurrency: currency,
    markups: { emprendedor: 35, vip: 25, premium: 15 },
  },
})
try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select '2026-11-06T18:00:00Z'::timestamptz$$",
  )
  const cases = [
    [840, 'NIO', 35, 37],
    [940, 'NIO', 35, 37],
    [840, 'NIO', 25, 37],
    [840, 'NIO', 15, 37],
    [30, 'USD', 0, 37],
    [30.000001, 'USD', 0, 37],
    [1110, 'NIO', 0, 37],
    [1110.000001, 'NIO', 0, 37],
    [0.01, 'USD', 0, 37],
    [1000, 'NIO', 12.34, 36.6243],
    [24.01, 'USD', 45, 37],
    [1, 'USD', 0, 0.000001],
  ]
  for (let i = 1; i <= 88; i++)
    cases.push([
      Math.round((i * 13.77 + 0.01) * 1e6) / 1e6,
      i % 2 ? 'USD' : 'NIO',
      Math.round(((i * 7.13) % 200) * 100) / 100,
      Math.round((36 + (i % 7) * 0.17) * 1e6) / 1e6,
    ])
  for (const [cost, currency, percent, rate] of cases) {
    const r = await one(
      'select * from private.rounded_markup_prices($1,$2,$3,$4)',
      [cost, currency, percent, rate],
    )
    eq(
      roundedMarkupPrices(cost, currency, percent, rate),
      { USD: Number(r.usd), NIO: Number(r.nio) },
      'cliente y servidor coinciden sin redondeos intermedios',
    )
    eq(Number.isInteger(Number(r.usd)), true)
  }
  eq(
    roundedMarkupPrices(30, 'USD', 0, 37),
    { USD: 30, NIO: 1110 },
    'un entero no sube otro dólar',
  )
  eq(
    roundedMarkupPrices(30.000001, 'USD', 0, 37),
    { USD: 31, NIO: 1147 },
    'una fracción pequeña tampoco se pierde',
  )
  const quote = tierQuote(
    {
      purchasePrice: 840,
      purchaseCurrency: 'NIO',
      markups: { emprendedor: 35, vip: 25, premium: 15 },
    },
    'emprendedor',
    37,
  )
  eq([quote.price, quote.profit, quote.prices.USD], [1147, 307, 31])
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Admin','admin'),($2,'Caja','operator')",
    [admin, operator],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Tienda aislada');insert into public.price_tiers(code,name,sort_order)values('menudeo','Menudeo',4) on conflict(code)do nothing;insert into public.exchange_rates(id,usd_to_nio) values(true,37) on conflict(id)do update set usd_to_nio=37",
  )
  await identity(db, admin)
  await call('save_catalog_product', input(id1, 840))
  await call('save_catalog_product', input(id2, 940))
  eq(await price(id1, 'emprendedor'), { USD: 31, NIO: 1147 })
  eq(await price(id1, 'vip'), { USD: 29, NIO: 1073 })
  eq(await price(id1, 'premium'), { USD: 27, NIO: 999 })
  eq(await price(id2, 'emprendedor'), { USD: 35, NIO: 1295 })
  eq(
    await price(id2, 'menudeo'),
    { USD: 42, NIO: 1554 },
    'lista manual intacta',
  )
  await db.exec('reset role')
  await db.query(
    'update public.inventory_balances set quantity=10 where product_id in($1,$2)',
    [id1, id2],
  )
  await db.query(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,840),($2,940)',
    [id1, id2],
  )
  // Simular el estado real previo a publicar la corrección.
  await db.query(
    "update public.product_prices set amount=case tier_code when 'emprendedor' then case currency when 'USD' then 30.65 else 1134 end when 'vip' then case currency when 'USD' then 28.38 else 1050 end when 'premium' then case currency when 'USD' then 26.11 else 966 end else amount end where product_id=$1",
    [id1],
  )
  await db.query(
    "update public.product_prices set amount=case tier_code when 'emprendedor' then case currency when 'USD' then 34.30 else 1269 end when 'vip' then case currency when 'USD' then 31.76 else 1175 end when 'premium' then case currency when 'USD' then 29.22 else 1081 end else amount end where product_id=$1",
    [id2],
  )
  await identity(db, admin)
  await call('open_business_day', { openingNio: 1000, openingUsd: 0 })
  const document = {
    validUntil: '2026-11-13',
    customerName: 'Cliente aislado',
    tier: 'emprendedor',
    currency: 'NIO',
    location: 'store',
    paymentMethod: 'cash',
    notes: '',
    items: [
      { productId: id1, quantity: 1, expectedUnitPrice: 1134 },
      { productId: id2, quantity: 1, expectedUnitPrice: 1269 },
    ],
  }
  eq(
    (await call('create_document', { ...document, kind: 'invoice' })).total,
    2403,
  )
  eq(
    (await call('create_document', { ...document, kind: 'proforma' })).total,
    2403,
  )
  const tables = [
    'public.documents',
    'public.document_items',
    'public.inventory_balances',
    'public.product_costs',
    'public.product_pricing',
    'public.user_drafts',
  ]
  const before = await Promise.all(tables.map(snapshot))
  await db.exec('reset role')
  const sql = await readFile(
    'backend/supabase/migrations/20261106175818_redondear_precios_calculados_al_dolar_superior.sql',
    'utf8',
  )
  const normalize = sql.match(/do \$normalize\$[\s\S]*?end \$normalize\$;/)[0]
  await db.exec(normalize)
  eq(
    await Promise.all(tables.map(snapshot)),
    before,
    'no cambia documentos emitidos, existencias, costos, porcentajes ni borradores',
  )
  eq(await price(id1, 'emprendedor'), { USD: 31, NIO: 1147 })
  eq(await price(id2, 'emprendedor'), { USD: 35, NIO: 1295 })
  eq(
    (
      await one(
        "select count(*)::int n from private.catalog_changes where after_data->'cause'->>'kind'='rounding'",
      )
    ).n,
    2,
  )
  const count = await snapshot('private.catalog_changes')
  await db.exec(normalize)
  eq(
    await snapshot('private.catalog_changes'),
    count,
    'normalizar de nuevo no duplica cambios',
  )
  await identity(db, admin)
  const history = (
    await db.query('select * from public.list_price_changes($1)', [id1])
  ).rows
  eq(
    history.filter((h) => h.cause === 'rounding').length,
    3,
    'historial completo por lista',
  )
  eq(
    history
      .filter((h) => h.cause === 'rounding')
      .every((h) => h.automatic && Number(h.purchase_price) === 840),
    true,
  )
  await rejected(
    call('create_document', { ...document, kind: 'proforma' }),
    /precios cambiaron/,
  )
  for (const kind of ['invoice', 'proforma']) {
    const d = await call('create_document', {
      ...document,
      kind,
      expectedTotal: 2442,
      items: [
        { productId: id1, quantity: 1, expectedUnitPrice: 1147 },
        { productId: id2, quantity: 1, expectedUnitPrice: 1295 },
      ],
    })
    eq(d.total, 2442)
  }
  const usd = await call('create_document', {
    ...document,
    kind: 'proforma',
    currency: 'USD',
    expectedTotal: 66,
    items: [
      { productId: id1, quantity: 1, expectedUnitPrice: 31 },
      { productId: id2, quantity: 1, expectedUnitPrice: 35 },
    ],
  })
  eq(usd.total, 66)
  const discounted = await call('create_document', {
    ...document,
    kind: 'proforma',
    currency: 'USD',
    expectedTotal: 30.5,
    items: [
      {
        productId: id1,
        quantity: 1,
        expectedUnitPrice: 31,
        finalUnitPrice: 30.5,
      },
    ],
  })
  eq(discounted.total, 30.5, 'el descuento explícito conserva su importe')
  const frozen = await snapshot('public.documents')
  await db.query('select public.set_exchange_rate($1)', [38])
  eq(
    await price(id1, 'emprendedor'),
    { USD: 30, NIO: 1140 },
    'el cambio de tasa usa la misma regla al dólar entero',
  )
  eq(
    await snapshot('public.documents'),
    frozen,
    'cambiar tasa no recotiza documentos ya emitidos',
  )
  const pricesBeforeCost = await snapshot('public.product_prices')
  await db.exec('reset role')
  await db.query(
    'update public.product_costs set average_cost_nio=1000 where product_id=$1',
    [id1],
  )
  eq(
    await snapshot('public.product_prices'),
    pricesBeforeCost,
    'el costo promedio no cambia precios de venta',
  )
  await identity(db, operator)
  await rejected(
    call('save_catalog_product', input(crypto.randomUUID(), 10)),
    /permission|insufficient/i,
  )
  console.log(
    `PASS redondeo: ${checks} comprobaciones de precisión, listas, historial, precio unitario, totales, tasa, descuentos y documentos históricos.`,
  )
} finally {
  await db.close()
  await server.close()
}

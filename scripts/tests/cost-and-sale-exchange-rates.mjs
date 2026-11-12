import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
  warehouse,
  viewer,
} from './database-fixture.mjs'

const migration = '20261112010000_separar_tasa_de_costos_y_precios_de_venta.sql'
const db = await database({ beforeMigration: migration })
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  server: { middlewareMode: true, hmr: false, ws: false },
})
const { inventoryExchangeRate, accountingExchangeRate } =
  await server.ssrLoadModule('/src/lib/exchangeRates.ts')
const { landedUnitCost, roundedMarkupPrices } = await server.ssrLoadModule(
  '/src/lib/pricing.ts',
)
await server.close()
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000005201'
let checks = 0
const eq = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const call = (name, input) =>
  rpc(db, name, { requestId: crypto.randomUUID(), ...input })
const prices = async () =>
  (
    await one(
      "select jsonb_object_agg(tier_code||':'||currency,amount) r from public.product_prices where product_id=$1",
      [product],
    )
  ).r
const rates = async () => {
  const r = await one(
    'select usd_to_nio,inventory_usd_to_nio,accounting_usd_to_nio from public.exchange_rates',
  )
  return [
    Number(r.usd_to_nio),
    Number(r.inventory_usd_to_nio),
    Number(r.accounting_usd_to_nio),
  ]
}
const history = async () => {
  const result = {}
  for (const table of [
    'documents',
    'document_items',
    'document_item_costs',
    'purchase_shipments',
    'purchase_shipment_lines',
    'finance_entries',
    'journal_entries',
    'journal_lines',
    'product_costs',
    'inventory_balances',
  ]) {
    result[table] = (
      await one(
        `select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'')) h from public.${table} t`,
      )
    ).h
  }
  return result
}
try {
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Dueño','admin'),($2,'Caja','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer')",
    [admin, operator, warehouse, viewer],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Tasas corregidas QA'); update public.exchange_rates set usd_to_nio=36.6243,accounting_usd_to_nio=37",
  )
  await identity(db, admin)
  await call('save_catalog_product', {
    id: product,
    revision: 0,
    name: 'Perfume del audio',
    brand: 'Armaf',
    category: 'arabian',
    gender: 'unisex',
    size: 100,
    unit: 'ml',
    manufacturerBarcode: '',
    minimumStock: 0,
    active: true,
    imagePath: null,
    prices: {
      emprendedor: { USD: 24, NIO: 878.98 },
      vip: { USD: 22, NIO: 805.73 },
      premium: { USD: 30, NIO: 1098.73 },
    },
    pricing: {
      purchasePrice: 20,
      purchaseCurrency: 'USD',
      markups: { emprendedor: 20, vip: 10, premium: null },
    },
  })
  await db.exec('reset role')
  await db.query(
    "update public.inventory_balances set quantity=case when location='store' then 10 else 0 end where product_id=$1",
    [product],
  )
  await db.query(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,400)',
    [product],
  )
  await identity(db, admin)
  const today = (
    await one(
      "select (now() at time zone 'America/Managua')::date::text as day",
    )
  ).day
  await call('record_journal_entry', {
    kind: 'opening',
    occurredOn: today,
    description: 'Inventario inicial QA',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1130', debit: 4000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 4000 },
    ],
  })
  await call('open_business_day', {
    expectedDay: today,
    openingNio: 0,
    openingUsd: 0,
  })
  const purchase = (rate) => ({
    incurredOn: today,
    supplier: 'Proveedor QA',
    currency: 'USD',
    exchangeRate: rate,
    shippingAmount: 0,
    account: 'pending',
    lines: [
      { productId: product, location: 'store', quantity: 1, unitPrice: 10 },
    ],
  })
  await call('record_shipment', purchase(37))
  const sale = () =>
    call('create_document', {
      kind: 'invoice',
      customerName: 'Cliente QA',
      tier: 'emprendedor',
      currency: 'USD',
      exchangeRate: 37,
      location: 'store',
      paymentMethod: 'cash',
      notes: '',
      items: [{ productId: product, quantity: 1, expectedUnitPrice: 24 }],
    })
  const historicalInvoice = await sale()
  const before = await history()
  await db.exec('reset role')
  await db.exec(
    await readFile(`backend/supabase/migrations/${migration}`, 'utf8'),
  )
  await identity(db, admin)
  eq(await rates(), [37, 36.6243, 37])
  eq(
    await history(),
    before,
    'La migración conserva costos, compras y facturas emitidas',
  )
  const published = await prices()
  eq(published['emprendedor:USD'], 24)
  eq(published['emprendedor:NIO'], 888, 'Venta USD24 × 37')
  eq(published['premium:USD'], 30)
  eq(
    published['premium:NIO'],
    1110,
    'También convierte las listas manuales a 37',
  )
  eq(
    Number(
      (
        await one('select catalog_rate from public.documents where id=$1', [
          historicalInvoice.id,
        ])
      ).catalog_rate,
    ),
    36.6243,
  )
  const configured = {
    usdToNio: 37,
    inventoryUsdToNio: 36.6243,
    accountingUsdToNio: 37,
    updatedAt: null,
  }
  eq(inventoryExchangeRate(configured), 36.6243)
  eq(accountingExchangeRate(configured), 37)
  eq(landedUnitCost(10, 0, inventoryExchangeRate(configured)), 366.243)
  eq(roundedMarkupPrices(20, 'USD', 20, configured.usdToNio), {
    USD: 24,
    NIO: 888,
  })
  eq(
    inventoryExchangeRate({ usdToNio: 36.6 }),
    36.6,
    'Compatibilidad con la configuración anterior',
  )
  for (const value of [null, 0, -1, NaN, Infinity])
    eq(inventoryExchangeRate({ ...configured, inventoryUsdToNio: value }), null)
  const receipt = await call(
    'record_shipment',
    purchase(inventoryExchangeRate(configured)),
  )
  eq(
    Number(
      (
        await one(
          'select landed_unit_cost_nio from public.purchase_shipment_lines where shipment_id=$1',
          [receipt],
        )
      ).landed_unit_cost_nio,
    ),
    366.243,
  )
  const invoice = await sale()
  eq(
    Number(
      (
        await one(
          'select net_revenue_nio from public.document_item_costs where document_id=$1',
          [invoice.id],
        )
      ).net_revenue_nio,
    ),
    888,
  )
  const saved = await history()
  await db.query('select public.set_inventory_exchange_rate(36.5)')
  eq(await rates(), [37, 36.5, 37])
  eq(
    await prices(),
    published,
    'Cambiar costos no modifica los precios de venta',
  )
  await db.query('select public.set_accounting_exchange_rate(38.5)')
  eq(await rates(), [37, 36.5, 38.5])
  eq(await prices(), published)
  await db.query('select public.set_exchange_rate(38)')
  eq(await rates(), [38, 36.5, 38.5])
  eq((await prices())['emprendedor:NIO'], 912)
  eq(
    await history(),
    saved,
    'Las tres configuraciones conservan las operaciones históricas',
  )
  for (const value of [null, 0, -1, 1000001, 36.1234567]) {
    await assert.rejects(
      db.query('select public.set_inventory_exchange_rate($1)', [value]),
      /tipo de cambio/i,
    )
    checks++
  }
  for (const user of [operator, warehouse, viewer, null]) {
    await identity(db, user)
    await assert.rejects(
      db.query('select public.set_inventory_exchange_rate(39)'),
      /permission|privilege/i,
    )
    checks++
  }
  await identity(db, admin)
  eq(await rates(), [38, 36.5, 38.5])
  console.log(`PASS costos y precios de venta: ${checks} comprobaciones`)
} finally {
  await db.close()
}

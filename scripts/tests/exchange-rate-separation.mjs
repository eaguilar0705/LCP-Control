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

const migration = '20261111210000_tasas_de_inventario_y_contabilidad.sql'
const db = await database({ beforeMigration: migration })
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  server: { middlewareMode: true, hmr: false, ws: false },
})
const { roundedMarkupPrices } = await server.ssrLoadModule(
  '/src/lib/pricing.ts',
)
const { accountingExchangeRate } = await server.ssrLoadModule(
  '/src/lib/exchangeRates.ts',
)
const { statementCurrency } = await server.ssrLoadModule(
  '/src/features/accounting/statementCurrency.ts',
)
await server.close()
let checks = 0
const eq = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
}
const one = async (sql, values = []) => (await db.query(sql, values)).rows[0]
const call = (name, input) =>
  rpc(db, name, { requestId: crypto.randomUUID(), ...input })
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
const prices = async () =>
  (
    await one(
      "select jsonb_object_agg(currency,amount) p from public.product_prices where product_id=$1 and tier_code='emprendedor'",
      [id],
    )
  ).p
const rates = async () => {
  const r = await one(
    'select usd_to_nio,accounting_usd_to_nio from public.exchange_rates where id',
  )
  return [Number(r.usd_to_nio), Number(r.accounting_usd_to_nio)]
}
const historical = async () => {
  const result = {}
  for (const table of [
    'documents',
    'document_items',
    'document_item_costs',
    'purchase_shipments',
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
    "insert into public.business_settings(name) values('Prueba de tasas');update public.exchange_rates set usd_to_nio=37",
  )
  await identity(db, admin)
  await call('save_catalog_product', {
    id,
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
      emprendedor: { USD: 23, NIO: 851 },
      vip: { USD: 23, NIO: 851 },
      premium: { USD: 23, NIO: 851 },
    },
    pricing: {
      purchasePrice: 705,
      purchaseCurrency: 'NIO',
      markups: { emprendedor: 20, vip: 20, premium: 20 },
    },
  })
  eq(await prices(), { USD: 23, NIO: 851 })
  await db.exec('reset role')
  await db.query(
    'update public.inventory_balances set quantity=10 where product_id=$1',
    [id],
  )
  await db.query(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,705)',
    [id],
  )
  await identity(db, admin)
  await call('open_business_day', { openingNio: 1000, openingUsd: 0 })
  const invoice = await call('create_document', {
    kind: 'invoice',
    customerName: 'Cliente histórico',
    tier: 'emprendedor',
    currency: 'USD',
    exchangeRate: 37,
    location: 'store',
    paymentMethod: 'cash',
    notes: '',
    items: [{ productId: id, quantity: 1, expectedUnitPrice: 23 }],
  })
  eq(invoice.total, 23)
  const before = await historical()
  await db.exec('reset role')
  await db.exec(
    await readFile(`backend/supabase/migrations/${migration}`, 'utf8'),
  )
  await identity(db, admin)
  eq(await rates(), [36.6243, 37])
  eq(
    await prices(),
    { USD: 24, NIO: 878.98 },
    'el ejemplo pasa de 23 a 24 dólares con redondeo superior',
  )
  eq(
    await historical(),
    before,
    'la migración conserva costos, existencias y todos los datos históricos',
  )
  eq(
    Number(
      (
        await one('select catalog_rate from public.documents where id=$1', [
          invoice.id,
        ])
      ).catalog_rate,
    ),
    37,
  )
  const configured = {
    usdToNio: 36.6243,
    accountingUsdToNio: 37,
    updatedAt: null,
  }
  eq(roundedMarkupPrices(705, 'NIO', 20, configured.usdToNio), {
    USD: 24,
    NIO: 878.98,
  })
  eq(accountingExchangeRate(configured), 37)
  eq(
    statementCurrency({
      currency: 'USD',
      exchangeRate: accountingExchangeRate(configured),
    }).convert(3700),
    100,
  )
  for (const rate of [38.5, 36.62, 37]) {
    await db.query('select public.set_accounting_exchange_rate($1)', [rate])
    eq(await rates(), [36.6243, rate])
    eq(
      await prices(),
      { USD: 24, NIO: 878.98 },
      'la tasa contable no cambia precios',
    )
    eq(await historical(), before)
  }
  await db.query('select public.set_exchange_rate($1)', [37])
  eq(await rates(), [37, 37])
  eq(await prices(), { USD: 23, NIO: 851 })
  await db.query('select public.set_exchange_rate($1)', [36.6243])
  eq(await rates(), [36.6243, 37])
  eq(await prices(), { USD: 24, NIO: 878.98 })
  eq(await historical(), before)
  for (const rate of [null, 0, -1, 1000001, 36.1234567]) {
    await assert.rejects(
      db.query('select public.set_accounting_exchange_rate($1)', [rate]),
      /tipo de cambio/,
    )
    checks++
    eq(await rates(), [36.6243, 37])
  }
  for (const user of [operator, warehouse, viewer, null]) {
    await identity(db, user)
    await assert.rejects(
      db.query('select public.set_accounting_exchange_rate(39)'),
      /privilege|permission/i,
    )
    checks++
  }
  await identity(db, admin)
  eq(await rates(), [36.6243, 37])
  eq(await historical(), before)
  const currentInvoice = await call('create_document', {
    kind: 'invoice',
    customerName: 'Cliente con tasas separadas',
    tier: 'emprendedor',
    currency: 'USD',
    exchangeRate: 37,
    location: 'store',
    paymentMethod: 'cash',
    notes: '',
    items: [{ productId: id, quantity: 1, expectedUnitPrice: 24 }],
  })
  eq(currentInvoice.total, 24)
  const stored = await one(
    'select catalog_rate,request_payload from public.documents where id=$1',
    [currentInvoice.id],
  )
  eq(
    Number(stored.catalog_rate),
    36.6243,
    'la factura conserva la tasa comercial con que se cotizó',
  )
  eq(
    stored.request_payload.exchangeRate,
    37,
    'la contabilización conserva su tasa independiente',
  )
  eq(
    Number(
      (
        await one(
          'select net_revenue_nio from public.document_item_costs where document_id=$1',
          [currentInvoice.id],
        )
      ).net_revenue_nio,
    ),
    888,
    'la venta de USD24 se contabiliza a 37',
  )
  console.log(`Tasas independientes: ${checks} comprobaciones correctas.`)
} finally {
  await db.close()
}

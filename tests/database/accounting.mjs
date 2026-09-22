// Runs the actual migrations in disposable PostgreSQL, never a deployed service.
import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

const db = new PGlite()
const admin = '11111111-1111-4111-8111-111111111111'
const operator = '22222222-2222-4222-8222-222222222222'
const warehouse = '33333333-3333-4333-8333-333333333333'
const viewer = '44444444-4444-4444-8444-444444444444'
const outsider = '55555555-5555-4555-8555-555555555555'
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const legacy = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const empty = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const unknown = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
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
async function rpc(name, input) {
  return (await db.query(`select public.${name}($1::jsonb) as result`, [JSON.stringify(input)])).rows[0].result
}
async function rows(table) {
  return (await db.query(`select * from public.${table}`)).rows
}
async function average(id = product) {
  const result = (await db.query('select average_cost_nio from public.product_costs where product_id=$1', [id])).rows[0]
  return result?.average_cost_nio == null ? null : Number(result.average_cost_nio)
}
async function quantity(id = product, location = 'store') {
  return (await db.query('select quantity from public.inventory_balances where product_id=$1 and location=$2', [id, location])).rows[0].quantity
}
// Un pedido: una caja con perfumes y un solo cobro de la agencia por el peso.
const shipment = (changes = {}, lines) => ({
  requestId: crypto.randomUUID(), incurredOn: '2026-01-01', supplier: 'Proveedor',
  agency: 'Agencia de envíos', reference: 'PED-001', note: 'Factura del proveedor',
  currency: 'NIO', exchangeRate: 1, shippingAmount: 100,
  lines: lines ?? [{ productId: product, location: 'store', quantity: 10, unitPrice: 105 }],
  ...changes,
})
const opening = (changes = {}) => ({
  requestId: crypto.randomUUID(), productId: product, unitCost: 50, currency: 'NIO',
  exchangeRate: 1, note: 'Costo respaldado por factura original', ...changes,
})
const invoice = (changes = {}) => ({
  requestId: crypto.randomUUID(), kind: 'invoice', customerName: 'Cliente contabilidad',
  tier: 'emprendedor', currency: 'NIO', location: 'store', paymentMethod: 'cash', notes: '',
  taxRate: 15, items: [{ productId: product, quantity: 2 }], ...changes,
})
const movement = (changes = {}) => ({
  requestId: crypto.randomUUID(), productId: product, location: 'store', type: 'DAMAGED',
  quantity: 1, note: 'Frasco roto', ...changes,
})
const expense = (changes = {}) => ({
  requestId: crypto.randomUUID(), incurredOn: '2026-01-01', category: 'agua_luz',
  description: 'Servicio eléctrico', amount: 100,
  currency: 'NIO', exchangeRate: 1, reference: 'REC-001', ...changes,
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
  `)
  await db.query('insert into auth.users(id) values($1),($2),($3),($4),($5)', [admin, operator, warehouse, viewer, outsider])
  for (const file of (await readdir('supabase/migrations')).sort()) {
    if (file.endsWith('.sql') && !file.includes('harden_platform_function_grants')) {
      await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'))
    }
  }
  await db.query("insert into public.staff_members(user_id,display_name,role) values($1,'Admin','admin'),($2,'Operator','operator'),($3,'Warehouse','warehouse'),($4,'Viewer','viewer')", [admin, operator, warehouse, viewer])
  await db.exec("insert into public.business_settings(name) values('Pruebas contables'); insert into public.brands(name) values('Marca');")
  for (const id of [product, legacy, empty, unknown]) {
    await db.query("insert into public.products(id,sku,name,brand_id) values($1::uuid,$1::text,'Perfume',(select id from public.brands limit 1))", [id])
    await db.query("insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',115),($1,'emprendedor','USD',10)", [id])
    await db.query("insert into public.inventory_balances(product_id,location,quantity) values($1,'store',$2),($1,'warehouse',$3)", [id, id === empty ? 0 : 10, id === unknown ? null : 0])
  }
  await identity(admin)

  await check('existing selling prices never become costs and unknown counts block opening/purchases', async () => {
    assert.equal(await average(), null)
    await assert.rejects(rpc('set_opening_cost', opening({ productId: unknown })), /conteo/)
    await assert.rejects(rpc('record_shipment', shipment({}, [{ productId: unknown, location: 'store', quantity: 1, unitPrice: 10 }])), /conteo/)
    assert.equal((await rows('purchase_shipments')).length, 0)
  })
  await check('legacy sales freeze unknown cost without deriving it from sale prices', async () => {
    const doc = await rpc('create_document', invoice({ items: [{ productId: legacy, quantity: 1 }] }))
    const snapshot = (await rows('document_item_costs')).find((r) => r.document_id === doc.id)
    assert.equal(snapshot.unit_cost_nio, null)
    assert.equal(Number(snapshot.net_revenue_nio), 100)
    assert.equal(Number(snapshot.tax_nio), 15)
  })
  await check('explicit opening basis is idempotent, audited and cannot silently overwrite known cost', async () => {
    const input = opening()
    const id = await rpc('set_opening_cost', input)
    assert.equal(await rpc('set_opening_cost', input), id)
    assert.equal(await average(), 50)
    assert.equal((await rows('opening_cost_records'))[0].quantity, 10)
    await assert.rejects(rpc('set_opening_cost', { ...input, unitCost: 51 }), /otros datos/)
    await assert.rejects(rpc('set_opening_cost', opening()), /ya tiene costo/)
    assert.equal((await rows('opening_cost_records')).length, 1)
  })
  await check('the agency weight is split evenly per unit and the shipment receives stock exactly once', async () => {
    const input = shipment()
    const id = await rpc('record_shipment', input)
    assert.equal(await rpc('record_shipment', input), id)
    assert.equal(await quantity(), 20)
    // 105 del proveedor + 10 de peso por unidad, ponderado contra las 10 existentes a 50.
    assert.equal(await average(), 82.5)
    const header = (await rows('purchase_shipments'))[0]
    assert.equal(Number(header.shipping_per_unit), 10)
    assert.equal(Number(header.goods_amount), 1050)
    assert.equal(header.units, 10)
    assert.equal(Number((await rows('purchase_shipment_lines'))[0].landed_unit_cost_nio), 115)
    await assert.rejects(rpc('record_shipment', { ...input, shippingAmount: 101 }), /otros datos/)
    assert.equal((await rows('purchase_shipments')).length, 1)
  })
  await check('sales freeze average and included taxes before stock deduction', async () => {
    const input = invoice()
    const doc = await rpc('create_document', input)
    assert.equal((await rpc('create_document', input)).id, doc.id)
    const snapshot = (await rows('document_item_costs')).find((r) => r.document_id === doc.id)
    assert.equal(Number(snapshot.unit_cost_nio), 82.5)
    assert.equal(Number(snapshot.net_revenue_nio), 200)
    assert.equal(Number(snapshot.tax_nio), 30)
    assert.equal(await quantity(), 18)
    assert.equal((await rows('inventory_movement_costs')).length, 0)
  })
  await check('USD shipment converts once and weights the remaining stock', async () => {
    await rpc('record_shipment', shipment({ currency: 'USD', exchangeRate: 36.5, shippingAmount: 0 },
      [{ productId: product, location: 'store', quantity: 2, unitPrice: 3 }]))
    assert.equal(await quantity(), 20)
    assert.equal(await average(), 85.2)
    assert.equal(Number((await rows('document_item_costs')).find((r) => Number(r.unit_cost_nio) === 82.5).unit_cost_nio), 82.5)
  })
  await check('USD invoices require explicit FX; failed invoice rolls back number, stock and snapshots', async () => {
    const before = (await rows('documents')).length
    const snapshots = (await rows('document_item_costs')).length
    await assert.rejects(rpc('create_document', invoice({ currency: 'USD' })), /exchangeRate/)
    assert.equal((await rows('documents')).length, before)
    assert.equal((await rows('document_item_costs')).length, snapshots)
    assert.equal(await quantity(), 20)
    const doc = await rpc('create_document', invoice({ currency: 'USD', exchangeRate: 36.5, taxRate: 0, items: [{ productId: product, quantity: 1 }] }))
    const row = (await rows('document_item_costs')).find((r) => r.document_id === doc.id)
    assert.equal(Number(row.net_revenue_nio), 365)
    assert.equal(Number(row.tax_nio), 0)
  })
  await check('invalid invoice quantities and missing stock cannot partially deduct products', async () => {
    const before = await quantity()
    await assert.rejects(rpc('create_document', invoice({ items: [{ productId: product, quantity: 1 }, { productId: empty, quantity: 1 }] })), /insuficientes/)
    assert.equal(await quantity(), before)
    await assert.rejects(rpc('create_document', invoice({ taxRate: -15 })), /inválido/)
    assert.equal(await quantity(), before)
  })
  await check('loss snapshots cover damage, exits and negative adjustments without changing average', async () => {
    await rpc('record_inventory_movement', movement())
    await rpc('record_inventory_movement', movement({ type: 'EXIT', quantity: 2 }))
    await rpc('record_inventory_movement', movement({ type: 'ADJUSTMENT', quantity: 14 }))
    const losses = await rows('inventory_movement_costs')
    assert.deepEqual(losses.map((r) => r.quantity), [1, 2, 2])
    assert.ok(losses.every((r) => Number(r.unit_cost_nio) === 85.2))
    assert.equal(await average(), 85.2)
  })
  await check('uncosted incoming stock invalidates average and future sales preserve missing basis', async () => {
    await rpc('record_inventory_movement', movement({ type: 'ENTRY', quantity: 1 }))
    assert.equal(await average(), null)
    const doc = await rpc('create_document', invoice({ items: [{ productId: product, quantity: 1 }] }))
    assert.equal((await rows('document_item_costs')).find((r) => r.document_id === doc.id).unit_cost_nio, null)
    await rpc('record_inventory_movement', movement())
    assert.equal((await rows('inventory_movement_costs')).at(-1).unit_cost_nio, null)
    await rpc('set_opening_cost', opening({ unitCost: 90 }))
    assert.equal(await average(), 90)
    assert.equal((await rows('document_item_costs')).find((r) => r.document_id === doc.id).unit_cost_nio, null)
  })
  await check('a shipment refuses to enter a cost gap and names the perfume; empty stock establishes cost', async () => {
    // Existencias contadas y ningún costo: no hay base contra la cual promediar,
    // así que el pedido se detiene entero en lugar de tirar el costo que sí trae.
    const stock = await quantity(legacy)
    await assert.rejects(
      rpc('record_shipment', shipment({}, [{ productId: legacy, location: 'store', quantity: 10, unitPrice: 105 }])),
      /Carga primero el costo inicial/,
    )
    assert.equal(await average(legacy), null)
    assert.equal(await quantity(legacy), stock)
    assert.equal((await rows('purchase_shipment_lines')).filter((r) => r.product_id === legacy).length, 0)
    // Declarado el costo inicial, el mismo pedido entra y pondera.
    await rpc('set_opening_cost', opening({ productId: legacy, unitCost: 100 }))
    await rpc('record_shipment', shipment({}, [{ productId: legacy, location: 'store', quantity: 10, unitPrice: 105 }]))
    assert.equal(await average(legacy), Number(((100 * stock + 115 * 10) / (stock + 10)).toFixed(6)))
    // Sin existencias previas no hay nada que promediar: el pedido establece el costo.
    await rpc('record_shipment', shipment({}, [{ productId: empty, location: 'store', quantity: 10, unitPrice: 105 }]))
    assert.equal(await average(empty), 115)
  })
  await check('one box with two perfumes shares the same weight charge and refuses a repeated product', async () => {
    const before = await quantity(empty)
    // 30 unidades y 300 de envío: diez córdobas de peso para cada perfume.
    await rpc('record_shipment', shipment({ shippingAmount: 300 }, [
      { productId: empty, location: 'store', quantity: 10, unitPrice: 105 },
      { productId: legacy, location: 'warehouse', quantity: 20, unitPrice: 40 },
    ]))
    const header = (await rows('purchase_shipments')).at(-1)
    assert.equal(Number(header.shipping_per_unit), 10)
    assert.equal(header.units, 30)
    assert.equal(await quantity(empty), before + 10)
    assert.equal(await quantity(legacy, 'warehouse'), 20)
    // El empty ya valía 115 con 10 unidades; entran otras 10 al mismo costo.
    assert.equal(await average(empty), 115)
    await assert.rejects(rpc('record_shipment', shipment({}, [
      { productId: empty, location: 'store', quantity: 1, unitPrice: 10 },
      { productId: empty, location: 'warehouse', quantity: 1, unitPrice: 10 },
    ])), /repetirse/)
  })
  await check('invalid currency, money, lines and dates roll back all shipment effects', async () => {
    const before = await quantity()
    const count = (await rows('purchase_shipments')).length
    const lines = (changes) => [{ productId: product, location: 'store', quantity: 10, unitPrice: 105, ...changes }]
    for (const [patch, replacement] of [
      [{ exchangeRate: 2 }], [{ exchangeRate: 0, currency: 'USD' }], [{ exchangeRate: 'NaN', currency: 'USD' }],
      [{ currency: 'EUR' }], [{ shippingAmount: 0.001 }], [{ shippingAmount: -1 }],
      [{ incurredOn: '2026-02-30' }], [{ incurredOn: '2099-01-01' }], [{ supplier: 'X'.repeat(161) }],
      [{}, []], [{}, lines({ quantity: 1.5 })], [{}, lines({ unitPrice: -1 })], [{}, lines({ unitPrice: '100' })],
      [{}, lines({ location: 'bodega' })], [{}, lines({ productId: null })],
    ]) await assert.rejects(rpc('record_shipment', shipment(patch, replacement)))
    assert.equal(await quantity(), before)
    assert.equal((await rows('purchase_shipments')).length, count)
    assert.equal((await rows('inventory_movements')).filter((r) => r.note === 'Pedido de importación recibido').length,
      (await rows('purchase_shipment_lines')).length)
  })
  let expenseId
  await check('expenses keep their own rate, are idempotent and prohibit merchandise category', async () => {
    const input = expense()
    expenseId = await rpc('record_expense', input)
    assert.equal(await rpc('record_expense', input), expenseId)
    const row = (await rows('expense_records')).find((r) => r.id === expenseId)
    assert.equal(Number(row.amount) * Number(row.exchange_rate), 100)
    await assert.rejects(rpc('record_expense', { ...input, amount: 101 }), /otros datos/)
    await assert.rejects(rpc('record_expense', expense({ category: 'mercaderia' })))
    // Las dos categorías de gastos operativos salen de los pedidos: no se teclean.
    await assert.rejects(rpc('record_expense', expense({ category: 'compra_mercaderia' })))
    await assert.rejects(rpc('record_expense', expense({ category: 'flete_importacion' })))
    await assert.rejects(rpc('record_expense', expense({ category: 'servicios' })))
    await assert.rejects(rpc('record_expense', expense({ amount: 0 })), /monto/)
    for (const category of ['impuestos_dgi', 'prestamo_bancario', 'interes_acreedor', 'marketing'])
      assert.ok(await rpc('record_expense', expense({ category })))
    assert.equal((await rows('expense_records')).length, 5)
  })
  await check('void expense preserves audit, permits retry and rejects a different reason', async () => {
    const voidExpense = (reason) => db.query('select public.void_expense($1,$2) as id', [expenseId, reason])
    await assert.rejects(voidExpense(''), /motivo/)
    assert.equal((await voidExpense('Duplicado')).rows[0].id, expenseId)
    assert.equal((await voidExpense('Duplicado')).rows[0].id, expenseId)
    await assert.rejects(voidExpense('Otro'), /otro motivo/)
    const row = (await rows('expense_records')).find((r) => r.id === expenseId)
    assert.ok(row.voided_at)
    assert.equal(row.voided_by, admin)
    assert.equal(row.void_reason, 'Duplicado')
    assert.equal(Number(row.amount), 100)
  })
  await check('all cost tables and RPCs enforce roles independently of the UI', async () => {
    const tables = ['product_costs', 'purchase_shipments', 'purchase_shipment_lines', 'opening_cost_records', 'expense_records', 'document_item_costs', 'inventory_movement_costs']
    for (const uid of [operator, warehouse, viewer, outsider]) {
      await identity(uid)
      for (const table of tables) assert.equal((await rows(table)).length, 0, `${uid} must not see ${table}`)
      for (const name of ['record_shipment', 'set_opening_cost', 'record_expense']) await assert.rejects(rpc(name, {}), /insufficient_privilege/)
      await assert.rejects(db.query('select public.void_expense($1,$2)', [expenseId, 'Motivo']), /insufficient_privilege/)
    }
    await identity('', 'anon')
    for (const table of tables) await assert.rejects(rows(table), /permission denied/)
    for (const name of ['record_shipment', 'set_opening_cost', 'record_expense']) await assert.rejects(rpc(name, {}), /permission denied/)
    await identity(admin)
    for (const table of tables) {
      await assert.rejects(db.query(`delete from public.${table}`), /permission denied/)
    }
    await assert.rejects(db.query('update public.product_costs set average_cost_nio=1'), /permission denied/)
    await assert.rejects(db.query('insert into public.product_costs(product_id) values($1)', [unknown]), /permission denied/)
  })
  await check('operator can invoice while the confidential cost snapshot stays owner-only', async () => {
    await identity(operator)
    const doc = await rpc('create_document', invoice({ items: [{ productId: product, quantity: 1 }] }))
    assert.equal((await rows('document_item_costs')).length, 0)
    assert.ok((await rows('documents')).some((r) => r.id === doc.id))
    await identity(admin)
    assert.equal(Number((await rows('document_item_costs')).find((r) => r.document_id === doc.id).unit_cost_nio), 90)
  })
  await check('proformas do not snapshot cost or require an accounting exchange rate', async () => {
    const before = (await rows('document_item_costs')).length
    await rpc('create_document', { ...invoice({ kind: 'proforma', currency: 'USD', validUntil: '2099-01-01' }), location: undefined, paymentMethod: undefined })
    assert.equal((await rows('document_item_costs')).length, before)
  })
  await check('the exchange rate is readable by any staff account and writable only by an owner', async () => {
    await identity(admin)
    await db.query('select public.set_exchange_rate($1::numeric)', [36.75])
    assert.equal(Number((await rows('exchange_rates'))[0].usd_to_nio), 36.75)
    await db.query('select public.set_exchange_rate($1::numeric)', [37.1])
    assert.equal((await rows('exchange_rates')).length, 1)
    assert.equal(Number((await rows('exchange_rates'))[0].usd_to_nio), 37.1)
    for (const uid of [operator, warehouse, viewer]) {
      await identity(uid)
      assert.equal(Number((await rows('exchange_rates'))[0].usd_to_nio), 37.1)
      await assert.rejects(db.query('select public.set_exchange_rate($1::numeric)', [1]), /insufficient|denied/i)
    }
    await identity(outsider)
    assert.equal((await rows('exchange_rates')).length, 0)
    await identity(admin)
    await assert.rejects(db.query('select public.set_exchange_rate($1::numeric)', [0]), /tipo de cambio/)
    await assert.rejects(db.query('select public.set_exchange_rate(null::numeric)'), /tipo de cambio/)
    await assert.rejects(db.query('update public.exchange_rates set usd_to_nio=1'), /permission denied/)
  })
  await check('current catalogue saves derive all NIO prices from USD and enforce revisions', async () => {
    const input = {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', revision: 0,
      name: 'Perfume con precio en dólares', brand: 'Marca', size: 100, unit: 'ml',
      category: 'niche', gender: 'unisex', minimumStock: 0, active: true,
      prices: { emprendedor: { USD: 25, NIO: 9999 }, vip: { USD: 24 }, premium: { USD: 22 } },
    }
    assert.equal(await rpc('save_catalog_product', input), input.id)
    const prices = (await db.query('select tier_code,currency,amount from public.product_prices where product_id=$1', [input.id])).rows
    assert.equal(prices.length, 6)
    for (const [tier, price] of Object.entries(input.prices)) {
      assert.equal(Number(prices.find((p) => p.tier_code === tier && p.currency === 'USD').amount), price.USD)
      assert.equal(Number(prices.find((p) => p.tier_code === tier && p.currency === 'NIO').amount), Math.round(price.USD * 37.1 * 100) / 100)
    }
    await assert.rejects(rpc('save_catalog_product', input), /Otro usuario/)
    await assert.rejects(rpc('save_catalog_product', { ...input, revision: 1, prices: { ...input.prices, vip: { USD: -1 } } }), /precio/i)
    assert.equal((await db.query('select revision from public.products where id=$1', [input.id])).rows[0].revision, 1)
  })
  await check('rate changes reprice the catalogue without rewriting issued documents or costs', async () => {
    const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const doc = await rpc('create_document', invoice({ kind: 'proforma', validUntil: '2099-01-01', items: [{ productId: id, quantity: 2 }] }))
    assert.equal(Number(doc.catalog_rate), 37.1)
    assert.equal(Number(doc.total), 1855)
    const costBefore = await average()
    await db.query('select public.set_exchange_rate($1::numeric)', [38])
    assert.equal(Number((await db.query("select amount from public.product_prices where product_id=$1 and tier_code='emprendedor' and currency='NIO'", [id])).rows[0].amount), 950)
    const frozen = (await db.query('select catalog_rate,total from public.documents where id=$1', [doc.id])).rows[0]
    assert.equal(Number(frozen.catalog_rate), 37.1)
    assert.equal(Number(frozen.total), 1855)
    assert.equal(await average(), costBefore)
  })
  await check('a count correction keeps the cost; a manual entry without cost still clears it', async () => {
    // Corregir un conteo corrige la cuenta de unidades, no su valoración: el
    // costo se queda. Una entrada manual sí trae mercadería que nadie costeó.
    const before = await average(empty)
    assert.ok(before !== null, 'el perfume necesita costo para comprobar que se conserva')
    const stock = await quantity(empty)
    await rpc('record_inventory_movement', movement({ productId: empty, type: 'ADJUSTMENT', quantity: stock + 2, note: 'Recuento: eran dos más' }))
    assert.equal(await quantity(empty), stock + 2)
    assert.equal(await average(empty), before)
    await rpc('record_inventory_movement', movement({ productId: empty, type: 'ADJUSTMENT', quantity: stock, note: 'Recuento corregido' }))
    assert.equal(await average(empty), before)
    await rpc('record_inventory_movement', movement({ productId: empty, type: 'ENTRY', quantity: 1, note: 'Entrada sin costo declarado' }))
    assert.equal(await average(empty), null)
  })
  await check('price history lists only real price changes, newest first, and only for the owner', async () => {
    const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const base = {
      id, name: 'Perfume con precio en dólares', brand: 'Marca', size: 100, unit: 'ml',
      category: 'niche', gender: 'unisex', minimumStock: 0, active: true,
    }
    const revision = async () => (await db.query('select revision from public.products where id=$1', [id])).rows[0].revision
    const history = async () => (await db.query('select * from public.list_price_changes($1::uuid)', [id])).rows
    // Guardar sin mover el precio no es un cambio de precio.
    await rpc('save_catalog_product', { ...base, revision: await revision(), prices: { emprendedor: { USD: 25 }, vip: { USD: 24 }, premium: { USD: 22 } } })
    const quiet = await history()
    // Subir la lista Emprendedor sí lo es, y sólo esa lista aparece.
    await rpc('save_catalog_product', { ...base, revision: await revision(), prices: { emprendedor: { USD: 30 }, vip: { USD: 24 }, premium: { USD: 22 } } })
    const changed = await history()
    assert.equal(changed.length, quiet.length + 1)
    const last = changed[0]
    assert.equal(last.tier, 'emprendedor')
    assert.equal(Number(last.before_usd), 25)
    assert.equal(Number(last.after_usd), 30)
    assert.equal(Number(last.after_nio), Math.round(30 * 38 * 100) / 100)
    assert.equal(Number(last.catalog_rate), 38)
    assert.equal(last.actor, 'Admin')
    // El alta del perfume queda como su precio de partida, sin un «antes».
    assert.equal(changed.at(-1).before_usd, null)
    for (const uid of [operator, warehouse, viewer, outsider]) {
      await identity(uid)
      await assert.rejects(db.query('select * from public.list_price_changes($1::uuid)', [id]), /insufficient|denied/i)
    }
    await identity(admin)
  })
  await check('deleting a registered author retains all financial records, price history and product photos', async () => {
    await db.exec('reset role')
    await db.query("update auth.users set email='removed@example.test' where id=$1", [admin])
    await db.query("update public.staff_members set role='superadmin' where user_id=$1", [viewer])
    await db.query("insert into storage.objects(bucket_id,name,owner,owner_id) values('product-images','historic/photo.webp',$1::uuid,$1::uuid::text)", [admin])
    const tables = ['documents','inventory_movements','purchase_shipments','opening_cost_records','expense_records','inventory_balances','products','product_prices','document_item_costs']
    const before = {}
    for (const t of tables) before[t] = await rows(t)
    const changes = (await db.query('select * from private.catalog_changes')).rows
    await identity(viewer)
    await db.query("select public.delete_staff_account('removed@example.test',$1,'admin')", [admin])
    await db.exec('reset role')
    assert.equal((await db.query('select * from auth.users where id=$1', [admin])).rows.length,0)
    assert.equal((await db.query('select * from public.staff_members where user_id=$1', [admin])).rows.length,0)
    for (const t of tables) assert.deepEqual(await rows(t),before[t],t)
    assert.deepEqual((await db.query('select * from private.catalog_changes')).rows,changes)
    const photo = (await db.query("select * from storage.objects where name='historic/photo.webp'")).rows[0]
    assert.equal(photo.owner,viewer)
    assert.equal(photo.owner_id,viewer)
    await identity(viewer)
    const history = (await db.query("select * from public.list_price_changes('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')")).rows
    assert.ok(history.length > 0)
    assert.equal(history[0].actor,'Admin')
    await identity(admin)
    assert.equal((await rows('products')).length,0)
    await assert.rejects(db.query('select * from public.list_staff_accounts()'), /insufficient/)
  })
  console.log(`${checks} accounting PostgreSQL checks passed. No deployed database was accessed.`)
} finally {
  await db.close()
}

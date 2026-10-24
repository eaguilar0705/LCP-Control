import assert from 'node:assert/strict'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
  warehouse,
  viewer,
  outsider,
} from './database-fixture.mjs'

// Migraciones y funciones reales, en PostgreSQL desechable sin red.
const db = await database()
let checks = 0
const eq = (actual, expected, note) => {
  assert.deepEqual(actual, expected, note)
  checks++
}
const reject = async (operation, pattern) => {
  await assert.rejects(operation, pattern)
  checks++
}
const call = (name, input) => rpc(db, name, input)
const rows = async (sql, params = []) => (await db.query(sql, params)).rows
const productIds = [crypto.randomUUID(), crypto.randomUUID()]
const input = (id, revision = 0, prices = {}) => ({
  id,
  revision,
  name: `Perfume ${id.slice(0, 4)}`,
  brand: 'Marca de pruebas',
  category: 'arabian',
  gender: 'unisex',
  size: 100,
  unit: 'ml',
  manufacturerBarcode: '',
  minimumStock: 1,
  active: true,
  imagePath: null,
  prices: {
    emprendedor: { USD: 50, NIO: 1850 },
    vip: { USD: 45, NIO: 1665 },
    premium: { USD: 40, NIO: 1480 },
    ...prices,
  },
})
const revision = async (id) =>
  (await rows('select revision from public.products where id=$1', [id]))[0]
    .revision
const price = async (id, tier) =>
  rows(
    'select currency,amount::float8 amount from public.product_prices where product_id=$1 and tier_code=$2 order by currency',
    [id, tier],
  )
const save = (tier, rowInput, currency = 'USD') => ({
  requestId: crypto.randomUUID(),
  tier,
  currency,
  rows: rowInput,
})
try {
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Admin','admin'),($2,'Caja','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer')",
    [admin, operator, warehouse, viewer],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Tienda de pruebas')",
  )
  await identity(db, admin)
  for (const id of productIds) await call('save_catalog_product', input(id))
  await db.exec('reset role')
  await db.exec('update public.inventory_balances set quantity=20')
  await db.exec(
    'insert into public.product_costs(product_id,average_cost_nio) select id,1000 from public.products',
  )
  await identity(db, admin)
  const snapshot = async () => {
    await db.exec('reset role')
    try {
      return (
        await rows(
          `select jsonb_build_object('stock',(select jsonb_agg(t order by product_id,location) from public.inventory_balances t),'cost',(select jsonb_agg(t order by product_id) from public.product_costs t),'documents',(select count(*) from public.documents),'journal',(select count(*) from public.journal_entries)) result`,
        )
      )[0].result
    } finally {
      await identity(db, admin)
    }
  }
  const before = await snapshot()
  const create = { requestId: crypto.randomUUID(), name: 'Menudeo' }
  const tier = await call('create_price_tier', create)
  eq(
    await call('create_price_tier', create),
    tier,
    'Repetir creación no duplica',
  )
  eq(
    (await rows('select name from public.price_tiers where code=$1', [tier]))[0]
      .name,
    'Menudeo',
  )
  eq(await price(productIds[0], tier), [], 'Una lista comienza sin precios')
  await reject(
    call('create_price_tier', { ...create, name: 'Otra' }),
    /otros datos/,
  )
  await reject(
    call('create_price_tier', {
      requestId: crypto.randomUUID(),
      name: ' menudeo ',
    }),
    /Ya existe/,
  )
  await reject(
    call('create_price_tier', { requestId: crypto.randomUUID(), name: ' ' }),
    /nombre/,
  )
  const secondTier = await call('create_price_tier', {
    requestId: crypto.randomUUID(),
    name: 'Mayorista especial',
  })
  eq(
    (await rows('select count(*)::int count from public.price_tiers'))[0].count,
    5,
  )
  const batch = save(tier, [
    {
      productId: productIds[0],
      revision: await revision(productIds[0]),
      amount: 60,
    },
    {
      productId: productIds[1],
      revision: await revision(productIds[1]),
      amount: 70,
    },
  ])
  eq(await call('save_price_list', batch), 2)
  const updatedRevision = await revision(productIds[0])
  eq(
    await call('save_price_list', batch),
    2,
    'Reintento devuelve resultado original',
  )
  eq(
    await revision(productIds[0]),
    updatedRevision,
    'Reintento no vuelve a incrementar revisión',
  )
  eq(await price(productIds[0], tier), [
    { currency: 'NIO', amount: 2220 },
    { currency: 'USD', amount: 60 },
  ])
  eq(
    await snapshot(),
    before,
    'Crear listas y precios no toca costos, existencias ni contabilidad',
  )
  const unchanged = await price(productIds[0], tier)
  await reject(
    call(
      'save_price_list',
      save(tier, [
        { productId: productIds[0], revision: updatedRevision, amount: 61 },
        { productId: productIds[1], revision: 999, amount: 71 },
      ]),
    ),
    /Otro usuario/,
  )
  eq(
    await price(productIds[0], tier),
    unchanged,
    'Conflicto en un perfume revierte todo el lote',
  )
  await reject(
    call('save_price_list', { ...batch, currency: 'NIO' }),
    /otros datos/,
  )
  eq(
    await call(
      'save_price_list',
      save(tier, [
        { productId: productIds[0], revision: updatedRevision, amount: 60 },
      ]),
    ),
    0,
    'Guardar el mismo importe no genera cambios',
  )
  eq(await revision(productIds[0]), updatedRevision)
  await reject(
    call(
      'save_price_list',
      save(tier, [
        { productId: productIds[0], revision: updatedRevision, amount: 0 },
      ]),
    ),
    /positivos/,
  )
  await reject(
    call(
      'save_price_list',
      save(tier, [
        { productId: productIds[0], revision: updatedRevision, amount: 1.234 },
      ]),
    ),
    /decimales/,
  )
  await reject(
    call(
      'save_price_list',
      save(tier, [
        { productId: productIds[0], revision: updatedRevision, amount: 65 },
        { productId: productIds[0], revision: updatedRevision, amount: 65 },
      ]),
    ),
    /repitas/,
  )
  await reject(
    call(
      'save_price_list',
      save('desconocida', [
        { productId: productIds[0], revision: updatedRevision, amount: 65 },
      ]),
    ),
    /no encontrada/,
  )
  await reject(
    call(
      'save_price_list',
      save(tier, [
        {
          productId: productIds[0],
          revision: updatedRevision + 0.1,
          amount: 65,
        },
      ]),
    ),
    /Otro usuario/,
  )
  await call('save_catalog_product', {
    ...input(productIds[0], updatedRevision),
    name: 'Nombre actualizado',
  })
  eq(
    await price(productIds[0], tier),
    unchanged,
    'Editar datos conserva importes de listas omitidas',
  )
  await call(
    'save_catalog_product',
    input(productIds[0], await revision(productIds[0]), {
      [secondTier]: { USD: 80, NIO: 2960 },
    }),
  )
  eq(await price(productIds[0], secondTier), [
    { currency: 'NIO', amount: 2960 },
    { currency: 'USD', amount: 80 },
  ])
  eq(await price(productIds[0], tier), unchanged)
  const nio = save(
    secondTier,
    [
      {
        productId: productIds[1],
        revision: await revision(productIds[1]),
        amount: 1000,
      },
    ],
    'NIO',
  )
  eq(await call('save_price_list', nio), 1)
  eq(await price(productIds[1], secondTier), [
    { currency: 'NIO', amount: 1000.11 },
    { currency: 'USD', amount: 27.03 },
  ])
  const history = await rows('select * from public.list_price_changes($1)', [
    productIds[0],
  ])
  eq(
    history.some((h) => h.tier === tier && Number(h.after_usd) === 60),
    true,
    'Historial incluye listas nuevas',
  )
  eq(
    history.some((h) => h.tier === secondTier && Number(h.after_usd) === 80),
    true,
  )
  for (const user of [operator, warehouse, viewer, outsider]) {
    await identity(db, user)
    await reject(
      call('create_price_tier', {
        requestId: crypto.randomUUID(),
        name: `Sin permiso ${user}`,
      }),
      /permission denied|insufficient_privilege/,
    )
    await reject(
      call('save_price_list', batch),
      /permission denied|insufficient_privilege/,
    )
  }
  await identity(db, null, 'anon')
  await reject(
    call('create_price_tier', {
      requestId: crypto.randomUUID(),
      name: 'Anónima',
    }),
    /permission denied/,
  )
  await identity(db, admin)
  const today = (
    await rows(
      "select (now() at time zone 'America/Managua')::date::text as day",
    )
  )[0].day
  await call('record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: today,
    description: 'Inventario inicial',
    reference: '',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1130', debit: 80000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 80000 },
    ],
  })
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 0,
    openingUsd: 0,
  })
  const customer = await call('save_customer', {
    id: crypto.randomUUID(),
    revision: 0,
    name: 'Cliente Menudeo',
    phone: '',
    priceTier: tier,
    email: '',
    taxId: '',
    address: '',
    notes: '',
    active: true,
  })
  const document = {
    requestId: crypto.randomUUID(),
    kind: 'invoice',
    customerId: customer,
    tier,
    currency: 'NIO',
    exchangeRate: 1,
    location: 'store',
    paymentMethod: 'cash',
    notes: '',
    items: [{ productId: productIds[0], quantity: 2, expectedUnitPrice: 2220 }],
    expectedTotal: 4440,
  }
  await identity(db, operator)
  const issued = await call('create_document', document)
  eq(Number(issued.total), 4440, 'Caja factura lista asignada al cliente')
  eq(
    (await call('create_document', document)).id,
    issued.id,
    'Reintento de factura conserva documento',
  )
  await reject(
    call('create_document', {
      ...document,
      requestId: crypto.randomUUID(),
      tier: 'vip',
    }),
    /lista asignada/,
  )
  await identity(db, admin)
  const missing = await call('create_price_tier', {
    requestId: crypto.randomUUID(),
    name: 'Sin precios',
  })
  const stock = (
    await rows(
      "select quantity from public.inventory_balances where product_id=$1 and location='store'",
      [productIds[0]],
    )
  )[0].quantity
  await reject(
    call('create_document', {
      ...document,
      requestId: crypto.randomUUID(),
      tier: missing,
    }),
    /No hay precio/,
  )
  eq(
    (
      await rows(
        "select quantity from public.inventory_balances where product_id=$1 and location='store'",
        [productIds[0]],
      )
    )[0].quantity,
    stock,
    'No deduce stock cuando falta precio',
  )
  await call(
    'save_price_list',
    save(tier, [
      {
        productId: productIds[0],
        revision: await revision(productIds[0]),
        amount: 65,
      },
    ]),
  )
  eq(await call('save_price_list', batch), 2)
  eq(
    (await price(productIds[0], tier)).find((row) => row.currency === 'USD')
      .amount,
    65,
    'Reintento antiguo no restaura un precio anterior',
  )
  await reject(
    call('create_document', { ...document, requestId: crypto.randomUUID() }),
    /precios cambiaron/,
  )
  eq(
    Number(
      (
        await rows('select total from public.documents where id=$1', [
          issued.id,
        ])
      )[0].total,
    ),
    4440,
    'Cambiar lista no reescribe facturas anteriores',
  )
  const now = (
    await rows(
      "select (now() at time zone 'America/Managua')::date::text as day",
    )
  )[0].day
  const ledger = (
    await rows('select public.ledger_report($1,$1) result', [now])
  )[0].result
  const digest = (
    await rows('select public.report_digest($1,$1) result', [now])
  )[0].result
  eq(
    digest.ledger.tiers.some((t) => t.tier === tier),
    true,
    'Contabilidad incluye venta de lista nueva',
  )
  eq(ledger.missingCosts, 0)
  eq(ledger.missingSales, 0)
  eq(ledger.accounts.find((account) => account.code === '4110').credit, 4440)
  eq(ledger.accounts.find((account) => account.code === '5120').debit, 2000)
  await call('save_product_pricing', [
    {
      productId: productIds[0],
      revision: await revision(productIds[0]),
      pricing: {
        purchasePrice: 10,
        purchaseCurrency: 'USD',
        markups: { emprendedor: null, vip: 20, premium: null },
      },
    },
  ])
  await reject(
    call(
      'save_price_list',
      save('vip', [
        {
          productId: productIds[0],
          revision: await revision(productIds[0]),
          amount: 13,
        },
      ]),
    ),
    /se calcula/,
  )
  eq(
    (await price(productIds[0], tier)).find((row) => row.currency === 'USD')
      .amount,
    65,
    'El precio calculado de una lista no modifica las listas manuales nuevas',
  )
  console.log(
    `PASS listas de precios: ${checks} comprobaciones de permisos, precios, reintentos, concurrencia, facturación y contabilidad`,
  )
} catch (error) {
  console.error(error.message, error.where ?? '', error.query ?? '')
  process.exitCode = 1
} finally {
  await db.close()
}

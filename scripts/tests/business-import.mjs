import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import {
  database,
  identity,
  admin,
  operator,
  warehouse,
  viewer,
  outsider,
} from './database-fixture.mjs'

const db = await database()
let checks = 0
let serial = 0
let current = admin
const day = '2026-10-01'
const equal = (actual, expected) => {
  assert.deepEqual(actual, expected)
  checks++
}
const product = (sku = 'LEGACY-001', changes = {}) => ({
  sku,
  name: 'Perfume de migración',
  brand: 'Marca importada',
  barcode: null,
  size: 100,
  unit: 'ml',
  category: 'arabian',
  gender: 'unisex',
  minimumStock: 2,
  pricesUSD: { emprendedor: 40, vip: 38, premium: 35 },
  ...changes,
})
const request = (changes = {}) => ({
  version: 1,
  requestId: randomUUID(),
  sourceHash: createHash('sha256').update(`source-${++serial}`).digest('hex'),
  filename: 'Migración La Casa del Perfume.xlsx',
  occurredOn: day,
  products: [],
  stocks: [],
  accounts: [],
  openingBalances: [],
  customers: [],
  suppliers: [],
  business: null,
  ...changes,
})
const run = async (input, preview = false) =>
  (
    await db.query(
      'select public.import_business_excel($1::jsonb,$2::boolean) result',
      [JSON.stringify(input), preview],
    )
  ).rows[0].result
const act = async (id, role = 'authenticated') => {
  current = id
  await identity(db, id, role)
}
const query = async (sql, args = []) => {
  await db.exec('reset role')
  const result = await db.query(sql, args)
  await identity(db, current)
  return result.rows
}
const state = async () =>
  (
    await query(`select jsonb_build_object(
      'products',(select jsonb_agg(to_jsonb(x) order by id) from public.products x),
      'brands',(select jsonb_agg(to_jsonb(x) order by id) from public.brands x),
      'prices',(select jsonb_agg(to_jsonb(x) order by product_id,tier_code,currency) from public.product_prices x),
      'balances',(select jsonb_agg(to_jsonb(x) order by product_id,location) from public.inventory_balances x),
      'movements',(select jsonb_agg(to_jsonb(x) order by id) from public.inventory_movements x),
      'costs',(select jsonb_agg(to_jsonb(x) order by product_id) from public.product_costs x),
      'openingCosts',(select jsonb_agg(to_jsonb(x) order by id) from public.opening_cost_records x),
      'accounts',(select jsonb_agg(to_jsonb(x) order by code) from public.ledger_accounts x),
      'entries',(select jsonb_agg(to_jsonb(x) order by id) from public.journal_entries x),
      'lines',(select jsonb_agg(to_jsonb(x) order by entry_id,line_no) from public.journal_lines x),
      'customers',(select jsonb_agg(to_jsonb(x) order by id) from public.customers x),
      'suppliers',(select jsonb_agg(to_jsonb(x) order by id) from public.suppliers x),
      'business',(select to_jsonb(x) from public.business_settings x),
      'imports',(select jsonb_agg(to_jsonb(x) order by source_hash) from private.business_excel_imports x),
      'audit',(select jsonb_agg(to_jsonb(x) order by id) from private.catalog_changes x),
      'limits',(select jsonb_agg(to_jsonb(x) order by user_id,action) from private.rate_limits x)
    ) data`)
  )[0].data
const rejects = async (input, pattern, preview = false) => {
  const before = await state()
  await assert.rejects(run(input, preview), pattern)
  checks++
  equal(await state(), before)
}

try {
  await db.query(
    `insert into public.staff_members(user_id,display_name,role,active) values
      ($1,'Administración','admin',true),($2,'Ventas','operator',true),
      ($3,'Bodega','warehouse',true),($4,'Consulta','viewer',true),
      ($5,'Administrador inactivo','admin',false)`,
    [admin, operator, warehouse, viewer, outsider],
  )
  await db.query(
    'insert into public.exchange_rates(usd_to_nio,updated_by) values(36.62,$1) on conflict(id) do update set usd_to_nio=excluded.usd_to_nio,updated_by=excluded.updated_by',
    [admin],
  )
  const simple = request({ products: [product()] })
  for (const id of [operator, warehouse, viewer, outsider]) {
    await act(id)
    await assert.rejects(
      run(simple),
      /insufficient_privilege|insufficient privilege/i,
    )
    checks++
  }
  await act(null, 'anon')
  await assert.rejects(run(simple), /permission denied/i)
  checks++
  await act(admin)
  await assert.rejects(run(simple, null), /Formato de importación inválido/)
  checks++

  const contact = {
    name: 'Cliente de Excel',
    phone: '50588881234',
    email: 'cliente@example.com',
    address: 'Managua',
    taxId: '',
    priceTier: 'vip',
  }
  const initial = request({
    products: [product()],
    stocks: [{ sku: 'LEGACY-001', warehouse: 5, store: 10, unitCostNio: 1000 }],
    accounts: [
      { code: '1120-010', name: 'Banco de migración', parent: '1120' },
      { code: '1130', name: 'Inventario de perfumes', parent: '1100' },
    ],
    openingBalances: [
      { account: '1130', debit: 15000, credit: 0 },
      { account: '1110-001', debit: 5000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 20000 },
    ],
    customers: [contact],
    suppliers: [
      { ...contact, name: 'Proveedor de Excel', phone: '+1 999 555' },
    ],
    business: {
      name: 'La Casa del Perfume',
      legalName: 'Casa del Perfume S.A.',
      taxId: 'J123456',
      address: 'Managua',
      phone: '88881234',
      email: '',
      branch: 'Principal',
      billingDetails: '',
    },
  })
  const empty = await state()
  const preview = await run(initial, true)
  equal(preview, {
    preview: true,
    alreadyImported: false,
    products: 1,
    stocks: 1,
    accounts: 2,
    openingBalances: 3,
    customers: 1,
    suppliers: 1,
    business: true,
  })
  equal(await state(), empty)
  await rejects(
    {
      ...initial,
      products: [product(), product('ZZ-BAD', { unit: 'litros' })],
    },
    /Productos, fila 3 \(ZZ-BAD\).*Unidad/,
  )
  await rejects(
    { ...initial, openingBalances: initial.openingBalances.slice(1) },
    /Incluye la cuenta 1130/,
  )
  await rejects(
    {
      ...initial,
      openingBalances: [
        { account: '1130', debit: 16000, credit: 0 },
        { account: '3110-001', debit: 0, credit: 16000 },
      ],
    },
    /debe coincidir.*15000/,
    true,
  )
  await rejects(
    {
      ...initial,
      openingBalances: [
        { account: '1130', debit: 15000, credit: 0 },
        { account: '3110-001', debit: 0, credit: 14000 },
      ],
    },
    /debe y el haber deben ser iguales/,
  )
  const committed = await run(initial)
  equal(committed, { ...preview, preview: false })
  equal(
    await query(
      'select location,quantity from public.inventory_balances order by location',
    ),
    [
      { location: 'store', quantity: 10 },
      { location: 'warehouse', quantity: 5 },
    ],
  )
  equal(
    Number(
      (await query('select average_cost_nio from public.product_costs'))[0]
        .average_cost_nio,
    ),
    1000,
  )
  equal(
    (
      await query('select count(*)::int n from private.inventory_count_gains')
    )[0].n,
    0,
  )
  equal(
    (
      await query(
        "select count(*)::int n from public.journal_entries where kind='opening'",
      )
    )[0].n,
    1,
  )
  equal(
    (
      await query(
        'select sum(debit_nio-credit_nio)::numeric balance from public.journal_lines',
      )
    )[0].balance,
    '0.00',
  )
  equal(
    (
      await query(
        "select amount from public.product_prices where tier_code='emprendedor' and currency='NIO'",
      )
    )[0].amount,
    '1464.80',
  )
  const after = await state()
  equal(await run(initial), { ...committed, alreadyImported: true })
  equal(
    await run(
      {
        ...initial,
        requestId: randomUUID(),
        filename: 'Archivo renombrado.xlsx',
      },
      true,
    ),
    { ...committed, preview: true, alreadyImported: true },
  )
  equal(await state(), after)
  await rejects({ ...initial, stocks: [] }, /ya se usó con otros datos/)
  await rejects(
    { ...initial, sourceHash: 'f'.repeat(64) },
    /ya se usó con otros datos/,
  )
  await rejects(
    request({
      stocks: [
        { sku: 'LEGACY-001', warehouse: 6, store: null, unitCostNio: null },
      ],
    }),
    /LEGACY-001.*conteo en bodega/,
  )
  await rejects(
    request({
      stocks: [
        { sku: 'LEGACY-001', warehouse: null, store: null, unitCostNio: 999 },
      ],
    }),
    /LEGACY-001.*costo promedio/,
  )
  await rejects(
    request({ products: [product('LEGACY-001', { name: 'Otro producto' })] }),
    /LEGACY-001.*otros datos/,
  )
  await rejects(
    request({
      products: [
        product('LEGACY-001', {
          pricesUSD: { emprendedor: 99, vip: null, premium: null },
        }),
      ],
    }),
    /lista emprendedor.*otro precio/,
  )
  await rejects(
    request({
      accounts: [{ code: '1130', name: 'Renombrado', parent: '1100' }],
    }),
    /1130.*otros datos/,
  )
  await rejects(
    request({
      accounts: [
        { code: '1130-001', name: 'Padre de movimiento', parent: '1130' },
      ],
    }),
    /1130-001.*cuenta mayor válida/,
  )
  await rejects(
    request({
      openingBalances: [
        { account: '1110-001', debit: 1, credit: 0 },
        { account: '3110-001', debit: 0, credit: 1 },
      ],
    }),
    /Incluye la cuenta 1130/,
  )
  await rejects(
    request({
      stocks: [
        { sku: 'LEGACY-001', warehouse: '5', store: null, unitCostNio: null },
      ],
    }),
    /Valor numérico requerido/,
  )
  await rejects(
    request({ products: [product('DUP'), product('DUP')] }),
    /códigos repetidos/,
  )
  await rejects(
    request({
      stocks: [{ sku: 'UNKNOWN', warehouse: 0, store: 0, unitCostNio: null }],
    }),
    /UNKNOWN.*No existe un producto/,
  )
  await rejects(
    request({ customers: [{ ...contact, name: 'Teléfono de otro cliente' }] }),
    /Ya existe un cliente/,
  )

  const partial = request({
    products: [
      product('LEGACY-002', {
        pricesUSD: { emprendedor: null, vip: null, premium: null },
      }),
    ],
    stocks: [
      { sku: 'LEGACY-002', warehouse: null, store: 0, unitCostNio: null },
    ],
  })
  await rejects(partial, /apertura contable ya está registrada/)
  await run({ ...partial, stocks: [] })
  equal(
    await query(
      "select location,quantity from public.inventory_balances where product_id=(select id from public.products where sku='LEGACY-002') order by location",
    ),
    [
      { location: 'store', quantity: null },
      { location: 'warehouse', quantity: null },
    ],
  )
  await rejects(
    request({
      stocks: [
        { sku: 'LEGACY-002', warehouse: null, store: null, unitCostNio: 500 },
      ],
    }),
    /apertura contable ya está registrada/,
  )
  const exact = request({
    stocks: initial.stocks,
    customers: initial.customers,
    suppliers: initial.suppliers,
    accounts: initial.accounts,
  })
  await run(exact)
  equal(
    (await query('select count(*)::int n from public.inventory_movements'))[0]
      .n,
    2,
  )
  equal((await query('select count(*)::int n from public.customers'))[0].n, 1)

  await db.exec('reset role')
  await db.exec(
    "insert into public.product_costs(product_id,average_cost_nio) select id,100 from public.products where sku='LEGACY-002'",
  )
  await db.exec(`insert into public.inventory_movements(product_id,location,type,quantity,before_quantity,after_quantity,actor_id,note,created_at)
    select id,'store','EXIT',1,1,0,'${admin}','Operación posterior','2026-10-02T12:00:00-06:00' from public.products where sku='LEGACY-002'`)
  // Una operación heredada anterior a conocer su costo no se puede volver a
  // tratar como saldo inicial. Se prepara sólo con privilegios de propietario.
  await db.exec(
    "update public.inventory_movement_costs set unit_cost_nio=null where product_id=(select id from public.products where sku='LEGACY-002'); delete from public.product_costs where product_id=(select id from public.products where sku='LEGACY-002')",
  )
  await act(admin)
  await rejects(
    request({
      stocks: [
        { sku: 'LEGACY-002', warehouse: 1, store: null, unitCostNio: null },
      ],
    }),
    /ya tiene operaciones/,
  )
  await db.exec('reset role')
  await db.query(
    "update public.staff_members set role='superadmin' where user_id=$1",
    [admin],
  )
  await act(admin)
  equal(
    (
      await run(
        request({
          accounts: [
            { code: '1120-011', name: 'Banco superadmin', parent: '1120' },
          ],
        }),
      )
    ).accounts,
    1,
  )
  equal(
    (
      await query(
        "select bucket,nature,postable from public.ledger_accounts where code='1120-011'",
      )
    )[0],
    { bucket: 'asset', nature: 'debit', postable: true },
  )
  // The initial importer also supports a legacy LCP code without colliding
  // with the next perfume created through the ordinary catalogue editor.
  await run(request({ products: [product('LCP-0001')] }))
  const nextProduct = randomUUID()
  await db.query('select public.save_catalog_product($1::jsonb)', [
    JSON.stringify({
      id: nextProduct,
      revision: 0,
      name: 'Creado después de Excel',
      brand: 'Marca importada',
      size: 50,
      unit: 'ml',
      category: 'arabian',
      gender: 'unisex',
      manufacturerBarcode: null,
      minimumStock: 0,
      active: true,
      prices: {
        emprendedor: { USD: 20 },
        vip: { USD: 19 },
        premium: { USD: 18 },
      },
    }),
  ])
  equal(
    (
      await query('select sku from public.products where id=$1', [nextProduct])
    )[0].sku,
    'LCP-0002',
  )
  await assert.rejects(
    db.query(
      'select private.save_catalog_product_before_excel_import($1::jsonb)',
      ['{}'],
    ),
    /permission denied/,
  )
  checks++
  const bulk = request({
    products: Array.from({ length: 121 }, (_, index) =>
      product(`BULK-${index}`),
    ),
  })
  equal((await run(bulk)).products, 121)
  await rejects(
    request({ products: [product('BAD-TYPE', { name: 42 })] }),
    /campo name debe ser texto/,
  )
  await rejects(
    { ...initial, requestId: bulk.requestId },
    /ya se usó con otros datos/,
  )

  // A separate unadopted workspace verifies that a blank count stays unknown
  // while an explicit zero is saved as a completed count.
  const unadopted = await database()
  try {
    await unadopted.query(
      "insert into public.staff_members(user_id,display_name,role) values($1,'Migración','admin')",
      [admin],
    )
    await identity(unadopted, admin)
    await unadopted.query(
      'select public.import_business_excel($1::jsonb,false)',
      [JSON.stringify(partial)],
    )
    const rows = (
      await unadopted.query(
        'select location,quantity from public.inventory_balances order by location',
      )
    ).rows
    equal(rows, [
      { location: 'store', quantity: 0 },
      { location: 'warehouse', quantity: null },
    ])
    await assert.rejects(
      unadopted.query('select public.import_business_excel($1::jsonb,false)', [
        JSON.stringify(
          request({
            stocks: [
              {
                sku: 'LEGACY-002',
                warehouse: null,
                store: null,
                unitCostNio: 500,
              },
            ],
          }),
        ),
      ]),
      /conteo en bodega y tienda/,
    )
    checks++
  } finally {
    await unadopted.close()
  }
  console.log(`Business Excel import: ${checks} checks passed.`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  await db.close()
}

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

const db = await database()
let checks = 0
const eq = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
}
const reject = async (p, re) => {
  await assert.rejects(p, re)
  checks++
}
const one = async (sql, args = []) => {
  await db.exec('reset role')
  try {
    return (await db.query(sql, args)).rows[0]
  } finally {
    await identity(db, admin)
  }
}
const call = (name, p) =>
  rpc(db, name, { requestId: crypto.randomUUID(), ...p })
const day = '2026-11-06'
const products = [
  'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
]
const snapshot = async () =>
  one(`select
 (select jsonb_agg(to_jsonb(b) order by product_id,location) from public.inventory_balances b) balances,
 (select jsonb_agg(to_jsonb(b) order by product_id) from public.product_costs b) costs,
 (select jsonb_agg(to_jsonb(b) order by product_id) from private.inventory_value_balances b) inventory_values,
 (select jsonb_agg(to_jsonb(b) order by id) from public.inventory_movements b) movements,
 (select count(*)::int from public.finance_entries) payments,
 (select count(*)::int from public.documents) documents,
 (select count(*)::int from public.product_prices) prices`)
try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select '2026-11-06T20:00:00Z'::timestamptz$$",
  )
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'SuperAdmin','superadmin'),($2,'Caja','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer'),($5,'Admin','admin')",
    [admin, operator, warehouse, viewer, outsider],
  )
  await db.exec(
    "insert into public.business_settings(name) values('QA');insert into public.brands(name) values('Armaf')",
  )
  for (let i = 0; i < products.length; i++) {
    await db.query(
      "insert into public.products(id,sku,name,brand_id,size,unit) values($1,$2,$3,(select id from public.brands limit 1),100,'ml')",
      [
        products[i],
        'QA-' + i,
        i === 0 ? 'Club de nuit intense' : 'Odyssey Mandaryn sky',
      ],
    )
    await db.query(
      "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',0),($1,'warehouse',0)",
      [products[i]],
    )
    await db.query(
      'insert into public.product_costs(product_id,average_cost_nio) values($1,$2)',
      [products[i], i === 0 ? 830.585 : 771.985833],
    )
  }
  await identity(db, admin)
  await call('open_business_day', {
    expectedDay: day,
    openingNio: 1000,
    openingUsd: 0,
  })
  await call('record_journal_entry', {
    kind: 'opening',
    occurredOn: day,
    description: 'Saldos iniciales',
    reference: 'QA',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1110-001', debit: 1000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 1000 },
    ],
  })
  const movements = []
  for (const productId of products)
    movements.push(
      await call('record_inventory_movement', {
        productId,
        location: 'store',
        type: 'ADJUSTMENT',
        quantity: 12,
        expectedQuantity: 0,
        note: 'Conteo físico',
      }),
    )
  const ctx = (
    await one('select public.count_purchase_context($1) r', [movements[0]])
  ).r
  eq(ctx.quantity, 12, 'se identifica el ingreso real de doce unidades')
  eq(
    ctx.valueNio,
    9967.02,
    'se conserva el valor exacto reconocido originalmente',
  )
  const before = await snapshot()
  eq(
    (
      await one(
        "select sum(credit-debit)::numeric amount from private.operational_postings where account='4190'",
      )
    ).amount,
    '19230.85',
  )
  for (const id of [operator, warehouse, viewer, outsider]) {
    await identity(db, id)
    await reject(
      call('adopt_inventory_counts_as_purchase', {
        movementIds: movements,
        expectedTotalNio: 19230.85,
      }),
      /permission|privilege/i,
    )
    await reject(
      db.query('select public.count_purchase_context($1)', [movements[0]]),
      /permission|privilege/i,
    )
  }
  await identity(db, null, 'anon')
  await reject(
    call('adopt_inventory_counts_as_purchase', {
      movementIds: movements,
      expectedTotalNio: 19230.85,
    }),
    /permission|privilege/i,
  )
  await identity(db, admin)
  await reject(
    call('adopt_inventory_counts_as_purchase', {
      movementIds: [movements[0], movements[0]],
      expectedTotalNio: 19230.85,
    }),
    /una sola vez/,
  )
  await reject(
    call('adopt_inventory_counts_as_purchase', {
      movementIds: movements,
      expectedTotalNio: 1,
    }),
    /valor.*cambió/,
  )
  eq(
    await snapshot(),
    before,
    'una solicitud rechazada no modifica existencias ni costos',
  )
  eq((await one('select count(*)::int n from public.purchase_shipments')).n, 0)
  const state = (await one('select public.get_business_day($1) r', [day])).r
  await call('close_business_day', {
    day,
    expectedRevision: state.revision,
    expectedStateToken: state.stateToken,
    countedNio: state.report.expectedNio,
    countedUsd: state.report.expectedUsd,
    note: '',
  })
  const input = {
    requestId: crypto.randomUUID(),
    movementIds: movements,
    expectedTotalNio: 19230.85,
  }
  const shipment = await rpc(db, 'adopt_inventory_counts_as_purchase', input)
  eq(
    await snapshot(),
    before,
    'reclasificar una jornada cerrada no repite inventario, costo, precios, ventas ni pagos',
  )
  eq(
    await rpc(db, 'adopt_inventory_counts_as_purchase', input),
    shipment,
    'recuperar una respuesta perdida es idempotente',
  )
  await reject(
    rpc(db, 'adopt_inventory_counts_as_purchase', {
      ...input,
      expectedTotalNio: 1,
    }),
    /solicitud cambió/,
  )
  await reject(
    call('adopt_inventory_counts_as_purchase', {
      movementIds: movements,
      expectedTotalNio: 19230.85,
    }),
    /ya se registró/,
  )
  eq((await one('select count(*)::int n from public.purchase_shipments')).n, 1)
  const receipt = (
    await one('select public.receipt_edit_context($1) r', [shipment])
  ).r
  eq(receipt.receipt.units, 24)
  eq(receipt.receipt.lines.length, 2)
  eq(receipt.receipt.goods_amount, 19230.85)
  eq(receipt.receipt.account, 'pending')
  eq(
    (await one('select public.count_purchase_context($1) r', [movements[0]])).r
      .shipmentId,
    shipment,
  )
  eq(
    (
      await one(
        "select count(*)::int amount from private.operational_postings where account='2190' or (source='purchase' and source_id=$1)",
        [shipment],
      )
    ).amount,
    0,
  )
  eq(
    (
      await one(
        "select count(*)::int n from private.operational_postings where source='count_gain'",
      )
    ).n,
    0,
    'ya no se reconoce la compra como otros ingresos',
  )
  eq(
    (await one('select count(*)::int n from private.inventory_purchase_links'))
      .n,
    2,
    'se archiva el detalle de ambos movimientos originales',
  )
  eq(
    (await one('select count(*)::int n from private.inventory_count_gains')).n,
    0,
  )
  await db.exec('reset role')
  await db.query(
    'update public.business_days set closed_at=null,report=null where day=$1',
    [day],
  )
  await identity(db, admin)
  const classification = await call('classify_purchase', {
    shipmentId: shipment,
    occurredOn: day,
    description: 'Compra de 24 unidades',
    reference: 'QA',
    currency: 'NIO',
    exchangeRate: 1,
    linkedPayments: [],
    lines: [
      {
        account: '1130',
        debit: 19230.85,
        credit: 0,
        currency: 'NIO',
        exchangeRate: 1,
      },
      {
        account: '2111',
        debit: 0,
        credit: 19230.85,
        currency: 'NIO',
        exchangeRate: 1,
      },
    ],
  })
  assert.ok(classification.id)
  checks++
  eq(
    await snapshot(),
    before,
    'clasificar a crédito tampoco mueve de nuevo las unidades',
  )
  const ledger = (await one('select public.ledger_report($1,$1) r', [day])).r
  eq(
    ledger.accounts.some((a) => a.code === '2190'),
    false,
  )
  eq(ledger.accounts.find((a) => a.code === '2111').closing, -19230.85)
  const revision = await call('revise_purchase_receipt', {
    shipmentId: shipment,
    expectedRevision: 0,
    incurredOn: day,
    supplier: 'Proveedor confirmado',
    reference: 'Factura real',
    note: 'Costo revisado',
    currency: 'NIO',
    exchangeRate: 1,
    shippingAmount: 0,
    counterpart: '1130',
    costAccount: '5120',
    lines: products.map((productId, i) => ({
      productId,
      location: 'store',
      quantity: 12,
      unitPrice: i === 0 ? 940 : 840,
    })),
    impacts: receipt.products.map((p) => ({
      productId: p.id,
      expectedStore: p.store,
      expectedWarehouse: p.warehouse,
      expectedValueNio: p.value,
      targetValueNio: p.id === products[0] ? 11280 : 10080,
    })),
  })
  eq(
    revision.receipt.goods_amount,
    21360,
    'el costo de la compra regularizada sigue siendo editable',
  )
  eq(
    (await one('select public.receipt_edit_context($1) r', [shipment])).r
      .history.length,
    1,
  )
  eq(
    (await one('select sum(quantity)::int q from public.inventory_balances')).q,
    24,
  )
  await call('correct_journal_entry', {
    entryId: classification.id,
    expectedRevision: 0,
    occurredOn: day,
    description: 'Contrapartida corregida',
    reference: 'Factura real',
    lines: [
      {
        account: '1130',
        debit: 21360,
        credit: 0,
        currency: 'NIO',
        exchangeRate: 1,
      },
      {
        account: '2111',
        debit: 0,
        credit: 21360,
        currency: 'NIO',
        exchangeRate: 1,
      },
    ],
  })
  const finalLedger = (await one('select public.ledger_report($1,$1) r', [day]))
    .r
  eq(
    finalLedger.accounts.some((a) => a.code === '2190'),
    false,
  )
  eq(finalLedger.accounts.find((a) => a.code === '1130').closing, 21360)
  console.log(
    `PASS ${checks} comprobaciones de compras regularizadas desde conteos; sin escrituras remotas`,
  )
} catch (e) {
  console.error(e.message, e.detail ?? '', e.where ?? '')
  process.exitCode = 1
} finally {
  await db.close()
}

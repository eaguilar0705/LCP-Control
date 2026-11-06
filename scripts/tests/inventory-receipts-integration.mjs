import assert from 'node:assert/strict'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
  warehouse,
} from './database-fixture.mjs'

// Exercise the migration boundary: warehouse review, later receipt corrections,
// and purchase classification share stock, journals, and recovery dispatch.
const db = await database()
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000401'
const day = '2026-11-06'
let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const reject = async (promise, pattern) => {
  await assert.rejects(promise, pattern)
  checks++
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const call = (name, input) =>
  rpc(db, name, { requestId: crypto.randomUUID(), ...input })
const stock = async () =>
  Number(
    (
      await one(
        'select sum(quantity) q from public.inventory_balances where product_id=$1',
        [product],
      )
    ).q,
  )
const confirmation = async (kind, requestId) =>
  (
    await one('select public.get_operation_confirmation($1,$2) r', [
      kind,
      requestId,
    ])
  ).r
const lines = (quantity, unitPrice) => [
  { productId: product, location: 'store', quantity, unitPrice },
]
const journalLine = (account, debit, credit) => ({
  account,
  debit,
  credit,
  currency: 'NIO',
  exchangeRate: 1,
})

try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select '2026-11-06T20:00:00Z'::timestamptz$$",
  )
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Propietario QA','superadmin'),($2,'Caja QA','operator'),($3,'Bodega QA','warehouse')",
    [admin, operator, warehouse],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Integración aislada'); insert into public.brands(name) values('Marca QA')",
  )
  await db.query(
    "insert into public.products(id,sku,name,brand_id) values($1,'REC-INTEGRATION','Perfume QA',(select id from public.brands limit 1))",
    [product],
  )
  await db.query(
    "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',0),($1,'warehouse',0)",
    [product],
  )
  await db.query(
    "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',1000)",
    [product],
  )
  await identity(db, admin)
  await call('record_journal_entry', {
    occurredOn: day,
    kind: 'opening',
    description: 'Apertura QA',
    reference: '',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1110-001', debit: 10000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 10000 },
    ],
  })
  await call('open_business_day', {
    expectedDay: day,
    openingNio: 10000,
    openingUsd: 0,
  })

  await identity(db, warehouse)
  const input = {
    requestId: crypto.randomUUID(),
    incurredOn: day,
    supplier: 'Proveedor QA',
    agency: '',
    reference: 'REC-INTEGRATION',
    note: '',
    currency: 'NIO',
    exchangeRate: 1,
    shippingAmount: 0,
    lines: lines(5, 100),
  }
  const receipt = await rpc(db, 'record_inventory_receipt', input)
  eq(
    await stock(),
    0,
    'la recepción pendiente continúa fuera del inventario vendible',
  )
  eq(
    await confirmation('inventory-receipt', input.requestId),
    { status: 'confirmed', id: receipt },
    'los wrappers contables conservan la recuperación de Bodega',
  )
  await identity(db, operator)
  await reject(
    call('create_document', {
      kind: 'invoice',
      customerName: 'Cliente QA',
      tier: 'emprendedor',
      currency: 'NIO',
      exchangeRate: 1,
      location: 'store',
      paymentMethod: 'cash',
      notes: '',
      items: [{ productId: product, quantity: 1 }],
    }),
    /existencias|unidades|costo|disponib|stock/i,
  )

  await identity(db, admin)
  eq(
    (await one("select public.purchase_accounting_rows('pending',null,null) r"))
      .r.length,
    0,
    'la recepción de Bodega aún no crea una compra por clasificar',
  )
  const { requestId: receiptRequest, ...purchase } = input
  const posting = {
    requestId: crypto.randomUUID(),
    receiptId: receipt,
    expectedRevision: 0,
    purchase: { ...purchase, account: 'caja' },
  }
  const shipment = await rpc(db, 'post_inventory_receipt', posting)
  eq(await stock(), 5)
  eq(await confirmation('inventory-receipt-post', posting.requestId), {
    status: 'confirmed',
    id: shipment,
  })
  eq(
    (await one("select public.purchase_accounting_rows('pending',null,null) r"))
      .r.length,
    0,
    'la cuenta explícita de la revisión conserva su tratamiento',
  )
  const correction = {
    requestId: crypto.randomUUID(),
    shipmentId: shipment,
    expectedRevision: 0,
    incurredOn: day,
    supplier: 'Proveedor corregido',
    reference: 'REC-CORREGIDA',
    note: 'Corrección posterior',
    currency: 'NIO',
    exchangeRate: 1,
    shippingAmount: 0,
    counterpart: '1110-001',
    costAccount: '5150',
    lines: lines(6, 120),
    impacts: [
      {
        productId: product,
        expectedStore: 5,
        expectedWarehouse: 0,
        expectedValueNio: 500,
        targetValueNio: 720,
      },
    ],
  }
  const revised = await rpc(db, 'revise_purchase_receipt', correction)
  eq(
    await stock(),
    6,
    'la corrección remota aplica solo la diferencia de unidades a la compra revisada localmente',
  )
  eq(
    (await confirmation('receipt-revision', correction.requestId)).id,
    revised.id,
  )
  eq(
    await rpc(db, 'post_inventory_receipt', posting),
    shipment,
    'reintentar la revisión original conserva su idempotencia tras corregir',
  )
  eq(
    await stock(),
    6,
    'recuperar la revisión original no revierte ni duplica la corrección posterior',
  )
  const context = (
    await one('select public.receipt_edit_context($1) r', [shipment])
  ).r
  eq(
    [
      context.receipt.goods_amount,
      context.receipt.units,
      context.history.length,
    ],
    [720, 6, 1],
  )
  const history = (await one('select public.purchase_history(null,null) r')).r
  eq(
    history.find((row) => row.id === shipment).goods_amount,
    720,
    'Compras muestra el costo definitivo de la revisión vinculada',
  )

  // Existing accounting-only receipts keep the newer classification workflow.
  const pending = await call('record_shipment', {
    ...purchase,
    reference: 'CLASIFICAR-QA',
    account: 'pending',
    lines: lines(2, 50),
  })
  eq(await stock(), 8)
  const classification = {
    requestId: crypto.randomUUID(),
    shipmentId: pending,
    occurredOn: day,
    description: 'Clasificación QA',
    reference: 'CLASIFICAR-QA',
    currency: 'NIO',
    exchangeRate: 1,
    linkedPayments: [],
    lines: [journalLine('2190', 100, 0), journalLine('1110-001', 0, 100)],
  }
  const entry = await rpc(db, 'classify_purchase', classification)
  eq(
    (await confirmation('purchase-classification', classification.requestId))
      .id,
    entry.id,
  )
  eq((await rpc(db, 'classify_purchase', classification)).id, entry.id)
  eq(
    await stock(),
    8,
    'clasificar una compra independiente no vuelve a recibir sus unidades',
  )
  const ledger = (await one('select public.ledger_report($1,$1) r', [day])).r
  eq(
    ledger.accounts.find((a) => a.code === '1130').closing,
    820,
    'ambos flujos y la corrección comparten el valor real del inventario',
  )
  eq(
    ledger.accounts.find((a) => a.code === '2190').closing,
    0,
    'la clasificación cancela únicamente la compra pendiente independiente',
  )

  await identity(db, warehouse)
  eq(
    await confirmation('inventory-receipt', receiptRequest),
    { status: 'confirmed', id: receipt },
    'Bodega recupera su solicitud tras operaciones contables posteriores',
  )
  console.log(
    `PASS ${checks} comprobaciones de integración de recepciones y contabilidad; PostgreSQL desechable, sin escrituras remotas.`,
  )
} finally {
  await db.close()
}

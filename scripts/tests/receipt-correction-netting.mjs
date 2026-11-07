import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
  warehouse,
  viewer,
} from './database-fixture.mjs'

const migration = '20261107220000_consolidar_correcciones_de_recepcion.sql'
const db = await database({ beforeMigration: migration })
const day = '2026-11-06'
let checks = 0
let productNumber = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const call = (name, input) =>
  rpc(db, name, { requestId: crypto.randomUUID(), ...input })
const detail = async (id) =>
  (await one('select public.get_journal_entry($1) r', [id])).r
const ledger = async () =>
  (await one('select public.ledger_report($1,$1) r', [day])).r
const cents = (value) => Math.round(value * 100)
const amounts = (report, account) => {
  const row = report.accounts.find((a) => a.code === account)
  return [row.opening, row.debit, row.credit, row.closing]
}
const postingLines = (entry) =>
  entry.lines.map((l) => [l.account, l.debit_nio, l.credit_nio])
const journalLine = (account, debit, credit) => ({
  account,
  debit,
  credit,
  currency: 'NIO',
  exchangeRate: 1,
})
const fingerprint = async () => {
  await db.exec('reset role')
  try {
    return (
      await one(`select jsonb_build_object(
       'entries',(select jsonb_agg(to_jsonb(e) order by id) from public.journal_entries e),
       'lines',(select jsonb_agg(to_jsonb(l) order by entry_id,line_no) from public.journal_lines l),
       'currencies',(select jsonb_agg(to_jsonb(c) order by entry_id,line_no) from private.journal_line_currencies c),
       'revisions',(select jsonb_agg(to_jsonb(r) order by id) from private.receipt_revisions r),
       'journalHistory',(select jsonb_agg(to_jsonb(h) order by id) from private.journal_corrections h),
       'originHistory',(select jsonb_agg(to_jsonb(h) order by id) from private.purchase_inventory_origin_changes h),
       'purchases',(select jsonb_agg(to_jsonb(s) order by id) from public.purchase_shipments s),
       'classifications',(select jsonb_agg(to_jsonb(c) order by shipment_id) from private.purchase_classifications c),
       'payments',(select jsonb_agg(to_jsonb(f) order by id) from public.finance_entries f),
       'movements',(select jsonb_agg(to_jsonb(m) order by id) from public.inventory_movements m),
       'stock',(select jsonb_agg(to_jsonb(b) order by product_id,location) from public.inventory_balances b),
       'values',(select jsonb_agg(to_jsonb(v) order by product_id) from private.inventory_value_balances v),
       'costs',(select jsonb_agg(to_jsonb(c) order by product_id) from public.product_costs c)
      ) r`)
    ).r
  } finally {
    await identity(db, admin)
  }
}
async function product() {
  const id = crypto.randomUUID()
  productNumber++
  await db.exec('reset role')
  await db.query(
    "insert into public.products(id,sku,name,brand_id) values($1,$2,'Perfume QA',(select id from public.brands limit 1))",
    [id, `NET-${productNumber}`],
  )
  await db.query(
    "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',0),($1,'warehouse',0)",
    [id],
  )
  await db.query(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,0)',
    [id],
  )
  await identity(db, admin)
  return id
}
const receive = (productId, quantity, unitPrice, account = 'pending') =>
  call('record_shipment', {
    incurredOn: day,
    supplier: 'Proveedor QA',
    agency: '',
    reference: 'REG-20261106-7d8f7741',
    note: '',
    currency: 'NIO',
    exchangeRate: 1,
    account,
    shippingAmount: 0,
    lines: [{ productId, location: 'store', quantity, unitPrice }],
  })
const revisionInput = (
  shipmentId,
  productId,
  quantity,
  unitPrice,
  expectedStore,
  expectedValueNio,
  targetValueNio,
  expectedRevision = 0,
) => ({
  requestId: crypto.randomUUID(),
  shipmentId,
  expectedRevision,
  incurredOn: day,
  supplier: 'Proveedor QA',
  reference: 'REG-20261106-7d8f7741',
  note: 'Revisión de costo QA',
  currency: 'NIO',
  exchangeRate: 1,
  shippingAmount: 0,
  counterpart: '1120-003',
  costAccount: '5150',
  lines: [{ productId, location: 'store', quantity, unitPrice }],
  impacts: [
    {
      productId,
      expectedStore,
      expectedWarehouse: 0,
      expectedValueNio,
      targetValueNio,
    },
  ],
})
async function classify(shipmentId, total, entryId) {
  return call('classify_purchase', {
    shipmentId,
    ...(entryId
      ? { entryId, expectedRevision: (await detail(entryId)).revision }
      : {}),
    occurredOn: day,
    description: 'Compra QA LAFISE',
    reference: 'REG-20261106-7d8f7741',
    currency: 'NIO',
    exchangeRate: 1,
    linkedPayments: [],
    lines: [journalLine('1130', total, 0), journalLine('1120-003', 0, total)],
  })
}
const exit = (productId) =>
  call('record_inventory_movement', {
    productId,
    location: 'store',
    type: 'EXIT',
    quantity: 2,
    note: 'Dos unidades consumidas antes de revisar el costo',
  })

try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select '2026-11-06T20:00:00Z'::timestamptz$$",
  )
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Propietario','superadmin'),($2,'Caja','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer')",
    [admin, operator, warehouse, viewer],
  )
  await db.exec(
    "insert into public.business_settings(name) values('QA');insert into public.brands(name) values('QA')",
  )
  await identity(db, admin)
  await call('record_journal_entry', {
    kind: 'opening',
    occurredOn: day,
    description: 'Apertura QA',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1120-003', debit: 100000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 100000 },
    ],
  })
  await call('open_business_day', {
    expectedDay: day,
    openingNio: 0,
    openingUsd: 0,
  })
  const inventoryAccount = (
    await one('select public.ledger_accounts_list() r')
  ).r.find((a) => a.code === '1130')
  await call('change_ledger_account', {
    action: 'rename',
    code: '1130',
    newCode: '1138',
    name: inventoryAccount.name,
    expectedRevision: inventoryAccount.revision,
  })

  // Reproduce el asiento del video: la misma cuenta recibe y entrega 2,129.15.
  const neutralProduct = await product()
  const neutralPurchase = await receive(neutralProduct, 1, 100)
  const neutralInput = revisionInput(
    neutralPurchase,
    neutralProduct,
    1,
    2229.15,
    1,
    100,
    2229.15,
  )
  const neutral = await rpc(db, 'revise_purchase_receipt', neutralInput)
  eq(
    postingLines(await detail(neutral.journalEntryId)),
    [
      ['1130', 2129.15, 0],
      ['1130', 0, 2129.15],
    ],
    'reproducción exacta del cargo/abono del video',
  )
  const neutralClassified = await classify(neutralPurchase, 2229.15)

  // Con consumo previo la revisión conserva solo el traslado real de costo.
  const consumedProduct = await product()
  const consumedPurchase = await receive(consumedProduct, 10, 100)
  const consumedClassified = await classify(consumedPurchase, 1000)
  await exit(consumedProduct)
  const consumedInput = revisionInput(
    consumedPurchase,
    consumedProduct,
    10,
    120,
    8,
    800,
    960,
  )
  const consumed = await rpc(db, 'revise_purchase_receipt', consumedInput)
  eq(postingLines(await detail(consumed.journalEntryId)), [
    ['1130', 160, 0],
    ['5150', 40, 0],
    ['1130', 0, 200],
  ])

  // Otra contrapartida elegida y un comprobante manual no se consolidan.
  const otherProduct = await product()
  const otherPurchase = await receive(otherProduct, 2, 100, 'credito')
  const other = await rpc(
    db,
    'revise_purchase_receipt',
    revisionInput(otherPurchase, otherProduct, 2, 150, 2, 200, 300),
  )
  const otherBefore = await detail(other.journalEntryId)
  const manual = await call('record_journal_entry', {
    kind: 'adjustment',
    occurredOn: day,
    description: 'Comprobante manual con dos patas en inventario',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [journalLine('1130', 787.58, 0), journalLine('1130', 0, 787.58)],
  })
  const manualBefore = await detail(manual)
  const adjustment = await call('record_inventory_movement', {
    productId: otherProduct,
    location: 'store',
    type: 'ADJUSTMENT',
    quantity: 3,
    expectedQuantity: 2,
    adjustmentKind: 'correction',
    counterAccount: '3110-001',
    note: 'Otra corrección de cantidad',
  })
  await db.exec('reset role')
  const adjustmentJournal = (
    await one(
      'select entry_id from private.inventory_adjustment_journals where movement_id=$1',
      [adjustment],
    )
  ).entry_id
  await identity(db, admin)
  const before = await ledger()
  const original = await fingerprint()
  await db.exec('reset role')
  await db.exec(
    await readFile(`backend/supabase/migrations/${migration}`, 'utf8'),
  )
  await identity(db, admin)
  eq(
    await fingerprint(),
    original,
    'la migración no altera comprobantes, renglones, payloads, historial, pagos, costos ni existencias',
  )

  const after = await ledger()
  for (const row of before.accounts) {
    const current = after.accounts.find((a) => a.code === row.code)
    eq(current.closing, row.closing, `${row.code}: conserva el saldo final`)
    eq(current.opening, row.opening, `${row.code}: conserva la apertura`)
  }
  eq(cents(amounts(before, '1130')[1] - amounts(after, '1130')[1]), 228915)
  eq(
    cents(amounts(before, '1130')[2] - amounts(after, '1130')[2]),
    228915,
    'solo retira patas opuestas de revisiones generadas',
  )
  eq(
    amounts(after, '5150'),
    amounts(before, '5150'),
    'los costos reales no cambian',
  )
  eq(
    amounts(after, '1120-003'),
    amounts(before, '1120-003'),
    'LAFISE no se vuelve a cobrar',
  )
  eq(after.purchaseAccounting, before.purchaseAccounting)
  eq(after.accounts.find((a) => a.code === '1130').displayCode, '1138')

  const neutralDetail = await detail(neutral.journalEntryId)
  eq(neutralDetail.lines, [])
  eq(
    neutralDetail.receiptOriginalLines.map((l) => [
      l.account,
      l.debit_nio,
      l.credit_nio,
    ]),
    [
      ['1130', 2129.15, 0],
      ['1130', 0, 2129.15],
    ],
  )
  eq(neutralDetail.receiptOriginalLines[0].displayAccount, '1138')
  eq(neutralDetail.receiptPostingNormalized, true)
  eq(neutralDetail.receiptNoAccountingEffect, true)
  eq(neutralDetail.receiptCorrection, true)
  eq(neutralDetail.sourceReceiptId, neutralPurchase)
  eq(
    (await rpc(db, 'revise_purchase_receipt', neutralInput)).journalEntryId,
    neutral.journalEntryId,
    'recuperar una revisión histórica conserva su identificador original',
  )
  const consumedDetail = await detail(consumed.journalEntryId)
  eq(postingLines(consumedDetail), [
    ['1130', 0, 40],
    ['5150', 40, 0],
  ])
  eq(consumedDetail.lines[0].displayAccount, '1138')
  eq(consumedDetail.receiptPostingNormalized, true)
  eq(consumedDetail.receiptNoAccountingEffect, false)
  eq(consumedDetail.receiptOriginalLines.length, 3)
  eq(
    postingLines(await detail(other.journalEntryId)),
    postingLines(otherBefore),
    'no cancela cuentas diferentes',
  )
  eq((await detail(other.journalEntryId)).receiptPostingNormalized, false)
  eq(
    postingLines(await detail(manual)),
    postingLines(manualBefore),
    'un comprobante manual conserva sus movimientos brutos',
  )
  eq((await detail(manual)).receiptPostingNormalized, undefined)
  eq(
    (await detail(adjustmentJournal)).inventoryCorrection,
    true,
    'conserva el origen de ajustes de cantidades',
  )
  eq(
    (await detail(neutralClassified.id)).receiptPostingNormalized,
    undefined,
    'una clasificación de compra no se normaliza como revisión',
  )
  const page = (await one('select public.journal_entries_page($1,$1) r', [day]))
    .r
  eq(
    page.entries.find((e) => e.id === neutral.journalEntryId)
      .receiptNoAccountingEffect,
    true,
  )
  eq(
    after.entries.find((e) => e.id === neutral.journalEntryId)
      .receiptNoAccountingEffect,
    true,
  )
  eq(
    page.entries.find((e) => e.id === adjustmentJournal).inventoryCorrection,
    true,
  )

  // Completar la compra revisada sigue cargando el inventario una sola vez.
  await classify(consumedPurchase, 1200, consumedClassified.id)
  eq((await ledger()).purchaseAccounting.pendingCount, 0)
  eq((await detail(consumedClassified.id)).lines[0].debit_nio, 1200)

  const futureProduct = await product()
  const futurePurchase = await receive(futureProduct, 1, 100)
  const futureInput = revisionInput(
    futurePurchase,
    futureProduct,
    1,
    2229.15,
    1,
    100,
    2229.15,
  )
  const countBefore = (
    await one('select count(*)::int n from public.journal_entries')
  ).n
  const future = await rpc(db, 'revise_purchase_receipt', futureInput)
  eq(
    future.journalEntryId,
    null,
    'una revisión nueva neta cero conserva su historial sin asiento ficticio',
  )
  eq(
    (await one('select count(*)::int n from public.journal_entries')).n,
    countBefore,
  )
  eq(
    await rpc(db, 'revise_purchase_receipt', futureInput),
    future,
    'reintento sin asiento también es idempotente',
  )
  eq(
    (
      await one('select public.get_operation_confirmation($1,$2) r', [
        'receipt-revision',
        futureInput.requestId,
      ])
    ).r,
    { status: 'confirmed', id: future.id },
  )
  const futureBefore = await ledger()
  await classify(futurePurchase, 2229.15)
  const futureAfter = await ledger()
  eq(
    cents(amounts(futureAfter, '1130')[1] - amounts(futureBefore, '1130')[1]),
    222915,
  )
  eq(amounts(futureAfter, '1130')[2], amounts(futureBefore, '1130')[2])

  const newConsumedProduct = await product()
  const newConsumedPurchase = await receive(newConsumedProduct, 10, 100)
  const newConsumedClassified = await classify(newConsumedPurchase, 1000)
  await exit(newConsumedProduct)
  const newConsumed = await rpc(
    db,
    'revise_purchase_receipt',
    revisionInput(
      newConsumedPurchase,
      newConsumedProduct,
      10,
      120,
      8,
      800,
      960,
    ),
  )
  const newConsumedLines = postingLines(
    await detail(newConsumed.journalEntryId),
  ).sort()
  eq(
    newConsumedLines,
    [
      ['1130', 0, 40],
      ['5150', 40, 0],
    ],
    'una revisión nueva con consumo solo genera el traslado real',
  )
  eq((await detail(newConsumed.journalEntryId)).receiptPostingNormalized, false)
  await classify(newConsumedPurchase, 1200, newConsumedClassified.id)
  const decreased = await rpc(
    db,
    'revise_purchase_receipt',
    revisionInput(
      newConsumedPurchase,
      newConsumedProduct,
      10,
      80,
      8,
      960,
      640,
      1,
    ),
  )
  eq(
    postingLines(await detail(decreased.journalEntryId)).sort(),
    [
      ['1130', 80, 0],
      ['5150', 0, 80],
    ],
    'una reducción de costo conserva la reversión neta real',
  )
  await classify(newConsumedPurchase, 800, newConsumedClassified.id)
  const final = await ledger()
  eq(final.purchaseAccounting.pendingCount, 0)
  eq(
    final.accounts
      .filter((a) => a.postable)
      .reduce((sum, a) => sum + cents(a.debit) - cents(a.credit), 0),
    0,
  )
  eq(
    final.accounts
      .filter((a) => a.postable)
      .reduce((sum, a) => sum + cents(a.closing), 0),
    0,
  )

  for (const user of [operator, warehouse, viewer]) {
    await identity(db, user)
    await assert.rejects(
      () => detail(neutral.journalEntryId),
      /permission|insufficient/i,
    )
    await assert.rejects(() => ledger(), /permission|insufficient/i)
    checks += 2
  }
  await identity(db, '', 'anon')
  await assert.rejects(
    () => detail(neutral.journalEntryId),
    /permission|insufficient/i,
  )
  checks++
  console.log(
    `PASS correcciones de recepción netas: ${checks} verificaciones; 2,129.15 reproducidos, historial intacto, consumo parcial, compras, mayor, permisos y recuperación`,
  )
} finally {
  await db.close()
}

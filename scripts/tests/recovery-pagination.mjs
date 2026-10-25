import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { browserDatabase } from './browser-database.mjs'
import { identity, admin, operator } from './database-fixture.mjs'
import { seedJournalPages } from './recovery-pagination-fixture.mjs'
const output = 'output/functional-recovery-pagination'
await mkdir(output, { recursive: true })
const fixture = await browserDatabase({ route: async () => {} })
const { db, today } = fixture
let checks = 0
const equal = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
}
const rejects = async (promise, pattern) => {
  await assert.rejects(promise, pattern)
  checks++
}
const call = async (name, input) =>
  (
    await db.query(`select public.${name}($1::jsonb) r`, [
      JSON.stringify(input),
    ])
  ).rows[0].r
const status = async (kind, id, retire = false) =>
  (
    await db.query(
      `select public.${retire ? 'retire_unconfirmed_operation' : 'get_operation_confirmation'}($1,$2::uuid) r`,
      [kind, id],
    )
  ).rows[0].r
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
const state = async () =>
  (
    await db.query(
      `select (select quantity from public.inventory_balances where product_id=$1 and location='store') store,
 (select quantity from public.inventory_balances where product_id=$1 and location='warehouse') warehouse,
 (select average_cost_nio::text from public.product_costs where product_id=$1) cost,
 (select count(*)::int from public.documents) documents,(select count(*)::int from public.purchase_shipments) purchases,
 (select count(*)::int from public.expense_records) expenses,(select count(*)::int from public.finance_entries) finance,
 (select count(*)::int from public.journal_entries) journals,(select count(*)::int from public.price_tiers) tiers`,
      [product],
    )
  ).rows[0]
const results = []
try {
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 1000,
    openingUsd: 0,
    expectedDay: today,
  })
  const customer = (await db.query('select id from public.customers limit 1'))
    .rows[0].id
  const families = [
    [
      'purchase',
      'record_shipment',
      {
        incurredOn: today,
        supplier: 'Proveedor QA',
        reference: 'RETIRE',
        currency: 'NIO',
        exchangeRate: 1,
        shippingAmount: 0,
        account: 'caja',
        note: 'Compra no enviada',
        lines: [
          {
            productId: product,
            location: 'store',
            quantity: 2,
            unitPrice: 100,
          },
        ],
      },
    ],
    [
      'inventory-movement',
      'record_inventory_movement',
      {
        productId: product,
        location: 'store',
        type: 'EXIT',
        quantity: 2,
        note: 'Salida no enviada',
      },
    ],
    [
      'finance-entry',
      'record_finance_entry',
      {
        occurredOn: today,
        kind: 'capital',
        account: 'caja',
        amount: 100,
        currency: 'NIO',
        exchangeRate: 1,
        counterparty: 'Capital QA',
        description: 'Fondos no enviados',
        reference: 'RETIRE',
      },
    ],
    [
      'expense',
      'record_expense',
      {
        incurredOn: today,
        category: 'renta',
        description: 'Gasto no enviado',
        amount: 10,
        currency: 'NIO',
        exchangeRate: 1,
        reference: 'RETIRE',
        account: 'caja',
      },
    ],
    [
      'inventory-transfer',
      'transfer_inventory',
      {
        productId: product,
        fromLocation: 'store',
        toLocation: 'warehouse',
        quantity: 2,
        note: 'Traslado no enviado',
      },
    ],
    [
      'journal',
      'record_journal_entry',
      {
        occurredOn: today,
        kind: 'income',
        description: 'Comprobante no enviado',
        reference: 'RETIRE',
        currency: 'NIO',
        exchangeRate: 1,
        lines: [
          { account: '1110-001', debit: 10, credit: 0 },
          { account: '4110', debit: 0, credit: 10 },
        ],
      },
    ],
    ['price-tier-create', 'create_price_tier', { name: 'Lista no enviada' }],
    [
      'invoice',
      'create_document',
      {
        kind: 'invoice',
        customerId: customer,
        tier: 'emprendedor',
        currency: 'NIO',
        exchangeRate: 1,
        location: 'store',
        paymentMethod: 'cash',
        notes: '',
        items: [{ productId: product, quantity: 1 }],
      },
    ],
    [
      'proforma',
      'create_document',
      {
        kind: 'proforma',
        customerId: customer,
        tier: 'emprendedor',
        currency: 'NIO',
        exchangeRate: 1,
        validUntil: today,
        notes: '',
        items: [{ productId: product, quantity: 1 }],
      },
    ],
  ]
  for (const [kind, name, payload] of families) {
    const requestId = crypto.randomUUID()
    const before = await state()
    equal(await status(kind, requestId), { status: 'missing' })
    equal(await status(kind, requestId, true), { status: 'retired' })
    equal(
      await status(kind, requestId, true),
      { status: 'retired' },
      'retirada idempotente',
    )
    await rejects(
      call(name, { ...payload, requestId }),
      /solicitud fue descartada/,
    )
    equal(
      await state(),
      before,
      'un envío tardío se revierte completo: ' + kind,
    )
    const sent = await call(name, {
      ...payload,
      requestId: crypto.randomUUID(),
      ...(kind === 'proforma'
        ? {
            validUntil: (await db.query('select ($1::date+7)::text d', [today]))
              .rows[0].d,
          }
        : {}),
    })
    equal(!!sent, true, 'nueva operación legítima permitida: ' + kind)
    results.push({ kind, status: 'PASS' })
  }
  const saved = (
    await db.query(
      'select request_id,id from public.purchase_shipments limit 1',
    )
  ).rows[0]
  equal((await status('purchase', saved.request_id)).id, saved.id)
  equal(
    (await status('purchase', saved.request_id, true)).status,
    'confirmed',
    'retirar no borra un guardado existente',
  )
  await db.exec('reset role')
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Caja QA','operator')",
    [operator],
  )
  await identity(db, operator)
  await rejects(status('purchase', saved.request_id), /insufficient_privilege/)
  equal(await status('invoice', crypto.randomUUID()), { status: 'missing' })
  await identity(db, admin)
  const openingProduct = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'
  await db.exec('reset role')
  await db.query('delete from public.product_costs where product_id=$1', [
    openingProduct,
  ])
  await identity(db, admin)
  const openingRequest = crypto.randomUUID()
  equal(await status('opening-cost', openingRequest, true), {
    status: 'retired',
  })
  await rejects(
    call('set_opening_cost', {
      requestId: openingRequest,
      productId: openingProduct,
      unitCost: 100,
      currency: 'NIO',
      exchangeRate: 1,
      note: 'Costo inicial no enviado',
    }),
    /solicitud fue descartada/,
  )
  equal(
    (
      await db.query(
        'select count(*)::int n from public.product_costs where product_id=$1',
        [openingProduct],
      )
    ).rows[0].n,
    0,
  )
  const closeRequest = crypto.randomUUID()
  const day = (await db.query('select public.get_business_day(null) r')).rows[0]
    .r
  equal(await status('business-day-close', closeRequest, true), {
    status: 'retired',
  })
  await rejects(
    call('close_business_day', {
      requestId: closeRequest,
      day: today,
      countedNio: day.report.expectedNio,
      countedUsd: day.report.expectedUsd,
      note: '',
      expectedRevision: day.revision,
      expectedStateToken: day.stateToken,
    }),
    /solicitud fue descartada/,
  )
  equal(
    (await db.query('select public.get_business_day(null) r')).rows[0].r.status,
    'open',
    'un cierre tardío no congela la jornada',
  )
  const range = await seedJournalPages(fixture)
  const entries = []
  let asOf = null,
    total = null
  for (let offset = 0; ; offset += 100) {
    const page = (
      await db.query(
        'select public.journal_entries_page($1,$2,$3,100,$4::timestamptz,$5::int) r',
        [range.from, range.to, offset, asOf, total],
      )
    ).rows[0].r
    asOf = page.asOf
    total = page.total
    equal(page.offset, offset)
    equal(page.entries.length <= 100, true)
    entries.push(...page.entries)
    if (entries.length >= total) break
  }
  equal(entries.length, total)
  equal(
    new Set(entries.map((e) => e.id)).size,
    total,
    'ningún comprobante omitido o repetido',
  )
  equal(
    entries.filter((e) => e.automatic).length,
    730,
    'VE/CV completos, más de 500',
  )
  equal(entries.filter((e) => !e.automatic).length, total - 730)
  for (const entry of entries.filter((e) => e.automatic)) {
    equal(Array.isArray(entry.lines), true)
    equal(entry.missingCosts, 0)
    equal(entry.missingSales, 0)
  }
  await rejects(
    db.query('select public.journal_entries_page($1,$2,0,101)', [
      range.from,
      range.to,
    ]),
    /página.*inválidos/,
  )
  await rejects(
    db.query(
      'select public.journal_entries_page($1,$2,50,50,$3::timestamptz,$4::int)',
      [range.from, range.to, asOf, total + 1],
    ),
    /historial cambió/,
  )
  await identity(db, operator)
  await rejects(
    db.query('select public.journal_entries_page($1,$2)', [
      range.from,
      range.to,
    ]),
    /insufficient_privilege/,
  )
  await identity(db, admin)
  results.push({
    kind: 'pagination',
    total,
    automatic: 730,
    manual: total - 730,
    status: 'PASS',
  })
  console.log(
    `PASS recuperación y páginas: ${checks} comprobaciones, ${total} comprobantes sin truncar.`,
  )
} catch (error) {
  console.error({
    message: error.message,
    where: error.where,
    query: error.query,
  })
  process.exitCode = 1
} finally {
  await fixture.close()
  await writeFile(
    `${output}/resultados.json`,
    JSON.stringify({ checks, results }, null, 2),
  )
}

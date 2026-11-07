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
const eq = (a, b, m) => {
  assert.deepEqual(a, b, m)
  checks++
}
const reject = async (p, re) => {
  await assert.rejects(p, re)
  checks++
}
const one = async (s, args = []) => (await db.query(s, args)).rows[0]
const call = (name, input) =>
  rpc(db, name, { requestId: crypto.randomUUID(), ...input })
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
const day = '2026-11-06'
const line = (account, debit, credit, currency = 'NIO', exchangeRate = 1) => ({
  account,
  debit,
  credit,
  currency,
  exchangeRate,
})
const ledger = async () =>
  (await one('select public.ledger_report($1,$1) r', [day])).r
const balance = (l, code) =>
  l.accounts.find((a) => a.code === code)?.closing ?? 0
const stock = async () =>
  (
    await one(
      'select sum(quantity)::int q from public.inventory_balances where product_id=$1',
      [product],
    )
  ).q
const classify = (id, lines, extra = {}) => ({
  shipmentId: id,
  occurredOn: day,
  description: 'Clasificación de compra',
  reference: 'REC-QA',
  currency: 'NIO',
  exchangeRate: 1,
  lines,
  linkedPayments: [],
  ...extra,
})
try {
  eq(
    (
      await one("select private.ledger_account_restriction('2190') r")
    ).r.includes('retirada'),
    true,
    'la cuenta temporal está retirada',
  )
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select '2026-11-06T20:00:00Z'::timestamptz$$",
  )
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'SuperAdmin QA','superadmin'),($2,'Caja QA','operator'),($3,'Bodega QA','warehouse'),($4,'Consulta QA','viewer'),($5,'Admin QA','admin')",
    [admin, operator, warehouse, viewer, outsider],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Prueba aislada');insert into public.brands(name) values('Marca QA')",
  )
  await db.query(
    "insert into public.products(id,sku,name,brand_id,size,unit) values($1,'QA-REC','Perfume QA',(select id from public.brands limit 1),100,'ml')",
    [product],
  )
  await db.query(
    "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',0),($1,'warehouse',0)",
    [product],
  )
  await db.query(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,0)',
    [product],
  )
  await identity(db, admin)
  await call('open_business_day', {
    expectedDay: day,
    openingNio: 20000,
    openingUsd: 1000,
  })
  await call('record_journal_entry', {
    occurredOn: day,
    kind: 'opening',
    description: 'Saldos iniciales QA',
    reference: 'QA',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1110-001', debit: 20000, credit: 0 },
      { account: '1120-001', debit: 20000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 40000 },
    ],
  })
  const before = await ledger()
  const receiptInput = {
    requestId: crypto.randomUUID(),
    incurredOn: day,
    supplier: 'Proveedor QA',
    agency: '',
    reference: 'REC-QA',
    note: 'Recepción',
    currency: 'NIO',
    exchangeRate: 1,
    account: 'pending',
    shippingAmount: 0,
    lines: [
      { productId: product, location: 'store', quantity: 10, unitPrice: 100 },
    ],
  }
  const receipt = await rpc(db, 'record_shipment', receiptInput)
  eq(
    await rpc(db, 'record_shipment', receiptInput),
    receipt,
    'reintentar no duplica recepción',
  )
  eq(await stock(), 10)
  let book = await ledger()
  eq(
    balance(book, '1110-001'),
    balance(before, '1110-001'),
    'recepción no descuenta efectivo',
  )
  eq(
    balance(book, '1120-001'),
    balance(before, '1120-001'),
    'recepción no descuenta banco',
  )
  eq(
    balance(book, '1130') - balance(before, '1130'),
    0,
    'la recepción preparada no duplica el cargo al mayor',
  )
  eq(balance(book, '2190') - balance(before, '2190'), 0)
  let credits = (await one('select public.credit_accounts($1) r', [day])).r
  eq(
    credits.rows.filter((r) => r.shipmentId === receipt).length,
    0,
    'pendiente no es deuda de proveedor',
  )
  const input = {
    requestId: crypto.randomUUID(),
    ...classify(receipt, [
      line('1130', 1000, 0),
      line('1120-001', 0, 400),
      line('1110-001', 0, 200),
      line('2111', 0, 400),
    ]),
  }
  const classified = await rpc(db, 'classify_purchase', input)
  eq(
    (await rpc(db, 'classify_purchase', input)).id,
    classified.id,
    'clasificación idempotente',
  )
  eq(await stock(), 10, 'clasificar no recibe unidades de nuevo')
  book = await ledger()
  eq(balance(book, '2190'), 0)
  eq(balance(book, '1120-001'), 19600)
  eq(balance(book, '1110-001'), 19800)
  credits = (await one('select public.credit_accounts($1) r', [day])).r
  const debt = credits.rows.find((r) => r.shipmentId === receipt)
  eq(debt.originalNio, 400)
  eq(debt.balanceNio, 400)
  eq(
    credits.unallocatedNio.payables,
    0,
    'clasificación no duplica saldo inicial de deuda',
  )
  const paymentId = await call('record_finance_entry', {
    occurredOn: day,
    kind: 'supplier_payment',
    account: 'banco',
    toAccount: null,
    bankLedgerAccount: '1120-001',
    amount: 150,
    currency: 'NIO',
    exchangeRate: 1,
    counterparty: '',
    description: 'Abono',
    reference: 'AB-QA',
    shipmentId: receipt,
  })
  credits = (await one('select public.credit_accounts($1) r', [day])).r
  eq(credits.rows.find((r) => r.shipmentId === receipt).balanceNio, 250)
  await reject(
    call('record_finance_entry', {
      occurredOn: day,
      kind: 'supplier_payment',
      account: 'caja',
      toAccount: null,
      amount: 251,
      currency: 'NIO',
      exchangeRate: 1,
      counterparty: '',
      description: 'Exceso',
      reference: '',
      shipmentId: receipt,
    }),
    /supera/,
  )
  const edit = {
    requestId: crypto.randomUUID(),
    entryId: classified.id,
    expectedRevision: 0,
    occurredOn: day,
    description: 'Compra corregida',
    reference: 'REC-CORR',
    lines: [
      line('1130', 1000, 0),
      line('1120-001', 0, 500),
      line('1110-001', 0, 100),
      line('2111', 0, 400),
    ],
  }
  const updated = await rpc(db, 'correct_journal_entry', edit)
  eq(updated.id, classified.id)
  eq(updated.number, classified.number)
  eq(updated.revision, 1)
  eq((await rpc(db, 'correct_journal_entry', edit)).revision, 1)
  eq(await stock(), 10)
  const detail = (
    await one('select public.get_journal_entry($1) r', [classified.id])
  ).r
  eq(detail.editHistory.length, 1)
  eq(detail.editHistory[0].before.reference, 'REC-QA')
  await reject(
    call('correct_journal_entry', { ...edit, requestId: crypto.randomUUID() }),
    /cambió/,
  )
  await reject(
    call('correct_journal_entry', {
      ...edit,
      requestId: crypto.randomUUID(),
      expectedRevision: 1,
      lines: [line('1130', 1000, 0), line('1120-001', 0, 1000)],
    }),
    /abonos/,
  )
  for (const user of [operator, warehouse, viewer, outsider]) {
    await identity(db, user)
    await reject(
      call('correct_journal_entry', {
        ...edit,
        requestId: crypto.randomUUID(),
        expectedRevision: 1,
      }),
      /privilege|permission|42501/,
    )
  }
  await identity(db, admin)
  const mixedInput = {
    occurredOn: day,
    kind: 'transfer',
    description: 'Compra de dólares',
    reference: 'CAMBIO-QA',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [line('1120-002', 100, 0, 'USD', 35.85), line('1120-001', 0, 3585)],
  }
  const mixed = await call('record_journal_entry', mixedInput)
  const mixedDetail = (
    await one('select public.get_journal_entry($1) r', [mixed])
  ).r
  eq(
    mixedDetail.lines.map((l) => [
      l.currency,
      l.exchange_rate,
      l.debit_nio,
      l.credit_nio,
    ]),
    [
      ['USD', 35.85, 3585, 0],
      ['NIO', 1, 0, 3585],
    ],
  )
  await reject(
    call('record_journal_entry', {
      ...mixedInput,
      lines: [
        line('1120-002', 100, 0, 'USD', 35.85),
        line('1120-001', 0, 3700),
      ],
    }),
    /coincidir/,
  )
  await reject(
    call('record_journal_entry', {
      ...mixedInput,
      lines: [
        line('1120-001', 100, 0, 'USD', 35.85),
        line('1120-003', 0, 3585),
      ],
    }),
    /moneda/,
  )
  await reject(
    call('record_journal_entry', {
      ...mixedInput,
      lines: [line('1120-002', 100, 0, 'USD', 0), line('1120-001', 0, 3585)],
    }),
    /cambio/,
  )
  const gain = await call('record_journal_entry', {
    ...mixedInput,
    reference: 'DIF-QA',
    lines: [
      line('1120-002', 100, 0, 'USD', 37),
      line('1120-001', 0, 3585),
      line('4190', 0, 115),
    ],
  })
  eq(
    (await one('select public.get_journal_entry($1) r', [gain])).r.lines.length,
    3,
    'diferencia clasificada expresamente por el contador',
  )
  await call('record_inventory_movement', {
    productId: product,
    location: 'store',
    type: 'EXIT',
    quantity: 2,
    expectedQuantity: 10,
    note: 'Salida posterior a la compra',
    reference: 'SAL-QA',
  })
  const revisionInput = {
    requestId: crypto.randomUUID(),
    shipmentId: receipt,
    expectedRevision: 0,
    incurredOn: day,
    supplier: 'Proveedor corregido',
    reference: 'REC-CORREGIDA',
    note: 'Corrección con operaciones posteriores',
    currency: 'NIO',
    exchangeRate: 1,
    shippingAmount: 0,
    counterpart: '1130',
    costAccount: '5150',
    lines: [
      { productId: product, location: 'store', quantity: 10, unitPrice: 120 },
    ],
    impacts: [
      {
        productId: product,
        expectedStore: 8,
        expectedWarehouse: 0,
        expectedValueNio: 800,
        targetValueNio: 960,
      },
    ],
  }
  const revised = await rpc(db, 'revise_purchase_receipt', revisionInput)
  eq((await rpc(db, 'revise_purchase_receipt', revisionInput)).id, revised.id)
  eq(await stock(), 8, 'corregir costo no duplica las unidades originales')
  eq(
    (
      await one(
        'select average_cost_nio::numeric a from public.product_costs where product_id=$1',
        [product],
      )
    ).a,
    '120.000000',
  )
  book = await ledger()
  eq(
    balance(book, '1130'),
    760,
    'la diferencia de compra espera revisión de la contrapartida',
  )
  eq(
    balance(book, '5150'),
    240,
    'la parte consumida queda en la cuenta elegida',
  )
  eq(
    balance(book, '2190'),
    0,
    'la corrección no vuelve a usar la cuenta retirada',
  )
  const digest = (await one('select public.report_digest($1,$1) r', [day])).r
  eq(
    digest.ledger.inventoryWriteOffNio,
    240,
    'los resúmenes reconocen el costo corregido',
  )
  eq(digest.ledger.months[0].inventoryWriteOffNio, 240)
  const context = (
    await one('select public.receipt_edit_context($1) r', [receipt])
  ).r
  eq(context.receipt.goods_amount, 1200)
  eq(context.history.length, 1)
  const revision2 = {
    ...revisionInput,
    requestId: crypto.randomUUID(),
    expectedRevision: 1,
    lines: [
      { productId: product, location: 'store', quantity: 11, unitPrice: 120 },
    ],
    impacts: [
      {
        productId: product,
        expectedStore: 8,
        expectedWarehouse: 0,
        expectedValueNio: 960,
        targetValueNio: 1080,
      },
    ],
  }
  await rpc(db, 'revise_purchase_receipt', revision2)
  eq(await stock(), 9, 'solo se suma la unidad corregida')
  eq(
    (
      await one(
        'select average_cost_nio::numeric a from public.product_costs where product_id=$1',
        [product],
      )
    ).a,
    '120.000000',
  )
  eq(
    (await one("select public.purchase_accounting_rows('pending',null,null) r"))
      .r[0].goods_amount,
    1320,
  )
  const currentEntry = (
    await one('select public.get_journal_entry($1) r', [classified.id])
  ).r
  await call('correct_journal_entry', {
    entryId: classified.id,
    expectedRevision: currentEntry.revision,
    occurredOn: day,
    description: 'Clasificación completada tras corrección',
    reference: 'REC-CORREGIDA',
    lines: [
      line('1130', 1320, 0),
      line('1120-001', 0, 820),
      line('1110-001', 0, 100),
      line('2111', 0, 400),
    ],
  })
  eq(balance(await ledger(), '2190'), 0)
  const paymentEdit = {
    requestId: crypto.randomUUID(),
    entryId: paymentId,
    expectedRevision: 0,
    occurredOn: day,
    kind: 'supplier_payment',
    account: 'caja',
    toAccount: null,
    amount: 180,
    currency: 'NIO',
    exchangeRate: 1,
    counterparty: 'Proveedor corregido',
    description: 'Abono corregido',
    reference: 'AB-CORREGIDO',
    shipmentId: receipt,
    documentId: null,
  }
  const paymentUpdated = await rpc(db, 'correct_finance_entry', paymentEdit)
  eq(paymentUpdated.id, paymentId)
  eq(paymentUpdated.amount, 180)
  eq(paymentUpdated.revision, 1)
  eq((await rpc(db, 'correct_finance_entry', paymentEdit)).revision, 1)
  eq(
    (await one('select public.credit_accounts($1) r', [day])).r.rows.find(
      (r) => r.shipmentId === receipt,
    ).balanceNio,
    220,
  )
  eq(
    (await one('select public.finance_correction_context($1) r', [paymentId])).r
      .history.length,
    1,
  )
  await reject(
    call('correct_finance_entry', {
      ...paymentEdit,
      requestId: crypto.randomUUID(),
      expectedRevision: 1,
      amount: 401,
    }),
    /supera/,
  )
  eq(
    (await one('select public.finance_correction_context($1) r', [paymentId])).r
      .entry.amount,
    180,
    'una edición inválida se revierte completa',
  )
  const draftId = crypto.randomUUID()
  const draftInput = {
    requestId: crypto.randomUUID(),
    draftId,
    expectedRevision: -1,
    data: {
      date: day,
      kind: 'adjustment',
      description: 'Borrador incompleto',
      reference: 'QA-DRAFT',
      lines: [line('1120-002', 100, 0, 'USD', 35.85)],
    },
  }
  const savedDraft = await rpc(db, 'save_accounting_draft', draftInput)
  eq(savedDraft.revision, 0)
  eq((await rpc(db, 'save_accounting_draft', draftInput)).id, draftId)
  eq((await one('select public.accounting_drafts(0) r')).r.length, 1)
  const bookBeforeDraftPost = await ledger()
  const draftPosted = await call('record_journal_entry', {
    ...mixedInput,
    description: 'Borrador completado',
    draftId,
    draftRevision: 0,
  })
  eq(
    (await one('select public.accounting_drafts(0) r')).r.length,
    0,
    'contabilizar retira el borrador en la misma transacción',
  )
  const bookAfterDraftPost = await ledger()
  eq(
    balance(bookAfterDraftPost, '1120-002') -
      balance(bookBeforeDraftPost, '1120-002'),
    3585,
  )
  await reject(
    call('record_journal_entry', {
      ...mixedInput,
      description: 'Doble pestaña del borrador',
      draftId,
      draftRevision: 0,
    }),
    /borrador cambió/,
  )
  eq(
    balance(await ledger(), '1120-002'),
    balance(bookAfterDraftPost, '1120-002'),
    'la doble pestaña no duplica el asiento',
  )
  eq(typeof draftPosted, 'string')
  const recovery = (
    await one('select public.get_operation_confirmation($1,$2) r', [
      'receipt-revision',
      revisionInput.requestId,
    ])
  ).r
  eq(recovery.status, 'confirmed')
  eq(
    (
      await one('select public.get_operation_confirmation($1,$2) r', [
        'finance-correction',
        paymentEdit.requestId,
      ])
    ).r.status,
    'confirmed',
  )
  const retired = crypto.randomUUID()
  eq(
    (
      await one('select public.retire_unconfirmed_operation($1,$2) r', [
        'receipt-revision',
        retired,
      ])
    ).r.status,
    'retired',
  )
  await reject(
    rpc(db, 'revise_purchase_receipt', {
      ...revision2,
      requestId: retired,
      expectedRevision: 2,
    }),
    /retirada|retired|retiró|descartada/,
  )
  const revisionEvents = (
    await one('select public.purchase_report_events($1,$1,0,500) r', [day])
  ).r
  eq(revisionEvents.rows.filter((r) => r.event_kind === 'correction').length, 2)
  eq(
    revisionEvents.rows.reduce(
      (s, r) => s + Number(r.goods_nio) + Number(r.shipping_nio),
      0,
    ),
    1320,
    'el informe suma compra original y diferencias, sin duplicarlas',
  )
  const reversibleReceipt = await rpc(db, 'record_shipment', {
    ...receiptInput,
    requestId: crypto.randomUUID(),
    reference: 'REC-REABRIR',
    lines: [
      { productId: product, location: 'store', quantity: 1, unitPrice: 10 },
    ],
  })
  const reversibleEntry = await call(
    'classify_purchase',
    classify(reversibleReceipt, [line('1130', 10, 0), line('1110-001', 0, 10)]),
  )
  await one('select public.void_journal_entry($1,$2)', [
    reversibleEntry.id,
    'Se necesita corregir la clasificación',
  ])
  eq(
    (
      await one("select public.purchase_accounting_rows('pending',null,null) r")
    ).r.find((r) => r.id === reversibleReceipt).classified,
    false,
  )
  const reopenedClassification = await call(
    'classify_purchase',
    classify(
      reversibleReceipt,
      [line('1130', 10, 0), line('1110-001', 0, 10)],
      { entryId: reversibleEntry.id },
    ),
  )
  eq(
    reopenedClassification.id !== reversibleEntry.id,
    true,
    'reclasificar conserva el comprobante anterior anulado',
  )
  eq(balance(await ledger(), '2190'), 0)
  const dayState = (await one('select public.get_business_day($1) r', [day])).r
  await call('close_business_day', {
    day,
    expectedRevision: dayState.revision,
    expectedStateToken: dayState.stateToken,
    countedNio: dayState.report.expectedNio,
    countedUsd: dayState.report.expectedUsd,
    note: '',
  })
  await call('correct_journal_entry', {
    entryId: mixed,
    expectedRevision: 0,
    occurredOn: day,
    description: 'Corrección posterior al cierre',
    reference: 'CAMBIO-CORR',
    lines: [line('1120-002', 100, 0, 'USD', 36), line('1120-001', 0, 3600)],
  })
  eq(
    (await one('select public.get_journal_entry($1) r', [mixed])).r.revision,
    1,
    'SuperAdmin puede corregir comprobante cerrado con historial',
  )
  await call('correct_finance_entry', {
    ...paymentEdit,
    requestId: crypto.randomUUID(),
    expectedRevision: 1,
    amount: 190,
  })
  eq(
    (await one('select public.finance_correction_context($1) r', [paymentId])).r
      .entry.amount,
    190,
    'puede corregir el abono de una jornada cerrada con historial',
  )
  console.log(
    `PASS ${checks} comprobaciones de recepciones, clasificación, edición y monedas`,
  )
} finally {
  await db.close()
}

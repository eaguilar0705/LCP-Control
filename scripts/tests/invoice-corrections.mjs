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
const reject = async (fn, pattern) => {
  await assert.rejects(fn, pattern)
  checks++
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const call = (name, input) => rpc(db, name, input)
const p1 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  p2 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'
const detail = async (id) =>
  (await one('select public.invoice_edit_detail($1) r', [id])).r
const day = async (date) =>
  (await one('select public.get_business_day($1) r', [date ?? null])).r
const ledger = async () =>
  (await one("select public.ledger_report('2026-11-02','2026-11-03') r")).r
const stock = async (id) =>
  (
    await db.query(
      'select location,quantity from public.inventory_balances where product_id=$1 order by location',
      [id],
    )
  ).rows
const cost = async (id) =>
  Number(
    (
      await one(
        'select sum(total_cost_nio)::numeric total from public.document_item_costs where document_id=$1',
        [id],
      )
    ).total,
  )
const edit = (d, overrides = {}) => ({
  requestId: crypto.randomUUID(),
  documentId: d.id,
  expectedRevision: d.revision,
  customerId: d.customer_id,
  customerName: d.customer_name,
  customerPhone: d.customer_phone,
  customerTaxId: d.customer_tax_id ?? '',
  tier: d.tier_code,
  currency: d.currency,
  exchangeRate: d.costs[0]?.exchange_rate ?? 1,
  location: d.location,
  paymentMethod: d.payment_method,
  notes: d.notes,
  invoiceDiscount: d.invoice_discount ?? 0,
  shippingMethod: d.shipping_method ?? null,
  shippingAmount: d.shipping_amount ?? 0,
  items: d.items.map((i) => ({
    productId: i.product_id,
    quantity: i.quantity,
    unitPrice: i.original_unit_price ?? i.unit_price,
    finalUnitPrice: i.unit_price,
  })),
  ...overrides,
})
try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.invoice_edit_now')::timestamptz$$",
  )
  await db.query(
    "select set_config('lcp.invoice_edit_now','2026-11-02T15:00:00Z',false)",
  )
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Admin','admin'),($2,'Caja','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer'),($5,'Propietario','superadmin')",
    [admin, operator, warehouse, viewer, outsider],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Tienda de auditoría'); insert into public.exchange_rates(id,usd_to_nio) values(true,37) on conflict(id) do update set usd_to_nio=37; insert into public.brands(name) values('Marca');",
  )
  await db.query(
    "insert into public.products(id,sku,name,brand_id) values($1,'QA-001','Perfume 1',(select id from public.brands limit 1)),($2,'QA-002','Perfume 2',(select id from public.brands limit 1))",
    [p1, p2],
  )
  await db.exec(
    "insert into public.inventory_balances(product_id,location,quantity) select id,l,case when l='store' then 20 else 10 end from public.products cross join unnest(array['store','warehouse'])l; insert into public.product_costs(product_id,average_cost_nio) select id,100 from public.products; insert into public.product_prices(product_id,tier_code,currency,amount) select id,'emprendedor',c,case when c='NIO' then 370 else 10 end from public.products cross join unnest(array['NIO','USD'])c;",
  )
  await identity(db, outsider)
  await call('record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: '2026-11-02',
    description: 'Apertura aislada',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1110-001', debit: 10000, credit: 0 },
      { account: '1130', debit: 6000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 16000 },
    ],
  })
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    expectedDay: '2026-11-02',
    openingNio: 1000,
    openingUsd: 0,
  })
  const originalRequest = {
    requestId: crypto.randomUUID(),
    kind: 'invoice',
    customerName: 'Cliente original',
    customerPhone: '88887777',
    tier: 'emprendedor',
    currency: 'USD',
    exchangeRate: 37,
    location: 'store',
    paymentMethod: 'pending',
    notes: 'Original',
    items: [{ productId: p1, quantity: 3 }],
  }
  const invoice = await call('create_document', originalRequest)
  let d = (await detail(invoice.id)).document
  eq(d.revision, 0)
  eq(await cost(d.id), 300)
  for (const uid of [admin, operator, warehouse, viewer]) {
    await identity(db, uid)
    await reject(call('correct_invoice', edit(d)), /permission|insufficient/i)
    await reject(
      db.query('select public.invoice_edit_detail($1)', [d.id]),
      /permission|insufficient/i,
    )
  }
  await identity(db, '', 'anon')
  await reject(call('correct_invoice', edit(d)), /permission/)
  await identity(db, outsider)
  for (const amount of [10, 20])
    await call('record_finance_entry', {
      requestId: crypto.randomUUID(),
      kind: 'collection',
      documentId: d.id,
      occurredOn: '2026-11-02',
      amount,
      currency: 'USD',
      exchangeRate: 37,
      account: 'banco',
      bankLedgerAccount: '1120-004',
      counterparty: 'Cliente original',
      description: 'Pago real recibido',
      reference: invoice.number,
    })
  const beforeStock = await stock(p1),
    beforeCosts = d.costs
  const paymentFix = edit(d, { paymentMethod: 'lafise_usd' })
  d = await call('correct_invoice', paymentFix)
  eq(d.id, invoice.id)
  eq(d.number, invoice.number)
  eq(d.created_at, invoice.created_at)
  eq(d.revision, 1)
  eq(d.payment_method, 'lafise_usd')
  eq(await stock(p1), beforeStock, 'cambiar el pago no mueve unidades')
  eq(d.costs, beforeCosts, 'cambiar el pago no recalcula los costos históricos')
  eq(
    (
      await one(
        'select count(*) n from public.finance_entries where document_id=$1 and voided_at is null',
        [d.id],
      )
    ).n,
    0,
  )
  eq(
    (await ledger()).accounts.find((a) => a.code === '1120-004').closing,
    1110,
    'el banco recibe el importe una sola vez',
  )
  eq((await ledger()).accounts.find((a) => a.code === '1140').closing, 0)
  eq((await detail(d.id)).history.length, 1)
  eq(
    (await detail(d.id)).history[0].before.collections.filter(
      (c) => !c.voided_at,
    ).length,
    2,
  )
  eq(await call('correct_invoice', paymentFix), d)
  eq((await detail(d.id)).history.length, 1)
  await reject(
    call('correct_invoice', { ...paymentFix, notes: 'Solicitud modificada' }),
    /solicitud.*cambió/,
  )
  await reject(
    call('correct_invoice', edit(d, { expectedRevision: 0 })),
    /factura cambió/,
  )
  await reject(call('correct_invoice', edit(d)), /No hay cambios/)
  eq(
    (
      await one('select public.get_operation_confirmation($1,$2) r', [
        'invoice-correction',
        paymentFix.requestId,
      ])
    ).r.status,
    'confirmed',
  )
  const retired = edit(d, { notes: 'No debe guardarse' })
  eq(
    (
      await one('select public.retire_unconfirmed_operation($1,$2) r', [
        'invoice-correction',
        retired.requestId,
      ])
    ).r.status,
    'retired',
  )
  await reject(call('correct_invoice', retired), /descartada/)
  eq((await detail(d.id)).document.revision, 1)
  await call('record_shipment', {
    requestId: crypto.randomUUID(),
    incurredOn: '2026-11-02',
    supplier: 'Proveedor',
    agency: '',
    reference: 'Compra posterior',
    note: 'Compra real posterior',
    currency: 'NIO',
    exchangeRate: 1,
    shippingAmount: 0,
    account: 'caja',
    lines: [{ productId: p1, location: 'store', quantity: 10, unitPrice: 500 }],
  })
  const oldCost = await cost(d.id)
  d = await call(
    'correct_invoice',
    edit(d, { notes: 'Cambiar una nota después de una compra' }),
  )
  eq(await cost(d.id), oldCost, 'editar una nota no usa el nuevo promedio')
  d = await call(
    'correct_invoice',
    edit(d, { items: [{ productId: p1, quantity: 4, unitPrice: 12 }] }),
  )
  eq((await stock(p1)).find((r) => r.location === 'store').quantity, 26)
  eq(await cost(d.id), 508.11, 'sólo la unidad adicional consume costo actual')
  d = await call(
    'correct_invoice',
    edit(d, { items: [{ productId: p1, quantity: 2, unitPrice: 12 }] }),
  )
  eq((await stock(p1)).find((r) => r.location === 'store').quantity, 28)
  eq(
    await cost(d.id),
    254.06,
    'las unidades retiradas devuelven su costo histórico exacto',
  )
  d = await call(
    'correct_invoice',
    edit(d, {
      customerName: 'Cliente corregido',
      customerPhone: '88887777',
      customerTaxId: 'RUC-CORREGIDO',
      currency: 'NIO',
      exchangeRate: 1,
      paymentMethod: 'bac_nio',
      shippingMethod: 'moto',
      shippingAmount: 80,
      invoiceDiscount: 20,
      items: [
        { productId: p1, quantity: 2, unitPrice: 400 },
        { productId: p2, quantity: 2, unitPrice: 200 },
      ],
    }),
  )
  eq(d.total, 1260)
  eq(d.customer_name, 'Cliente corregido')
  eq(d.customer_tax_id, 'RUC-CORREGIDO')
  eq(d.items.length, 2)
  eq(d.number, invoice.number)
  eq((await ledger()).accounts.find((a) => a.code === '1120-001').closing, 1260)
  eq((await ledger()).accounts.find((a) => a.code === '2117').closing, -80)
  const stableState = {
    stock1: await stock(p1),
    stock2: await stock(p2),
    cost: await cost(d.id),
    revision: d.revision,
  }
  for (const changes of [
    { items: [{ productId: p1, quantity: 9999, unitPrice: 400 }] },
    { items: [{ productId: p1, quantity: 1.5, unitPrice: 400 }] },
    { items: [{ productId: p1, quantity: 1, unitPrice: 0 }] },
    {
      items: [
        { productId: p1, quantity: 1, unitPrice: 400 },
        { productId: p1, quantity: 2, unitPrice: 400 },
      ],
    },
    { invoiceDiscount: 999999 },
    { shippingMethod: null, shippingAmount: 80 },
    { paymentMethod: 'bac_usd' },
  ])
    await reject(
      call('correct_invoice', edit(d, changes)),
      /existencias|cantidad|precio|repitas|descuento|envío|moneda/i,
    )
  eq(
    {
      stock1: await stock(p1),
      stock2: await stock(p2),
      cost: await cost(d.id),
      revision: (await detail(d.id)).document.revision,
    },
    stableState,
    'cada error revierte toda la edición',
  )
  const closing = await day()
  const closed = await call('close_business_day', {
    requestId: crypto.randomUUID(),
    day: closing.day,
    expectedRevision: closing.revision,
    expectedStateToken: closing.stateToken,
    countedNio: 0,
    countedUsd: 0,
    note: 'Conteo físico de auditoría con diferencia',
  })
  const closedHistory = (
    await one('select public.get_business_day_history($1) r', [closed.day])
  ).r
  await db.query(
    "select set_config('lcp.invoice_edit_now','2026-11-03T15:00:00Z',false)",
  )
  await reject(
    call('correct_invoice', edit(d, { notes: 'Tienda sin abrir' })),
    /Abre la tienda/,
  )
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    expectedDay: '2026-11-03',
    openingNio: 500,
    openingUsd: 0,
  })
  d = await call(
    'correct_invoice',
    edit(d, {
      paymentMethod: 'lafise_nio',
      notes: 'Corrección de banco del día anterior',
    }),
  )
  const correctedDay = await day(closed.day)
  eq(correctedDay.status, 'closed')
  eq(correctedDay.closedAt, closed.closedAt)
  eq(correctedDay.report.countedNio, closed.report.countedNio)
  eq(correctedDay.revision, closed.revision + 1)
  const nextHistory = (
    await one('select public.get_business_day_history($1) r', [closed.day])
  ).r
  eq(nextHistory[0].event, 'invoice_corrected')
  eq(nextHistory[1], closedHistory[0], 'se conserva el cierre original')
  eq((await day()).openingNio, 500)
  eq((await ledger()).accounts.find((a) => a.code === '1120-001').closing, 0)
  eq((await ledger()).accounts.find((a) => a.code === '1120-003').closing, 1260)
  const fresh = await call('create_document', {
    ...originalRequest,
    requestId: crypto.randomUUID(),
    currency: 'NIO',
    exchangeRate: 1,
    paymentMethod: 'cash',
    items: [{ productId: p2, quantity: 1 }],
  })
  const freshOriginal = (await detail(fresh.id)).document
  const freshEdit = await call(
    'correct_invoice',
    edit(freshOriginal, { notes: 'Factura corregida para probar anulación' }),
  )
  await db.query('select public.delete_invoice($1,$2)', [
    fresh.id,
    'Anulación de prueba aislada',
  ])
  eq(
    (
      await one('select count(*) n from public.documents where id=$1', [
        fresh.id,
      ])
    ).n,
    0,
  )
  await db.exec('reset role')
  eq(
    (
      await one(
        'select count(*) n from private.invoice_corrections where document_id=$1',
        [freshEdit.id],
      )
    ).n,
    1,
    'el historial sobrevive a la eliminación',
  )
  await identity(db, outsider)
  const splitOriginal = await call('create_document', {
    ...originalRequest,
    requestId: crypto.randomUUID(),
    currency: 'NIO',
    exchangeRate: 1,
    paymentMethod: 'cash',
    items: [{ productId: p2, quantity: 2 }],
    payments: [
      { method: 'cash', currency: 'NIO', amount: 370, exchangeRate: 1 },
      { method: 'bac_nio', currency: 'NIO', amount: 370, exchangeRate: 1 },
    ],
  })
  let split = (await detail(splitOriginal.id)).document
  const originalPayload = (
    await one('select request_payload from public.documents where id=$1', [
      split.id,
    ])
  ).request_payload
  split = await call(
    'correct_invoice',
    edit(split, {
      paymentMethod: 'bac_nio',
      payments: [
        { method: 'bac_nio', currency: 'NIO', amount: 370, exchangeRate: 1 },
        { method: 'cash', currency: 'USD', amount: 10, exchangeRate: 37 },
      ],
    }),
  )
  eq(split.payments.length, 2, 'se guardan ambos pagos de la corrección')
  eq(
    split.payments.reduce((sum, p) => sum + Number(p.amount_nio), 0),
    740,
  )
  eq(
    split.corrected_terms.payments.length,
    2,
    'el historial normal recibe los pagos nuevos',
  )
  eq(
    (
      await one('select request_payload from public.documents where id=$1', [
        split.id,
      ])
    ).request_payload,
    originalPayload,
    'los reintentos de emisión conservan su solicitud original',
  )
  await reject(
    call(
      'correct_invoice',
      edit(split, {
        paymentMethod: 'cash',
        payments: [
          { method: 'cash', currency: 'NIO', amount: 10, exchangeRate: 1 },
          { method: 'cash', currency: 'NIO', amount: 10, exchangeRate: 1 },
        ],
      }),
    ),
    /completar exactamente/,
  )
  await reject(
    call('correct_invoice', edit(split, { payments: { amount: 740 } })),
    /Revisa los pagos/,
  )
  await reject(
    call(
      'correct_invoice',
      edit(split, {
        payments: [
          { method: 'cash', currency: 'NIO', amount: 740, exchangeRate: 1 },
        ],
      }),
    ),
    /entre 2 y 10/,
  )
  eq(
    (await detail(split.id)).document.revision,
    1,
    'pagos inválidos no cambian la revisión',
  )
  split = await call(
    'correct_invoice',
    edit(split, {
      currency: 'USD',
      exchangeRate: 40,
      paymentMethod: 'lafise_usd',
      payments: [
        { method: 'lafise_usd', currency: 'USD', amount: 10, exchangeRate: 40 },
        { method: 'cash', currency: 'NIO', amount: 400, exchangeRate: 1 },
      ],
      items: [{ productId: p2, quantity: 2, unitPrice: 10 }],
    }),
  )
  eq(split.total, 20)
  eq(split.corrected_terms.exchangeRate, 40)
  eq(split.catalog_rate, 40, 'el equivalente impreso usa la tasa corregida')
  eq(
    split.payments.reduce((sum, p) => sum + Number(p.amount_nio), 0),
    800,
    'los pagos usan la tasa corregida',
  )
  split = await call(
    'correct_invoice',
    edit(split, {
      paymentMethod: 'lafise_usd',
      notes: 'Un único pago nuevamente',
    }),
  )
  eq(split.payments.length, 0)
  eq(split.corrected_terms.payments, [])
  const replay = await call('create_document', originalPayload)
  eq(
    replay.corrected_terms.payments,
    [],
    'reintentar la emisión no restaura los pagos originales',
  )
  eq((await detail(split.id)).document.payments.length, 0)
  const splitStock = await stock(p2),
    splitCost = await cost(split.id)
  split = await call('correct_invoice', edit(split, { location: 'warehouse' }))
  eq(
    (await stock(p2)).find((r) => r.location === 'store').quantity,
    splitStock.find((r) => r.location === 'store').quantity + 2,
  )
  eq(
    (await stock(p2)).find((r) => r.location === 'warehouse').quantity,
    splitStock.find((r) => r.location === 'warehouse').quantity - 2,
  )
  eq(
    await cost(split.id),
    splitCost,
    'traslado de la factura conserva el valor correcto',
  )
  split = await call(
    'correct_invoice',
    edit(split, { items: [{ productId: p1, quantity: 1, unitPrice: 20 }] }),
  )
  eq(split.items[0].product_id, p1, 'se puede sustituir un perfume por otro')
  eq(
    (await stock(p2)).find((r) => r.location === 'warehouse').quantity,
    splitStock.find((r) => r.location === 'warehouse').quantity,
    'el perfume retirado vuelve a su ubicación',
  )
  await call('record_sales_return', {
    requestId: crypto.randomUUID(),
    documentId: split.id,
    reason: 'Devolución de auditoría',
    refundMethod: 'lafise_usd',
    items: [{ itemId: split.items[0].id, quantity: 1, restock: true }],
  })
  eq((await detail(split.id)).hasReturns, true)
  await reject(
    call(
      'correct_invoice',
      edit(split, { notes: 'No debe alterar una nota de crédito' }),
    ),
    /notas de crédito/,
  )
  const partialInvoice = await call('create_document', {
    ...originalRequest,
    requestId: crypto.randomUUID(),
    currency: 'NIO',
    exchangeRate: 1,
    items: [{ productId: p2, quantity: 2 }],
  })
  let partial = (await detail(partialInvoice.id)).document
  await call('record_finance_entry', {
    requestId: crypto.randomUUID(),
    kind: 'collection',
    documentId: partial.id,
    occurredOn: '2026-11-03',
    amount: 500,
    currency: 'NIO',
    exchangeRate: 1,
    account: 'banco',
    bankLedgerAccount: '1120-001',
    counterparty: 'Cliente',
    description: 'Abono parcial',
    reference: partial.number,
  })
  partial = await call(
    'correct_invoice',
    edit(partial, {
      notes: 'Conservar abono parcial',
      items: [{ productId: p2, quantity: 2, unitPrice: 400 }],
    }),
  )
  eq(partial.collections.filter((c) => !c.voided_at).length, 1)
  await reject(
    call(
      'correct_invoice',
      edit(partial, {
        items: [{ productId: p2, quantity: 1, unitPrice: 400 }],
      }),
    ),
    /menor que los abonos/,
  )
  const credits = (await one("select public.credit_accounts('2026-11-03') r")).r
  eq(
    credits.rows.find((r) => r.documentId === partial.id).balanceNio,
    300,
    'la cuenta por cobrar conserva únicamente el saldo real',
  )
  const oldCredit = await call('create_document', {
    ...originalRequest,
    requestId: crypto.randomUUID(),
    currency: 'NIO',
    exchangeRate: 1,
    items: [{ productId: p2, quantity: 1 }],
  })
  const oldCreditDocument = (await detail(oldCredit.id)).document
  const currentDay = await day('2026-11-03')
  await call('close_business_day', {
    requestId: crypto.randomUUID(),
    day: currentDay.day,
    expectedRevision: currentDay.revision,
    expectedStateToken: currentDay.stateToken,
    countedNio: 0,
    countedUsd: 0,
    note: 'Auditoría de otro día',
  })
  await db.query(
    "select set_config('lcp.invoice_edit_now','2026-11-04T15:00:00Z',false)",
  )
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    expectedDay: '2026-11-04',
    openingNio: 0,
    openingUsd: 0,
  })
  await call('record_finance_entry', {
    requestId: crypto.randomUUID(),
    kind: 'collection',
    documentId: oldCredit.id,
    occurredOn: '2026-11-04',
    amount: 370,
    currency: 'NIO',
    exchangeRate: 1,
    account: 'banco',
    bankLedgerAccount: '1120-001',
    counterparty: 'Cliente',
    description: 'Cobrado al día siguiente',
    reference: oldCredit.number,
  })
  await reject(
    call(
      'correct_invoice',
      edit(oldCreditDocument, { paymentMethod: 'bac_nio' }),
    ),
    /otras fechas/,
  )
  const retained = await call(
    'correct_invoice',
    edit(oldCreditDocument, { notes: 'Conserva la fecha del cobro' }),
  )
  eq(
    retained.collections.filter((c) => !c.voided_at)[0].occurred_on,
    '2026-11-04',
  )
  await identity(db, admin)
  await reject(
    db.query('select * from private.invoice_corrections'),
    /permission/,
  )
  await identity(db, outsider)
  const report = await ledger()
  const totals = report.accounts
    .filter((a) => a.postable)
    .reduce(
      (v, a) => ({ debit: v.debit + a.debit, credit: v.credit + a.credit }),
      { debit: 0, credit: 0 },
    )
  eq(Math.round(totals.debit * 100), Math.round(totals.credit * 100))
  eq(report.missingCosts, 0)
  eq(report.missingSales, 0)
  console.log(
    `PASS edición completa de facturas: ${checks} comprobaciones, abonos sin duplicar, inventario exacto, costos históricos, banco, cierres, permisos e historial`,
  )
} finally {
  await db.close()
}

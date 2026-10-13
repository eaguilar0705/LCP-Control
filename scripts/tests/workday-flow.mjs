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
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
let checks = 0
function equal(actual, expected, reason) {
  assert.equal(actual, expected, reason)
  checks++
}
async function rejects(work, pattern) {
  await assert.rejects(work, pattern)
  checks++
}
const call = (name, input) => rpc(db, name, input)
const get = async (sql, args = []) => (await db.query(sql, args)).rows[0]
try {
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Admin','superadmin'),($2,'Ventas','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer')",
    [admin, operator, warehouse, viewer],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Auditoría aislada'); insert into public.brands(name) values('Marca');",
  )
  for (const id of [product, other]) {
    await db.query(
      "insert into public.products(id,sku,name,brand_id) values($1,$2,'Perfume auditoría',(select id from public.brands limit 1))",
      [id, id === product ? 'QA-001' : 'QA-002'],
    )
    await db.query(
      "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',0),($1,'warehouse',0)",
      [id],
    )
    await db.query(
      "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',150),($1,'emprendedor','USD',10)",
      [id],
    )
  }
  const { today, yesterday } = await get(
    "select (now() at time zone 'America/Managua')::date::text today,((now() at time zone 'America/Managua')::date-1)::text yesterday",
  )
  const invoice = (
    paymentMethod = 'cash',
    quantity = 1,
    currency = 'NIO',
    changes = {},
  ) => ({
    requestId: crypto.randomUUID(),
    kind: 'invoice',
    customerName: 'Cliente auditoría',
    tier: 'emprendedor',
    currency,
    exchangeRate: currency === 'USD' ? 36.6 : 1,
    location: 'store',
    paymentMethod,
    notes: '',
    items: [{ productId: product, quantity }],
    ...changes,
  })
  const voucher = (kind, lines, changes = {}) => ({
    requestId: crypto.randomUUID(),
    kind,
    occurredOn: today,
    description: 'Auditoría',
    reference: 'QA',
    currency: 'NIO',
    exchangeRate: 1,
    lines,
    ...changes,
  })
  const movement = (type, quantity, changes = {}) => ({
    requestId: crypto.randomUUID(),
    productId: product,
    location: 'store',
    type,
    quantity,
    note: 'Auditoría',
    ...changes,
  })
  const finance = (kind, amount, changes = {}) => ({
    requestId: crypto.randomUUID(),
    occurredOn: today,
    kind,
    account: 'caja',
    amount,
    currency: 'NIO',
    exchangeRate: 1,
    description: 'Auditoría',
    reference: 'QA',
    ...changes,
  })
  const stock = async (id = product) =>
    (
      await db.query(
        'select location,quantity from public.inventory_balances where product_id=$1 order by location',
        [id],
      )
    ).rows
  const purchase = (unitPrice, account = 'credito', changes = {}) => ({
    requestId: crypto.randomUUID(),
    incurredOn: today,
    supplier: 'Proveedor auditoría',
    reference: 'COMPRA-QA',
    agency: '',
    note: '',
    currency: 'NIO',
    exchangeRate: 1,
    shippingAmount: 100,
    account,
    lines: [{ productId: product, quantity: 10, unitPrice, location: 'store' }],
    ...changes,
  })
  const credits = async () =>
    (await get('select public.credit_accounts($1) r', [today])).r
  const ledger = async () =>
    (await get('select public.ledger_report($1,$2) r', [yesterday, today])).r
  const day = async () =>
    (await get('select public.get_business_day(null) r')).r
  await identity(db, admin)
  await rejects(call('create_document', invoice()), /cerrada|insuficientes/)
  // Proforma while closed is harmless, including repeated submission.
  const quote = invoice('cash', 2, 'NIO', {
    kind: 'proforma',
    validUntil: today,
  })
  const q = await call('create_document', quote)
  equal((await call('create_document', quote)).id, q.id, 'proforma idempotente')
  equal((await stock())[0].quantity, 0, 'proforma sin salida')
  await call(
    'record_journal_entry',
    voucher(
      'opening',
      [
        { account: '1110-001', debit: 5000, credit: 0 },
        { account: '1110-002', debit: 3660, credit: 0 },
        { account: '1120-001', debit: 5000, credit: 0 },
        { account: '1140', debit: 200, credit: 0 },
        { account: '2111', debit: 0, credit: 100 },
        { account: '3110-001', debit: 0, credit: 13760 },
      ],
      { occurredOn: yesterday },
    ),
  )
  equal(
    (await credits()).rows.find((x) => x.id === 'opening:receivable')
      .balanceNio,
    200,
    'deuda inicial del libro disponible para cobro',
  )
  equal(
    (await credits()).rows.find((x) => x.id === 'opening:payable').balanceNio,
    100,
  )
  await call('record_expense', {
    requestId: crypto.randomUUID(),
    incurredOn: today,
    category: 'renta',
    description: 'Gasto antes de contar la caja',
    amount: 100,
    currency: 'NIO',
    exchangeRate: 1,
    account: 'caja',
    reference: 'PRE-APERTURA',
  })
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 4900,
    openingUsd: 100,
  })
  equal(
    (await day()).report.expectedNio,
    4900,
    'apertura física no descuenta dos veces un gasto previo',
  )
  const p1 = purchase(100, 'caja'),
    p2 = purchase(80)
  const p1id = await call('record_shipment', p1),
    p2id = await call('record_shipment', p2)
  equal(await call('record_shipment', p1), p1id, 'compra sin duplicado')
  equal(
    Number(
      (
        await get(
          'select average_cost_nio from public.product_costs where product_id=$1',
          [product],
        )
      ).average_cost_nio,
    ),
    100,
    'promedio 110 y 90',
  )
  equal((await stock())[0].quantity, 20)
  await identity(db, operator)
  const cashInput = invoice('cash', 2),
    cash = await call('create_document', cashInput)
  equal(
    (await call('create_document', cashInput)).id,
    cash.id,
    'venta sin duplicado',
  )
  await rejects(
    call('create_document', {
      ...cashInput,
      notes: 'Cambio en una solicitud ya emitida',
    }),
    /otros datos/,
  )
  const credit = await call('create_document', invoice('pending', 3))
  const pos = await call('create_document', invoice('card_pos'))
  await call('create_document', invoice('bac_nio'))
  await call('create_document', invoice('cash', 1, 'USD'))
  await rejects(
    call('create_document', invoice('cash', 999)),
    /existencias|disponible|suficiente/i,
  )
  equal(
    (await stock())[0].quantity,
    12,
    'sin stock negativo ni salida duplicada',
  )
  await identity(db, admin)
  const pay = finance('collection', 200, {
    documentId: credit.id,
    account: 'banco',
    bankLedgerAccount: '1120-003',
  })
  const paymentId = await call('record_finance_entry', pay)
  equal(await call('record_finance_entry', pay), paymentId)
  await rejects(
    call('record_finance_entry', { ...pay, amount: 199 }),
    /otros datos/,
  )
  equal(
    (await credits()).rows.find((x) => x.documentId === credit.id).balanceNio,
    250,
  )
  await rejects(
    call(
      'record_finance_entry',
      finance('collection', 251, { documentId: credit.id }),
    ),
    /supera/,
  )
  await rejects(
    db.query('select public.delete_invoice($1,$2)', [credit.id, 'Auditoría']),
    /abonos/,
  )
  await call(
    'record_finance_entry',
    finance('supplier_payment', 400, { shipmentId: p2id }),
  )
  equal(
    (await credits()).rows.find((x) => x.shipmentId === p2id).balanceNio,
    500,
  )
  await call('record_finance_entry', finance('collection', 50))
  equal(
    (await credits()).rows.find((x) => x.id === 'opening:receivable')
      .balanceNio,
    150,
  )
  await call('record_expense', {
    requestId: crypto.randomUUID(),
    incurredOn: today,
    category: 'renta',
    description: 'Alquiler auditoría',
    amount: 100,
    currency: 'NIO',
    exchangeRate: 1,
    account: 'caja',
    reference: 'QA',
  })
  const settlement = voucher(
    'card_settlement',
    [
      { account: '1120-001', debit: 141, credit: 0 },
      { account: '5140-001', debit: 6.75, credit: 0 },
      { account: '1340', debit: 2.25, credit: 0 },
      { account: '1142', debit: 0, credit: 150 },
    ],
    {
      gross: 150,
      commissionRate: 4.5,
      withholdingRate: 1.5,
      withholdingBase: 'gross',
      bankAccount: '1120-001',
    },
  )
  await call('record_journal_entry', settlement)
  await rejects(
    call('record_journal_entry', {
      ...settlement,
      requestId: crypto.randomUUID(),
    }),
    /tarjetas pendientes/,
  )
  await rejects(
    db.query('select public.delete_invoice($1,$2)', [
      pos.id,
      'Devolución después de liquidar',
    ]),
    /ya liquidadas/,
  )
  await call(
    'record_journal_entry',
    voucher('transfer', [
      { account: '1120-003', debit: 500, credit: 0 },
      { account: '1120-001', debit: 0, credit: 500 },
    ]),
  )
  await call('record_inventory_movement', movement('DAMAGED', 1))
  await call('record_inventory_movement', movement('ADJUSTMENT', 12))
  const l = await ledger(),
    a = (code) => l.accounts.find((x) => x.code === code)
  equal(a('1130').closing, 1200, 'activo coincide con 12 unidades por C$100')
  equal(a('5120').debit, 800, 'costo de 8 unidades vendidas')
  equal(a('5150').debit, 100, 'daño como pérdida')
  equal(a('4190').credit, 100, 'ganancia por conteo sin compra ficticia')
  equal(a('1140').closing, 400, '150 iniciales + 250 factura')
  equal(a('2111').closing, -600, '100 iniciales + 500 compra')
  equal(a('1142').closing, 0, 'POS liquidado')
  equal(a('1340').closing, 2.25, 'retención como activo')
  equal(a('1120-003').closing, 700, 'cobro en el banco específico')
  equal(a('1110-001').closing, 3650, 'caja contable')
  equal((await day()).report.expectedNio, 3650, 'caja diaria concilia')
  equal((await day()).report.expectedUsd, 110, 'dólares separados')
  equal(
    l.accounts.reduce((s, x) => s + x.debit - x.credit, 0),
    0,
    'debe igual haber',
  )
  // Independent bank-account checks roll back so the control-day totals stay fixed.
  for (const [method, account] of [
    ['bac_nio', '1120-001'],
    ['bac_usd', '1120-002'],
    ['lafise_nio', '1120-003'],
    ['lafise_usd', '1120-004'],
    ['ficohsa_nio', '1120-005'],
    ['ficohsa_usd', '1120-006'],
  ]) {
    await db.exec('begin')
    const before = (await ledger()).accounts.find(
      (x) => x.code === account,
    ).debit
    await call(
      'create_document',
      invoice(method, 1, method.endsWith('usd') ? 'USD' : 'NIO'),
    )
    equal(
      (await ledger()).accounts.find((x) => x.code === account).debit - before,
      method.endsWith('usd') ? 366 : 150,
      method + ' acredita su propia cuenta',
    )
    await db.exec('rollback')
  }
  await db.exec('begin')
  await db.query('select public.void_finance_entry($1,$2)', [
    paymentId,
    'Corrección de banco',
  ])
  equal(
    (await credits()).rows.find((x) => x.documentId === credit.id).balanceNio,
    450,
    'anular un abono restaura la deuda',
  )
  equal(
    (await ledger()).accounts.find((x) => x.code === '1120-003').closing,
    500,
    'anular abono revierte el banco',
  )
  await db.exec('rollback')
  // Payable and inventory use the same rounding of goods and freight in FX.
  await db.exec('begin')
  const cents = await call(
    'record_shipment',
    purchase(0.01, 'credito', {
      currency: 'USD',
      exchangeRate: 36.6,
      shippingAmount: 0.01,
      lines: [
        { productId: product, quantity: 1, unitPrice: 0.01, location: 'store' },
      ],
    }),
  )
  equal(
    (await credits()).rows.find((x) => x.shipmentId === cents).originalNio,
    0.74,
  )
  const centsLedger = await ledger()
  equal(
    Math.round(
      (centsLedger.accounts.find((x) => x.code === '2111').credit -
        a('2111').credit) *
        100,
    ),
    74,
    'compra y deuda coinciden al centavo',
  )
  await db.exec('rollback')
  // Cost correction on invoice cancellation must consider BOTH locations.
  await call(
    'record_shipment',
    purchase(100, 'credito', {
      shippingAmount: 0,
      lines: [
        { productId: other, quantity: 10, unitPrice: 100, location: 'store' },
      ],
    }),
  )
  const returned = await call(
    'create_document',
    invoice('cash', 2, 'NIO', { items: [{ productId: other, quantity: 2 }] }),
  )
  await call(
    'record_shipment',
    purchase(200, 'credito', {
      shippingAmount: 0,
      lines: [
        {
          productId: other,
          quantity: 10,
          unitPrice: 200,
          location: 'warehouse',
        },
      ],
    }),
  )
  await db.query('select public.delete_invoice($1,$2)', [
    returned.id,
    'Corrección de venta',
  ])
  equal(
    Number(
      (
        await get(
          'select average_cost_nio from public.product_costs where product_id=$1',
          [other],
        )
      ).average_cost_nio,
    ),
    150,
    'devolución ponderada entre tienda y bodega',
  )
  equal(
    (await ledger()).accounts.find((x) => x.code === '4190').credit,
    100,
    'devolución no genera ganancia de conteo',
  )
  // Missing just one snapshot must not look like a complete invoice.
  const mixed = await call(
    'create_document',
    invoice('cash', 1, 'NIO', {
      items: [
        { productId: product, quantity: 1 },
        { productId: other, quantity: 1 },
      ],
    }),
  )
  await db.exec('reset role; begin')
  await db.query(
    'delete from public.document_item_costs where document_id=$1 and product_id=$2',
    [mixed.id, other],
  )
  equal(
    (await ledger()).missingSales,
    1,
    'factura parcialmente incompleta detectada',
  )
  await db.exec('rollback')
  await identity(db, admin)
  await db.query('select public.delete_invoice($1,$2)', [mixed.id, 'Auditoría'])
  const beforeClose = await day()
  const close = {
    requestId: crypto.randomUUID(),
    day: today,
    countedNio: beforeClose.report.expectedNio,
    countedUsd: beforeClose.report.expectedUsd,
    note: '',
  }
  equal((await call('close_business_day', close)).status, 'closed')
  await rejects(
    call(
      'record_finance_entry',
      finance('collection', 1, { documentId: credit.id }),
    ),
    /cerrada/,
  )
  await rejects(call('record_shipment', purchase(100)), /cerrada/)
  await rejects(
    db.query('select public.delete_invoice($1,$2)', [cash.id, 'Auditoría']),
    /cerrada/,
  )
  await rejects(
    call(
      'record_journal_entry',
      voucher('income', [
        { account: '1110-001', debit: 1, credit: 0 },
        { account: '4190', debit: 0, credit: 1 },
      ]),
    ),
    /cerrada/,
  )
  const frozen = await day()
  equal(
    frozen.report.expectedNio,
    beforeClose.report.expectedNio,
    'operaciones rechazadas son atómicas',
  )
  for (const uid of [operator, warehouse, viewer, outsider]) {
    await identity(db, uid)
    await rejects(
      db.query('select public.ledger_report($1,$2)', [today, today]),
    )
    await rejects(call('record_finance_entry', finance('capital', 100)))
    await rejects(
      call('open_business_day', {
        requestId: crypto.randomUUID(),
        openingNio: 0,
        openingUsd: 0,
      }),
    )
    equal(
      (await db.query('select * from public.journal_entries')).rows.length,
      0,
      'RLS contable',
    )
  }
  await identity(db, '', 'anon')
  await rejects(db.query('select public.get_business_day(null)'))
  console.log(
    `PASS full workday: ${checks} checks; purchases, sales, FX, credits, costs, returns, journal, day closing and roles`,
  )
} finally {
  await db.close()
}

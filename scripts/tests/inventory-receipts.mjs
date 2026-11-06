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
const inactive = '66666666-6666-4666-8666-666666666666'
const otherWarehouse = '77777777-7777-4777-8777-777777777777'
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000301'
const existing = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000302'
const uncounted = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000303'
const disabled = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000304'
let checks = 0
let current = ['', 'authenticated']
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const reject = async (promise, pattern) => {
  await assert.rejects(promise, pattern)
  checks++
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const as = async (id, role = 'authenticated') => {
  current = [id, role]
  await identity(db, id, role)
}
const owner = async (sql, args = []) => {
  await db.exec('reset role')
  try {
    return await one(sql, args)
  } finally {
    await identity(db, ...current)
  }
}
const financialTables = [
  'public.inventory_balances',
  'public.inventory_movements',
  'public.products',
  'public.product_costs',
  'private.inventory_value_balances',
  'private.inventory_count_gains',
  'public.product_prices',
  'public.purchase_shipments',
  'public.purchase_shipment_lines',
  'public.journal_entries',
  'public.journal_lines',
  'public.finance_entries',
  'public.documents',
  'public.document_items',
  'public.business_days',
  'private.business_day_events',
]
const snapshot = async (tables = financialTables) => {
  const result = {}
  for (const table of tables)
    result[table] = (
      await owner(
        `select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text)::text,'')) hash from ${table} x`,
      )
    ).hash
  return result
}
const allTables = [
  ...financialTables,
  'private.inventory_receipts',
  'private.inventory_receipt_lines',
  'private.inventory_receipt_operations',
]
const unchanged = async (name, input, pattern) => {
  const before = await snapshot(allTables)
  await reject(rpc(db, name, input), pattern)
  eq(
    await snapshot(allTables),
    before,
    'un rechazo no guarda efectos parciales',
  )
}
const receiptInput = (changes = {}) => ({
  requestId: crypto.randomUUID(),
  incurredOn: '2026-11-06',
  supplier: 'Proveedor de la recepción',
  agency: 'Agencia del pedido',
  reference: 'FACTURA-RECIBIDA',
  note: 'Mercadería recibida para revisión contable',
  currency: 'NIO',
  exchangeRate: 1,
  shippingAmount: 50,
  lines: [
    { productId: product, location: 'warehouse', quantity: 5, unitPrice: 100 },
    { productId: existing, location: 'store', quantity: 3, unitPrice: 200 },
  ],
  ...changes,
})
const purchase = (input, changes = {}) => {
  const rest = { ...input }
  delete rest.requestId
  return { ...rest, account: 'credito', ...changes }
}
const postInput = (id, input, changes = {}) => ({
  requestId: crypto.randomUUID(),
  receiptId: id,
  expectedRevision: 0,
  purchase: purchase(input),
  ...changes,
})
const cancelInput = (id, changes = {}) => ({
  requestId: crypto.randomUUID(),
  receiptId: id,
  expectedRevision: 0,
  reason: 'La recepción se registró por error',
  ...changes,
})
const page = (input = {}) => rpc(db, 'inventory_receipts', input)
const confirmation = async (kind, requestId, retire = false) =>
  (
    await one(
      `select public.${retire ? 'retire_unconfirmed_operation' : 'get_operation_confirmation'}($1,$2) r`,
      [kind, requestId],
    )
  ).r
const ledger = async () =>
  (await one("select public.ledger_report('2026-11-06','2026-11-06') r")).r
const account = (report, code) => report.accounts.find((a) => a.code === code)
const sale = () => ({
  requestId: crypto.randomUUID(),
  kind: 'invoice',
  customerName: 'Cliente de prueba',
  tier: 'emprendedor',
  currency: 'NIO',
  exchangeRate: 1,
  location: 'warehouse',
  paymentMethod: 'cash',
  notes: '',
  items: [{ productId: product, quantity: 1 }],
})

try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.receipts_now')::timestamptz$$",
  )
  await db.query(
    "select set_config('lcp.receipts_now','2026-11-06T18:00:00Z',false)",
  )
  await db.exec(
    "insert into private.pending_staff(email,display_name,role) values('inactive-receipt@example.test','Inactivo','admin'),('warehouse-receipt@example.test','Otra bodega','warehouse')",
  )
  await db.query(
    "insert into auth.users(id,email) values($1,'inactive-receipt@example.test'),($2,'warehouse-receipt@example.test')",
    [inactive, otherWarehouse],
  )
  await db.query(
    `insert into public.staff_members(user_id,display_name,role,active) values
     ($1,'Administración','admin',true),($2,'Caja','operator',true),
     ($3,'Bodega','warehouse',true),($4,'Consulta','viewer',true),
     ($5,'Propietario','superadmin',true),($6,'Inactivo','admin',false),
     ($7,'Otra bodega','warehouse',true)
     on conflict(user_id) do update set display_name=excluded.display_name,role=excluded.role,active=excluded.active`,
    [admin, operator, warehouse, viewer, outsider, inactive, otherWarehouse],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Recepciones aisladas'); insert into public.brands(name) values('Marca recibida'); insert into public.exchange_rates(id,usd_to_nio) values(true,37) on conflict(id) do update set usd_to_nio=37",
  )
  for (const [id, sku, quantity, cost] of [
    [product, 'RECEIPT-1', 0, null],
    [existing, 'RECEIPT-2', 2, 200],
    [uncounted, 'RECEIPT-3', null, null],
    [disabled, 'RECEIPT-4', 0, null],
  ]) {
    await db.query(
      "insert into public.products(id,sku,name,brand_id,active) values($1,$2,'Perfume recibido',(select id from public.brands limit 1),$3)",
      [id, sku, id !== disabled],
    )
    await db.query(
      "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',$2),($1,'warehouse',$3)",
      [id, quantity, quantity === null ? null : 0],
    )
    if (cost !== null)
      await db.query(
        'insert into public.product_costs(product_id,average_cost_nio) values($1,$2)',
        [id, cost],
      )
    await db.query(
      "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',1000),($1,'emprendedor','USD',30)",
      [id],
    )
  }
  await as(admin)
  const openingRequest = crypto.randomUUID()
  await rpc(db, 'record_journal_entry', {
    requestId: openingRequest,
    kind: 'opening',
    occurredOn: '2026-11-06',
    description: 'Saldos iniciales de la prueba',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1110-001', debit: 100000, credit: 0 },
      { account: '1120-001', debit: 100000, credit: 0 },
      { account: '1130', debit: 400, credit: 0 },
      { account: '3110-001', debit: 0, credit: 200400 },
    ],
  })
  const baseline = await snapshot()
  const input = receiptInput()
  for (const uid of [operator, viewer, inactive, '']) {
    await as(uid, uid ? 'authenticated' : 'anon')
    await reject(
      rpc(db, 'record_inventory_receipt', input),
      /permission|insufficient/i,
    )
    await reject(page(), /permission|insufficient/i)
    await reject(
      rpc(db, 'post_inventory_receipt', {}),
      /permission|insufficient/i,
    )
    await reject(
      rpc(db, 'cancel_inventory_receipt', {}),
      /permission|insufficient/i,
    )
  }
  await as(warehouse)
  await reject(
    db.query('select * from private.inventory_receipts'),
    /permission/i,
  )
  await reject(
    db.query('insert into private.inventory_receipts default values'),
    /permission/i,
  )
  for (const changes of [
    { account: 'caja' },
    { bankLedgerAccount: null },
    { incurredOn: '2026-11-07' },
    { currency: 'EUR' },
    { currency: null },
    { exchangeRate: 0 },
    { exchangeRate: 37 },
    { shippingAmount: -1 },
    { shippingAmount: 0.001 },
    { note: 'x'.repeat(2001) },
    { supplier: null },
    { lines: [] },
    { lines: [input.lines[0], input.lines[0]] },
    { lines: [{ ...input.lines[0], quantity: 0 }] },
    { lines: [{ ...input.lines[0], quantity: 0.5 }] },
    { lines: [{ ...input.lines[0], location: 'outside' }] },
    { lines: [{ ...input.lines[0], unitPrice: 1.001 }] },
    { lines: [{ ...input.lines[0], unitPrice: 12.34567 }] },
    { lines: [{ ...input.lines[0], productId: disabled }] },
    { shippingAmount: 0, lines: [{ ...input.lines[0], unitPrice: 0 }] },
  ])
    await unchanged(
      'record_inventory_receipt',
      receiptInput(changes),
      /recepción|Fecha|Moneda|cambio|numérico|texto|renglones|repetirse|cantidad|Ubicación|inactivo|costo/i,
    )

  const id = await rpc(db, 'record_inventory_receipt', input)
  eq(await rpc(db, 'record_inventory_receipt', input), id)
  eq(
    await snapshot(),
    baseline,
    'recibir con la tienda cerrada no toca existencias, caja, costos ni libro',
  )
  await unchanged(
    'record_inventory_receipt',
    { ...input, note: 'Otra nota' },
    /solicitud.*cambió/,
  )
  let row = (await page()).receipts.find((r) => r.id === id)
  eq(
    [row.status, row.revision, row.units, row.createdBy, row.createdByName],
    ['pending', 0, 8, warehouse, 'Bodega'],
  )
  eq([row.shipmentId, row.reviewedAt, row.cancelReason], [null, null, null])
  eq(row.posting, null, 'una recepción pendiente no fabrica datos contables')
  eq(
    row.lines.map((l) => [l.productName, l.sku]),
    [
      ['Perfume recibido', 'RECEIPT-1'],
      ['Perfume recibido', 'RECEIPT-2'],
    ],
  )
  eq(await confirmation('inventory-receipt', input.requestId), {
    status: 'confirmed',
    id,
  })
  await reject(
    rpc(db, 'post_inventory_receipt', postInput(id, input)),
    /permission|insufficient/i,
  )
  await as(admin)
  await unchanged(
    'post_inventory_receipt',
    postInput(id, input),
    /cerrada|jornada/i,
  )
  await rpc(db, 'open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 100000,
    openingUsd: 0,
  })
  await as(operator)
  await unchanged(
    'create_document',
    sale(),
    /existencias|unidades|costo|disponib|stock/i,
  )
  await as(admin)
  const posting = postInput(id, input, {
    purchase: purchase(input, {
      supplier: 'Proveedor revisado',
      shippingAmount: 75,
      lines: [...input.lines]
        .reverse()
        .map((l) => ({ ...l, unitPrice: l.unitPrice + 10 })),
    }),
  })
  for (const changes of [
    { expectedRevision: 1 },
    { purchase: { ...posting.purchase, account: undefined } },
    { purchase: { ...posting.purchase, account: '' } },
    { purchase: { ...posting.purchase, account: null } },
    { purchase: { ...posting.purchase, account: 'otro' } },
    { purchase: { ...posting.purchase, requestId: crypto.randomUUID() } },
    { purchase: { ...posting.purchase, account: 'banco' } },
    {
      purchase: {
        ...posting.purchase,
        account: 'banco',
        bankLedgerAccount: '1110-001',
      },
    },
    {
      purchase: {
        ...posting.purchase,
        lines: [input.lines[0], input.lines[0]],
      },
    },
    { purchase: { ...posting.purchase, lines: [input.lines[0]] } },
    {
      purchase: {
        ...posting.purchase,
        lines: input.lines.map((l) => ({ ...l, quantity: l.quantity + 1 })),
      },
    },
    {
      purchase: {
        ...posting.purchase,
        lines: input.lines.map((l) => ({ ...l, location: 'warehouse' })),
      },
    },
    { purchase: { ...posting.purchase, incurredOn: '2026-11-07' } },
  ])
    await unchanged(
      'post_inventory_receipt',
      { ...posting, ...changes },
      /recepción cambió|explícitamente|solicitud|banco|BAC|productos|Fecha|Ubicación|banco pagador/i,
    )

  const beforePosting = await ledger()
  const shipmentId = await rpc(db, 'post_inventory_receipt', posting)
  eq(
    await rpc(db, 'post_inventory_receipt', posting),
    shipmentId,
    'reintentar la revisión no recibe dos veces',
  )
  const posted = await snapshot(allTables)
  await unchanged(
    'post_inventory_receipt',
    { ...posting, purchase: { ...posting.purchase, note: 'Cambió' } },
    /solicitud.*cambió/,
  )
  await unchanged(
    'post_inventory_receipt',
    { ...posting, requestId: crypto.randomUUID() },
    /recepción cambió|pendiente/,
  )
  eq(await snapshot(allTables), posted)
  const afterPosting = await ledger()
  eq(
    account(afterPosting, '1130').closing -
      account(beforePosting, '1130').closing,
    1255,
  )
  eq(
    account(afterPosting, '2111').closing -
      account(beforePosting, '2111').closing,
    -1255,
  )
  eq(
    account(afterPosting, '4190').closing,
    account(beforePosting, '4190').closing,
    'una compra revisada no reconoce sobrantes ni ingresos',
  )
  eq(
    account(afterPosting, '1110-001').closing,
    account(beforePosting, '1110-001').closing,
  )
  eq(
    afterPosting.accounts
      .filter((a) => a.postable)
      .reduce((total, a) => total + a.debit - a.credit, 0),
    0,
    'partida doble conciliada',
  )
  eq(
    (
      await owner(
        'select quantity from public.inventory_balances where product_id=$1 and location=$2',
        [product, 'warehouse'],
      )
    ).quantity,
    5,
  )
  eq(
    (
      await owner(
        'select quantity from public.inventory_balances where product_id=$1 and location=$2',
        [existing, 'store'],
      )
    ).quantity,
    5,
  )
  eq(
    (await owner('select count(*)::int n from public.purchase_shipments')).n,
    1,
  )
  row = (await page({ status: 'posted' })).receipts.find((r) => r.id === id)
  eq(
    [row.revision, row.status, row.shipmentId, row.reviewedByName],
    [1, 'posted', shipmentId, 'Administración'],
  )
  eq(
    row.posting,
    {
      incurredOn: '2026-11-06',
      currency: 'NIO',
      exchangeRate: 1,
      goodsAmount: 1180,
      shippingAmount: 75,
      account: 'credito',
      bankLedgerAccount: null,
      corrected: false,
    },
    'el historial presenta el costo y la contrapartida aprobados',
  )
  eq(row.shippingAmount, 50, 'se conserva el envío originalmente informado')
  eq(await confirmation('inventory-receipt-post', posting.requestId), {
    status: 'confirmed',
    id: shipmentId,
  })
  eq(
    (await page()).receipts.some((r) => r.id === id),
    false,
  )
  await as(operator)
  eq(
    (await rpc(db, 'create_document', sale())).total,
    1000,
    'solo después de contabilizar se pueden vender las unidades',
  )

  await as(warehouse)
  const ownInput = receiptInput({ reference: 'CANCELAR-PROPIA' })
  const ownId = await rpc(db, 'record_inventory_receipt', ownInput)
  const cancel = cancelInput(ownId)
  await as(otherWarehouse)
  await unchanged(
    'cancel_inventory_receipt',
    cancel,
    /permission|insufficient/i,
  )
  await as(warehouse)
  await unchanged(
    'cancel_inventory_receipt',
    { ...cancel, reason: ' ' },
    /motivo/,
  )
  await unchanged(
    'cancel_inventory_receipt',
    { ...cancel, expectedRevision: 1 },
    /recepción cambió/,
  )
  const beforeCancel = await snapshot()
  eq(await rpc(db, 'cancel_inventory_receipt', cancel), ownId)
  eq(await rpc(db, 'cancel_inventory_receipt', cancel), ownId)
  eq(
    await snapshot(),
    beforeCancel,
    'cancelar no toca el inventario ni crea un asiento',
  )
  eq(await confirmation('inventory-receipt-cancel', cancel.requestId), {
    status: 'confirmed',
    id: ownId,
  })
  await unchanged(
    'cancel_inventory_receipt',
    { ...cancel, reason: 'Otro motivo' },
    /solicitud.*cambió/,
  )
  row = (await page({ status: 'cancelled' })).receipts.find(
    (r) => r.id === ownId,
  )
  eq(row.posting, null)
  eq(
    [row.status, row.revision, row.cancelReason, row.reviewedByName],
    ['cancelled', 1, cancel.reason, 'Bodega'],
  )
  await as(admin)
  await unchanged(
    'post_inventory_receipt',
    postInput(ownId, ownInput, { expectedRevision: 1 }),
    /pendiente/,
  )
  await unchanged(
    'cancel_inventory_receipt',
    cancelInput(id, { expectedRevision: 1 }),
    /pendiente/,
  )

  const pendingCountInput = receiptInput({
    lines: [
      {
        productId: uncounted,
        location: 'warehouse',
        quantity: 3,
        unitPrice: 100,
      },
    ],
  })
  const pendingCountId = await rpc(
    db,
    'record_inventory_receipt',
    pendingCountInput,
  )
  await unchanged(
    'post_inventory_receipt',
    postInput(pendingCountId, pendingCountInput),
    /conteo/i,
  )
  eq(
    (await page()).receipts.find((r) => r.id === pendingCountId).status,
    'pending',
  )
  eq(
    (
      await owner(
        'select quantity from public.inventory_balances where product_id=$1 and location=$2',
        [uncounted, 'warehouse'],
      )
    ).quantity,
    null,
  )

  for (const [payment, bank] of [
    ['caja', null],
    ['banco', '1120-001'],
  ]) {
    const paymentInput = receiptInput({
      lines: [input.lines[0]],
      reference: payment,
    })
    const paymentId = await rpc(db, 'record_inventory_receipt', paymentInput)
    const before = await ledger()
    const paymentPost = postInput(paymentId, paymentInput, {
      purchase: purchase(paymentInput, {
        account: payment,
        ...(bank ? { bankLedgerAccount: bank } : {}),
      }),
    })
    await rpc(db, 'post_inventory_receipt', paymentPost)
    const after = await ledger()
    eq(account(after, '1130').closing - account(before, '1130').closing, 550)
    eq(
      account(after, bank ?? '1110-001').closing -
        account(before, bank ?? '1110-001').closing,
      -550,
    )
  }

  // No se puede reutilizar una compra inmediata como si hubiera revisado la recepción.
  const immediateInput = receiptInput({
    lines: [input.lines[0]],
    reference: 'COMPRA-INMEDIATA',
  })
  const immediateId = await rpc(db, 'record_inventory_receipt', immediateInput)
  const immediatePost = postInput(immediateId, immediateInput)
  await rpc(db, 'record_shipment', {
    ...immediatePost.purchase,
    requestId: immediatePost.requestId,
  })
  await unchanged('post_inventory_receipt', immediatePost, /otra operación/)

  // La recuperación conserva las ramas previas y las nuevas retiradas evitan guardados tardíos.
  eq((await confirmation('journal', openingRequest)).status, 'confirmed')
  for (const [kind, name, payload] of [
    ['inventory-receipt', 'record_inventory_receipt', receiptInput()],
    [
      'inventory-receipt-post',
      'post_inventory_receipt',
      postInput(pendingCountId, pendingCountInput),
    ],
    [
      'inventory-receipt-cancel',
      'cancel_inventory_receipt',
      cancelInput(pendingCountId),
    ],
  ]) {
    eq((await confirmation(kind, payload.requestId)).status, 'missing')
    eq((await confirmation(kind, payload.requestId, true)).status, 'retired')
    // Usar un producto con conteos completos permite alcanzar el guardado retirado del post.
    if (kind === 'inventory-receipt-post') {
      const another = receiptInput({ lines: [input.lines[0]] })
      payload.receiptId = await rpc(db, 'record_inventory_receipt', another)
      payload.purchase = purchase(another)
    }
    await unchanged(name, payload, /descartada/)
  }
  await as(warehouse)
  await reject(
    confirmation('inventory-receipt-post', crypto.randomUUID()),
    /permission|insufficient/i,
  )
  await as(admin)
  for (const filter of [
    { status: 'bad' },
    { limit: 0 },
    { limit: 101 },
    { before: {} },
  ])
    await reject(page(filter), /Filtro|límite|numérico|página/)
  const whole = await page({ status: 'all', limit: 100 })
  let cursor
  const traversed = []
  do {
    const chunk = await page({
      status: 'all',
      limit: 2,
      ...(cursor ? { before: cursor } : {}),
    })
    traversed.push(...chunk.receipts.map((r) => r.id))
    const last = chunk.receipts.at(-1)
    cursor = chunk.hasMore ? { createdAt: last.createdAt, id: last.id } : null
  } while (cursor)
  eq(
    traversed,
    whole.receipts.map((r) => r.id),
    'paginación por fecha e id sin repetir ni omitir recepciones',
  )
  eq(new Set(traversed).size, traversed.length)
  await as(outsider)
  const superInput = receiptInput({
    reference: 'SUPERADMIN-USD',
    incurredOn: '2026-11-05',
    currency: 'USD',
    exchangeRate: 36.5,
    shippingAmount: 2.1,
    lines: [{ ...input.lines[0], quantity: 2, unitPrice: 15.2 }],
  })
  const superId = await rpc(db, 'record_inventory_receipt', superInput)
  eq(
    (await page()).receipts.some((r) => r.id === superId),
    true,
  )
  const superBefore = await ledger()
  await rpc(
    db,
    'post_inventory_receipt',
    postInput(superId, superInput, {
      purchase: purchase(superInput, {
        incurredOn: '2026-11-06',
        account: 'banco',
        bankLedgerAccount: '1120-002',
        exchangeRate: 37.25,
        shippingAmount: 3,
        lines: [{ ...superInput.lines[0], unitPrice: 18.75 }],
      }),
    }),
  )
  const superAfter = await ledger()
  eq(
    Math.round(
      (account(superAfter, '1130').closing -
        account(superBefore, '1130').closing) *
        100,
    ) / 100,
    1508.63,
  )
  eq(
    Math.round(
      (account(superAfter, '1120-002').closing -
        account(superBefore, '1120-002').closing) *
        100,
    ) / 100,
    -1508.63,
    'SuperAdmin revisa costo/tasa/fecha y contabiliza en el banco USD elegido',
  )
  const superHistory = (await page({ status: 'posted' })).receipts.find(
    (receipt) => receipt.id === superId,
  )
  eq(superHistory.posting, {
    incurredOn: '2026-11-06',
    currency: 'USD',
    exchangeRate: 37.25,
    goodsAmount: 37.5,
    shippingAmount: 3,
    account: 'banco',
    bankLedgerAccount: '1120-002',
    corrected: false,
  })
  eq(
    [
      superHistory.incurredOn,
      superHistory.exchangeRate,
      superHistory.shippingAmount,
    ],
    ['2026-11-05', 36.5, 2.1],
    'los datos originales se distinguen del costeo definitivo',
  )
  await rpc(db, 'correct_purchase', {
    requestId: crypto.randomUUID(),
    shipmentId: superHistory.shipmentId,
    reason: 'Revisión posterior de la compra recibida',
    paymentTreatment: 'recording_error',
    refundConfirmed: true,
  })
  eq(
    (await page({ status: 'posted' })).receipts.find(
      (receipt) => receipt.id === superId,
    ).posting.corrected,
    true,
    'una compra corregida no se presenta como vigente sin aviso',
  )

  // El cierre no se reabre al recibir/cancelar; los guardias de compra siguen vigentes.
  await as(admin)
  const day = (await one("select public.get_business_day('2026-11-06') r")).r
  await rpc(db, 'close_business_day', {
    requestId: crypto.randomUUID(),
    day: day.day,
    expectedRevision: day.revision,
    expectedStateToken: day.stateToken,
    countedNio: day.report.expectedNio,
    countedUsd: day.report.expectedUsd,
    reason: '',
  })
  const closedState = await snapshot()
  const closedInput = receiptInput({ reference: 'TIENDA-CERRADA' })
  await as(warehouse)
  const closedId = await rpc(db, 'record_inventory_receipt', closedInput)
  await as(admin)
  await unchanged(
    'post_inventory_receipt',
    postInput(closedId, closedInput),
    /cerrada|jornada/i,
  )
  await as(warehouse)
  await rpc(db, 'cancel_inventory_receipt', cancelInput(closedId))
  eq(await snapshot(), closedState)
  await as(admin)
  eq(
    (await one("select public.get_business_day('2026-11-06') r")).r.status,
    'closed',
  )
  eq(
    await rpc(db, 'post_inventory_receipt', posting),
    shipmentId,
    'la respuesta confirmada se recupera incluso después de cerrar',
  )
  console.log(
    `${checks} comprobaciones de recepciones pendientes aprobadas; PostgreSQL desechable, sin escrituras remotas.`,
  )
} finally {
  await db.close()
}

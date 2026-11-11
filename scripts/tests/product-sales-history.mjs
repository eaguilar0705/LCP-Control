import assert from 'node:assert/strict'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
  warehouse,
  viewer,
  outsider as superadmin,
} from './database-fixture.mjs'

const db = await database()
const day = '2026-11-10'
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000001201'
const other = 'aaaaaaaa-aaaa-4aaa-8aaa-000000001202'
const empty = 'aaaaaaaa-aaaa-4aaa-8aaa-000000001203'
const inactive = '66666666-6666-4666-8666-666666666666'
const unassigned = '77777777-7777-4777-8777-777777777777'
let checks = 0
let serial = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const rejects = async (work, expected) => {
  await assert.rejects(work, expected)
  checks++
}
const one = async (sql, values = []) => (await db.query(sql, values)).rows[0]
const owner = async (sql, values = []) => {
  await db.exec('reset role')
  try {
    return await one(sql, values)
  } finally {
    await db.exec('set role authenticated')
  }
}
const clock = (time) =>
  db.query("select set_config('lcp.history_now',$1,false)", [time])
const history = async (
  id = product,
  offset = 0,
  limit = 20,
  asOf = null,
  expectedTotal = null,
) =>
  (
    await one('select public.product_sales_history($1,$2,$3,$4,$5) r', [
      id,
      offset,
      limit,
      asOf,
      expectedTotal,
    ])
  ).r
const invoice = (extra = {}) =>
  rpc(db, 'create_document', {
    requestId: crypto.randomUUID(),
    kind: 'invoice',
    customerName: `Cliente ${++serial}`,
    tier: 'emprendedor',
    currency: 'NIO',
    exchangeRate: 1,
    location: 'store',
    paymentMethod: 'pending',
    notes: '',
    items: [{ productId: product, quantity: 1 }],
    ...extra,
  })
const detail = async (id) =>
  (await one('select public.invoice_edit_detail($1) r', [id])).r.document
const edit = (document, extra = {}) =>
  rpc(db, 'correct_invoice', {
    requestId: crypto.randomUUID(),
    documentId: document.id,
    expectedRevision: document.revision,
    customerId: document.customer_id,
    customerName: document.customer_name,
    customerPhone: document.customer_phone,
    customerTaxId: document.customer_tax_id ?? '',
    tier: document.tier_code,
    currency: document.currency,
    exchangeRate: document.costs[0]?.exchange_rate ?? 1,
    location: document.location,
    paymentMethod: document.payment_method,
    notes: document.notes,
    invoiceDiscount: document.invoice_discount ?? 0,
    shippingMethod: document.shipping_method ?? null,
    shippingAmount: document.shipping_amount ?? 0,
    items: document.items.map((i) => ({
      productId: i.product_id,
      quantity: i.quantity,
      unitPrice: i.original_unit_price ?? i.unit_price,
      finalUnitPrice: i.unit_price,
    })),
    ...extra,
  })
const returned = async (document, quantity) =>
  rpc(db, 'record_sales_return', {
    requestId: crypto.randomUUID(),
    documentId: document.id,
    reason: 'Devolución real para comprobar el historial del perfume',
    refundMethod: 'cash',
    items: [
      {
        itemId: document.items.find((i) => i.product_id === product).id,
        quantity,
        restock: true,
      },
    ],
  })
const fingerprint = () =>
  owner(`select jsonb_build_object(
 'balances',(select jsonb_agg(to_jsonb(x) order by product_id,location) from public.inventory_balances x),
 'values',(select jsonb_agg(to_jsonb(x) order by product_id) from private.inventory_value_balances x),
 'costs',(select jsonb_agg(to_jsonb(x) order by product_id) from public.product_costs x),
 'saleCosts',(select jsonb_agg(to_jsonb(x) order by document_item_id) from public.document_item_costs x),
 'movements',(select jsonb_agg(to_jsonb(x) order by id) from public.inventory_movements x),
 'documents',(select jsonb_agg(to_jsonb(x) order by id) from public.documents x),
 'items',(select jsonb_agg(to_jsonb(x) order by id) from public.document_items x),
 'returns',(select jsonb_agg(to_jsonb(x) order by id) from public.sales_returns x),
 'returnLines',(select jsonb_agg(to_jsonb(x) order by return_id,document_item_id) from public.sales_return_lines x),
 'journals',(select jsonb_agg(to_jsonb(x) order by id) from public.journal_entries x),
 'journalLines',(select jsonb_agg(to_jsonb(x) order by entry_id,line_no) from public.journal_lines x),
 'deletions',(select jsonb_agg(to_jsonb(x) order by id) from private.document_deletions x),
 'corrections',(select jsonb_agg(to_jsonb(x) order by id) from private.invoice_corrections x)) r`)

try {
  await db.exec(`create or replace function pg_catalog.now() returns timestamptz language sql stable
   as $$select current_setting('lcp.history_now')::timestamptz$$`)
  await clock(`${day}T15:00:00Z`)
  await db.exec(`insert into private.pending_staff(email,display_name,role) values
   ('inactive-history@example.test','Dueño inactivo','superadmin'),
   ('unassigned-history@example.test','Acceso retirado','viewer')`)
  await db.query(
    `insert into auth.users(id,email) values($1,'inactive-history@example.test'),
   ($2,'unassigned-history@example.test')`,
    [inactive, unassigned],
  )
  await db.query(
    'update public.staff_members set active=false where user_id=$1',
    [inactive],
  )
  await db.query('delete from public.staff_members where user_id=$1', [
    unassigned,
  ])
  await db.query(
    `insert into public.staff_members(user_id,display_name,role,active) values
   ($1,'Administrador','admin',true),($2,'Caja','operator',true),($3,'Bodega','warehouse',true),
   ($4,'Consulta','viewer',true),($5,'Dueño','superadmin',true)`,
    [admin, operator, warehouse, viewer, superadmin],
  )
  await db.exec(`insert into public.business_settings(name) values('Histórico comercial QA');
   insert into public.brands(name) values('Marca de histórico');
   insert into public.exchange_rates(id,usd_to_nio) values(true,37) on conflict(id) do update set usd_to_nio=37`)
  for (const [id, sku] of [
    [product, 'HISTORY-PERFUME'],
    [other, 'HISTORY-OTHER'],
    [empty, 'HISTORY-EMPTY'],
  ]) {
    await db.query(
      `insert into public.products(id,sku,name,brand_id)
     values($1,$2,'Perfume de histórico',(select id from public.brands limit 1))`,
      [id, sku],
    )
    await db.query(
      `insert into public.inventory_balances(product_id,location,quantity)
     values($1,'store',1000),($1,'warehouse',0)`,
      [id],
    )
    await db.query(
      'insert into public.product_costs(product_id,average_cost_nio) values($1,100)',
      [id],
    )
    await db.query(
      `insert into public.product_prices(product_id,tier_code,currency,amount)
     values($1,'emprendedor','NIO',300),($1,'emprendedor','USD',10)`,
      [id],
    )
  }
  await identity(db, superadmin)
  await rpc(db, 'record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: day,
    description: 'Apertura del histórico comercial',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1130', debit: 300000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 300000 },
    ],
  })
  await rpc(db, 'open_business_day', {
    requestId: crypto.randomUUID(),
    expectedDay: day,
    openingNio: 0,
    openingUsd: 0,
  })
  const issued = []
  for (let index = 0; index < 25; index++) {
    await clock(
      new Date(
        Date.parse(`${day}T16:00:00Z`) + Math.floor(index / 2) * 70000,
      ).toISOString(),
    )
    issued.push(await invoice())
  }
  await clock(`${day}T17:00:00Z`)
  const partial = await invoice({
    customerName: 'Cliente con descuento y devolución parcial',
    invoiceDiscount: 40,
    items: [{ productId: product, quantity: 3, finalUnitPrice: 280 }],
  })
  await returned(partial, 1)
  const full = await invoice({
    customerName: 'Cliente en dólares devuelto',
    currency: 'USD',
    exchangeRate: 37,
    invoiceDiscount: 1,
    items: [{ productId: product, quantity: 2, finalUnitPrice: 9 }],
  })
  await returned(full, 2)
  await clock(`${day}T17:02:00Z`)
  const cancelled = await invoice({
    customerName: 'Cliente de factura anulada',
    invoiceDiscount: 10,
    items: [{ productId: product, quantity: 2, finalUnitPrice: 250 }],
  })
  await db.query('select public.delete_invoice($1,$2)', [
    cancelled.id,
    'Anulación real para el histórico',
  ])
  eq(
    (
      await one('select count(*)::int n from public.documents where id=$1', [
        cancelled.id,
      ])
    ).n,
    0,
    'La factura anulada solo existe en su snapshot privado',
  )
  await clock(`${day}T17:04:00Z`)
  const corrected = await invoice({
    customerName: 'Cliente antes de corregir',
    items: [{ productId: product, quantity: 2 }],
  })
  const correctedCurrent = await edit(await detail(corrected.id), {
    customerName: 'Cliente corregido',
    invoiceDiscount: 15,
    items: [
      { productId: product, quantity: 3, unitPrice: 300, finalUnitPrice: 270 },
    ],
  })
  eq(
    (
      await owner(
        "select count(*)::int n from public.inventory_movements where document_id=$1 and type='SALE'",
        [corrected.id],
      )
    ).n,
    2,
    'La corrección dejó dos salidas, pero corresponde a una sola venta vigente',
  )
  await clock(`${day}T17:06:00Z`)
  const removed = await invoice({
    customerName: 'Cliente original de perfume retirado',
    items: [
      { productId: product, quantity: 1 },
      { productId: other, quantity: 1 },
    ],
  })
  await edit(await detail(removed.id), {
    customerName: 'Cliente después de retirar',
    items: [
      { productId: other, quantity: 1, unitPrice: 300, finalUnitPrice: 300 },
    ],
  })
  const readded = await invoice({
    customerName: 'Cliente de perfume reañadido',
    items: [
      { productId: product, quantity: 1 },
      { productId: other, quantity: 1 },
    ],
  })
  let readdedCurrent = await edit(await detail(readded.id), {
    items: [
      { productId: other, quantity: 1, unitPrice: 300, finalUnitPrice: 300 },
    ],
  })
  readdedCurrent = await edit(readdedCurrent, {
    customerName: 'Cliente vigente reañadido',
    items: [
      { productId: product, quantity: 2, unitPrice: 300, finalUnitPrice: 260 },
      { productId: other, quantity: 1, unitPrice: 300, finalUnitPrice: 300 },
    ],
  })
  await clock(`${day}T17:08:00Z`)
  const removedCancelled = await invoice({
    customerName: 'Cliente retirado antes de anular',
    items: [
      { productId: product, quantity: 1 },
      { productId: other, quantity: 1 },
    ],
  })
  await edit(await detail(removedCancelled.id), {
    items: [
      { productId: other, quantity: 1, unitPrice: 300, finalUnitPrice: 300 },
    ],
  })
  await db.query('select public.delete_invoice($1,$2)', [
    removedCancelled.id,
    'Anulación posterior al retiro',
  ])
  await clock(`${day}T17:20:00Z`)
  const otherOnly = await invoice({
    items: [{ productId: other, quantity: 1 }],
  })
  await invoice({
    kind: 'proforma',
    location: null,
    paymentMethod: null,
    validUntil: '2026-11-20',
  })

  await clock(`${day}T18:00:00Z`)
  await db.exec('reset role')
  await db.query(
    "update public.product_prices set amount=999 where product_id=$1 and currency='NIO'",
    [product],
  )
  await db.query('update public.products set active=false where id=$1', [
    product,
  ])
  await identity(db, superadmin)
  const beforeReads = await fingerprint()
  const first = await history()
  eq(first.productId, product)
  eq(first.offset, 0)
  eq(first.limit, 20)
  eq(first.total, 32)
  eq(first.rows.length, 20)
  eq(new Date(first.asOf).toISOString(), `${day}T18:00:00.000Z`)
  const second = await history(product, 20, 20, first.asOf, first.total)
  eq(second.asOf, first.asOf)
  eq(second.total, first.total)
  eq(second.rows.length, 12)
  const all = [...first.rows, ...second.rows]
  eq(
    new Set(all.map((row) => row.documentId)).size,
    32,
    'Sin duplicados entre páginas ni por corrección de facturas',
  )
  eq(
    all.map((row) => `${row.createdAt}|${row.documentId}`),
    [...all]
      .sort(
        (a, b) =>
          Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
          b.documentId.localeCompare(a.documentId),
      )
      .map((row) => `${row.createdAt}|${row.documentId}`),
    'Orden estable por fecha y UUID en empates',
  )
  eq((await history(product, 40, 20, first.asOf, first.total)).rows, [])
  const row = (id) => all.find((entry) => entry.documentId === id)
  eq(
    row(issued[0].id).unitPrice,
    300,
    'El histórico conserva el precio facturado aunque el catálogo ahora diga 999',
  )
  eq(row(issued[0].id).lineTotal, 300)
  eq(row(issued[0].id).status, 'issued')
  eq(row(partial.id).unitPrice, 266.666667)
  eq(row(partial.id).lineTotal, 800)
  eq(row(partial.id).originalUnitPrice, 300)
  eq(row(partial.id).invoiceDiscount, 40)
  eq(row(partial.id).returnedQuantity, 1)
  eq(row(partial.id).returnedAmount, 266.67)
  eq(row(partial.id).status, 'partially_returned')
  eq(row(full.id).currency, 'USD')
  eq(row(full.id).unitPrice, 8.5)
  eq(row(full.id).lineTotal, 17)
  eq(row(full.id).originalUnitPrice, 10)
  eq(row(full.id).invoiceDiscount, 1)
  eq(row(full.id).returnedQuantity, 2)
  eq(row(full.id).returnedAmount, 17)
  eq(row(full.id).status, 'returned')
  eq(row(cancelled.id).customerName, 'Cliente de factura anulada')
  eq(row(cancelled.id).number, cancelled.number)
  eq(row(cancelled.id).unitPrice, 245)
  eq(row(cancelled.id).lineTotal, 490)
  eq(row(cancelled.id).status, 'cancelled')
  eq(row(cancelled.id).cancelledAt !== null, true)
  eq(row(cancelled.id).removedAt, null)
  eq(row(corrected.id).quantity, 3)
  eq(row(corrected.id).unitPrice, 265)
  eq(row(corrected.id).lineTotal, 795)
  eq(row(corrected.id).customerName, 'Cliente corregido')
  eq(row(corrected.id).revision, correctedCurrent.revision)
  eq(row(removed.id).status, 'removed')
  eq(row(removed.id).customerName, 'Cliente original de perfume retirado')
  eq(row(removed.id).unitPrice, 300)
  eq(row(removed.id).quantity, 1)
  eq(row(removed.id).revision, 0)
  eq(row(removed.id).removedAt !== null, true)
  eq(row(readded.id).status, 'issued')
  eq(row(readded.id).quantity, 2)
  eq(row(readded.id).unitPrice, 260)
  eq(row(readded.id).customerName, 'Cliente vigente reañadido')
  eq(row(readded.id).revision, readdedCurrent.revision)
  eq(row(readded.id).removedAt, null)
  eq(row(removedCancelled.id).status, 'removed')
  eq(row(removedCancelled.id).customerName, 'Cliente retirado antes de anular')
  eq(row(removedCancelled.id).removedAt !== null, true)
  eq(row(removedCancelled.id).cancelledAt !== null, true)
  eq((await history(empty)).total, 0)
  eq((await history(empty)).rows, [])
  eq(
    (await history(product, 0, 50, `${day}T16:00:00Z`)).total,
    2,
    'El corte limita la emisión e incluye todos los empates de la fecha',
  )
  eq(
    Object.keys(first.rows[0]).sort(),
    [
      'documentId',
      'number',
      'createdAt',
      'customerId',
      'customerName',
      'currency',
      'location',
      'quantity',
      'unitPrice',
      'lineTotal',
      'originalUnitPrice',
      'invoiceDiscount',
      'returnedQuantity',
      'returnedAmount',
      'status',
      'revision',
      'cancelledAt',
      'removedAt',
    ].sort(),
    'La respuesta no expone solicitudes, costos ni otros datos del snapshot',
  )
  eq(
    await fingerprint(),
    beforeReads,
    'Consultar páginas no modifica existencias, costos, ventas ni contabilidad',
  )

  for (const [id, offset, limit, asOf] of [
    [null, 0, 20, null],
    ['aaaaaaaa-aaaa-4aaa-8aaa-000000009999', 0, 20, null],
    [product, -1, 20, null],
    [product, null, 20, null],
    [product, 1000001, 20, null],
    [product, 0, 0, null],
    [product, 0, 51, null],
    [product, 0, null, null],
    [product, 0, 20, 'infinity'],
    [product, 0, 20, '-infinity'],
    [product, 0, 20, `${day}T19:00:00Z`],
  ])
    await rejects(() => history(id, offset, limit, asOf), { code: '22023' })
  await rejects(() => history(product, 0, 20, first.asOf, -1), {
    code: '22023',
  })
  for (const who of [operator, warehouse, viewer, inactive, unassigned]) {
    await identity(db, who)
    await rejects(() => history(), { code: '42501' })
    await rejects(
      () => db.query('select private.product_sales_history($1)', [product]),
      { code: '42501' },
    )
  }
  await identity(db, admin)
  eq(
    (await history()).total,
    first.total,
    'Administración puede consultar ventas de todo el personal',
  )
  await identity(db, admin, 'anon')
  await rejects(() => history(), { code: '42501' })
  await identity(db, null)
  await rejects(() => history(), { code: '42501' })
  await identity(db, superadmin)
  await db.exec('reset role')
  await db.query(
    'update public.staff_members set active=false where user_id=$1',
    [admin],
  )
  await identity(db, admin)
  await rejects(() => history(), { code: '42501' })
  await identity(db, superadmin)
  eq(await fingerprint(), beforeReads)

  // Una factura antigua de otro perfume puede incorporar este producto después
  // de abrir la primera página. Su emisión queda antes del corte, por lo que
  // asOf solo no impediría que OFFSET duplicase u omitiese filas.
  await clock(`${day}T18:05:00Z`)
  await owner('update public.products set active=true where id=$1', [product])
  await edit(await detail(otherOnly.id), {
    items: [
      { productId: other, quantity: 1, unitPrice: 300, finalUnitPrice: 300 },
      { productId: product, quantity: 1, unitPrice: 999, finalUnitPrice: 300 },
    ],
  })
  eq(
    (await history(product, 0, 50, first.asOf)).total,
    first.total + 1,
    'Una corrección posterior puede añadir una venta emitida antes de asOf',
  )
  const afterCorrection = await fingerprint()
  await rejects(() => history(product, 20, 20, first.asOf, first.total), {
    code: 'P0001',
    message:
      'El historial cambió mientras lo consultabas. Pulsa Actualizar ventas para volver al inicio.',
  })
  eq(
    await fingerprint(),
    afterCorrection,
    'Rechazar una página obsoleta no modifica operaciones',
  )
  const refreshed = await history()
  eq(refreshed.total, first.total + 1)
  eq(refreshed.rows[0].documentId, otherOnly.id)
  const refreshedSecond = await history(
    product,
    20,
    20,
    refreshed.asOf,
    refreshed.total,
  )
  const refreshedRows = [...refreshed.rows, ...refreshedSecond.rows]
  eq(refreshedRows.length, refreshed.total)
  eq(
    new Set(refreshedRows.map((entry) => entry.documentId)).size,
    refreshed.total,
    'Después de actualizar, todas las ventas aparecen exactamente una vez',
  )
  eq(
    refreshedRows.filter((entry) => entry.documentId === otherOnly.id).length,
    1,
  )
  console.log(
    `PASS histórico de ventas por perfume: ${checks} comprobaciones de paginación, precios, clientes, correcciones, anulaciones, devoluciones, permisos y lectura sin cambios`,
  )
} finally {
  await db.close()
}

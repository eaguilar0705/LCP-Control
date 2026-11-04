import assert from 'node:assert/strict'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
} from './database-fixture.mjs'
const db = await database()
let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const get = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const call = (name, input) => rpc(db, name, input)
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
const ledger = async (from = '2026-11-03', to = from) =>
  (await get('select public.ledger_report($1,$2) r', [from, to])).r
const account = (r, code) => r.accounts.find((a) => a.code === code)
const profit = (r) =>
  Math.round(
    -r.accounts
      .filter(
        (a) =>
          a.postable &&
          ['revenue', 'cost', 'expense', 'tax'].includes(a.bucket),
      )
      .reduce((sum, a) => sum + a.debit - a.credit, 0) * 100,
  ) / 100 || 0
const journal = (kind, description, lines, date = '2026-11-03') => ({
  requestId: crypto.randomUUID(),
  kind,
  description,
  occurredOn: date,
  currency: 'NIO',
  exchangeRate: 1,
  lines,
})
try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.shipping_now')::timestamptz$$",
  )
  await db.query(
    "select set_config('lcp.shipping_now','2026-11-03T18:00:00Z',false)",
  )
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'SuperAdmin','superadmin'),($2,'Caja','operator')",
    [admin, operator],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Prueba aislada');insert into public.brands(name) values('Marca');insert into public.exchange_rates(id,usd_to_nio) values(true,37) on conflict(id) do update set usd_to_nio=37",
  )
  await db.query(
    "insert into public.products(id,sku,name,brand_id) values($1,'QA-ENVIO','Perfume',(select id from public.brands limit 1))",
    [product],
  )
  await db.query(
    "insert into public.inventory_balances values($1,'store',20,now()),($1,'warehouse',0,now());",
    [product],
  )
  await db.query(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,400)',
    [product],
  )
  await db.query(
    "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',1000),($1,'emprendedor','USD',10)",
    [product],
  )
  await identity(db, admin)
  await call(
    'record_journal_entry',
    journal('opening', 'Apertura aislada', [
      { account: '1110-001', debit: 10000, credit: 0 },
      { account: '1130', debit: 8000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 18000 },
    ]),
  )
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 10000,
    openingUsd: 0,
  })
  const before = await ledger()
  eq(
    account(before, '4120'),
    undefined,
    'la cuenta retirada no aparece si no tiene movimientos vigentes',
  )
  eq(account(before, '4190-001').parent, '4190')
  eq(
    (await get("select active from public.ledger_accounts where code='4120'"))
      .active,
    false,
    'se conserva el registro histórico de la cuenta retirada',
  )
  eq(account(before, '2117').bucket, 'liability')
  eq(
    account(before, '5130-011').bucket,
    'expense',
    'se conserva la cuenta de gasto',
  )
  const input = {
    requestId: crypto.randomUUID(),
    kind: 'invoice',
    customerName: 'Cliente',
    tier: 'emprendedor',
    currency: 'NIO',
    exchangeRate: 1,
    location: 'store',
    paymentMethod: 'cash',
    notes: '',
    items: [{ productId: product, quantity: 1 }],
    shippingMethod: 'moto',
    shippingAmount: 80,
  }
  const invoice = await call('create_document', input)
  eq(invoice.total, 1080)
  let report = await ledger()
  eq(account(report, '2117').closing, -80)
  eq(
    account(report, '1110-001').closing - account(before, '1110-001').closing,
    1080,
  )
  eq(account(report, '4110').credit, 1000)
  eq(account(report, '5130-011').debit, 0)
  eq(
    account(report, '4190-001').credit,
    0,
    'facturar no reconoce ganancia automática por envíos',
  )
  eq(profit(report), 600)
  const paid = journal('expense', 'Pago manual al transportista', [
    { account: '2117', debit: 60, credit: 0 },
    { account: '1110-001', debit: 0, credit: 60 },
  ])
  const paidId = await call('record_journal_entry', paid)
  eq(
    await call('record_journal_entry', paid),
    paidId,
    'reintento no vuelve a pagar',
  )
  report = await ledger()
  eq(account(report, '2117').closing, -20)
  eq(account(report, '5130-011').debit, 0)
  eq(profit(report), 600, 'pagar deuda no es un gasto adicional')
  const ownExpense = journal('expense', 'Envío asumido por la tienda', [
    { account: '5130-011', debit: 30, credit: 0 },
    { account: '1110-001', debit: 0, credit: 30 },
  ])
  await call('record_journal_entry', ownExpense)
  eq(profit(await ledger()), 570)
  const snapshot = (
    await get('select public.invoice_edit_detail($1) r', [invoice.id])
  ).r.document
  const corrected = await call('correct_invoice', {
    requestId: crypto.randomUUID(),
    documentId: invoice.id,
    expectedRevision: 0,
    customerId: snapshot.customer_id,
    customerName: snapshot.customer_name,
    customerPhone: snapshot.customer_phone,
    customerTaxId: '',
    currency: 'NIO',
    exchangeRate: 1,
    tier: 'emprendedor',
    location: 'store',
    paymentMethod: 'cash',
    notes: 'Envío corregido',
    invoiceDiscount: 0,
    shippingMethod: 'moto',
    shippingAmount: 100,
    items: [{ productId: product, quantity: 1, unitPrice: 1000 }],
  })
  eq(corrected.number, invoice.number)
  eq(corrected.total, 1100)
  report = await ledger()
  eq(
    account(report, '2117').closing,
    -40,
    'editar envío ajusta la deuda y conserva pagos manuales',
  )
  eq(profit(report), 570)
  const second = await call('create_document', {
    ...input,
    requestId: crypto.randomUUID(),
    currency: 'USD',
    exchangeRate: 37,
    paymentMethod: 'pending',
    shippingAmount: 2,
  })
  eq(
    account(await ledger(), '2117').closing,
    -114,
    'el pasivo usa la conversión congelada de la factura',
  )
  await db.query('select public.delete_invoice($1,$2)', [
    second.id,
    'Prueba aislada de anulación',
  ])
  eq(
    account(await ledger(), '2117').closing,
    -40,
    'anular retira exclusivamente el envío de esa factura',
  )
  await assert.rejects(
    call(
      'record_journal_entry',
      journal('income', 'Cuenta retirada', [
        { account: '1110-001', debit: 1, credit: 0 },
        { account: '4120', debit: 0, credit: 1 },
      ]),
    ),
    /Cuenta no disponible/,
  )
  checks++
  const day = (await get('select public.get_business_day(null) r')).r
  eq(
    day.report.expectedNio,
    11010,
    'el efectivo esperado incluye factura corregida y pagos manuales una sola vez',
  )
  const balanceReport = await ledger()
  const natural = (bucket) =>
    balanceReport.accounts
      .filter((a) => a.postable && a.bucket === bucket)
      .reduce((sum, a) => sum + a.closing, 0)
  eq(
    natural('asset'),
    -natural('liability') - natural('equity') + profit(balanceReport),
    'activo = pasivo + capital + resultado, sin convertir envíos en ganancia',
  )
  await call('close_business_day', {
    requestId: crypto.randomUUID(),
    day: day.day,
    expectedRevision: day.revision,
    expectedStateToken: day.stateToken,
    countedNio: day.report.expectedNio,
    countedUsd: day.report.expectedUsd,
    note: '',
  })
  eq(account(await ledger(), '2117').closing, -40)
  eq(
    account(await ledger(), '4190-001').credit,
    0,
    'cerrar la jornada no traslada diferencias a ingresos',
  )
  await db.query(
    "select set_config('lcp.shipping_now','2026-12-01T18:00:00Z',false)",
  )
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: day.report.expectedNio,
    openingUsd: day.report.expectedUsd,
  })
  const december = await ledger('2026-12-01')
  eq(
    account(december, '2117').opening,
    -40,
    'el siguiente mes arrastra el saldo pendiente',
  )
  eq(
    account(december, '4190-001').credit,
    0,
    'el cambio de mes tampoco reconoce la diferencia automáticamente',
  )
  const management = journal(
    'adjustment',
    'Traslado manual de diferencia de envíos',
    [
      { account: '2117', debit: 40, credit: 0 },
      { account: '4190-001', debit: 0, credit: 40 },
    ],
    '2026-12-01',
  )
  const managementId = await call('record_journal_entry', management)
  const final = await ledger('2026-12-01')
  eq(account(final, '2117').closing, 0)
  eq(account(final, '4190-001').credit, 40)
  eq(
    profit(final),
    40,
    'la gestión aparece como ingreso solamente cuando Miguel registra el ajuste',
  )
  eq(
    profit(await ledger()),
    570,
    'el ajuste posterior no cambia el resultado del mes anterior',
  )
  eq(
    final.accounts
      .filter((a) => a.postable)
      .reduce((sum, a) => sum + a.debit - a.credit, 0),
    0,
  )
  await db.query('select public.void_journal_entry($1,$2)', [
    managementId,
    'Auditoría de reversión',
  ])
  eq(account(await ledger('2026-12-01'), '2117').closing, -40)
  eq(profit(await ledger('2026-12-01')), 0)
  await identity(db, operator)
  await assert.rejects(
    call('record_journal_entry', management),
    /permission|insufficient/i,
  )
  checks++
  console.log(
    `PASS envíos como pasivo: ${checks} comprobaciones de factura, pago y gestión manuales, gasto propio, correcciones, moneda, cierre y arrastre mensual; producción intacta.`,
  )
} finally {
  await db.close()
}

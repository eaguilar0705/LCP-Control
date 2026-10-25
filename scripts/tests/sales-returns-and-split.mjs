import assert from 'node:assert/strict'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
  warehouse,
  viewer,
} from './database-fixture.mjs'
const db = await database()
let checks = 0
const eq = (a, b, label) => {
  assert.deepEqual(a, b, label)
  checks++
}
const call = (name, payload) => rpc(db, name, payload)
const get = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const owner = async (sql, args = []) => {
  await db.exec('reset role')
  try {
    return await get(sql, args)
  } finally {
    await identity(db, admin)
  }
}
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
const day = '2026-10-24'
const next = '2026-10-25'
const cents = (n) => Math.round(Number(n) * 100) || 0
const invoice = (patch = {}) => ({
  requestId: crypto.randomUUID(),
  kind: 'invoice',
  customerName: 'Cliente de prueba aislada',
  tier: 'emprendedor',
  currency: 'NIO',
  exchangeRate: 1,
  location: 'store',
  paymentMethod: 'cash',
  notes: '',
  items: [{ productId: product, quantity: 3, expectedUnitPrice: 300 }],
  ...patch,
})
const returns = (d, item, quantity, patch = {}) => ({
  requestId: crypto.randomUUID(),
  documentId: d.id,
  reason: 'Corrección autorizada del producto entregado',
  refundMethod: 'cash',
  items: [{ itemId: item.id, quantity, restock: true }],
  ...patch,
})
const detail = async (d) =>
  (await get('select public.invoice_return_detail($1) r', [d.id])).r
const ledger = async (to) =>
  (await get('select public.ledger_report($1,$2) r', [day, to])).r
const balance = (report, code) =>
  cents(report.accounts.find((a) => a.code === code).closing)
const today = async () =>
  (await get('select public.get_business_day(null) r')).r
async function fingerprint() {
  return owner(
    "select jsonb_build_object('documents',(select count(*) from public.documents),'returns',(select count(*) from public.sales_returns),'lines',(select count(*) from public.sales_return_lines),'journal',(select count(*) from public.journal_lines),'payments',(select count(*) from public.invoice_payments),'balances',(select jsonb_agg(to_jsonb(b) order by product_id,location) from public.inventory_balances b),'value',(select jsonb_agg(to_jsonb(v) order by product_id) from private.inventory_value_balances v)) r",
  )
}
async function rejected(work, pattern) {
  const before = await fingerprint()
  await assert.rejects(work, pattern)
  checks++
  eq(await fingerprint(), before, 'rechazo completo sin cambios parciales')
}
async function close() {
  const state = await today()
  return call('close_business_day', {
    requestId: crypto.randomUUID(),
    day: state.day,
    revision: state.revision,
    countedNio: state.report.expectedNio,
    countedUsd: state.report.expectedUsd,
    note: '',
    expectedReport: state.report,
  })
}
try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.test_now')::timestamptz$$",
  )
  await db.query("select set_config('lcp.test_now',$1,false)", [
    day + 'T14:00:00Z',
  ])
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Admin','superadmin'),($2,'Caja','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer')",
    [admin, operator, warehouse, viewer],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Simulación aislada');insert into public.brands(name) values('Marca')",
  )
  await db.query(
    "insert into public.products(id,sku,name,brand_id) values($1,'QA-NC-001','Perfume NC',(select id from public.brands limit 1))",
    [product],
  )
  await db.query(
    "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',20),($1,'warehouse',0)",
    [product],
  )
  await db.query(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,100.005)',
    [product],
  )
  await db.query(
    "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',300),($1,'emprendedor','USD',10)",
    [product],
  )
  await identity(db, admin)
  await call('record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: day,
    currency: 'NIO',
    exchangeRate: 1,
    description: 'Saldos iniciales aislados',
    lines: [
      { account: '1110-001', debit: 100000, credit: 0 },
      { account: '1130', debit: 2000.1, credit: 0 },
      { account: '3110-001', debit: 0, credit: 102000.1 },
    ],
  })
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 100000,
    openingUsd: 1000,
  })
  const cash = await call('create_document', invoice())
  const initialDetail = await detail(cash)
  const original = await owner(
    'select to_jsonb(d) r from public.documents d where id=$1',
    [cash.id],
  )
  const cost = await owner(
    'select total_cost_nio from public.document_item_costs where document_id=$1',
    [cash.id],
  )
  eq(
    cents(cost.total_cost_nio),
    30002,
    'costo total reconocido exacto con fracción de centavo',
  )
  const firstInput = returns(cash, initialDetail.items[0], 1)
  const first = await call('record_sales_return', firstInput)
  eq(
    (await call('record_sales_return', firstInput)).id,
    first.id,
    'reintento no duplica NC',
  )
  eq(
    await owner('select to_jsonb(d) r from public.documents d where id=$1', [
      cash.id,
    ]),
    original,
    'factura original inmutable',
  )
  await rejected(
    () =>
      call('record_sales_return', { ...firstInput, reason: 'Datos distintos' }),
    /otros datos/,
  )
  await rejected(
    () => call('record_sales_return', returns(cash, initialDetail.items[0], 3)),
    /supera/,
  )
  await rejected(
    () =>
      call('record_sales_return', returns(cash, initialDetail.items[0], 1.5)),
    /numérico inválido/,
  )
  const remainingInput = returns(cash, initialDetail.items[0], 2)
  await call('record_sales_return', remainingInput)
  const restored = await owner(
    'select quantity,value_nio from private.inventory_value_balances where product_id=$1',
    [product],
  )
  eq(restored.quantity, 20, 'devolución completa restaura existencias')
  eq(
    cents(restored.value_nio),
    200010,
    'devolución completa restaura valor original exacto',
  )
  const returnedCosts = await owner(
    'select sum(cost_nio) amount from public.sales_return_lines where document_item_id=$1',
    [initialDetail.items[0].id],
  )
  eq(
    cents(returnedCosts.amount),
    30002,
    'fracciones de devolución suman costo total congelado',
  )
  const afterReturn = await ledger(day)
  eq(balance(afterReturn, '4110'), 0, 'devolución revierte ingreso completo')
  eq(balance(afterReturn, '5120'), 0, 'devolución revierte costo completo')
  await rejected(
    () =>
      db.query('select public.delete_invoice($1,$2)', [
        cash.id,
        'Borrar original',
      ]),
    /Devolución/,
  )
  const journalId = (await detail(cash)).returns[0].journalEntryId
  await rejected(
    () =>
      db.query('select public.void_journal_entry($1,$2)', [
        journalId,
        'Anular por fuera',
      ]),
    /notas de crédito/,
  )

  const credit = await call(
    'create_document',
    invoice({
      paymentMethod: 'pending',
      items: [{ productId: product, quantity: 4 }],
    }),
  )
  await call('record_finance_entry', {
    requestId: crypto.randomUUID(),
    occurredOn: day,
    kind: 'collection',
    account: 'caja',
    currency: 'NIO',
    exchangeRate: 1,
    amount: 1000,
    documentId: credit.id,
    description: 'Abono',
    reference: 'REC-001',
  })
  const creditLine = (await detail(credit)).items[0]
  const creditReturn = await call(
    'record_sales_return',
    returns(credit, creditLine, 1),
  )
  eq(creditReturn.creditReductionNio, 200, 'NC reduce primero lo pendiente')
  eq(creditReturn.refundNio, 100, 'NC devuelve sólo lo cobrado en exceso')
  const credits = (await get('select public.credit_accounts($1) r', [day])).r
  eq(
    credits.rows.find((r) => r.documentId === credit.id).balanceNio,
    0,
    'auxiliar de crédito conciliado tras NC y abono',
  )
  eq(
    (
      await owner(
        'select count(*)::int amount from public.finance_entries where document_id=$1',
        [credit.id],
      )
    ).amount,
    1,
    'abono vinculado conservado',
  )
  await rejected(
    () =>
      call('record_finance_entry', {
        requestId: crypto.randomUUID(),
        occurredOn: day,
        kind: 'collection',
        account: 'caja',
        currency: 'NIO',
        exchangeRate: 1,
        amount: 1,
        documentId: credit.id,
        description: 'Abono de más',
        reference: '',
      }),
    /supera el saldo/,
  )

  const splitInput = invoice({
    payments: [
      { method: 'cash', currency: 'NIO', amount: 400, exchangeRate: 1 },
      { method: 'card_pos', currency: 'NIO', amount: 200, exchangeRate: 1 },
      { method: 'bac_nio', currency: 'NIO', amount: 300, exchangeRate: 1 },
    ],
  })
  const beforeSplit = await ledger(day)
  const beforeDay = await today()
  const split = await call('create_document', splitInput)
  eq(
    (await call('create_document', splitInput)).id,
    split.id,
    'pago dividido idempotente',
  )
  eq(
    (
      await owner(
        'select count(*)::int n from public.invoice_payments where document_id=$1',
        [split.id],
      )
    ).n,
    3,
    'tres pagos almacenados',
  )
  const afterSplit = await ledger(day)
  for (const [account, delta] of [
    ['1110-001', 40000],
    ['1142', 20000],
    ['1120-001', 30000],
  ])
    eq(
      balance(afterSplit, account) - balance(beforeSplit, account),
      delta,
      'tramo exacto en mayor ' + account,
    )
  eq(
    cents((await today()).report.expectedNio) -
      cents(beforeDay.report.expectedNio),
    40000,
    'caja recibe sólo efectivo de la venta dividida',
  )
  const cross = invoice({
    items: [{ productId: product, quantity: 1 }],
    payments: [
      { method: 'cash', currency: 'NIO', amount: 117, exchangeRate: 1 },
      { method: 'cash', currency: 'USD', amount: 5, exchangeRate: 36.6 },
    ],
  })
  const beforeCross = await today()
  await call('create_document', cross)
  const afterCross = await today()
  eq(
    cents(afterCross.report.expectedNio) -
      cents(beforeCross.report.expectedNio),
    11700,
    'pago mixto conserva efectivo NIO',
  )
  eq(
    cents(afterCross.report.expectedUsd) -
      cents(beforeCross.report.expectedUsd),
    500,
    'pago mixto conserva efectivo USD',
  )
  await rejected(
    () =>
      call(
        'create_document',
        invoice({
          payments: [
            { method: 'cash', currency: 'NIO', amount: 1, exchangeRate: 1 },
            { method: 'cash', currency: 'NIO', amount: 1, exchangeRate: 1 },
          ],
        }),
      ),
    /completar exactamente/,
  )
  await rejected(
    () =>
      call(
        'create_document',
        invoice({
          payments: [
            { method: 'cash', currency: 'NIO', amount: 600, exchangeRate: 1 },
            {
              method: 'bac_usd',
              currency: 'NIO',
              amount: 300,
              exchangeRate: 1,
            },
          ],
        }),
      ),
    /moneda del pago/,
  )
  const flow = (
    await get('select public.finance_cashflow($1,$2) r', [day, day])
  ).r
  const endLedger = await ledger(day)
  eq(
    cents(flow.closing.caja),
    balance(endLedger, '1110-001') + balance(endLedger, '1110-002'),
    'flujo de caja y mayores con pagos mixtos y NC',
  )
  eq(
    cents(flow.closing.banco),
    balance(endLedger, '1120-001'),
    'flujo bancario y mayor con pagos divididos',
  )
  const historical = await call(
    'create_document',
    invoice({ items: [{ productId: product, quantity: 1 }] }),
  )
  const historicalLine = (await detail(historical)).items[0]
  const closed = await close()
  await rejected(
    () => call('record_sales_return', returns(historical, historicalLine, 1)),
    /Abre la jornada/,
  )
  await db.query("select set_config('lcp.test_now',$1,false)", [
    next + 'T14:00:00Z',
  ])
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 100000,
    openingUsd: 1000,
  })
  await call(
    'record_sales_return',
    returns(historical, historicalLine, 1, {
      items: [{ itemId: historicalLine.id, quantity: 1, restock: false }],
    }),
  )
  eq(
    (await detail(historical)).returns[0].date,
    next,
    'NC de factura histórica se registra hoy',
  )
  eq(
    (await get('select public.get_business_day($1) r', [day])).r.report,
    closed.report,
    'reporte diario cerrado conservado',
  )
  const damagedLedger = await ledger(next)
  assert.ok(balance(damagedLedger, '5150') > 0)
  checks++
  const stockNow = await owner(
    'select sum(quantity)::int n from public.inventory_balances where product_id=$1',
    [product],
  )
  eq(stockNow.n, 12, 'mercadería dañada no vuelve al inventario')
  for (const role of [operator, warehouse, viewer]) {
    await identity(db, role)
    await assert.rejects(
      () => call('record_sales_return', returns(historical, historicalLine, 1)),
      /permission denied|insufficient_privilege/,
    )
    checks++
    await assert.rejects(
      () => detail(historical),
      /permission denied|insufficient_privilege/,
    )
    checks++
  }
  await identity(db, admin)
  const usdInvoice = await call(
    'create_document',
    invoice({
      currency: 'USD',
      exchangeRate: 36.6,
      paymentMethod: 'pending',
      items: [{ productId: product, quantity: 3, expectedUnitPrice: 10 }],
    }),
  )
  await call('record_finance_entry', {
    requestId: crypto.randomUUID(),
    occurredOn: next,
    kind: 'collection',
    account: 'caja',
    currency: 'NIO',
    exchangeRate: 1,
    amount: 1097.99,
    documentId: usdInvoice.id,
    description: 'Abono en córdobas',
    reference: 'REC-USD-CENTAVO',
  })
  const usdLine = (await detail(usdInvoice)).items[0]
  const usdReturn = await call(
    'record_sales_return',
    returns(usdInvoice, usdLine, 1),
  )
  eq(
    usdReturn.creditReductionNio,
    0.01,
    'NC USD aplica centavo pendiente exacto',
  )
  eq(
    usdReturn.refundNio,
    365.99,
    'NC USD conserva el importe histórico con deuda de un centavo',
  )
  const usdCredit = (
    await get('select public.credit_accounts($1) r', [next])
  ).r.rows.find((r) => r.documentId === usdInvoice.id)
  eq(usdCredit.balanceNio, 0, 'auxiliar USD con abono en NIO y NC exacto')
  const usdJournal = (await detail(usdInvoice)).returns[0].journalEntryId
  const usdTotals = await owner(
    'select sum(debit-credit) native,sum(debit_nio-credit_nio) nio from public.journal_lines where entry_id=$1',
    [usdJournal],
  )
  eq(cents(usdTotals.native), 0, 'NC USD cuadra en moneda original')
  eq(cents(usdTotals.nio), 0, 'NC USD cuadra en NIO con conversión subcentavo')
  const initialLosses = (
    await get('select public.report_digest($1,$2) r', [day, next])
  ).r.ledger.belowCost.count
  await owner(
    "update public.product_prices set amount=50 where product_id=$1 and currency='NIO' returning amount",
    [product],
  )
  const belowCost = await call(
    'create_document',
    invoice({
      items: [{ productId: product, quantity: 1, expectedUnitPrice: 50 }],
    }),
  )
  eq(
    (await get('select public.report_digest($1,$2) r', [day, next])).r.ledger
      .belowCost.count,
    initialLosses + 1,
    'venta por debajo del costo aparece una sola vez',
  )
  await call(
    'record_sales_return',
    returns(belowCost, (await detail(belowCost)).items[0], 1),
  )
  eq(
    (await get('select public.report_digest($1,$2) r', [day, next])).r.ledger
      .belowCost.count,
    initialLosses,
    'devolución completa elimina la pérdida que ya fue revertida',
  )
  await owner(
    "update public.product_prices set amount=300 where product_id=$1 and currency='NIO' returning amount",
    [product],
  )
  const finalLedger = await ledger(next)
  const digest = (
    await get('select public.report_digest($1,$2) r', [day, next])
  ).r
  eq(
    cents(digest.ledger.revenueNio),
    -balance(finalLedger, '4110'),
    'digest de ingresos netos coincide con el mayor tras NC',
  )
  eq(
    cents(digest.ledger.costOfSalesNio),
    balance(finalLedger, '5120'),
    'digest de costo neto coincide con el mayor tras NC',
  )
  eq(
    cents(digest.ledger.inventoryWriteOffNio),
    balance(finalLedger, '5150'),
    'digest reconoce pérdida por devolución dañada',
  )
  eq(digest.ledger.missingCostUnits, 0, 'NC conocida no crea costos pendientes')
  eq(
    digest.ledger.missingRevenueLines,
    0,
    'NC conocida no crea ingresos pendientes',
  )
  for (const currency of ['NIO', 'USD']) {
    const expected = await owner(
      "select coalesce((select sum(total) from public.documents where kind='invoice' and currency=$1),0)-coalesce((select sum(amount) from public.sales_returns where currency=$1),0) revenue,(select count(*)::int from public.documents where kind='invoice' and currency=$1) count",
      [currency],
    )
    const sales = digest.sales[currency]
    eq(
      cents(sales.current.revenue),
      cents(expected.revenue),
      'ventas netas del resumen ' + currency,
    )
    eq(
      sales.current.count,
      expected.count,
      'NC no se cuenta como factura ' + currency,
    )
    eq(
      cents(sales.payments.reduce((sum, p) => sum + p.value, 0)),
      cents(sales.current.revenue),
      'desglose de pagos netos completo ' + currency,
    )
    eq(
      cents(sales.days.reduce((sum, d) => sum + d.revenue, 0)),
      cents(sales.current.revenue),
      'serie diaria neta completa ' + currency,
    )
    eq(
      cents(sales.tiers.reduce((sum, t) => sum + t.value, 0)),
      cents(sales.current.revenue),
      'listas de precios netas completas ' + currency,
    )
  }
  eq(
    cents(finalLedger.accounts.reduce((s, a) => s + a.debit - a.credit, 0)),
    0,
    'partida doble final exacta',
  )
  console.log(
    `PASS devoluciones y pagos divididos: ${checks} comprobaciones; original, abonos, NC parcial/histórica/dañada, stock y valor exactos, caja NIO/USD, POS, banco, rollback, idempotencia y permisos`,
  )
} catch (e) {
  console.error(e.code ?? '', e.message, e.where ?? '', e.position ?? '')
  process.exitCode = 1
} finally {
  await db.close()
}

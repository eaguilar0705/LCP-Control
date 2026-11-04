import assert from 'node:assert/strict'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
} from './database-fixture.mjs'

// Todas las operaciones ocurren en PostgreSQL WASM desechable; no se conecta
// con Supabase ni se modifica información del negocio.
const db = await database()
let checks = 0
const product = crypto.randomUUID()
const other = crypto.randomUUID()
const get = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const call = (name, input) => rpc(db, name, input)
const cents = (value) => Math.round(Number(value) * 100) || 0
const eq = (actual, expected, reason) => {
  assert.deepEqual(actual, expected, reason)
  checks++
}
const owner = async (sql, args = []) => {
  await db.exec('reset role')
  try {
    return await get(sql, args)
  } finally {
    await identity(db, admin)
  }
}
const fingerprint = () =>
  get(`select jsonb_build_object(
    'documents',(select count(*) from public.documents),
    'expenses',(select count(*) from public.expense_records),
    'payments',(select count(*) from public.invoice_payments),
    'returns',(select count(*) from public.sales_returns),
    'stock',(select jsonb_agg(to_jsonb(b) order by product_id,location) from public.inventory_balances b)) r`)
async function rejected(work, pattern) {
  const before = await fingerprint()
  await assert.rejects(work, pattern)
  checks++
  eq(
    await fingerprint(),
    before,
    'el rechazo revierte el documento y sus efectos',
  )
}

try {
  await db.query("select set_config('lcp.test_now',$1,false)", [
    '2026-11-02T14:00:00Z',
  ])
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.test_now')::timestamptz$$",
  )
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Propietario','superadmin'),($2,'Caja','operator')",
    [admin, operator],
  )
  await db.exec(
    "insert into public.business_settings(name) values('QA envíos');insert into public.brands(name) values('Marca')",
  )
  for (const [id, usd] of [
    [product, 10.01],
    [other, 7.01],
  ]) {
    await db.query(
      "insert into public.products(id,sku,name,brand_id) values($1,$2,'Perfume envío',(select id from public.brands limit 1))",
      [id, 'QA-' + id.slice(0, 8)],
    )
    await db.query(
      "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',1000),($1,'warehouse',0)",
      [id],
    )
    await db.query(
      'insert into public.product_costs(product_id,average_cost_nio) values($1,100)',
      [id],
    )
    await db.query(
      "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',300),($1,'emprendedor','USD',$2)",
      [id, usd],
    )
  }
  await identity(db, admin)
  const today = (
    await get(
      "select (now() at time zone 'America/Managua')::date::text as day",
    )
  ).day
  const ledger = async () =>
    (await get('select public.ledger_report($1,$1) r', [today])).r
  const day = async () =>
    (await get('select public.get_business_day(null) r')).r
  const credits = async () =>
    (await get('select public.credit_accounts($1) r', [today])).r
  const balance = (report, account) =>
    cents(report.accounts.find((row) => row.code === account).closing)
  const invoice = (patch = {}) => ({
    requestId: crypto.randomUUID(),
    kind: 'invoice',
    customerName: 'Cliente de envío',
    tier: 'emprendedor',
    currency: 'NIO',
    exchangeRate: 1,
    location: 'store',
    paymentMethod: 'cash',
    notes: '',
    items: [{ productId: product, quantity: 1, expectedUnitPrice: 300 }],
    shippingMethod: 'moto',
    shippingAmount: 50,
    expectedTotal: 350,
    ...patch,
  })
  await call('record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: today,
    currency: 'NIO',
    exchangeRate: 1,
    description: 'Apertura de prueba',
    lines: [
      { account: '1110-001', debit: 100000, credit: 0 },
      { account: '1110-002', debit: 36600, credit: 0 },
      { account: '1120-001', debit: 100000, credit: 0 },
      { account: '1120-002', debit: 36600, credit: 0 },
      { account: '1130', debit: 200000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 473200 },
    ],
  })
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 100000,
    openingUsd: 1000,
  })

  const legacy = invoice({ expectedTotal: 300 })
  delete legacy.shippingMethod
  delete legacy.shippingAmount
  const old = await call('create_document', legacy)
  eq(
    [
      old.shipping_method,
      Number(old.shipping_amount),
      Number(old.shipping_nio),
    ],
    [null, 0, 0],
    'solicitudes antiguas conservan envío cero',
  )
  const free = await call(
    'create_document',
    invoice({ shippingMethod: 'buses', shippingAmount: 0, expectedTotal: 300 }),
  )
  eq(
    [free.shipping_method, Number(free.shipping_amount)],
    ['buses', 0],
    'se puede indicar envío gratuito',
  )

  const beforeQuote = await ledger()
  const quote = await call(
    'create_document',
    invoice({
      kind: 'proforma',
      validUntil: today,
      shippingMethod: 'cargotrans',
      shippingAmount: 25,
      expectedTotal: 325,
    }),
  )
  eq(Number(quote.total), 325, 'proforma muestra productos y envío')
  eq(await ledger(), beforeQuote, 'proforma no genera cobro ni asientos')

  const beforeCash = await ledger()
  const beforeDay = await day()
  const discountedInput = invoice({
    items: [
      {
        productId: product,
        quantity: 3,
        expectedUnitPrice: 300,
        finalUnitPrice: 280,
      },
    ],
    invoiceDiscount: 40,
    expectedTotal: 850,
  })
  const discounted = await call('create_document', discountedInput)
  eq(
    [
      Number(discounted.original_total),
      Number(discounted.discount_amount),
      Number(discounted.invoice_discount),
    ],
    [900, 100, 40],
    'descuentos pertenecen solo a los productos',
  )
  eq(
    [
      Number(discounted.items[0].line_total),
      Number(discounted.shipping_amount),
      Number(discounted.total),
    ],
    [800, 50, 850],
    'el total agrega envío después de descuentos',
  )
  const afterCash = await ledger()
  eq(
    balance(afterCash, '1110-001') - balance(beforeCash, '1110-001'),
    85000,
    'caja recibe productos y envío',
  )
  eq(
    balance(afterCash, '4110') - balance(beforeCash, '4110'),
    -80000,
    'venta de perfumes conserva importe neto',
  )
  eq(
    balance(afterCash, '2117') - balance(beforeCash, '2117'),
    -5000,
    'el cobro por envío tiene cuenta propia',
  )
  eq(
    cents((await day()).report.expectedNio) -
      cents(beforeDay.report.expectedNio),
    85000,
    'cierre de caja incluye el envío',
  )
  eq(
    Number(
      (
        await get(
          'select net_revenue_nio from public.document_item_costs where document_id=$1',
          [discounted.id],
        )
      ).net_revenue_nio,
    ),
    800,
    'snapshot de perfume excluye envío',
  )
  eq(
    (await call('create_document', discountedInput)).id,
    discounted.id,
    'reintento recupera exactamente la misma factura',
  )
  eq(await ledger(), afterCash, 'reintento no vuelve a cobrar el envío')
  await rejected(
    call('create_document', { ...discountedInput, shippingAmount: 55 }),
    /otros datos/,
  )

  for (const patch of [
    { shippingAmount: -1 },
    { shippingAmount: '50' },
    { shippingAmount: null },
    { shippingAmount: 0.001 },
    { shippingAmount: 10000000.01 },
    { shippingMethod: 'otro' },
    { shippingMethod: 1 },
    { shippingMethod: null },
    { shippingMethod: '' },
  ])
    await rejected(
      call('create_document', invoice(patch)),
      /envío|shippingAmount|numérico/,
    )
  await rejected(
    call('create_document', invoice({ expectedTotal: 300 })),
    /precios cambiaron/,
  )

  const pending = await call(
    'create_document',
    invoice({
      paymentMethod: 'pending',
      shippingMethod: 'cargotrans',
      shippingAmount: 75,
      expectedTotal: 375,
    }),
  )
  eq(
    (await credits()).rows.find((row) => row.documentId === pending.id)
      .originalNio,
    375,
    'deuda incorpora el envío',
  )
  const beforeCollection = await ledger()
  await call('record_finance_entry', {
    requestId: crypto.randomUUID(),
    kind: 'collection',
    occurredOn: today,
    account: 'banco',
    bankLedgerAccount: '1120-001',
    currency: 'NIO',
    exchangeRate: 1,
    amount: 375,
    documentId: pending.id,
    description: 'Cobro con envío',
  })
  eq(
    (await credits()).rows.find((row) => row.documentId === pending.id)
      .balanceNio,
    0,
    'se cobra la deuda completa con envío',
  )
  eq(
    balance(await ledger(), '1120-001') - balance(beforeCollection, '1120-001'),
    37500,
    'banco recibe cobro completo',
  )

  const beforePos = await ledger()
  const pos = await call(
    'create_document',
    invoice({ paymentMethod: 'card_pos' }),
  )
  eq(
    balance(await ledger(), '1142') - balance(beforePos, '1142'),
    35000,
    'POS conserva también envío pendiente de acreditar',
  )
  const settlement = await call('record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'card_settlement',
    occurredOn: today,
    description: 'Acreditación con envío',
    currency: 'NIO',
    exchangeRate: 1,
    gross: 350,
    commissionRate: 0,
    withholdingRate: 0,
    withholdingBase: 'gross',
    bankAccount: '1120-001',
    lines: [
      { account: '1120-001', debit: 350, credit: 0 },
      { account: '1142', debit: 0, credit: 350 },
    ],
  })
  eq(
    balance(await ledger(), '1142'),
    balance(beforePos, '1142'),
    'liquidación acredita producto y envío',
  )
  await rejected(
    db.query('select public.delete_invoice($1,$2)', [pos.id, 'Revisión']),
    /tarjetas ya liquidadas/,
  )
  await db.query('select public.void_journal_entry($1,$2)', [
    settlement,
    'Revisar liquidación',
  ])

  const beforeSplit = await ledger()
  const split = await call(
    'create_document',
    invoice({
      payments: [
        { method: 'cash', currency: 'NIO', amount: 100, exchangeRate: 1 },
        { method: 'bac_nio', currency: 'NIO', amount: 250, exchangeRate: 1 },
      ],
    }),
  )
  const afterSplit = await ledger()
  eq(
    balance(afterSplit, '1110-001') - balance(beforeSplit, '1110-001'),
    10000,
    'split no duplica débito de envío en efectivo',
  )
  eq(
    balance(afterSplit, '1120-001') - balance(beforeSplit, '1120-001'),
    25000,
    'split asigna el resto al banco',
  )
  eq(
    balance(afterSplit, '2117') - balance(beforeSplit, '2117'),
    -5000,
    'split reconoce envío una sola vez',
  )
  eq(
    Number(
      (
        await get(
          'select sum(amount_nio) n from public.invoice_payments where document_id=$1',
          [split.id],
        )
      ).n,
    ),
    350,
    'split concilia con el importe de factura',
  )
  await rejected(
    call(
      'create_document',
      invoice({
        payments: [
          { method: 'cash', currency: 'NIO', amount: 100, exchangeRate: 1 },
          { method: 'bac_nio', currency: 'NIO', amount: 200, exchangeRate: 1 },
        ],
      }),
    ),
    /completar exactamente/,
  )

  const beforeUsd = await ledger()
  const usd = await call(
    'create_document',
    invoice({
      currency: 'USD',
      exchangeRate: 36.6,
      shippingAmount: 0.01,
      items: [
        { productId: product, quantity: 1, expectedUnitPrice: 10.01 },
        { productId: other, quantity: 1, expectedUnitPrice: 7.01 },
      ],
      expectedTotal: 17.03,
      payments: [
        { method: 'cash', currency: 'USD', amount: 8, exchangeRate: 36.6 },
        {
          method: 'bac_usd',
          currency: 'USD',
          amount: 9.03,
          exchangeRate: 36.6,
        },
      ],
    }),
  )
  eq(
    [Number(usd.total), Number(usd.shipping_nio)],
    [17.03, 0.37],
    'envío USD congela conversión al centavo',
  )
  const usdPayments = await get(
    'select sum(amount_nio) nio,sum(amount_document) native,sum(rounding_nio) rounding from public.invoice_payments where document_id=$1',
    [usd.id],
  )
  eq(
    [
      Number(usdPayments.nio),
      Number(usdPayments.native),
      Number(usdPayments.rounding),
    ],
    [623.31, 17.03, 0.01],
    'split ajusta centavo contra productos más envío congelados',
  )
  eq(
    balance(await ledger(), '2117') - balance(beforeUsd, '2117'),
    -37,
    'asiento conserva conversión original del envío',
  )
  await db.exec('reset role')
  await db.exec('update public.exchange_rates set usd_to_nio=40 where id')
  await identity(db, admin)
  eq(
    Number(
      (
        await get('select shipping_nio from public.documents where id=$1', [
          usd.id,
        ])
      ).shipping_nio,
    ),
    0.37,
    'cambiar tasa actual no revaloriza envío histórico',
  )

  const beforeReturn = await ledger()
  const returnInput = {
    requestId: crypto.randomUUID(),
    documentId: discounted.id,
    reason: 'Cliente devuelve los perfumes',
    refundMethod: 'cash',
    items: [{ itemId: discounted.items[0].id, quantity: 3, restock: true }],
  }
  const returned = await call('record_sales_return', returnInput)
  eq(
    returned.refundNio,
    800,
    'devolución completa devuelve productos y conserva envío',
  )
  eq(
    balance(await ledger(), '2117'),
    balance(beforeReturn, '2117'),
    'devolución no revierte cobro de envío',
  )
  eq(
    Number(
      (
        await get('select shipping_amount from public.documents where id=$1', [
          discounted.id,
        ])
      ).shipping_amount,
    ),
    50,
    'factura original conserva envío después de devolución',
  )
  const unpaid = await call(
    'create_document',
    invoice({ paymentMethod: 'pending' }),
  )
  await call('record_sales_return', {
    ...returnInput,
    requestId: crypto.randomUUID(),
    documentId: unpaid.id,
    items: [{ itemId: unpaid.items[0].id, quantity: 1, restock: true }],
  })
  eq(
    (await credits()).rows.find((row) => row.documentId === unpaid.id)
      .balanceNio,
    50,
    'devolución a crédito conserva solamente deuda del envío',
  )

  const deleteInput = invoice({ shippingAmount: 37, expectedTotal: 337 })
  const beforeDelete = await ledger()
  const deleted = await call('create_document', deleteInput)
  await db.query('select public.delete_invoice($1,$2)', [
    deleted.id,
    'Documento de prueba anulado',
  ])
  eq(
    await ledger(),
    beforeDelete,
    'anulación retira productos y envío del mayor',
  )
  const deletion = await owner(
    'select snapshot from private.document_deletions where document_id=$1',
    [deleted.id],
  )
  eq(
    [
      deletion.snapshot.shipping_method,
      Number(deletion.snapshot.shipping_amount),
    ],
    ['moto', 37],
    'auditoría de anulación conserva el envío original',
  )

  const expense = (patch = {}) => ({
    requestId: crypto.randomUUID(),
    incurredOn: today,
    category: 'envios',
    description: 'Pago al transportista',
    amount: 30,
    currency: 'NIO',
    exchangeRate: 1,
    account: 'caja',
    reference: discounted.number,
    ...patch,
  })
  const beforeExpense = await ledger()
  const beforeExpenseDay = await day()
  const expenseInput = expense()
  const expenseId = await call('record_expense', expenseInput)
  eq(
    await call('record_expense', expenseInput),
    expenseId,
    'pago a transportista idempotente',
  )
  eq(
    balance(await ledger(), '5130-011') - balance(beforeExpense, '5130-011'),
    3000,
    'transportista se registra como gasto de ventas',
  )
  eq(
    cents((await day()).report.expectedNio) -
      cents(beforeExpenseDay.report.expectedNio),
    -3000,
    'pago posterior sale de caja',
  )
  eq(
    balance(await ledger(), '2117'),
    balance(beforeExpense, '2117'),
    'gasto no modifica cobro facturado',
  )
  const beforeBankExpense = await ledger()
  await call(
    'record_expense',
    expense({ account: 'banco', bankLedgerAccount: '1120-001', amount: 40 }),
  )
  eq(
    balance(await ledger(), '1120-001') -
      balance(beforeBankExpense, '1120-001'),
    -4000,
    'pago transportista usa banco elegido',
  )
  const usdExpense = await call(
    'record_expense',
    expense({
      account: 'banco',
      bankLedgerAccount: '1120-002',
      amount: 1.5,
      currency: 'USD',
      exchangeRate: 36.6,
    }),
  )
  eq(
    (
      await get(
        'select bank_ledger_account from public.expense_records where id=$1',
        [usdExpense],
      )
    ).bank_ledger_account,
    '1120-002',
    'gasto USD conserva banco pagador',
  )
  await rejected(
    call(
      'record_expense',
      expense({ account: 'banco', bankLedgerAccount: '1120-002' }),
    ),
    /moneda del gasto/,
  )
  await rejected(
    call('record_expense', expense({ bankLedgerAccount: '1120-001' })),
    /solo corresponde/,
  )
  await rejected(
    call(
      'record_expense',
      expense({ account: 'banco', bankLedgerAccount: '1110-001' }),
    ),
    /moneda del gasto/,
  )
  await db.query('select public.void_expense($1,$2)', [
    expenseId,
    'Corregir pago de prueba',
  ])
  eq(
    balance(await ledger(), '5130-011') - balance(beforeExpense, '5130-011'),
    9490,
    'anular gasto conserva los otros pagos y revierte el propio',
  )

  const journalExpense = (amount, patch = {}) => ({
    requestId: crypto.randomUUID(),
    kind: 'expense',
    occurredOn: today,
    description: 'Pago de envío desde Comprobantes',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '5130-011', debit: amount, credit: 0 },
      { account: '1110-001', debit: 0, credit: amount },
    ],
    ...patch,
  })
  const voidedJournal = await call('record_journal_entry', journalExpense(18))
  await call(
    'record_journal_entry',
    journalExpense(1.5, {
      currency: 'USD',
      exchangeRate: 36.6,
      lines: [
        { account: '5130-011', debit: 1.5, credit: 0 },
        { account: '1120-002', debit: 0, credit: 1.5 },
      ],
    }),
  )
  await call(
    'record_journal_entry',
    journalExpense(7, {
      kind: 'adjustment',
      lines: [
        { account: '1110-001', debit: 7, credit: 0 },
        { account: '5130-011', debit: 0, credit: 7 },
      ],
    }),
  )
  eq(
    (await get('select public.report_digest($1,$1) r', [today])).r.ledger
      .shippingExpenseNio,
    65.9,
    'resumen incorpora gasto por comprobantes, conversión USD y corrección a crédito sin duplicar expense_records',
  )
  await db.query('select public.void_journal_entry($1,$2)', [
    voidedJournal,
    'Pago de prueba duplicado',
  ])

  const digest = (await get('select public.report_digest($1,$1) r', [today])).r
  eq(
    digest.ledger.shippingExpenseNio,
    47.9,
    'resumen excluye comprobantes de gasto anulados',
  )
  eq(
    digest.ledger.months[0].shippingExpenseNio,
    47.9,
    'gasto de comprobantes entra al mes correspondiente',
  )
  const allShipping = Number(
    (
      await get(
        "select sum(shipping_nio) n from public.documents where kind='invoice'",
      )
    ).n,
  )
  eq(
    digest.ledger.shippingNio,
    allShipping,
    'digest distingue envío de ingresos por perfumes',
  )
  eq(
    digest.ledger.months[0].shippingNio,
    allShipping,
    'digest mensual conserva cobros por envío',
  )
  eq(
    digest.ledger.revenueNio,
    -balance(await ledger(), '4110') / 100,
    'digest de productos concilia con ventas sin envío',
  )
  const vouchers = (
    await get('select public.sales_journal_entries($1,$1) r', [today])
  ).r
  eq(
    vouchers
      .find((row) => row.kind === 'sales')
      .lines.find((row) => row.account === '2117').credit,
    allShipping,
    'comprobante automático incluye cuenta de envío',
  )
  const finalLedger = await ledger()
  eq(
    finalLedger.accounts.reduce(
      (sum, row) => sum + cents(row.debit) - cents(row.credit),
      0,
    ),
    0,
    'todos los asientos conservan partida doble',
  )
  const flow = (await get('select public.finance_cashflow($1,$1) r', [today])).r
  eq(
    cents(flow.closing.caja),
    balance(finalLedger, '1110-001') + balance(finalLedger, '1110-002'),
    'flujo de caja concilia con mayor tras envíos, devoluciones y gastos',
  )
  eq(
    cents(flow.closing.banco),
    finalLedger.accounts
      .filter((row) => row.code.startsWith('1120-'))
      .reduce((sum, row) => sum + cents(row.closing), 0),
    'flujo bancos concilia con mayor',
  )

  // Caja puede cobrar el envío autorizado; no obtiene permiso para pagar
  // transportistas ni consultar las cuentas del negocio.
  await identity(db, operator)
  const own = await call(
    'create_document',
    invoice({ customerId: old.customer_id }),
  )
  eq(Number(own.total), 350, 'Caja emite factura con envío')
  await assert.rejects(
    call('record_expense', expense()),
    /permission|privilege|denied/i,
  )
  checks++

  // Un mes sin ventas también muestra el gasto de envío en su propia fecha.
  await identity(db, admin)
  const closing = await day()
  await call('close_business_day', {
    requestId: crypto.randomUUID(),
    day: closing.day,
    revision: closing.revision,
    countedNio: closing.report.expectedNio,
    countedUsd: closing.report.expectedUsd,
    note: '',
    expectedReport: closing.report,
  })
  const nextDate = new Date(today + 'T12:00:00Z')
  nextDate.setUTCMonth(nextDate.getUTCMonth() + 1, 1)
  const nextDay = nextDate.toISOString().slice(0, 10)
  await db.exec('reset role')
  await db.query("select set_config('lcp.test_now',$1,false)", [
    nextDay + 'T14:00:00Z',
  ])
  await identity(db, admin)
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: closing.report.expectedNio,
    openingUsd: closing.report.expectedUsd,
  })
  await call(
    'record_journal_entry',
    journalExpense(22, { occurredOn: nextDay }),
  )
  const isolated = (
    await get('select public.report_digest($1,$1) r', [nextDay])
  ).r.ledger
  eq(
    [isolated.revenueNio, isolated.shippingNio, isolated.shippingExpenseNio],
    [0, 0, 22],
    'gasto de otro mes no exige facturas y conserva fecha contable',
  )
  eq(
    isolated.months.map((row) => [row.month, row.shippingExpenseNio]),
    [[nextDay.slice(0, 7), 22]],
    'calendario incluye mes con gasto de envío sin ventas',
  )
  eq(
    (await get('select public.report_digest($1,$1) r', [today])).r.ledger
      .shippingExpenseNio,
    47.9,
    'gasto posterior no se atribuye al período anterior',
  )
  console.log(
    `PASS envíos en documentos y contabilidad (${checks} comprobaciones)`,
  )
} catch (error) {
  console.error(error.message)
  if (error.where) console.error(error.where)
  if (error.actual !== undefined)
    console.error({ actual: error.actual, expected: error.expected })
  process.exitCode = 1
} finally {
  await db.close()
}

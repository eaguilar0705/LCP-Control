import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
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

// This test has no network transport or credentials. Every production migration
// runs in a fresh, disposable PostgreSQL/WASM database. Only this database's
// clock is replaced, so successive workdays exercise the actual date guards.
const db = await database()
const started = performance.now()
const days = 30
const products = []
const accounts = new Map()
const receivables = []
const payables = []
const dailyReports = []
const automaticReports = []
let checks = 0
let operations = 0
let minute = 0
let date = '2026-09-01'
let cashNio = 500000
let cashUsd = 500
let invoices = 0
let proformas = 0
let invoiceLines = 0
let purchases = 0
let refunds = 0
let soldUnits = 0
const rate = 36.6
const cents = (amount) => Math.round((amount + Number.EPSILON) * 100) || 0
const money = (amount) => cents(amount) / 100
const six = (amount) => Math.round((amount + Number.EPSILON) * 1e6) / 1e6
const equal = (actual, expected, message) => {
  assert.equal(actual, expected, message)
  checks++
}
const near = (actual, expected, tolerance, message) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} != ${expected}`,
  )
  checks++
}
const add = (account, amount) =>
  accounts.set(account, (accounts.get(account) ?? 0) + cents(amount))
const post = (debit, credit, amount) => {
  add(debit, amount)
  add(credit, -amount)
}
async function tick() {
  await db.query("select set_config('lcp.test_now',$1,false)", [
    `${date}T${String(14 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute++ % 60).padStart(2, '0')}:00Z`,
  ])
}
async function call(name, input) {
  await tick()
  operations++
  return rpc(db, name, input)
}
const get = async (sql, args = []) => (await db.query(sql, args)).rows[0]
async function rejects(work, pattern, message) {
  await assert.rejects(work, pattern, message)
  checks++
}
const voucher = (kind, lines, changes = {}) => ({
  requestId: crypto.randomUUID(),
  kind,
  occurredOn: date,
  currency: 'NIO',
  exchangeRate: 1,
  description: 'Prueba prolongada aislada',
  reference: 'PRUEBA-AISLADA',
  lines,
  ...changes,
})
const finance = (kind, amount, changes = {}) => ({
  requestId: crypto.randomUUID(),
  kind,
  amount,
  occurredOn: date,
  account: 'caja',
  currency: 'NIO',
  exchangeRate: 1,
  description: 'Prueba prolongada aislada',
  reference: 'PRUEBA-AISLADA',
  ...changes,
})
const paymentMethods = [
  ['cash', 'NIO', '1110-001'],
  ['cash', 'USD', '1110-002'],
  ['card_pos', 'NIO', '1142'],
  ['pending', 'NIO', '1140'],
  ['bac_nio', 'NIO', '1120-001'],
  ['bac_usd', 'USD', '1120-002'],
  ['lafise_nio', 'NIO', '1120-003'],
  ['lafise_usd', 'USD', '1120-004'],
  ['ficohsa_nio', 'NIO', '1120-005'],
  ['ficohsa_usd', 'USD', '1120-006'],
]
const customerId = (index) =>
  `cccccccc-cccc-4ccc-8ccc-${String(index + 1).padStart(12, '0')}`
const invoice = (
  dayIndex,
  saleIndex,
  count = 1 + (saleIndex % 8),
  kind = 'invoice',
) => {
  const [method, currency] = paymentMethods[saleIndex % paymentMethods.length]
  return {
    requestId: crypto.randomUUID(),
    kind,
    customerId: customerId(saleIndex % 20),
    tier: 'emprendedor',
    currency,
    exchangeRate: currency === 'USD' ? rate : 1,
    location: 'store',
    paymentMethod: method,
    notes: 'Prueba aislada de operación prolongada',
    ...(kind === 'proforma' ? { validUntil: date } : {}),
    items: Array.from({ length: count }, (_, line) => ({
      productId:
        products[(dayIndex * 17 + saleIndex * 7 + line * 11) % products.length]
          .id,
      quantity: 1 + ((saleIndex + line) % 2),
    })),
  }
}
const itemProduct = (item) => products.find((p) => p.id === item.productId)
function modelSale(input) {
  const snapshots = input.items.map((item) => {
    const product = itemProduct(item)
    const revenue = money(
      item.quantity * product.prices[input.currency] * input.exchangeRate,
    )
    const cost = money(item.quantity * product.average)
    product.store -= item.quantity
    assert.ok(product.store >= 0)
    post(
      paymentMethods.find(
        ([method, currency]) =>
          method === input.paymentMethod && currency === input.currency,
      )[2],
      '4110',
      revenue,
    )
    post('5120', '1130', cost)
    return {
      product,
      quantity: item.quantity,
      revenue,
      cost,
      average: product.average,
    }
  })
  const total = money(
    input.items.reduce(
      (sum, item) =>
        sum + item.quantity * itemProduct(item).prices[input.currency],
      0,
    ),
  )
  if (input.paymentMethod === 'cash') {
    if (input.currency === 'NIO') cashNio = money(cashNio + total)
    else cashUsd = money(cashUsd + total)
  }
  invoices++
  invoiceLines += input.items.length
  soldUnits += input.items.reduce((sum, item) => sum + item.quantity, 0)
  return { snapshots, total }
}
async function reconcile(dayIndex) {
  const ledger = (
    await get('select public.ledger_report($1,$2) r', ['2026-09-01', date])
  ).r
  for (const account of ledger.accounts) {
    equal(
      cents(account.closing),
      accounts.get(account.code) ?? 0,
      `día ${dayIndex + 1}: saldo independiente ${account.code}`,
    )
  }
  equal(
    cents(
      ledger.accounts.reduce(
        (sum, account) => sum + account.debit - account.credit,
        0,
      ),
    ),
    0,
    'partida doble balanceada',
  )
  equal(ledger.missingCosts, 0, 'ningún costo incompleto')
  equal(ledger.missingSales, 0, 'ninguna venta incompleta')
  const credits = (await get('select public.credit_accounts($1) r', [date])).r
  for (const debt of [...receivables, ...payables]) {
    const row = credits.rows.find(
      (credit) =>
        credit.documentId === debt.documentId &&
        credit.shipmentId === debt.shipmentId,
    )
    assert.ok(row, `deuda ${debt.documentId ?? debt.shipmentId} presente`)
    equal(
      cents(row.balanceNio),
      cents(debt.balance),
      'auxiliar individual coincide con modelo',
    )
  }
  const flow = (
    await get('select public.finance_cashflow($1,$2) r', ['2026-09-01', date])
  ).r
  equal(
    cents(flow.closing.caja),
    (accounts.get('1110-001') ?? 0) + (accounts.get('1110-002') ?? 0),
    'flujo de caja coincide con ambos mayores',
  )
  equal(
    cents(flow.closing.banco),
    [...accounts]
      .filter(([account]) => account.startsWith('1120-'))
      .reduce((sum, [, value]) => sum + value, 0),
    'flujo bancario coincide con todos los bancos',
  )
  const current = (await get('select public.get_business_day(null) r')).r
  equal(
    cents(current.report.expectedNio),
    cents(cashNio),
    'efectivo diario NIO independiente',
  )
  equal(
    cents(current.report.expectedUsd),
    cents(cashUsd),
    'efectivo diario USD independiente',
  )
  const inventory = (
    await db.query(
      'select b.product_id,b.location,b.quantity,c.average_cost_nio from public.inventory_balances b join public.product_costs c on c.product_id=b.product_id',
    )
  ).rows
  for (const product of products) {
    for (const location of ['store', 'warehouse']) {
      const actual = inventory.find(
        (row) => row.product_id === product.id && row.location === location,
      )
      equal(
        actual.quantity,
        product[location],
        `existencias ${product.sku} ${location}`,
      )
      near(
        Number(actual.average_cost_nio),
        product.average,
        0.0000011,
        `costo promedio ${product.sku}`,
      )
    }
  }
  return current
}

try {
  // Replacing a built-in function is confined to this throwaway fixture. Date
  // defaults and production functions keep their original SQL implementations.
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.test_now')::timestamptz$$",
  )
  await tick()
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Administración','superadmin'),($2,'Ventas','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer')",
    [admin, operator, warehouse, viewer],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Prueba prolongada aislada'); insert into public.brands(name) values('Marca de prueba')",
  )
  for (let index = 0; index < 20; index++) {
    await db.query(
      "insert into public.customers(id,name,price_tier) values($1,$2,'emprendedor')",
      [customerId(index), `Cliente ${index + 1}`],
    )
  }
  for (let index = 0; index < 260; index++) {
    const product = {
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, '0')}`,
      sku: `AISLADO-${String(index + 1).padStart(4, '0')}`,
      store: 40,
      warehouse: 10,
      average: 100 + index,
      prices: { NIO: 500 + index * 10, USD: money(20 + index / 5) },
    }
    await db.query(
      'insert into public.products(id,sku,name,brand_id) values($1,$2,$3,(select id from public.brands limit 1))',
      [product.id, product.sku, `Perfume ${index + 1}`],
    )
    await db.query(
      "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',40),($1,'warehouse',10)",
      [product.id],
    )
    await db.query(
      'insert into public.product_costs(product_id,average_cost_nio) values($1,$2) on conflict(product_id) do update set average_cost_nio=excluded.average_cost_nio',
      [product.id, product.average],
    )
    await db.query(
      "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',$2),($1,'emprendedor','USD',$3)",
      [product.id, product.prices.NIO, product.prices.USD],
    )
    products.push(product)
  }
  await identity(db, admin)
  const inventoryOpening = products.reduce(
    (sum, product) =>
      sum + (product.store + product.warehouse) * product.average,
    0,
  )
  const openingLines = [
    { account: '1110-001', debit: cashNio, credit: 0 },
    { account: '1110-002', debit: cashUsd * rate, credit: 0 },
    { account: '1120-000', debit: 100000, credit: 0 },
    { account: '1130', debit: inventoryOpening, credit: 0 },
    {
      account: '3110-001',
      debit: 0,
      credit: cashNio + cashUsd * rate + 100000 + inventoryOpening,
    },
  ]
  await call('record_journal_entry', voucher('opening', openingLines))
  for (const line of openingLines) add(line.account, line.debit - line.credit)
  for (let dayIndex = 0; dayIndex < days; dayIndex++) {
    date = `2026-09-${String(dayIndex + 1).padStart(2, '0')}`
    minute = 0
    await tick()
    await identity(db, admin)
    const openInput = {
      requestId: crypto.randomUUID(),
      openingNio: cashNio,
      openingUsd: cashUsd,
    }
    equal(
      (await call('open_business_day', openInput)).status,
      'open',
      'jornada abre',
    )
    equal(
      (await call('open_business_day', openInput)).status,
      'open',
      'reintento de apertura idempotente',
    )
    for (let shipment = 0; shipment < 3; shipment++) {
      const currency = shipment === 1 ? 'USD' : 'NIO'
      const exchangeRate = currency === 'USD' ? rate : 1
      const account = ['credito', 'banco', 'caja'][shipment]
      const lines = Array.from({ length: 10 }, (_, line) => {
        const product =
          products[
            (dayIndex * 23 + shipment * 37 + line * 13) % products.length
          ]
        return {
          productId: product.id,
          location: line % 3 === 0 ? 'warehouse' : 'store',
          quantity: 6,
          unitPrice:
            currency === 'USD'
              ? money(5 + line / 5 + dayIndex / 10)
              : 150 + line * 3 + dayIndex,
        }
      })
      const shippingAmount = 60
      const payload = {
        requestId: crypto.randomUUID(),
        incurredOn: date,
        supplier: `Proveedor ${shipment + 1}`,
        reference: `COMPRA-${dayIndex}-${shipment}`,
        agency: 'Agencia de prueba',
        note: '',
        currency,
        exchangeRate,
        shippingAmount,
        account,
        lines,
      }
      const id = await call('record_shipment', payload)
      equal(await call('record_shipment', payload), id, 'compra idempotente')
      const goods = money(
        lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0),
      )
      const amountNio =
        money(goods * exchangeRate) + money(shippingAmount * exchangeRate)
      post(
        '1130',
        account === 'credito'
          ? '2111'
          : account === 'banco'
            ? '1120-000'
            : '1110-001',
        amountNio,
      )
      if (account === 'credito')
        payables.push({ shipmentId: id, documentId: null, balance: amountNio })
      if (account === 'caja') cashNio = money(cashNio - goods - shippingAmount)
      for (const line of lines) {
        const product = itemProduct(line)
        const units = product.store + product.warehouse
        const landed = six((line.unitPrice + 1) * exchangeRate)
        product.average = six(
          (product.average * units + landed * line.quantity) /
            (units + line.quantity),
        )
        product[line.location] += line.quantity
      }
      purchases++
    }
    await identity(db, operator)
    const dayInvoices = []
    for (let saleIndex = 0; saleIndex < 40; saleIndex++) {
      const payload = invoice(
        dayIndex,
        saleIndex,
        dayIndex === 14 && saleIndex === 10 ? 100 : undefined,
      )
      const result = await call('create_document', payload)
      const expected = modelSale(payload)
      equal(
        cents(result.total),
        cents(expected.total),
        'total de factura independiente',
      )
      if (payload.paymentMethod === 'pending')
        receivables.push({
          documentId: result.id,
          shipmentId: null,
          balance: expected.snapshots.reduce(
            (sum, snapshot) => money(sum + snapshot.revenue),
            0,
          ),
        })
      if (saleIndex % 13 === 0)
        equal(
          (await call('create_document', payload)).id,
          result.id,
          'reintento sin duplicar factura ni inventario',
        )
      dayInvoices.push({ ...result, payload, ...expected })
      if (saleIndex % 10 === 0) {
        const quote = invoice(
          dayIndex,
          saleIndex + 80,
          dayIndex === 14 && saleIndex === 10 ? 100 : 12,
          'proforma',
        )
        const stockBefore = products.map((product) => product.store)
        const q = await call('create_document', quote)
        equal(
          (await call('create_document', quote)).id,
          q.id,
          'proforma idempotente',
        )
        equal(
          products.map((product) => product.store).join(','),
          stockBefore.join(','),
          'modelo no descuenta proforma',
        )
        proformas++
      }
    }
    await identity(db, admin)
    // Cancel a cash sale before any subsequent purchase changes its cost.
    const refund = dayInvoices[0]
    await db.query('select public.delete_invoice($1,$2)', [
      refund.id,
      'Revisión aislada de devolución',
    ])
    for (const snapshot of refund.snapshots) {
      snapshot.product.store += snapshot.quantity
      post('1110-001', '4110', -snapshot.revenue)
      post('5120', '1130', -snapshot.cost)
    }
    cashNio = money(cashNio - refund.total)
    invoices--
    invoiceLines -= refund.payload.items.length
    soldUnits -= refund.payload.items.reduce(
      (sum, item) => sum + item.quantity,
      0,
    )
    refunds++
    const expectedSales = new Map()
    const expectedCosts = new Map()
    const expectedLine = (map, code, debit, credit) => {
      const previous = map.get(code) ?? { debit: 0, credit: 0 }
      map.set(code, {
        debit: previous.debit + cents(debit),
        credit: previous.credit + cents(credit),
      })
    }
    for (const document of dayInvoices.slice(1)) {
      const account = paymentMethods.find(
        ([method, currency]) =>
          method === document.payload.paymentMethod &&
          currency === document.payload.currency,
      )[2]
      for (const snapshot of document.snapshots) {
        expectedLine(expectedSales, account, snapshot.revenue, 0)
        expectedLine(expectedSales, '4110', 0, snapshot.revenue)
        expectedLine(expectedCosts, '5120', snapshot.cost, 0)
        expectedLine(expectedCosts, '1130', 0, snapshot.cost)
      }
    }
    automaticReports.push({
      date,
      sales: expectedSales,
      sales_cost: expectedCosts,
    })
    const clientDebt = receivables[dayIndex]
    const collected = money(clientDebt.balance / 2)
    const bank = dayIndex % 2 === 0 ? '1120-003' : '1120-005'
    const payment = finance('collection', collected, {
      documentId: clientDebt.documentId,
      account: 'banco',
      bankLedgerAccount: bank,
    })
    const paymentId = await call('record_finance_entry', payment)
    equal(
      await call('record_finance_entry', payment),
      paymentId,
      'abono idempotente',
    )
    post(bank, '1140', collected)
    clientDebt.balance = money(clientDebt.balance - collected)
    await rejects(
      () =>
        call('record_finance_entry', {
          ...payment,
          requestId: crypto.randomUUID(),
          amount: money(clientDebt.balance + 1),
        }),
      /supera/,
      'sobrepago rechazado',
    )
    if (dayIndex % 5 === 0) {
      await db.query('select public.void_finance_entry($1,$2)', [
        paymentId,
        'Corrección aislada',
      ])
      post(bank, '1140', -collected)
      clientDebt.balance = money(clientDebt.balance + collected)
    }
    const supplierDebt = payables[dayIndex]
    const supplierPaid = money(supplierDebt.balance / 3)
    await call(
      'record_finance_entry',
      finance('supplier_payment', supplierPaid, {
        shipmentId: supplierDebt.shipmentId,
      }),
    )
    post('2111', '1110-001', supplierPaid)
    supplierDebt.balance = money(supplierDebt.balance - supplierPaid)
    cashNio = money(cashNio - supplierPaid)
    for (const [category, code, amount] of [
      ['renta', '5130-002', 250],
      ['impuestos_alma', '5130-004', 30],
      ['internet', '5130-009', 20],
    ]) {
      const id = await call('record_expense', {
        requestId: crypto.randomUUID(),
        incurredOn: date,
        category,
        description: 'Gasto de prueba aislada',
        amount,
        currency: 'NIO',
        exchangeRate: 1,
        account: 'caja',
        reference: 'PRUEBA',
      })
      post(code, '1110-001', amount)
      cashNio = money(cashNio - amount)
      if (category === 'internet' && dayIndex % 4 === 0) {
        await db.query('select public.void_expense($1,$2)', [
          id,
          'Gasto anulado en prueba',
        ])
        post(code, '1110-001', -amount)
        cashNio = money(cashNio + amount)
      }
    }
    await call(
      'record_journal_entry',
      voucher('transfer', [
        { account: '1120-001', debit: 100, credit: 0 },
        { account: '1120-003', debit: 0, credit: 100 },
      ]),
    )
    post('1120-001', '1120-003', 100)
    const gross = (accounts.get('1142') ?? 0) / 100
    const commissionRate = dayIndex % 2 === 0 ? 4.5 : 3.25
    const withholdingRate = dayIndex % 3 === 0 ? 1.5 : 1
    const withholdingBase = dayIndex % 2 === 0 ? 'gross' : 'net_commission'
    const fee = money((gross * commissionRate) / 100)
    const withholding = money(
      ((withholdingBase === 'gross' ? gross : gross - fee) * withholdingRate) /
        100,
    )
    const settlement = voucher(
      'card_settlement',
      [
        {
          account: '1120-001',
          debit: money(gross - fee - withholding),
          credit: 0,
        },
        { account: '5140-001', debit: fee, credit: 0 },
        { account: '1340', debit: withholding, credit: 0 },
        { account: '1142', debit: 0, credit: gross },
      ],
      {
        gross,
        commissionRate,
        withholdingRate,
        withholdingBase,
        bankAccount: '1120-001',
      },
    )
    await call('record_journal_entry', settlement)
    post('1120-001', '1142', gross)
    post('5140-001', '1120-001', fee)
    post('1340', '1120-001', withholding)
    await rejects(
      () =>
        call('record_journal_entry', {
          ...settlement,
          requestId: crypto.randomUUID(),
        }),
      /tarjetas pendientes/,
      'no liquidar dos veces tarjetas',
    )
    await identity(db, warehouse)
    for (const [type, change, debit, credit] of [
      ['DAMAGED', -1, '5150', '1130'],
      ['EXIT', -1, '5150', '1130'],
      ['ADJUSTMENT', 1, '1130', '4190'],
    ]) {
      const product =
        products[
          (dayIndex * 19 + (type === 'DAMAGED' ? 0 : type === 'EXIT' ? 1 : 2)) %
            products.length
        ]
      await call('record_inventory_movement', {
        requestId: crypto.randomUUID(),
        productId: product.id,
        location: 'warehouse',
        type,
        quantity: type === 'ADJUSTMENT' ? product.warehouse + 1 : 1,
        note: 'Prueba aislada de merma o conteo',
      })
      product.warehouse += change
      post(debit, credit, money(product.average))
    }
    await identity(db, admin)
    const beforeClose = await reconcile(dayIndex)
    equal(beforeClose.report.invoices, 39, '39 ventas netas por jornada')
    const close = {
      requestId: crypto.randomUUID(),
      day: date,
      countedNio: cashNio,
      countedUsd: cashUsd,
      note: '',
    }
    const closed = await call('close_business_day', close)
    equal(closed.status, 'closed', 'cierre guardado')
    equal(
      (await call('close_business_day', close)).status,
      'closed',
      'reintento cierre idempotente',
    )
    equal(closed.report.differenceNio, 0, 'caja NIO sin diferencia')
    equal(closed.report.differenceUsd, 0, 'caja USD sin diferencia')
    await rejects(
      () => call('create_document', invoice(dayIndex, 41)),
      /cerrada/,
      'no vender después de cierre',
    )
    await rejects(
      () =>
        call('record_expense', {
          requestId: crypto.randomUUID(),
          incurredOn: date,
          category: 'renta',
          description: 'No debe guardarse',
          amount: 1,
          currency: 'NIO',
          exchangeRate: 1,
          account: 'caja',
        }),
      /cerrada/,
      'no alterar gastos después de cierre',
    )
    dailyReports.push({
      date,
      invoices: closed.report.invoices,
      units: closed.report.units,
      expectedNio: closed.report.expectedNio,
      expectedUsd: closed.report.expectedUsd,
    })
    console.log(
      `PASS jornada ${dayIndex + 1}/${days}: 40 facturas, 4 proformas, 3 compras, 1 devolución; inventario, auxiliares, caja y mayor conciliados`,
    )
  }
  for (const uid of [operator, warehouse, viewer, outsider]) {
    await identity(db, uid)
    await rejects(() =>
      db.query('select public.ledger_report($1,$2)', ['2026-09-01', date]),
    )
    await rejects(() => db.query('select public.credit_accounts($1)', [date]))
    await rejects(() =>
      db.query('select public.sales_journal_entries($1,$2)', [
        '2026-09-01',
        date,
      ]),
    )
    await rejects(() =>
      call('open_business_day', {
        requestId: crypto.randomUUID(),
        openingNio: 0,
        openingUsd: 0,
      }),
    )
    equal(
      (await db.query('select * from public.journal_entries')).rows.length,
      0,
      'asientos protegidos por rol',
    )
  }
  await identity(db, admin)
  const first = (
    await get('select public.get_business_day($1) r', ['2026-09-01'])
  ).r
  equal(
    cents(first.report.expectedNio),
    cents(dailyReports[0].expectedNio),
    'cierre histórico no cambia con jornadas posteriores',
  )
  const finalLedger = (
    await get('select public.ledger_report($1,$2) r', ['2026-09-01', date])
  ).r
  const finalAccount = (code) =>
    finalLedger.accounts.find((account) => account.code === code).closing
  const automatic = (
    await get('select public.sales_journal_entries($1,$2) r', [
      '2026-09-01',
      date,
    ])
  ).r
  equal(automatic.length, days * 2, 'dos comprobantes automáticos por jornada')
  for (const report of automaticReports) {
    for (const kind of ['sales', 'sales_cost']) {
      const actual = automatic.find(
        (entry) => entry.occurred_on === report.date && entry.kind === kind,
      )
      assert.ok(actual, `${report.date} ${kind} disponible`)
      equal(actual.automatic, true, 'comprobante automático identificado')
      equal(actual.missingCosts, 0, 'comprobante automático completo')
      equal(
        actual.reference,
        '39 factura(s)',
        'devolución excluida del resumen',
      )
      equal(
        actual.lines.length,
        report[kind].size,
        'cuentas automáticas completas',
      )
      for (const line of actual.lines) {
        const expected = report[kind].get(line.account)
        assert.ok(expected, `cuenta ${line.account} esperada en ${kind}`)
        equal(
          cents(line.debit_nio),
          expected.debit,
          'debe automático independiente',
        )
        equal(
          cents(line.credit_nio),
          expected.credit,
          'haber automático independiente',
        )
      }
    }
  }
  await db.exec('reset role')
  const counts = await get(
    "select (select count(*)::int from public.documents where kind='invoice') invoices,(select count(*)::int from public.documents where kind='proforma') proformas,(select count(*)::int from public.document_items i join public.documents d on d.id=i.document_id where d.kind='invoice') invoice_lines,(select count(*)::int from public.purchase_shipments) purchases,(select count(*)::int from public.business_days where closed_at is not null) closed_days",
  )
  equal(counts.invoices, invoices, 'número final de facturas sin duplicados')
  equal(counts.proformas, proformas, 'número final de proformas')
  equal(counts.invoice_lines, invoiceLines, 'renglones finales')
  equal(counts.purchases, purchases, 'número final de compras')
  equal(counts.closed_days, days, 'todas las jornadas cerradas')
  const result = {
    isolated: true,
    engine: 'PGlite, PostgreSQL WASM',
    days,
    products: products.length,
    createdInvoices: invoices + refunds,
    activeInvoices: invoices,
    refunds,
    invoiceLines,
    proformas,
    purchases,
    soldUnits,
    rpcOperations: operations,
    assertions: checks,
    automaticSalesVouchers: automatic.length,
    seconds: money((performance.now() - started) / 1000),
    closingBalances: {
      cashNio,
      cashUsd,
      inventoryNio: finalAccount('1130'),
      revenueNio: -finalAccount('4110'),
      costOfSalesNio: finalAccount('5120'),
      writeOffNio: finalAccount('5150'),
      countGainNio: -finalAccount('4190'),
      receivableNio: finalAccount('1140'),
      payableNio: -finalAccount('2111'),
      unsettledCardNio: finalAccount('1142'),
      cardCommissionNio: finalAccount('5140-001'),
      withholdingNio: finalAccount('1340'),
    },
    dailyReports,
  }
  await mkdir('output/extended-store-review', { recursive: true })
  await writeFile(
    'output/extended-store-review/summary.json',
    JSON.stringify(result, null, 2),
  )
  console.log(
    `PASS prueba prolongada: ${checks} verificaciones; ${days} jornadas; ${invoices + refunds} facturas emitidas; ${invoiceLines} renglones vigentes; ${proformas} proformas; ${purchases} compras; ${result.seconds} s`,
  )
} catch (error) {
  console.error(`FAIL prueba prolongada día ${date}: ${error.stack}`)
  process.exitCode = 1
} finally {
  await db.close()
}

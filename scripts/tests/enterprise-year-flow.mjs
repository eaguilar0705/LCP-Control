import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
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
const resumeDirectory = process.env.LCP_SIMULATION_RESUME
const resumed = resumeDirectory
  ? JSON.parse(await readFile(`${resumeDirectory}/state.json`, 'utf8'))
  : null
const db = resumed
  ? new PGlite({
      loadDataDir: new Blob([
        await readFile(`${resumeDirectory}/database.tar.gz`),
      ]),
    })
  : await database()
const started = performance.now()
const elapsedBefore = resumed?.elapsedMs ?? 0
const artifactDirectory =
  process.env.LCP_SIMULATION_OUTPUT ?? 'output/enterprise-year-review'
const days = Number(process.env.LCP_SIMULATION_DAYS ?? 365)
assert.ok(
  Number.isInteger(days) && days >= 1 && days <= 365,
  'LCP_SIMULATION_DAYS debe ser un entero entre 1 y 365',
)
const salesPerDay = Number(process.env.LCP_SIMULATION_SALES ?? 60)
assert.ok(
  Number.isInteger(salesPerDay) && salesPerDay >= 20 && salesPerDay <= 100,
)
const checkpointEvery = Number(
  process.env.LCP_SIMULATION_CHECKPOINT_EVERY ?? 15,
)
assert.ok(Number.isInteger(checkpointEvery) && checkpointEvery >= 1)
const savedDocuments = new Map()
const issuerProfile = {
  name: 'Prueba prolongada aislada',
  legal_name: 'Perfumería aislada de simulación anual',
  tax_id: 'J0000000000000',
  address: 'Dirección ficticia de la prueba, Managua',
  phone: '+50588880000',
  email: 'simulacion@example.invalid',
  branch: 'Sucursal de prueba aislada',
  billing_details: 'Datos íntegros con acentos: revisión anual',
}
let persistedHeaderChecks = 0
let persistedItemChecks = 0
let atomicFailures = 0
const startDate = '2026-09-01'
const simulatedDate = (index) =>
  new Date(Date.UTC(2026, 8, 1 + index)).toISOString().slice(0, 10)
const shipmentQuantity = days > 30 ? 12 : 6
const products = []
const accounts = new Map()
const receivables = []
const payables = []
const dailyReports = []
const automaticReports = []
const immutableDocuments = []
const revisionReports = []
const monthlyModels = new Map()
let reportServer
let dormantProduct
let catalogEdits = 0
let reopenings = 0
let staleWritesRejected = 0
let checks = 0
let operations = 0
let minute = 0
let date = startDate
let cashNio = 500000
let cashUsd = 500
let invoices = 0
let proformas = 0
let invoiceLines = 0
let purchases = 0
let bankWithdrawals = 0
let refunds = 0
let soldUnits = 0
const rate = 36.6
// Las entradas llegan en decimales. El modelo usa microunidades enteras para
// ponderar el costo y división half-up, igual que NUMERIC, sin leer el costo
// calculado por la base para ajustar el esperado.
const divideHalfUp = (numerator, denominator) => {
  assert.ok(denominator > 0n)
  if (numerator < 0n) return -divideHalfUp(-numerator, denominator)
  return (numerator * 2n + denominator) / (denominator * 2n)
}
const scaled = (amount, places) => {
  const text = Number(amount).toFixed(9)
  const negative = text.startsWith('-')
  const digits = BigInt(text.replace('-', '').replace('.', ''))
  const rounded = divideHalfUp(digits, 10n ** BigInt(9 - places))
  return negative ? -rounded : rounded
}
const micros = (amount) => scaled(amount, 6)
const cents = (amount) => Number(scaled(amount, 2)) || 0
const money = (amount) => cents(amount) / 100
const six = (amount) => Number(micros(amount)) / 1e6
const weightedAverage = (average, units, landed, quantity) =>
  Number(
    divideHalfUp(
      micros(average) * BigInt(units) + micros(landed) * BigInt(quantity),
      BigInt(units + quantity),
    ),
  ) / 1e6
const landedCost = (price, freight, exchangeRate) =>
  Number(
    divideHalfUp(
      (micros(price) + micros(freight)) * micros(exchangeRate),
      1000000n,
    ),
  ) / 1e6
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
    notes:
      'Venta aislada ' +
      date +
      ' · referencia ' +
      saleIndex +
      ' · observación íntegra con acentos y número ' +
      dayIndex,
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
function rememberDocument(result, payload, snapshots = null) {
  const expectedItems = payload.items.map((item) => {
    const product = itemProduct(item)
    const snapshot = snapshots?.find(
      (entry) => entry.product.id === item.productId,
    )
    return {
      productId: product.id,
      description:
        'Marca de prueba · ' +
        product.name +
        (product.size ? ' · ' + product.size + ' ml' : ''),
      quantity: item.quantity,
      unitPrice: product.prices[payload.currency],
      average: snapshot?.average ?? null,
      revenue: snapshot?.revenue ?? null,
    }
  })
  savedDocuments.set(result.id, {
    id: result.id,
    number: result.number,
    kind: payload.kind,
    total: money(
      expectedItems.reduce(
        (sum, item) => sum + item.quantity * item.unitPrice,
        0,
      ),
    ),
    payload: structuredClone(payload),
    createdBy: payload.kind === 'invoice' ? operator : admin,
    items: expectedItems,
  })
}
async function verifyDocuments(ids, label) {
  const actualDocuments = (
    await db.query('select * from public.documents where id=any($1::uuid[])', [
      ids,
    ])
  ).rows
  equal(actualDocuments.length, ids.length, label + ': cabeceras completas')
  const actualItems = (
    await db.query(
      'select i.*,c.unit_cost_nio,c.net_revenue_nio,c.tax_nio,c.exchange_rate cost_rate,c.quantity cost_quantity from public.document_items i left join public.document_item_costs c on c.document_item_id=i.id where i.document_id=any($1::uuid[])',
      [ids],
    )
  ).rows
  const itemsByDocument = new Map()
  for (const item of actualItems) {
    if (!itemsByDocument.has(item.document_id))
      itemsByDocument.set(item.document_id, [])
    itemsByDocument.get(item.document_id).push(item)
  }
  for (const actual of actualDocuments) {
    const expected = savedDocuments.get(actual.id)
    const payload = expected.payload
    equal(actual.number, expected.number, label + ': número persistido')
    equal(actual.kind, expected.kind, label + ': tipo independiente')
    equal(actual.customer_id, payload.customerId, label + ': cliente')
    const customerIndex = Number(payload.customerId.slice(-12))
    equal(
      actual.customer_phone,
      '505' + String(80000000 + customerIndex),
      label + ': teléfono del cliente',
    )
    equal(
      actual.customer_tax_id,
      'RUC-CLIENTE-' + customerIndex,
      label + ': identificación del cliente',
    )
    equal(
      actual.customer_name,
      'Cliente ' + Number(payload.customerId.slice(-12)),
      label + ': instantánea cliente',
    )
    equal(actual.tier_code, payload.tier, label + ': lista')
    equal(actual.currency, payload.currency, label + ': moneda')
    equal(cents(Number(actual.total)), cents(expected.total), label + ': total')
    equal(actual.notes, payload.notes, label + ': nota completa')
    equal(actual.created_by, expected.createdBy, label + ': autor')
    for (const [key, value] of Object.entries(issuerProfile))
      equal(actual.issuer[key], value, label + ': datos del negocio ' + key)
    near(
      Number(actual.catalog_rate),
      rate,
      0.0000011,
      label + ': cambio del catálogo',
    )
    equal(
      actual.location,
      payload.kind === 'invoice' ? payload.location : null,
      label + ': ubicación',
    )
    equal(
      actual.payment_method,
      payload.kind === 'invoice' ? payload.paymentMethod : null,
      label + ': pago',
    )
    equal(
      actual.valid_until
        ? new Date(actual.valid_until).toISOString().slice(0, 10)
        : null,
      payload.kind === 'proforma' ? payload.validUntil : null,
      label + ': vigencia',
    )
    assert.deepEqual(
      actual.request_payload,
      payload,
      label + ': petición completa para reintentos',
    )
    checks++
    persistedHeaderChecks++
    const items = itemsByDocument.get(actual.id) ?? []
    equal(
      items.length,
      expected.items.length,
      label + ': todos los renglones persistidos',
    )
    const itemMap = new Map(items.map((item) => [item.product_id, item]))
    for (const expectedItem of expected.items) {
      const item = itemMap.get(expectedItem.productId)
      assert.ok(item, label + ': producto ' + expectedItem.productId)
      checks++
      equal(
        item.description,
        expectedItem.description,
        label + ': descripción histórica',
      )
      equal(item.quantity, expectedItem.quantity, label + ': cantidad')
      equal(
        cents(Number(item.unit_price)),
        cents(expectedItem.unitPrice),
        label + ': precio unitario',
      )
      equal(
        cents(Number(item.line_total)),
        cents(expectedItem.quantity * expectedItem.unitPrice),
        label + ': importe',
      )
      if (expected.kind === 'invoice') {
        equal(
          micros(item.unit_cost_nio),
          micros(expectedItem.average),
          label + ': instantánea de costo',
        )
        equal(
          item.cost_quantity,
          expectedItem.quantity,
          label + ': cantidad valorizada',
        )
        equal(
          cents(Number(item.net_revenue_nio)),
          cents(expectedItem.revenue),
          label + ': ingreso neto',
        )
        equal(Number(item.tax_nio), 0, label + ': sin IVA')
        near(
          Number(item.cost_rate),
          payload.exchangeRate,
          0.0000011,
          label + ': cambio histórico',
        )
      } else
        equal(
          item.unit_cost_nio,
          null,
          label + ': cotización sin costo de venta',
        )
      persistedItemChecks++
    }
  }
}
async function fingerprint() {
  return (
    await get(
      "select jsonb_build_object('documents',(select count(*) from public.documents),'items',(select count(*) from public.document_items),'costs',(select count(*) from public.document_item_costs),'movements',(select count(*) from public.inventory_movements),'stock',(select jsonb_agg(to_jsonb(b) order by product_id,location) from public.inventory_balances b),'counters',(select jsonb_agg(to_jsonb(c) order by kind) from private.document_counters c)) value",
    )
  ).value
}
async function rejectAtomic(payload, pattern, label) {
  await db.exec('reset role')
  const before = await fingerprint()
  await identity(db, operator)
  await rejects(() => call('create_document', payload), pattern, label)
  await db.exec('reset role')
  const after = await fingerprint()
  assert.deepEqual(after, before, label + ': rollback íntegro')
  checks++
  atomicFailures++
  await identity(db, admin)
}
function checkpointState(nextDayIndex) {
  return {
    nextDayIndex,
    days,
    salesPerDay,
    shipmentQuantity,
    elapsedMs: elapsedBefore + performance.now() - started,
    products,
    accounts: [...accounts],
    receivables,
    payables,
    dailyReports,
    automaticReports: automaticReports.map((row) => ({
      ...row,
      sales: [...row.sales],
      sales_cost: [...row.sales_cost],
    })),
    immutableDocuments,
    revisionReports,
    monthlyModels: [...monthlyModels].map(([month, row]) => [
      month,
      {
        ...row,
        opening: [...row.opening],
        closing: row.closing ? [...row.closing] : null,
      },
    ]),
    savedDocuments: [...savedDocuments],
    dormantProduct,
    catalogEdits,
    reopenings,
    staleWritesRejected,
    checks,
    operations,
    minute,
    date,
    cashNio,
    cashUsd,
    invoices,
    proformas,
    invoiceLines,
    purchases,
    bankWithdrawals,
    refunds,
    soldUnits,
    persistedHeaderChecks,
    persistedItemChecks,
    atomicFailures,
  }
}
async function saveCheckpoint(
  nextDayIndex,
  label = String(nextDayIndex).padStart(3, '0'),
) {
  const directory = `${artifactDirectory}/checkpoints/day-${label}`
  await mkdir(directory, { recursive: true })
  await db.exec('reset role')
  const dump = await db.dumpDataDir('gzip')
  await writeFile(
    `${directory}/database.tar.gz`,
    new Uint8Array(await dump.arrayBuffer()),
  )
  await writeFile(
    `${directory}/state.json`,
    JSON.stringify(checkpointState(nextDayIndex)),
  )
  await identity(db, admin)
  console.log(`CHECKPOINT guardado: ${directory}`)
}
function restoreCheckpoint(state) {
  assert.ok(
    state.nextDayIndex >= 0 && state.nextDayIndex <= days,
    'El checkpoint debe ser de una jornada completada',
  )
  assert.equal(
    state.salesPerDay,
    salesPerDay,
    'Conservar ventas por día al reanudar',
  )
  assert.equal(
    state.shipmentQuantity,
    shipmentQuantity,
    'Conservar cantidades de reposición al reanudar',
  )
  products.push(...state.products)
  for (const [key, value] of state.accounts) accounts.set(key, value)
  for (const [key, value] of state.savedDocuments)
    savedDocuments.set(key, value)
  receivables.push(...state.receivables)
  payables.push(...state.payables)
  dailyReports.push(...state.dailyReports)
  automaticReports.push(
    ...state.automaticReports.map((row) => ({
      ...row,
      sales: new Map(row.sales),
      sales_cost: new Map(row.sales_cost),
    })),
  )
  immutableDocuments.push(...state.immutableDocuments)
  revisionReports.push(...state.revisionReports)
  for (const [month, row] of state.monthlyModels)
    monthlyModels.set(month, {
      ...row,
      opening: new Map(row.opening),
      closing: row.closing ? new Map(row.closing) : undefined,
    })
  dormantProduct = state.dormantProduct
  catalogEdits = state.catalogEdits
  reopenings = state.reopenings
  staleWritesRejected = state.staleWritesRejected
  checks = state.checks
  operations = state.operations
  minute = state.minute
  date = state.date
  cashNio = state.cashNio
  cashUsd = state.cashUsd
  invoices = state.invoices
  proformas = state.proformas
  invoiceLines = state.invoiceLines
  purchases = state.purchases
  bankWithdrawals = state.bankWithdrawals ?? 0
  refunds = state.refunds
  soldUnits = state.soldUnits
  persistedHeaderChecks = state.persistedHeaderChecks
  persistedItemChecks = state.persistedItemChecks
  atomicFailures = state.atomicFailures
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
  const creditMap = new Map(
    credits.rows.map((credit) => [
      `${credit.documentId}:${credit.shipmentId}`,
      credit,
    ]),
  )
  for (const debt of [...receivables, ...payables]) {
    const row = creditMap.get(`${debt.documentId}:${debt.shipmentId}`)
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
      equal(
        micros(actual.average_cost_nio),
        micros(product.average),
        `costo promedio ${product.sku}`,
      )
    }
  }
  return current
}

try {
  if (resumed) {
    restoreCheckpoint(resumed)
    await tick()
    await identity(db, admin)
    console.log(`RESUME desde jornada ${resumed.nextDayIndex + 1}`)
  } else {
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
    await db.query(
      'update public.business_settings set legal_name=$1,tax_id=$2,address=$3,phone=$4,email=$5,branch=$6,billing_details=$7 where id',
      [
        issuerProfile.legal_name,
        issuerProfile.tax_id,
        issuerProfile.address,
        issuerProfile.phone,
        issuerProfile.email,
        issuerProfile.branch,
        issuerProfile.billing_details,
      ],
    )
    await db.query(
      'insert into public.exchange_rates(id,usd_to_nio) values(true,$1) on conflict(id) do update set usd_to_nio=excluded.usd_to_nio',
      [rate],
    )
    for (let index = 0; index < 20; index++) {
      await db.query(
        "insert into public.customers(id,name,price_tier,phone,tax_id) values($1,$2,'emprendedor',$3,$4)",
        [
          customerId(index),
          `Cliente ${index + 1}`,
          '505' + String(80000000 + index + 1),
          'RUC-CLIENTE-' + (index + 1),
        ],
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
        name: `Perfume ${index + 1}`,
      }
      await db.query(
        'insert into public.products(id,sku,name,brand_id) values($1,$2,$3,(select id from public.brands limit 1))',
        [product.id, product.sku, product.name],
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
    dormantProduct = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      revision: 0,
      name: 'Perfume de temporada',
      brand: 'Marca de prueba',
      category: 'designer',
      gender: 'unisex',
      size: 100,
      unit: 'ml',
      manufacturerBarcode: '',
      minimumStock: 0,
      active: true,
      imagePath: null,
      prices: {
        emprendedor: { USD: 25 },
        vip: { USD: 24 },
        premium: { USD: 23 },
      },
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
    await call('save_catalog_product', dormantProduct)
    dormantProduct.revision = 1
    catalogEdits++
  }
  for (let dayIndex = resumed?.nextDayIndex ?? 0; dayIndex < days; dayIndex++) {
    date = simulatedDate(dayIndex)
    const month = date.slice(0, 7)
    if (!monthlyModels.has(month))
      monthlyModels.set(month, {
        from: date,
        opening: dayIndex === 0 ? new Map() : new Map(accounts),
      })
    const purchasesBefore = purchases
    minute = 0
    await tick()
    await identity(db, admin)
    const openInput = {
      requestId: crypto.randomUUID(),
      expectedDay: date,
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
    // Mantener un fondo real de caja para las compras. Si falta efectivo pero
    // hay dinero en BAC C$, se retira del banco con su comprobante: no se
    // inventa efectivo ni se intenta contar una cantidad física negativa.
    if (cashNio < 300000) {
      const withdrawal = 500000
      assert.ok(
        (accounts.get('1120-001') ?? 0) >= cents(withdrawal),
        'El retiro debe tener respaldo en el banco pagador',
      )
      await call(
        'record_journal_entry',
        voucher(
          'transfer',
          [
            { account: '1110-001', debit: withdrawal, credit: 0 },
            { account: '1120-001', debit: 0, credit: withdrawal },
          ],
          {
            description: 'Retiro de BAC C$ para el fondo de caja',
            reference: 'RETIRO-CAJA-' + date,
          },
        ),
      )
      post('1110-001', '1120-001', withdrawal)
      cashNio = money(cashNio + withdrawal)
      bankWithdrawals++
    }
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
          quantity: shipmentQuantity,
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
        const shippingPerUnit = six(
          shippingAmount /
            lines.reduce((sum, entry) => sum + entry.quantity, 0),
        )
        const landed = landedCost(line.unitPrice, shippingPerUnit, exchangeRate)
        product.average = weightedAverage(
          product.average,
          units,
          landed,
          line.quantity,
        )
        product[line.location] += line.quantity
      }
      purchases++
    }
    // Revisar existencias y reponer los productos con mayor salida es parte de
    // la operación diaria. No se inventan unidades ni se cambian saldos por SQL:
    // una compra real alimenta tanto inventario como cuentas por pagar.
    const demand = new Map()
    for (let saleIndex = 0; saleIndex < salesPerDay; saleIndex++) {
      const planned = invoice(
        dayIndex,
        saleIndex,
        dayIndex === 14 && saleIndex === 10 ? 100 : undefined,
      )
      for (const item of planned.items)
        demand.set(
          item.productId,
          (demand.get(item.productId) ?? 0) + item.quantity,
        )
    }
    const reorder = products.filter(
      (product) => product.store < (demand.get(product.id) ?? 0),
    )
    if (reorder.length) {
      const short = reorder[0]
      const invalid = {
        ...invoice(dayIndex, 0),
        items: [{ productId: short.id, quantity: short.store + 1 }],
      }
      await rejects(
        () => call('create_document', invalid),
        /insuficientes/,
        'no vender más existencias de las disponibles antes de reponer',
      )
      const restock = {
        requestId: crypto.randomUUID(),
        incurredOn: date,
        supplier: 'Reposición de perfumes de mayor demanda',
        reference: `REPOSICION-${date}`,
        agency: '',
        note: '',
        currency: 'NIO',
        exchangeRate: 1,
        shippingAmount: 0,
        account: 'credito',
        lines: reorder.map((product) => ({
          productId: product.id,
          location: 'store',
          quantity: (demand.get(product.id) ?? 0) - product.store + 12,
          unitPrice: money(product.average + 5 + (dayIndex % 7)),
        })),
      }
      const id = await call('record_shipment', restock)
      const goods = money(
        restock.lines.reduce(
          (sum, line) => sum + line.quantity * line.unitPrice,
          0,
        ),
      )
      post('1130', '2111', goods)
      payables.push({ shipmentId: id, documentId: null, balance: goods })
      for (const line of restock.lines) {
        const product = itemProduct(line)
        const units = product.store + product.warehouse
        product.average = weightedAverage(
          product.average,
          units,
          line.unitPrice,
          line.quantity,
        )
        product.store += line.quantity
      }
      purchases++
    }
    // Errores humanos deben rechazarse sin guardar cabeceras, líneas ni descontar stock.
    if (dayIndex % 7 === 0) {
      const bad = invoice(dayIndex, 2, 3)
      bad.items[2].quantity = 0
      await rejectAtomic(
        bad,
        /Cantidad|cantidad/,
        'cantidad cero tras renglones válidos',
      )
      const duplicate = invoice(dayIndex, 2, 2)
      duplicate.items.push(duplicate.items[0])
      await rejectAtomic(
        duplicate,
        /producto|product|duplic/i,
        'producto duplicado en factura',
      )
      const fractional = invoice(dayIndex, 2, 2)
      fractional.items[1].quantity = 1.5
      await rejectAtomic(fractional, /entera|entero/, 'cantidad fraccionaria')
    }
    await identity(db, operator)
    const dayInvoices = []
    for (let saleIndex = 0; saleIndex < salesPerDay; saleIndex++) {
      const payload = invoice(
        dayIndex,
        saleIndex,
        dayIndex === 14 && saleIndex === 10 ? 100 : undefined,
      )
      const result = await call('create_document', payload)
      const expected = modelSale(payload)
      rememberDocument(result, payload, expected.snapshots)
      if (cents(result.total) !== cents(expected.total)) {
        console.error(
          JSON.stringify(
            {
              dayIndex,
              saleIndex,
              currency: payload.currency,
              expected: expected.total,
              actual: result.total,
              products: payload.items.map((item) => ({
                ...item,
                expected: itemProduct(item).prices,
              })),
              actualLines: (
                await db.query(
                  'select i.description,i.product_id,i.unit_price from public.document_items i where i.document_id=$1',
                  [result.id],
                )
              ).rows,
            },
            null,
            2,
          ),
        )
      }
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
        if (dayIndex === 0 && saleIndex === 0)
          await rejects(
            () => call('create_document', quote),
            /insufficient_privilege/,
            'Caja no emite proformas',
          )
        await identity(db, admin)
        const q = await call('create_document', quote)
        rememberDocument(q, quote)
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
        await identity(db, operator)
      }
    }
    await identity(db, admin)
    // Se verifican todos los documentos de hoy antes de editar catálogo o devolver una venta.
    await verifyDocuments(
      [
        ...dayInvoices.map((entry) => entry.id),
        ...[...savedDocuments.values()]
          .filter(
            (entry) =>
              entry.kind === 'proforma' && entry.payload.validUntil === date,
          )
          .map((entry) => entry.id),
      ],
      'día ' + date,
    )
    immutableDocuments.push({
      id: dayInvoices[1].id,
      rows: (
        await db.query(
          'select i.description,i.quantity,i.unit_price,c.unit_cost_nio,c.net_revenue_nio from public.document_items i join public.document_item_costs c on c.document_item_id=i.id where i.document_id=$1 order by i.product_id',
          [dayInvoices[1].id],
        )
      ).rows,
    })
    // A real catalog edit changes future sales only. Previously issued invoices
    // must keep both the description/price and their weighted-cost snapshot.
    const changed = itemProduct(dayInvoices[1].payload.items[0])
    const beforeEdit = await get(
      'select revision from public.products where id=$1',
      [changed.id],
    )
    const editedUsd = money(changed.prices.USD + 0.15 + (dayIndex % 3) / 10)
    const edit = {
      ...dormantProduct,
      id: changed.id,
      revision: beforeEdit.revision,
      name: `${changed.name.split(' · ')[0]} · edición ${dayIndex + 1}`,
      manufacturerBarcode: String(7500000000000 + dayIndex),
      prices: {
        emprendedor: { USD: editedUsd },
        vip: { USD: money(editedUsd - 1) },
        premium: { USD: money(editedUsd - 2) },
      },
    }
    await call('save_catalog_product', edit)
    catalogEdits++
    changed.name = edit.name
    changed.size = edit.size
    changed.prices = { USD: editedUsd, NIO: money(editedUsd * rate) }
    await rejects(
      () =>
        call('save_catalog_product', {
          ...edit,
          name: 'Edición obsoleta que no debe guardarse',
        }),
      /Otro usuario/,
      'edición simultánea obsoleta rechazada',
    )
    staleWritesRejected++
    await rejects(
      () =>
        call('save_catalog_product', {
          ...edit,
          revision: beforeEdit.revision + 1,
          active: false,
        }),
      /existencias/,
      'no desactivar un perfume con existencias',
    )
    if (dayIndex % 5 === 0) {
      dormantProduct.active = false
      await call('save_catalog_product', dormantProduct)
      dormantProduct.revision++
      catalogEdits++
      const inactiveSale = {
        ...invoice(dayIndex, 1),
        items: [{ productId: dormantProduct.id, quantity: 1 }],
      }
      await rejects(
        () => call('create_document', inactiveSale),
        /inactivo|disponible/,
        'no vender un producto desactivado',
      )
      dormantProduct.active = true
      await call('save_catalog_product', dormantProduct)
      dormantProduct.revision++
      catalogEdits++
    }
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
    savedDocuments.delete(refund.id)
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
    monthlyModels.get(month).to = date
    monthlyModels.get(month).closing = new Map(accounts)
    equal(
      beforeClose.report.invoices,
      salesPerDay - 1,
      'ventas netas por jornada',
    )
    const close = {
      requestId: crypto.randomUUID(),
      day: date,
      countedNio: cashNio,
      countedUsd: cashUsd,
      note: '',
      expectedRevision: beforeClose.revision,
      expectedStateToken: beforeClose.stateToken,
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
    if (dayIndex % 7 === 0) {
      const closeSnapshot = JSON.parse(JSON.stringify(closed.report))
      const reopen = {
        requestId: crypto.randomUUID(),
        day: date,
        expectedRevision: closed.revision,
        reason: 'Cierre accidental: falta comprobar el informe de la jornada',
      }
      equal(
        (await call('reopen_business_day', reopen)).status,
        'open',
        'reapertura autorizada conserva la jornada',
      )
      reopenings++
      const reopened = await reconcile(dayIndex)
      equal(
        (await call('close_business_day', close)).status,
        'open',
        'reintento de cierre antiguo no vuelve a cerrar',
      )
      const recounted = {
        ...close,
        requestId: crypto.randomUUID(),
        expectedRevision: reopened.revision,
        expectedStateToken: reopened.stateToken,
        note: 'Arqueo confirmado después de la reapertura',
      }
      equal(
        (await call('close_business_day', recounted)).status,
        'closed',
        'nuevo cierre después de reapertura',
      )
      equal(
        (await call('reopen_business_day', reopen)).status,
        'closed',
        'reintento de reapertura antiguo no vuelve a abrir',
      )
      const history = (
        await get('select public.get_business_day_history($1) r', [date])
      ).r
      equal(
        history.length,
        3,
        'historial completo de cierre, reapertura y nuevo cierre',
      )
      const firstClose = history.find(
        (entry) =>
          entry.event === 'close' && entry.revision === closed.revision,
      )
      for (const key of Object.keys(closeSnapshot)) {
        assert.deepEqual(
          firstClose.report[key],
          closeSnapshot[key],
          `primer cierre inmutable: ${key}`,
        )
        checks++
      }
      revisionReports.push({ date, events: history.length })
    }
    await rejects(
      () =>
        call('create_document', {
          ...invoice(dayIndex, 41),
          items: [
            {
              productId: products.find((product) => product.store > 0).id,
              quantity: 1,
            },
          ],
        }),
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
      `PASS jornada ${dayIndex + 1}/${days}: ${salesPerDay} facturas, ${Math.ceil(salesPerDay / 10)} proformas, ${purchases - purchasesBefore} compras, 1 devolución; inventario, auxiliares, caja y mayor conciliados`,
    )
    if ((dayIndex + 1) % checkpointEvery === 0 || dayIndex + 1 === days)
      await saveCheckpoint(dayIndex + 1)
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
  for (const snapshot of immutableDocuments) {
    const currentRows = (
      await db.query(
        'select i.description,i.quantity,i.unit_price,c.unit_cost_nio,c.net_revenue_nio from public.document_items i join public.document_item_costs c on c.document_item_id=i.id where i.document_id=$1 order by i.product_id',
        [snapshot.id],
      )
    ).rows
    assert.deepEqual(
      currentRows,
      snapshot.rows,
      'facturas históricas conservan descripción, precio, costo y venta neta tras todas las compras y ediciones',
    )
    checks++
  }
  // Releer todas las facturas y proformas al final prueba que compras y cambios posteriores
  // no han reescrito los datos ya emitidos. Los lotes evitan enormes respuestas JSON.
  const persistedIds = [...savedDocuments.keys()]
  for (let offset = 0; offset < persistedIds.length; offset += 500)
    await verifyDocuments(
      persistedIds.slice(offset, offset + 500),
      'cierre anual',
    )
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
  reportServer = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../../frontend', import.meta.url)),
    cacheDir: fileURLToPath(
      new URL('../../output/cache/enterprise-year-tests', import.meta.url),
    ),
    server: { middlewareMode: true, hmr: false, ws: false },
    ssr: { noExternal: ['@lcp/contracts'] },
  })
  const { journalModel } = await reportServer.ssrLoadModule(
    '/src/features/accounting/journalModel.ts',
  )
  for (const period of [
    ...monthlyModels.values(),
    { from: startDate, to: date, opening: new Map(), closing: accounts },
  ]) {
    const ledger = (
      await get('select public.ledger_report($1,$2) r', [
        period.from,
        period.to,
      ])
    ).r
    for (const account of ledger.accounts) {
      equal(
        cents(account.opening),
        period.opening.get(account.code) ?? 0,
        `saldo inicial independiente ${period.from} ${account.code}`,
      )
      equal(
        cents(account.closing),
        period.closing.get(account.code) ?? 0,
        `saldo final independiente ${period.to} ${account.code}`,
      )
      equal(
        cents(account.debit - account.credit),
        (period.closing.get(account.code) ?? 0) -
          (period.opening.get(account.code) ?? 0),
        `movimiento mensual independiente ${account.code}`,
      )
    }
    const model = journalModel(ledger, 'Prueba prolongada aislada')
    assert.deepEqual(
      model.warnings,
      [],
      'los estados financieros reales no generan avisos de pendientes con toda la información cargada',
    )
    checks++
    for (const row of model.trial)
      for (const key of ['openingNio', 'debitNio', 'creditNio', 'closingNio']) {
        equal(
          typeof row[key],
          'number',
          `balanza sin pendiente: ${row.code} ${key}`,
        )
      }
    equal(
      cents(model.trialTotals.debitNio),
      cents(model.trialTotals.creditNio),
      'balanza de comprobación cuadra en la pantalla',
    )
    equal(
      cents(model.trialTotals.closingNio),
      0,
      'saldo neto de balanza igual a cero',
    )
    equal(
      cents(model.balance.left.at(-1).amount),
      cents(model.balance.right.at(-1).amount),
      'activo igual a pasivo más capital en el modelo de la pantalla',
    )
    equal(
      typeof model.income.at(-1).periodNio,
      'number',
      'utilidad del período sin pendiente',
    )
    equal(
      typeof model.income.at(-1).accumulatedNio,
      'number',
      'utilidad acumulada sin pendiente',
    )
    const expectedProfit = [...period.closing]
      .filter(([code]) => /^[45]/.test(code))
      .reduce(
        (sum, [code, value]) => sum - value + (period.opening.get(code) ?? 0),
        0,
      )
    equal(
      cents(model.income.at(-1).periodNio),
      expectedProfit,
      'utilidad independiente coincide con la pantalla',
    )
  }
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
        `${salesPerDay - 1} factura(s)`,
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
    productionDataTouched: false,
    salesPerDay,
    persistedHeaderChecks,
    persistedItemChecks,
    distinctDocumentsVerified: savedDocuments.size + refunds,
    bankWithdrawals,
    rejectedHumanErrorsWithoutPartialWrites: atomicFailures,
    engine: 'PGlite, PostgreSQL WASM',
    days,
    products: products.length,
    createdInvoices: invoices + refunds,
    activeInvoices: invoices,
    refunds,
    catalogEdits,
    staleWritesRejected,
    reopenings,
    preservedInvoiceSnapshots: immutableDocuments.length,
    completeAccountingPeriods: monthlyModels.size + 1,
    preservedCloseHistories: revisionReports,
    invoiceLines,
    proformas,
    purchases,
    soldUnits,
    rpcOperations: operations,
    assertions: checks,
    automaticSalesVouchers: automatic.length,
    seconds: money((elapsedBefore + performance.now() - started) / 1000),
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
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(
    `${artifactDirectory}/summary.json`,
    JSON.stringify(result, null, 2),
  )
  console.log(
    `PASS prueba prolongada: ${checks} verificaciones; ${days} jornadas; ${invoices + refunds} facturas emitidas; ${invoiceLines} renglones vigentes; ${proformas} proformas; ${purchases} compras; ${result.seconds} s`,
  )
} catch (error) {
  console.error(`FAIL prueba prolongada día ${date}: ${error.stack}`)
  try {
    await db.exec('reset role')
    await mkdir(artifactDirectory, { recursive: true })
    await writeFile(
      `${artifactDirectory}/failure.json`,
      JSON.stringify(
        {
          date,
          message: error.message,
          stack: error.stack,
          checks,
          operations,
          completedDays: dailyReports.length,
          products,
          expectedAccounts: [...accounts],
          actualInventory: (
            await db.query(
              'select b.*,c.average_cost_nio from public.inventory_balances b left join public.product_costs c on c.product_id=b.product_id order by b.product_id,b.location',
            )
          ).rows,
          actualLedger: (
            await get('select public.ledger_report($1,$2) r', [startDate, date])
          ).r,
          todayPostings: (
            await db.query(
              'select * from private.operational_postings where day=$1',
              [date],
            )
          ).rows,
        },
        null,
        2,
      ),
    )
    await saveCheckpoint(-1, 'failed-' + date)
  } catch (snapshotError) {
    console.error(
      'No se pudo exportar el fallo aislado:',
      snapshotError.message,
    )
  }
  process.exitCode = 1
} finally {
  await reportServer?.close()
  await db.close()
}

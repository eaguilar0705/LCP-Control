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
const equal = (actual, expected, reason) => {
  assert.deepEqual(actual, expected, reason)
  checks++
}
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
try {
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Administración','superadmin'),($2,'Ventas','operator')",
    [admin, operator],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Auditoría de comprobantes'); insert into public.brands(name) values('Marca');",
  )
  await db.query(
    "insert into public.products(id,sku,name,brand_id) values($1,'QA-AUTO','Perfume',(select id from public.brands limit 1));",
    [product],
  )
  await db.query(
    "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',100),($1,'warehouse',0)",
    [product],
  )
  await db.query(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,100)',
    [product],
  )
  await db.query(
    "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',200),($1,'emprendedor','USD',10)",
    [product],
  )
  await db.query(
    "insert into public.products(id,sku,name,brand_id) values($1,'QA-AUTO-2','Perfume segundo',(select id from public.brands limit 1))",
    [other],
  )
  await db.query(
    "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',100),($1,'warehouse',0)",
    [other],
  )
  await db.query(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,100)',
    [other],
  )
  await db.query(
    "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',200)",
    [other],
  )
  await identity(db, admin)
  const today = (
    await db.query(
      "select (now() at time zone 'America/Managua')::date::text as day",
    )
  ).rows[0].day
  const vouchers = async () =>
    (
      await db.query('select public.sales_journal_entries($1,$2) r', [
        today,
        today,
      ])
    ).rows[0].r
  const ledger = async () =>
    (await db.query('select public.ledger_report($1,$2) r', [today, today]))
      .rows[0].r
  equal(
    await vouchers(),
    [],
    'Sin apertura no se inventan comprobantes contables',
  )
  await rpc(db, 'record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: today,
    description: 'Saldos iniciales',
    reference: 'QA',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1130', debit: 20000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 20000 },
    ],
  })
  await rpc(db, 'open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 0,
    openingUsd: 0,
    note: '',
  })
  const sell = (paymentMethod, currency = 'NIO', kind = 'invoice') =>
    rpc(db, 'create_document', {
      requestId: crypto.randomUUID(),
      kind,
      customerName: 'Cliente',
      tier: 'emprendedor',
      currency,
      exchangeRate: currency === 'USD' ? 36.6 : 1,
      location: 'store',
      paymentMethod,
      notes: '',
      validUntil: today,
      items: [{ productId: product, quantity: 1 }],
    })
  const cash = await sell('cash')
  await sell('bac_nio')
  await sell('lafise_nio')
  await sell('ficohsa_usd', 'USD')
  await sell('pending')
  await sell('card_pos')
  await sell('cash', 'NIO', 'proforma')
  const before = await ledger()
  const entries = await vouchers()
  equal(entries.length, 2, 'Una venta consolidada y un costo separado por día')
  const sales = entries.find((e) => e.kind === 'sales'),
    cost = entries.find((e) => e.kind === 'sales_cost')
  equal(
    sales.reference,
    '6 factura(s)',
    'La proforma no genera ingreso ni costo',
  )
  equal(
    sales.lines.find((l) => l.account === '4110').credit,
    1366,
    'Ingresos incluyen USD a su tipo de cambio histórico',
  )
  equal(
    sales.lines.find((l) => l.account === '1110-001').debit,
    200,
    'Caja separada de bancos y pendientes',
  )
  equal(
    sales.lines.find((l) => l.account === '1120-001').debit,
    200,
    'Transferencia BAC en su cuenta',
  )
  equal(
    sales.lines.find((l) => l.account === '1120-003').debit,
    200,
    'Transferencia LAFISE en su cuenta',
  )
  equal(
    sales.lines.find((l) => l.account === '1120-006').debit,
    366,
    'Transferencia Ficohsa USD convertida',
  )
  equal(
    sales.lines.find((l) => l.account === '1140').debit,
    200,
    'Crédito separado en cuentas por cobrar',
  )
  equal(
    sales.lines.find((l) => l.account === '1142').debit,
    200,
    'Tarjeta pendiente de acreditar, sin depósito ficticio',
  )
  equal(
    cost.lines.map((l) => l.account),
    ['1130', '5120'],
    'Costo afecta inventario/costo, nunca caja/ventas',
  )
  equal(
    cost.lines.find((l) => l.account === '5120').debit,
    600,
    'Costo histórico consolidado',
  )
  equal(
    sales.lines.reduce((s, l) => s + l.debit, 0),
    sales.lines.reduce((s, l) => s + l.credit, 0),
    'Comprobante de ventas balanceado',
  )
  equal(
    cost.lines.reduce((s, l) => s + l.debit, 0),
    cost.lines.reduce((s, l) => s + l.credit, 0),
    'Comprobante de costo balanceado',
  )
  equal(
    await vouchers(),
    entries,
    'Lectura repetible sin duplicar comprobantes',
  )
  equal(
    await ledger(),
    before,
    'Consultar comprobantes no altera ningún saldo del mayor',
  )
  equal(
    before.entries.length,
    1,
    'No inserta ventas duplicadas en journal_entries',
  )
  await db.query('select public.delete_invoice($1)', [cash.id])
  const after = await vouchers()
  equal(
    after
      .find((e) => e.kind === 'sales')
      .lines.find((l) => l.account === '4110').credit,
    1166,
    'Eliminar factura actualiza ingresos automáticamente',
  )
  equal(
    after
      .find((e) => e.kind === 'sales_cost')
      .lines.find((l) => l.account === '5120').debit,
    500,
    'Eliminar factura actualiza costo automáticamente',
  )
  await db.exec('reset role')
  await db.query(
    "update public.document_item_costs set unit_cost_nio=null where document_id=(select id from public.documents where kind='invoice' limit 1)",
  )
  await identity(db, admin)
  const missing = (await vouchers()).find((e) => e.kind === 'sales_cost')
  equal(missing.missingCosts, 1, 'Costo histórico desconocido señalado')
  equal(
    missing.lines.find((l) => l.account === '5120').debit,
    null,
    'No se presenta suma parcial como costo definitivo',
  )
  equal(
    missing.lines.find((l) => l.account === '1130').credit,
    null,
    'Inventario tampoco oculta el costo desconocido',
  )
  // Corrupción histórica simulada sólo en esta base descartable: un día con
  // media foto contable y otro sin ninguna fila no pueden aparentar completos.
  await db.exec('reset role')
  await db.exec('update public.document_item_costs set unit_cost_nio=100')
  await identity(db, admin)
  const finish = async (date) => {
    const report = (await db.query('select public.get_business_day(null) r'))
      .rows[0].r.report
    await rpc(db, 'close_business_day', {
      requestId: crypto.randomUUID(),
      day: date,
      countedNio: report.expectedNio,
      countedUsd: report.expectedUsd,
      note: '',
    })
  }
  await finish(today)
  const secondDay = new Date(`${today}T12:00:00Z`)
  secondDay.setUTCDate(secondDay.getUTCDate() + 1)
  const thirdDay = new Date(secondDay)
  thirdDay.setUTCDate(thirdDay.getUTCDate() + 1)
  const later = secondDay.toISOString().slice(0, 10),
    last = thirdDay.toISOString().slice(0, 10)
  await db.exec('reset role')
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$ select current_setting('lcp.test_now')::timestamptz $$",
  )
  await db.exec('discard plans')
  await db.query("select set_config('lcp.test_now',$1,false)", [
    `${later}T15:00:00Z`,
  ])
  await identity(db, admin)
  await rpc(db, 'open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 0,
    openingUsd: 0,
    note: '',
  })
  const partial = await rpc(db, 'create_document', {
    requestId: crypto.randomUUID(),
    kind: 'invoice',
    customerName: 'Detalle parcial',
    tier: 'emprendedor',
    currency: 'NIO',
    exchangeRate: 1,
    location: 'store',
    paymentMethod: 'cash',
    notes: '',
    items: [
      { productId: product, quantity: 1 },
      { productId: other, quantity: 1 },
    ],
  })
  await finish(later)
  await db.exec('reset role')
  await db.query(
    'delete from public.document_item_costs where document_id=$1 and product_id=$2',
    [partial.id, other],
  )
  await db.query("select set_config('lcp.test_now',$1,false)", [
    `${last}T15:00:00Z`,
  ])
  await identity(db, admin)
  await rpc(db, 'open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 400,
    openingUsd: 0,
    note: '',
  })
  const absent = await sell('bac_nio')
  await db.exec('reset role')
  await db.query(
    'delete from public.document_item_costs where document_id=$1',
    [absent.id],
  )
  await identity(db, admin)
  const all = (
    await db.query('select public.sales_journal_entries($1,$2) r', [
      today,
      last,
    ])
  ).rows[0].r
  equal(
    all.length,
    6,
    'Días con filas contables faltantes conservan ambos comprobantes',
  )
  for (const date of [later, last]) {
    for (const kind of ['sales', 'sales_cost']) {
      const entry = all.find((e) => e.occurred_on === date && e.kind === kind)
      equal(
        entry.missingSales,
        1,
        `${date} ${kind}: falta de detalle detectada`,
      )
      equal(
        entry.reference,
        '1 factura(s)',
        `${date} ${kind}: factura no desaparece`,
      )
      equal(
        entry.lines.every(
          (line) => line.debit === null && line.credit === null,
        ),
        true,
        `${date} ${kind}: no presenta suma incompleta como definitiva`,
      )
      equal(
        entry.lines.length >= 2,
        true,
        `${date} ${kind}: muestra cuentas aun sin ningún snapshot`,
      )
    }
  }
  equal(
    all
      .find((e) => e.occurred_on === today && e.kind === 'sales')
      .lines.find((l) => l.account === '4110').credit,
    1166,
    'Otros días completos conservan sus importes conocidos',
  )
  equal(
    all
      .find((e) => e.occurred_on === today && e.kind === 'sales_cost')
      .lines.find((l) => l.account === '5120').debit,
    500,
    'Otros días completos conservan su costo conocido',
  )
  await identity(db, operator)
  await assert.rejects(vouchers(), /privilege|permiso|42501/)
  checks++
  await identity(db, '', 'anon')
  await assert.rejects(vouchers(), /permission denied/)
  checks++
  console.log(
    `OK: ${checks} comprobaciones de comprobantes automáticos de ventas y costo`,
  )
} finally {
  await db.close()
}

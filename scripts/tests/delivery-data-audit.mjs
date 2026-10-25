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

// Sólo PostgreSQL desechable: no red, cuentas reales ni datos de producción.
const db = await database()
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const historical = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const day = '2026-10-15'
let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const call = (name, input) => rpc(db, name, input)
const query = async (sql, args = []) => (await db.query(sql, args)).rows
async function owner(sql, args = []) {
  await db.exec('reset role')
  try {
    return await query(sql, args)
  } finally {
    await db.exec('set role authenticated')
  }
}
const clock = (value) =>
  db.query("select set_config('lcp.test_now',$1,false)", [value])
const currentDay = async () =>
  (await query('select public.get_business_day(null) r'))[0].r
const ledger = async (to = day) =>
  (await query('select public.ledger_report($1,$2) r', [day, to]))[0].r
const invoice = (changes = {}) => ({
  requestId: crypto.randomUUID(),
  kind: 'invoice',
  customerName: 'Cliente de auditoría de entrega',
  tier: 'emprendedor',
  currency: 'NIO',
  exchangeRate: 1,
  paymentMethod: 'cash',
  location: 'store',
  notes: '',
  expectedTotal: 200,
  items: [{ productId: product, quantity: 1, expectedUnitPrice: 200 }],
  ...changes,
})
async function reject(work, pattern) {
  await db.exec('savepoint rejected_operation')
  try {
    await assert.rejects(work, pattern)
    checks++
  } finally {
    await db.exec('rollback to savepoint rejected_operation')
    await db.exec('release savepoint rejected_operation')
  }
}
async function scenario(name, work) {
  await db.exec('begin')
  try {
    await work()
    console.log(`PASS ${name}`)
  } finally {
    await db.exec('rollback')
    await identity(db, admin)
  }
}
async function snapshot() {
  return (
    await owner(`select jsonb_build_object(
      'documents',(select jsonb_agg(to_jsonb(t) order by id) from public.documents t),
      'customers',(select jsonb_agg(to_jsonb(t) order by id) from public.customers t),
      'counters',(select jsonb_agg(to_jsonb(t) order by kind) from private.document_counters t),
      'balances',(select jsonb_agg(to_jsonb(t) order by product_id,location) from public.inventory_balances t),
      'costs',(select jsonb_agg(to_jsonb(t) order by product_id) from public.product_costs t),
      'movements',(select jsonb_agg(to_jsonb(t) order by id) from public.inventory_movements t),
      'finance',(select jsonb_agg(to_jsonb(t) order by id) from public.finance_entries t),
      'deletions',(select jsonb_agg(to_jsonb(t) order by id) from private.document_deletions t)
    ) r`)
  )[0].r
}
async function close() {
  const state = await currentDay()
  return call('close_business_day', {
    requestId: crypto.randomUUID(),
    day: state.day,
    countedNio: state.report.expectedNio,
    countedUsd: state.report.expectedUsd,
    expectedRevision: state.revision,
    expectedStateToken: state.stateToken,
    note: '',
  })
}
const collection = (documentId, amount, date = day) => ({
  requestId: crypto.randomUUID(),
  occurredOn: date,
  kind: 'collection',
  account: 'caja',
  amount,
  currency: 'NIO',
  exchangeRate: 1,
  description: 'Abono de auditoría',
  documentId,
})

try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.test_now')::timestamptz$$",
  )
  await clock(`${day}T14:00:00Z`)
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Administración','superadmin'),($2,'Ventas','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer')",
    [admin, operator, warehouse, viewer],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Auditoría de entrega'); insert into public.brands(name) values('Marca de auditoría')",
  )
  for (const [id, name, price, cost] of [
    [product, 'Perfume uno', 200, 100],
    [second, 'Perfume dos', 300, 120],
    [historical, 'Perfume histórico', 250, null],
  ]) {
    await db.query(
      'insert into public.products(id,sku,name,brand_id) values($1,$2,$3,(select id from public.brands limit 1))',
      [id, name, name],
    )
    await db.query(
      "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',10),($1,'warehouse',5)",
      [id],
    )
    if (cost !== null)
      await db.query(
        'insert into public.product_costs(product_id,average_cost_nio) values($1,$2)',
        [id, cost],
      )
    await db.query(
      "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',$2),($1,'emprendedor','USD',10)",
      [id, price],
    )
  }
  await identity(db, admin)
  await call('record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: day,
    description: 'Saldos iniciales de auditoría',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1110-001', debit: 1000, credit: 0 },
      { account: '1130', debit: 3300, credit: 0 },
      { account: '3110-001', debit: 0, credit: 4300 },
    ],
  })
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 1000,
    openingUsd: 0,
  })

  await scenario(
    'un precio nuevo no puede cambiar el importe confirmado',
    async () => {
      const input = invoice()
      await owner(
        "update public.product_prices set amount=300 where product_id=$1 and currency='NIO'",
        [product],
      )
      const before = await snapshot()
      await reject(
        () => call('create_document', input),
        /Los precios cambiaron/,
      )
      eq(
        await snapshot(),
        before,
        'rechazo sin cliente, numeración ni salida parcial',
      )
      const result = await call('create_document', {
        ...input,
        expectedTotal: 300,
        items: [{ productId: product, quantity: 1, expectedUnitPrice: 300 }],
      })
      eq(result.total, 300, 'después de revisar se acepta el precio vigente')
      eq((await ledger()).missingCosts, 0)
    },
  )

  await scenario(
    'cambios opuestos se detectan aunque conserven el total',
    async () => {
      const input = invoice({
        expectedTotal: 500,
        items: [
          { productId: product, quantity: 1, expectedUnitPrice: 200 },
          { productId: second, quantity: 1, expectedUnitPrice: 300 },
        ],
      })
      await owner(
        "update public.product_prices set amount=case when product_id=$1 then 250 else 250 end where product_id in ($1,$2) and currency='NIO'",
        [product, second],
      )
      const before = await snapshot()
      await reject(
        () => call('create_document', input),
        /Los precios cambiaron/,
      )
      eq(await snapshot(), before)
      await reject(
        () =>
          call('create_document', {
            ...input,
            kind: 'proforma',
            validUntil: day,
          }),
        /Los precios cambiaron/,
      )
      eq(
        await snapshot(),
        before,
        'la proforma tampoco cambia precios silenciosamente',
      )
    },
  )

  await scenario(
    'validación monetaria y compatibilidad sin reinterpretar reintentos',
    async () => {
      for (const value of [null, '200', -1, 200.001]) {
        const before = await snapshot()
        await reject(
          () => call('create_document', invoice({ expectedTotal: value })),
          /numérico/,
        )
        eq(await snapshot(), before)
      }
      for (const value of [null, '200', -1, 200.001]) {
        await reject(
          () =>
            call(
              'create_document',
              invoice({
                items: [
                  { productId: product, quantity: 1, expectedUnitPrice: value },
                ],
              }),
            ),
          /numérico/,
        )
      }
      // El cliente puede declarar sólo el total; no permite fijar precios propios.
      eq(
        (
          await call(
            'create_document',
            invoice({ items: [{ productId: product, quantity: 1 }] }),
          )
        ).total,
        200,
      )
      const legacy = invoice()
      delete legacy.expectedTotal
      delete legacy.items[0].expectedUnitPrice
      eq((await call('create_document', legacy)).total, 200)
      const input = invoice()
      const result = await call('create_document', input)
      await owner(
        "update public.product_prices set amount=400 where product_id=$1 and currency='NIO'",
        [product],
      )
      const frozen = await close()
      const before = await snapshot()
      eq(
        (await call('create_document', input)).id,
        result.id,
        'respuesta perdida recupera la factura original tras cierre y cambio',
      )
      eq(await snapshot(), before)
      eq((await currentDay()).report, frozen.report)
      await reject(
        () => call('create_document', { ...input, expectedTotal: 400 }),
        /otros datos/,
      )
    },
  )

  await scenario(
    'cobrar mañana no duplica ventas ni altera el cierre de ayer',
    async () => {
      const credit = await call(
        'create_document',
        invoice({ paymentMethod: 'pending' }),
      )
      const frozen = await close()
      await clock('2026-10-16T14:00:00Z')
      await call('open_business_day', {
        requestId: crypto.randomUUID(),
        openingNio: 1000,
        openingUsd: 0,
      })
      const input = collection(credit.id, 50, '2026-10-16')
      const payment = await call('record_finance_entry', input)
      eq(
        await call('record_finance_entry', input),
        payment,
        'abono repetido no cobra dos veces',
      )
      eq((await currentDay()).report.expectedNio, 1050)
      const report = await ledger('2026-10-16')
      eq(report.accounts.find((a) => a.code === '4110').credit, 200)
      eq(report.accounts.find((a) => a.code === '1140').closing, 150)
      const old = (
        await query('select public.get_business_day($1) r', [day])
      )[0].r
      eq(old.report, frozen.report, 'arqueo anterior permanece exacto')
      const before = await snapshot()
      await reject(
        () =>
          db.query('select public.delete_invoice($1,$2)', [
            credit.id,
            'Venta cerrada',
          ]),
        /cerrada|abonos/,
      )
      eq(
        await snapshot(),
        before,
        'rechazo conserva existencias, costo y bitácora',
      )
      await reject(
        () =>
          call(
            'record_finance_entry',
            collection(credit.id, 151, '2026-10-16'),
          ),
        /supera/,
      )
      eq(await snapshot(), before)
      const debts = (
        await query('select public.credit_accounts($1) r', ['2026-10-16'])
      )[0].r
      eq(debts.rows.find((row) => row.documentId === credit.id).balanceNio, 150)
    },
  )

  await scenario(
    'compra, devolución y merma conservan el costo entre ubicaciones',
    async () => {
      const sale = await call(
        'create_document',
        invoice({
          expectedTotal: 1000,
          items: [{ productId: product, quantity: 5, expectedUnitPrice: 200 }],
        }),
      )
      await call('record_shipment', {
        requestId: crypto.randomUUID(),
        incurredOn: day,
        supplier: 'Proveedor',
        currency: 'NIO',
        exchangeRate: 1,
        shippingAmount: 0,
        account: 'credito',
        lines: [
          {
            productId: product,
            quantity: 10,
            unitPrice: 200,
            location: 'warehouse',
          },
        ],
      })
      eq(
        Number(
          (
            await query(
              'select average_cost_nio from public.product_costs where product_id=$1',
              [product],
            )
          )[0].average_cost_nio,
        ),
        150,
      )
      eq(
        (
          await query(
            'select unit_cost_nio from public.document_item_costs where document_id=$1',
            [sale.id],
          )
        )[0].unit_cost_nio,
        '100.000000',
        'la compra no reescribe el costo vendido',
      )
      await db.query('select public.delete_invoice($1,$2)', [
        sale.id,
        'Cambio autorizado de venta de hoy',
      ])
      eq(
        Number(
          (
            await query(
              'select average_cost_nio from public.product_costs where product_id=$1',
              [product],
            )
          )[0].average_cost_nio,
        ),
        140,
      )
      eq((await ledger()).accounts.find((a) => a.code === '1130').closing, 5300)
      const movement = {
        requestId: crypto.randomUUID(),
        productId: product,
        location: 'store',
        type: 'DAMAGED',
        quantity: 3,
        note: 'Frascos dañados',
      }
      const id = await call('record_inventory_movement', movement)
      eq(await call('record_inventory_movement', movement), id)
      const report = await ledger()
      eq(report.accounts.find((a) => a.code === '5150').debit, 420)
      eq(report.accounts.find((a) => a.code === '1130').closing, 4880)
      eq(
        report.accounts.find((a) => a.code === '4190').credit,
        0,
        'devolución no inventa ganancia por conteo',
      )
      eq(report.missingCosts, 0)
    },
  )

  await scenario(
    'datos históricos incompletos siguen pendientes sin contaminar ventas nuevas',
    async () => {
      await owner(
        'insert into public.product_costs(product_id,average_cost_nio) values($1,90)',
        [historical],
      )
      const old = await call(
        'create_document',
        invoice({
          expectedTotal: 250,
          items: [
            { productId: historical, quantity: 1, expectedUnitPrice: 250 },
          ],
        }),
      )
      // Representa un snapshot heredado, sin permitirlo en ventas nuevas.
      await owner(
        'update public.document_item_costs set unit_cost_nio=null where document_id=$1',
        [old.id],
      )
      const fresh = await call(
        'create_document',
        invoice({
          expectedTotal: 250,
          items: [
            { productId: historical, quantity: 1, expectedUnitPrice: 250 },
          ],
        }),
      )
      eq(
        (
          await query(
            'select unit_cost_nio from public.document_item_costs where document_id=$1',
            [old.id],
          )
        )[0].unit_cost_nio,
        null,
      )
      eq(
        (
          await query(
            'select unit_cost_nio from public.document_item_costs where document_id=$1',
            [fresh.id],
          )
        )[0].unit_cost_nio,
        '90.000000',
      )
      eq(
        (await ledger()).missingCosts,
        1,
        'el costo actual no inventa el histórico ausente',
      )
      const vouchers = (
        await query('select public.sales_journal_entries($1,$2) r', [day, day])
      )[0].r
      eq(vouchers.find((item) => item.kind === 'sales_cost').missingCosts, 1)
    },
  )

  await scenario(
    'permisos revocados se aplican aun conservando la sesión anterior',
    async () => {
      await identity(db, operator)
      const input = invoice()
      const result = await call('create_document', input)
      await owner(
        'update public.staff_members set active=false where user_id=$1',
        [operator],
      )
      const before = await snapshot()
      await reject(
        () => call('create_document', invoice()),
        /privilege|permission/,
      )
      await reject(() => call('create_document', input), /privilege|permission/)
      eq(
        (await query('select * from public.documents where id=$1', [result.id]))
          .length,
        0,
        'RLS retira lectura inmediatamente',
      )
      eq(await snapshot(), before)
      for (const person of [warehouse, viewer]) {
        await identity(db, person)
        await reject(
          () => call('create_document', invoice()),
          /privilege|permission/,
        )
        await reject(
          () => query('select public.ledger_report($1,$2)', [day, day]),
          /privilege|permission/,
        )
      }
    },
  )
  console.log(
    `Auditoría de datos para entrega: ${checks} verificaciones correctas; sin red ni producción.`,
  )
} finally {
  await db.close()
}

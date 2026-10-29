import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import {
  database,
  identity,
  rpc,
  admin,
  warehouse,
  viewer,
  operator,
} from './database-fixture.mjs'
const db = await database()
let checks = 0
const scenarios = []
const eq = (actual, expected, why) => {
  assert.deepEqual(actual, expected, why)
  checks++
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const owner = async (sql, args = []) => {
  await db.exec('reset role')
  try {
    return await one(sql, args)
  } finally {
    await db.exec('set role authenticated')
  }
}
const call = (name, input) => rpc(db, name, input)
async function rejects(work, pattern) {
  await db.exec('savepoint expected_failure')
  try {
    await assert.rejects(work, pattern)
  } finally {
    await db.exec(
      'rollback to savepoint expected_failure; release savepoint expected_failure',
    )
  }
}
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000101'
const empty = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000102'
const scenariosRun = async (label, work) => {
  await db.exec('begin')
  try {
    await identity(db, admin)
    await work()
    scenarios.push(label)
    console.log('PASS ' + label)
  } finally {
    await db.exec('rollback')
    await identity(db, admin)
  }
}
const state = () =>
  owner(
    'select quantity,value_nio::text from private.inventory_value_balances where product_id=$1',
    [product],
  )
let today
const ledger = async () =>
  (await one('select public.ledger_report($1,$1) r', [today])).r
const account = (book, code) => book.accounts.find((a) => a.code === code)
async function sale(quantity = 1) {
  const price = (
    await one(
      "select amount from public.product_prices where product_id=$1 and tier_code='emprendedor' and currency='NIO'",
      [product],
    )
  ).amount
  return call('create_document', {
    requestId: crypto.randomUUID(),
    kind: 'invoice',
    customerName: 'Cliente de valorización',
    customerPhone: '',
    tier: 'emprendedor',
    currency: 'NIO',
    exchangeRate: 1,
    paymentMethod: 'cash',
    location: 'store',
    expectedTotal: Number(price) * quantity,
    items: [{ productId: product, quantity, expectedUnitPrice: Number(price) }],
  })
}
const costs = () =>
  one(
    'select sum(coalesce(total_cost_nio,round(quantity*unit_cost_nio,2)))::text total from public.document_item_costs',
  )
const preview = async () =>
  (await one('select public.inventory_valuation_preview() r')).r
try {
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Admin','superadmin'),($2,'Inventario','warehouse'),($3,'Consulta','viewer'),($4,'Caja','operator')",
    [admin, warehouse, viewer, operator],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Valorización aislada'); insert into public.brands(name) values('Marca');",
  )
  for (const [id, sku, qty, avg] of [
    [product, 'VAL-01', 15, 1033.333333],
    [empty, 'VAL-02', 0, null],
  ]) {
    await db.query(
      "insert into public.products(id,sku,name,brand_id) values($1,$2,'Perfume para valor exacto',(select id from public.brands limit 1))",
      [id, sku],
    )
    await db.query(
      "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',$2),($1,'warehouse',0)",
      [id, qty],
    )
    if (avg !== null)
      await db.query(
        'insert into public.product_costs(product_id,average_cost_nio) values($1,$2)',
        [id, avg],
      )
    await db.query(
      "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',2000)",
      [id],
    )
  }
  await identity(db, admin)
  today = (
    await one(
      "select (now() at time zone 'America/Managua')::date::text as day",
    )
  ).day
  await call('record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: today,
    description: 'Saldo inicial exacto',
    reference: 'VAL',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1130', debit: 15500, credit: 0 },
      { account: '3110-001', debit: 0, credit: 15500 },
    ],
  })
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 0,
    openingUsd: 0,
    expectedDay: today,
  })
  await scenariosRun(
    '15 ventas separadas agotan exactamente el valor C$15500',
    async () => {
      for (let i = 0; i < 15; i++) {
        const doc = await sale()
        eq(doc.items.length, 1)
        const current = await state()
        eq(current.quantity, 14 - i)
        eq(Number(current.value_nio) >= 0, true)
      }
      eq(await costs(), { total: '15500.00' })
      eq(await state(), { quantity: 0, value_nio: '0.00' })
      const book = await ledger()
      eq(account(book, '1130').closing, 0)
      eq(account(book, '5120').debit, 15500)
      eq(book.missingCosts, 0)
      const digest = (
        await one('select public.report_digest($1,$1) r', [today])
      ).r
      eq(
        JSON.stringify(digest).includes('15500'),
        true,
        'digest conserva total reconocido',
      )
    },
  )
  await scenariosRun(
    'Venta agrupada y partidas separadas reconocen el mismo total',
    async () => {
      await sale(15)
      eq(await costs(), { total: '15500.00' })
      eq(account(await ledger(), '1130').closing, 0)
    },
  )
  await scenariosRun(
    'Anular devuelve el costo total histórico y conserva el valor pendiente',
    async () => {
      await sale(4)
      const document = await sale(5)
      const before = await state()
      const cost = Number(
        (
          await one(
            'select total_cost_nio from public.document_item_costs where document_id=$1',
            [document.id],
          )
        ).total_cost_nio,
      )
      await db.query('select public.delete_invoice($1,$2)', [
        document.id,
        'Error de cantidades',
      ])
      const after = await state()
      eq(after.quantity, before.quantity + 5)
      eq(
        Math.round(Number(after.value_nio) * 100),
        Math.round((Number(before.value_nio) + cost) * 100),
      )
      eq(
        Math.round(account(await ledger(), '1130').closing * 100),
        Math.round(Number(after.value_nio) * 100),
      )
    },
  )
  await scenariosRun(
    'Mermas y diferencias de conteo consumen exactamente el saldo',
    async () => {
      await sale(7)
      await call('record_inventory_movement', {
        requestId: crypto.randomUUID(),
        productId: product,
        location: 'store',
        type: 'DAMAGED',
        quantity: 3,
        note: 'Daño real',
      })
      await call('record_inventory_movement', {
        requestId: crypto.randomUUID(),
        productId: product,
        location: 'store',
        type: 'ADJUSTMENT',
        quantity: 0,
        note: 'Conteo físico final',
      })
      eq(await state(), { quantity: 0, value_nio: '0.00' })
      eq(account(await ledger(), '1130').closing, 0)
    },
  )
  await scenariosRun(
    'Una compra nueva conserva el costo total exacto y después se agota',
    async () => {
      await sale(15)
      await call('record_shipment', {
        requestId: crypto.randomUUID(),
        incurredOn: today,
        supplier: 'Proveedor',
        reference: 'VAL-COMPRA',
        currency: 'NIO',
        exchangeRate: 1,
        account: 'credito',
        shippingAmount: 0,
        lines: [
          {
            productId: product,
            location: 'store',
            quantity: 11,
            unitPrice: 1234.57,
          },
        ],
      })
      eq((await state()).quantity, 11)
      eq(
        Math.round(Number((await state()).value_nio) * 100),
        Math.round(account(await ledger(), '1130').closing * 100),
      )
      await sale(3)
      await sale(7)
      await sale(1)
      eq(await state(), { quantity: 0, value_nio: '0.00' })
      eq(account(await ledger(), '1130').closing, 0)
    },
  )
  await scenariosRun(
    'El residuo histórico exige vista previa y motivo y no reescribe facturas',
    async () => {
      for (let i = 0; i < 15; i++) await sale()
      // Reproducir únicamente el formato anterior al despliegue: costo sin total.
      await owner(
        'update public.document_item_costs set total_cost_nio=null returning document_item_id',
      )
      eq(account(await ledger(), '1130').closing, 0.05)
      const before = await owner(
        'select jsonb_agg(to_jsonb(c) order by document_item_id) rows from public.document_item_costs c',
      )
      let p = await preview()
      eq(p.differenceNio, 0.05)
      const input = {
        requestId: crypto.randomUUID(),
        expectedToken: p.token,
        note: 'Regularización documentada de centavos históricos',
      }
      const id = await call('reconcile_inventory_value', input)
      eq(typeof id, 'string')
      eq(await call('reconcile_inventory_value', input), id)
      const recovered = (
        await one('select public.get_operation_confirmation($1,$2) r', [
          'inventory-valuation',
          input.requestId,
        ])
      ).r
      eq(recovered.status, 'confirmed')
      eq(
        recovered.id,
        id,
        'Recuperación tras recarga encuentra la conciliación exacta',
      )
      p = await preview()
      eq(p.differenceNio, 0)
      eq(account(await ledger(), '1130').closing, 0)
      eq(
        await owner(
          'select jsonb_agg(to_jsonb(c) order by document_item_id) rows from public.document_item_costs c',
        ),
        before,
        'snapshots históricos intactos',
      )
      eq(
        Number(
          (
            await owner(
              'select count(*) n from private.inventory_value_reconciliations',
            )
          ).n,
        ),
        1,
        'un solo registro de regularización',
      )
      const journal = await owner(
        'select journal_entry_id from private.inventory_value_reconciliations where id=$1',
        [id],
      )
      await rejects(
        () =>
          db.query('select public.void_journal_entry($1,$2)', [
            journal.journal_entry_id,
            'No borrar historial',
          ]),
        /conciliación/,
      )
      checks++
    },
  )
  await scenariosRun(
    'Vista previa obsoleta y cambios grandes no se disfrazan de redondeo',
    async () => {
      const p = await preview()
      await sale()
      await rejects(
        () =>
          call('reconcile_inventory_value', {
            requestId: crypto.randomUUID(),
            expectedToken: p.token,
            note: 'Vista vieja',
          }),
        /cambió/,
      )
      checks++
      await owner(
        "update public.inventory_balances set quantity=100 where product_id=$1 and location='store' returning product_id",
        [product],
      )
      const next = await preview()
      eq(Math.abs(next.differenceNio) > next.roundingLimitNio, true)
      await rejects(
        () =>
          call('reconcile_inventory_value', {
            requestId: crypto.randomUUID(),
            expectedToken: next.token,
            note: 'No inventar saldo',
          }),
        /supera un redondeo/,
      )
      checks++
    },
  )
  await scenariosRun(
    'Sin conteos o costos se explica qué completar y no se guarda una conciliación',
    async () => {
      await owner(
        "update public.inventory_balances set quantity=null where product_id=$1 and location='warehouse' returning product_id",
        [product],
      )
      const p = await preview()
      eq(p.uncounted, 1)
      await rejects(
        () =>
          call('reconcile_inventory_value', {
            requestId: crypto.randomUUID(),
            expectedToken: p.token,
            note: 'Datos pendientes',
          }),
        /conteos y costos/,
      )
      checks++
      eq(
        Number(
          (
            await owner(
              'select count(*) n from private.inventory_value_reconciliations',
            )
          ).n,
        ),
        0,
      )
    },
  )
  await scenariosRun(
    'El primer conteo pendiente de otra ubicación se reconoce como ganancia después de comenzar a vender',
    async () => {
      await owner(
        "update public.inventory_balances set quantity=null where product_id=$1 and location='warehouse' returning product_id",
        [product],
      )
      await sale()
      await call('record_inventory_movement', {
        requestId: crypto.randomUUID(),
        productId: product,
        location: 'warehouse',
        type: 'ADJUSTMENT',
        quantity: 5,
        note: 'Conteo físico completado después de la venta',
      })
      const value = await state()
      eq(value.quantity, 19)
      eq(Number(value.value_nio), 19633.34)
      const values = (await one('select public.inventory_value_rows(0,500) r'))
        .r
      eq(values.count, 2)
      eq(
        values.rows.find((row) => row.product_id === product)
          .inventory_value_nio,
        19633.34,
        'El KPI recibe el mismo valor exacto',
      )
      eq(account(await ledger(), '1130').closing, 19633.34)
      eq(
        (
          await owner(
            'select count(*)::int n from private.inventory_count_gains where product_id=$1',
            [product],
          )
        ).n,
        1,
      )
      await call('transfer_inventory', {
        requestId: crypto.randomUUID(),
        productId: product,
        fromLocation: 'warehouse',
        toLocation: 'store',
        quantity: 5,
        note: 'Traslado del conteo físico',
      })
      await sale(19)
      eq((await state()).quantity, 0)
      eq(Number((await state()).value_nio), 0)
      eq(account(await ledger(), '1130').closing, 0)
    },
  )
  await scenariosRun(
    'Descartar una conciliación no guardada bloquea su envío tardío sin crear un asiento',
    async () => {
      const p = await preview()
      const requestId = crypto.randomUUID()
      eq(
        (
          await one('select public.retire_unconfirmed_operation($1,$2) r', [
            'inventory-valuation',
            requestId,
          ])
        ).r.status,
        'retired',
      )
      const before = await owner(
        'select count(*)::int n from public.journal_entries',
      )
      await rejects(
        () =>
          call('reconcile_inventory_value', {
            requestId,
            expectedToken: p.token,
            note: 'Solicitud retirada antes del envío tardío',
          }),
        /descartad|retirad/,
      )
      eq(
        await owner('select count(*)::int n from public.journal_entries'),
        before,
      )
      eq(
        (
          await owner(
            'select count(*)::int n from private.inventory_value_reconciliations',
          )
        ).n,
        0,
      )
    },
  )
  await scenariosRun(
    'Un perfume sin unidades que ya tiene revisión de valor se desactiva conservando el historial',
    async () => {
      const p = await preview()
      await call('reconcile_inventory_value', {
        requestId: crypto.randomUUID(),
        expectedToken: p.token,
        note: 'Revisión sin diferencias antes de desactivar una referencia',
      })
      const row = await one(
        'select revision from public.products where id=$1',
        [empty],
      )
      const removed = (
        await one('select public.remove_catalog_product($1,$2) r', [
          empty,
          row.revision,
        ])
      ).r
      eq(removed, 'archived')
      eq(
        (await one('select active from public.products where id=$1', [empty]))
          .active,
        false,
      )
      eq(
        (
          await owner(
            'select quantity from private.inventory_value_balances where product_id=$1',
            [empty],
          )
        ).quantity,
        0,
      )
    },
  )
  await scenariosRun(
    'Sólo Administración consulta valores o confirma regularizaciones',
    async () => {
      for (const uid of [operator, warehouse, viewer]) {
        await identity(db, uid)
        await rejects(() => preview(), /permission|privilege/i)
        checks++
        await rejects(
          () => one('select public.inventory_value_rows(0,500)'),
          /permission|privilege/i,
        )
        checks++
        await rejects(
          () => db.query('select * from private.inventory_value_balances'),
          /permission/i,
        )
        checks++
      }
    },
  )
  await mkdir('output/inventory-value', { recursive: true })
  await writeFile(
    'output/inventory-value/resultados.json',
    JSON.stringify({ checks, scenarios, productionWrites: false }, null, 2),
  )
  console.log(
    `PASS valor exacto: ${checks} comprobaciones y ${scenarios.length} escenarios`,
  )
} finally {
  await db.close()
}

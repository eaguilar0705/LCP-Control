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
const day = '2026-11-07'
const superadmin = '66666666-6666-4666-8666-666666666666'
const inactive = '77777777-7777-4777-8777-777777777777'
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000001001'
const fractional = 'aaaaaaaa-aaaa-4aaa-8aaa-000000001002'
const unknown = 'aaaaaaaa-aaaa-4aaa-8aaa-000000001003'
let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const rejects = async (work, expected) => {
  await db.exec('savepoint expected_failure')
  try {
    await assert.rejects(work, expected)
    checks++
  } finally {
    await db.exec(
      'rollback to savepoint expected_failure; release savepoint expected_failure',
    )
  }
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
const call = (name, input) =>
  rpc(db, name, { requestId: crypto.randomUUID(), ...input })
const adjustment = (quantity, expectedQuantity, extra = {}) => ({
  requestId: crypto.randomUUID(),
  productId: product,
  location: 'store',
  type: 'ADJUSTMENT',
  quantity,
  expectedQuantity,
  reference: 'VOID-QA',
  note: 'Conteo registrado con un error de unidades',
  ...extra,
})
const state = (id = product) =>
  owner(
    `select b.quantity,v.value_nio::text,c.average_cost_nio::text
 from public.inventory_balances b left join private.inventory_value_balances v on v.product_id=b.product_id
 left join public.product_costs c on c.product_id=b.product_id where b.product_id=$1 and b.location='store'`,
    [id],
  )
const context = async (id) =>
  (await one('select public.inventory_adjustment_void_context($1) r', [id])).r
const voidInput = (ctx, extra = {}) => ({
  requestId: crypto.randomUUID(),
  movementId: ctx.movementId,
  stateToken: ctx.stateToken,
  reason: 'El conteo original tenía un error manual; se anula con trazabilidad',
  ...extra,
})
const blocked = async (id, expected) => {
  const ctx = await context(id)
  eq(ctx.canVoid, false)
  assert.match(ctx.blockedReason, expected)
  checks++
  await rejects(
    () => rpc(db, 'void_inventory_adjustment', voidInput(ctx)),
    expected,
  )
}
const book = async (from = day, to = day) =>
  (await one('select public.ledger_report($1,$2) r', [from, to])).r
const account = (report, code) =>
  report.accounts.find((row) => row.code === code)
const digest = async (from = day, to = day) =>
  (await one('select public.report_digest($1,$2) r', [from, to])).r
const movement = (id) =>
  owner(
    'select to_jsonb(m) row from public.inventory_movements m where id=$1',
    [id],
  )
const counts = () =>
  owner(`select jsonb_build_object(
 'movements',(select count(*) from public.inventory_movements),
 'journals',(select count(*) from public.journal_entries),
 'lines',(select count(*) from public.journal_lines)) r`)
const correctionEntry = (id) =>
  owner(
    'select entry_id from private.inventory_adjustment_journals where movement_id=$1',
    [id],
  )
const detail = async (id) =>
  (await one('select public.get_journal_entry($1) r', [id])).r
const lineAmounts = (entry) =>
  entry.lines.map((line) => [line.account, line.debit_nio, line.credit_nio])
const sale = (quantity) =>
  call('create_document', {
    kind: 'invoice',
    customerName: 'Cliente que ya compró',
    customerPhone: '',
    tier: 'emprendedor',
    currency: 'NIO',
    exchangeRate: 1,
    paymentMethod: 'cash',
    location: 'store',
    expectedTotal: quantity * 200,
    items: [{ productId: product, quantity, expectedUnitPrice: 200 }],
  })
const scenario = async (name, work, transactional = true) => {
  if (transactional) await db.exec('begin')
  try {
    await identity(db, superadmin)
    await work()
    console.log('PASS ' + name)
  } finally {
    if (transactional) await db.exec('rollback')
    await identity(db, superadmin)
  }
}

try {
  await db.exec(`create or replace function pg_catalog.now() returns timestamptz language sql stable
   as $$select '2026-11-07T20:00:00Z'::timestamptz$$;
   insert into private.pending_staff(email,display_name,role) values
   ('void-owner@example.test','Dueño de anulaciones','superadmin'),
   ('void-inactive@example.test','Dueño inactivo','superadmin')`)
  await db.query(
    `insert into auth.users(id,email) values
   ($1,'void-owner@example.test'),($2,'void-inactive@example.test')`,
    [superadmin, inactive],
  )
  await db.query(
    'update public.staff_members set active=false where user_id=$1',
    [inactive],
  )
  await db.query(
    `insert into public.staff_members(user_id,display_name,role) values
   ($1,'Admin','admin'),($2,'Caja','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer')`,
    [admin, operator, warehouse, viewer],
  )
  await db.exec(`insert into public.business_settings(name) values('Anulaciones de inventario QA');
   insert into public.brands(name) values('Marca para anular')`)
  for (const [id, sku, quantity, cost] of [
    [product, 'VOID-20', 20, 100],
    [fractional, 'VOID-CENTS', 3, 1033.333333],
    [unknown, 'VOID-UNKNOWN', null, null],
  ]) {
    await db.query(
      `insert into public.products(id,sku,name,brand_id)
     values($1,$2,'Perfume para anulación',(select id from public.brands limit 1))`,
      [id, sku],
    )
    await db.query(
      `insert into public.inventory_balances(product_id,location,quantity)
     values($1,'store',$2),($1,'warehouse',0)`,
      [id, quantity],
    )
    if (cost !== null)
      await db.query(
        'insert into public.product_costs(product_id,average_cost_nio) values($1,$2)',
        [id, cost],
      )
  }
  await db.query(
    `insert into public.product_prices(product_id,tier_code,currency,amount)
   values($1,'emprendedor','NIO',200)`,
    [product],
  )
  await identity(db, superadmin)
  await call('record_journal_entry', {
    kind: 'opening',
    occurredOn: day,
    description: 'Apertura antes de los ajustes equivocados',
    reference: 'VOID-QA',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1130', debit: 5100, credit: 0 },
      { account: '1110-001', debit: 1000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 6100 },
    ],
  })
  await call('open_business_day', {
    expectedDay: day,
    openingNio: 1000,
    openingUsd: 0,
  })

  await scenario(
    'La pérdida histórica se neutraliza sin borrar el movimiento',
    async () => {
      const input = adjustment(15, 20)
      const id = await rpc(db, 'record_inventory_movement', input)
      const original = (await movement(id)).row
      const frozen = await owner(
        'select to_jsonb(c) row from public.inventory_movement_costs c where movement_id=$1',
        [id],
      )
      eq(account(await book(), '5150').closing, 500)
      eq((await digest()).ledger.inventoryWriteOffNio, 500)
      const ctx = await context(id)
      eq(ctx.movementId, id)
      eq(ctx.beforeQuantity, 20)
      eq(ctx.afterQuantity, 15)
      eq(ctx.currentQuantity, 15)
      eq(ctx.resultingQuantity, 20)
      eq(ctx.quantityDelta, 5)
      eq(ctx.currentValueNio, 1500)
      eq(ctx.resultingValueNio, 2000)
      eq(ctx.valueDeltaNio, 500)
      eq(typeof ctx.stateToken, 'string')
      const payload = voidInput(ctx)
      const result = await rpc(db, 'void_inventory_adjustment', payload)
      eq(result.movementId, id)
      eq(typeof result.reversalMovementId, 'string')
      eq(typeof result.journalEntryId, 'string')
      eq(result.voidReason, payload.reason)
      eq(await state(), {
        quantity: 20,
        value_nio: '2000.00',
        average_cost_nio: '100.000000',
      })
      const saved = (await movement(id)).row
      eq(saved.void_reason, payload.reason)
      eq(saved.voided_by, superadmin)
      eq(typeof saved.voided_at, 'string')
      const unchanged = (row) =>
        Object.fromEntries(
          Object.entries(row).filter(
            ([key]) => !['voided_at', 'void_reason', 'voided_by'].includes(key),
          ),
        )
      eq(
        unchanged(saved),
        unchanged(original),
        'La anulación conserva el registro original completo',
      )
      const reversed = (await movement(result.reversalMovementId)).row
      eq(reversed.reversal_of, id)
      eq(reversed.before_quantity, 15)
      eq(reversed.after_quantity, 20)
      eq(reversed.actor_id, superadmin)
      eq(
        await owner(
          'select to_jsonb(c) row from public.inventory_movement_costs c where movement_id=$1',
          [id],
        ),
        frozen,
        'Se conserva el costo histórico de la pérdida',
      )
      eq(account(await book(), '5150').closing, 0)
      eq(account(await book(), '4190').closing, 0)
      eq(account(await book(), '1130').closing, 5100)
      eq((await digest()).ledger.inventoryWriteOffNio, 0)
      eq((await digest()).ledger.missingWriteOffUnits, 0)
      eq(
        lineAmounts(await detail(result.journalEntryId)).sort(),
        [
          ['1130', 500, 0],
          ['5150', 0, 500],
        ].sort(),
      )
      eq((await context(id)).canVoid, false)
      const beforeRetry = await counts()
      eq(await rpc(db, 'void_inventory_adjustment', payload), result)
      eq(
        await rpc(db, 'record_inventory_movement', input),
        id,
        'Reintentar el ajuste original anulado no vuelve a aplicarlo',
      )
      eq(await counts(), beforeRetry)
      await rejects(
        () =>
          rpc(db, 'void_inventory_adjustment', {
            ...payload,
            reason: 'Otro motivo distinto del original',
          }),
        /solicitud|datos|anulad|cambi/i,
      )
      await rejects(
        () =>
          rpc(db, 'void_inventory_adjustment', {
            ...payload,
            stateToken: 'otro-token',
          }),
        /solicitud|datos|anulad|cambi/i,
      )
      await rejects(
        () => rpc(db, 'void_inventory_adjustment', voidInput(ctx)),
        /anulad|existe/i,
      )
      await blocked(
        result.reversalMovementId,
        /anulaci|revers|original|manual|ajuste/i,
      )
    },
  )

  await scenario(
    'La corrección contra Capital se revierte contra la misma cuenta',
    async () => {
      const id = await rpc(
        db,
        'record_inventory_movement',
        adjustment(15, 20, {
          adjustmentKind: 'correction',
          counterAccount: '3110-001',
        }),
      )
      const originalEntry = await correctionEntry(id)
      const originalDetail = await detail(originalEntry.entry_id)
      const originalBook = await book()
      eq(account(originalBook, '1130').closing, 4600)
      eq(account(originalBook, '5150').closing, 0)
      const result = await rpc(
        db,
        'void_inventory_adjustment',
        voidInput(await context(id)),
      )
      eq(await state(), {
        quantity: 20,
        value_nio: '2000.00',
        average_cost_nio: '100.000000',
      })
      eq(
        lineAmounts(await detail(result.journalEntryId)).sort(),
        [
          ['1130', 500, 0],
          ['3110-001', 0, 500],
        ].sort(),
      )
      eq(
        await detail(originalEntry.entry_id),
        originalDetail,
        'El comprobante vinculado original no se modifica ni se anula por separado',
      )
      eq(account(await book(), '1130').closing, 5100)
      eq(account(await book(), '3110-001').closing, -6100)
      eq(account(await book(), '5150').closing, 0)
      eq(account(await book(), '4190').closing, 0)
      eq((await digest()).ledger.inventoryWriteOffNio, 0)
    },
  )

  await scenario(
    'Se conserva la contrapartida histórica aunque la cuenta esté inactiva',
    async () => {
      await owner(`insert into public.ledger_accounts(code,name,parent,bucket,nature)
       values('3110-098','Capital histórico QA','3110','equity','credit') returning code`)
      const id = await rpc(
        db,
        'record_inventory_movement',
        adjustment(25, 20, {
          adjustmentKind: 'correction',
          counterAccount: '3110-098',
        }),
      )
      await call('change_ledger_account', {
        action: 'deactivate',
        code: '3110-098',
        expectedRevision: 0,
      })
      const result = await rpc(
        db,
        'void_inventory_adjustment',
        voidInput(await context(id)),
      )
      eq(
        lineAmounts(await detail(result.journalEntryId)).sort(),
        [
          ['1130', 0, 500],
          ['3110-098', 500, 0],
        ].sort(),
      )
      eq(account(await book(), '3110-098').closing, 0)
      eq(account(await book(), '1130').closing, 5100)
      eq((await state()).quantity, 20)
      eq((await digest()).ledger.inventoryWriteOffNio, 0)
    },
  )

  await scenario(
    'Anular el sobrante respeta las ventas posteriores y sus costos congelados',
    async () => {
      const id = await rpc(db, 'record_inventory_movement', adjustment(25, 20))
      eq(account(await book(), '4190').closing, -500)
      const invoice = await sale(2)
      const salesBefore = await owner(
        `select jsonb_build_object(
     'document',(select to_jsonb(d) from public.documents d where id=$1),
     'costs',(select jsonb_agg(to_jsonb(c) order by document_item_id) from public.document_item_costs c where document_id=$1)) r`,
        [invoice.id],
      )
      const ctx = await context(id)
      eq(ctx.quantityDelta, -5)
      eq(ctx.currentQuantity, 23)
      eq(ctx.resultingQuantity, 18)
      eq(ctx.valueDeltaNio, -500)
      const result = await rpc(db, 'void_inventory_adjustment', voidInput(ctx))
      eq(await state(), {
        quantity: 18,
        value_nio: '1800.00',
        average_cost_nio: '100.000000',
      })
      eq(
        lineAmounts(await detail(result.journalEntryId)).sort(),
        [
          ['1130', 0, 500],
          ['4190', 500, 0],
        ].sort(),
      )
      eq(account(await book(), '4190').closing, 0)
      eq(account(await book(), '5150').closing, 0)
      eq(account(await book(), '5120').debit, 200)
      eq((await digest()).ledger.costOfSalesNio, 200)
      for (const movementId of [id, result.reversalMovementId]) {
        await rejects(
          () => one('select public.count_purchase_context($1)', [movementId]),
          /anulado|reversión/i,
        )
        await rejects(
          () =>
            call('adopt_inventory_counts_as_purchase', {
              movementIds: [movementId],
              expectedTotalNio: 500,
            }),
          /anulado|reversión/i,
        )
      }
      eq(
        await owner(
          `select jsonb_build_object(
     'document',(select to_jsonb(d) from public.documents d where id=$1),
     'costs',(select jsonb_agg(to_jsonb(c) order by document_item_id) from public.document_item_costs c where document_id=$1)) r`,
          [invoice.id],
        ),
        salesBefore,
        'La anulación no reescribe ventas ni recalcula sus costos',
      )
    },
  )

  await scenario(
    'La reversión usa el costo original aunque una compra posterior cambie el promedio',
    async () => {
      const id = await rpc(db, 'record_inventory_movement', adjustment(25, 20))
      await call('record_shipment', {
        incurredOn: day,
        supplier: 'Proveedor de costo nuevo',
        agency: '',
        reference: 'COSTO-POSTERIOR',
        note: '',
        currency: 'NIO',
        exchangeRate: 1,
        account: 'credito',
        shippingAmount: 0,
        lines: [
          {
            productId: product,
            location: 'store',
            quantity: 5,
            unitPrice: 200,
          },
        ],
      })
      eq((await state()).quantity, 30)
      eq((await state()).value_nio, '3500.00')
      eq(
        Math.abs(Number((await state()).average_cost_nio) - 3500 / 30) <
          0.00001,
        true,
      )
      const ctx = await context(id)
      eq(ctx.quantityDelta, -5)
      eq(
        ctx.valueDeltaNio,
        -500,
        'No valora las cinco unidades al promedio nuevo',
      )
      eq(ctx.resultingValueNio, 3000)
      const result = await rpc(db, 'void_inventory_adjustment', voidInput(ctx))
      eq(await state(), {
        quantity: 25,
        value_nio: '3000.00',
        average_cost_nio: '120.000000',
      })
      eq(
        lineAmounts(await detail(result.journalEntryId)).sort(),
        [
          ['1130', 0, 500],
          ['4190', 500, 0],
        ].sort(),
      )
      eq(account(await book(), '4190').closing, 0)
      eq(account(await book(), '1130').closing, 6100)
    },
  )

  await scenario(
    'Un conteo posterior invalida la previsualización; la nueva aplica sólo la diferencia original',
    async () => {
      const id = await rpc(db, 'record_inventory_movement', adjustment(15, 20))
      const stale = await context(id)
      await rpc(
        db,
        'record_inventory_movement',
        adjustment(16, 15, {
          adjustmentKind: 'correction',
          counterAccount: '3110-001',
        }),
      )
      const before = await counts()
      await rejects(
        () => rpc(db, 'void_inventory_adjustment', voidInput(stale)),
        /cambi|actualiz|vigent|revisa/i,
      )
      eq(
        await counts(),
        before,
        'Una previsualización obsoleta no deja movimientos ni asientos parciales',
      )
      const fresh = await context(id)
      eq(fresh.resultingQuantity, 21)
      eq(fresh.resultingValueNio, 2100)
      await rpc(db, 'void_inventory_adjustment', voidInput(fresh))
      eq(await state(), {
        quantity: 21,
        value_nio: '2100.00',
        average_cost_nio: '100.000000',
      })
      eq(account(await book(), '5150').closing, 0)
    },
  )

  await scenario(
    'Dos anulaciones concurrentes no duplican la devolución',
    async () => {
      const id = await rpc(db, 'record_inventory_movement', adjustment(15, 20))
      const ctx = await context(id)
      const before = await counts()
      const attempts = await Promise.allSettled([
        rpc(db, 'void_inventory_adjustment', voidInput(ctx)),
        rpc(db, 'void_inventory_adjustment', voidInput(ctx)),
      ])
      eq(attempts.filter((result) => result.status === 'fulfilled').length, 1)
      eq(attempts.filter((result) => result.status === 'rejected').length, 1)
      eq((await state()).quantity, 20)
      eq((await counts()).r.movements, before.r.movements + 1)
      eq(account(await book(), '5150').closing, 0)
    },
    false,
  )

  await scenario(
    'Anular conserva exactamente los centavos consumidos, incluso la última unidad',
    async () => {
      const id = await rpc(
        db,
        'record_inventory_movement',
        adjustment(2, 3, { productId: fractional }),
      )
      eq((await state(fractional)).value_nio, '2066.67')
      const ctx = await context(id)
      eq(ctx.valueDeltaNio, 1033.33)
      await rpc(db, 'void_inventory_adjustment', voidInput(ctx))
      eq((await state(fractional)).value_nio, '3100.00')
      eq((await state(fractional)).quantity, 3)
      const empty = await rpc(
        db,
        'record_inventory_movement',
        adjustment(0, 3, { productId: fractional }),
      )
      eq((await state(fractional)).value_nio, '0.00')
      eq((await context(empty)).valueDeltaNio, 3100)
      await rpc(
        db,
        'void_inventory_adjustment',
        voidInput(await context(empty)),
      )
      eq((await state(fractional)).value_nio, '3100.00')
      eq(account(await book(), '5150').closing, 0)
      eq((await digest()).ledger.inventoryWriteOffNio, 0)
    },
  )

  await scenario(
    'No se puede retirar un sobrante ya consumido ni dejar el valor negativo',
    async () => {
      const gain = await rpc(
        db,
        'record_inventory_movement',
        adjustment(25, 20),
      )
      await call('record_inventory_movement', {
        productId: product,
        location: 'store',
        type: 'EXIT',
        quantity: 24,
        note: 'Las unidades ya fueron retiradas antes de anular',
      })
      const before = await counts()
      await blocked(gain, /existencias|unidades|negativ|anular|cantidad/i)
      eq((await state()).quantity, 1)
      eq(await counts(), before)
      eq((await movement(gain)).row.voided_at, null)
    },
  )

  await scenario(
    'Una reversión no puede dejar valor negativo ni importe residual sin unidades',
    async () => {
      const gain = await rpc(
        db,
        'record_inventory_movement',
        adjustment(25, 20),
      )
      await call('record_inventory_movement', {
        productId: product,
        location: 'store',
        type: 'EXIT',
        quantity: 20,
        note: 'Quedan exactamente las cinco unidades del sobrante',
      })
      for (const value of [400, 600]) {
        // Simulate a later valuation correction independently of the count:
        // reversing the original C$500 must still leave a valid remainder.
        await owner(
          'update private.inventory_value_balances set value_nio=$2 where product_id=$1 returning product_id',
          [product, value],
        )
        await owner(
          'update public.product_costs set average_cost_nio=$2 where product_id=$1 returning product_id',
          [product, value / 5],
        )
        const before = await counts()
        await blocked(gain, /valorización|valor|costo|inválid/i)
        eq(await counts(), before)
        eq((await state()).quantity, 5)
        eq((await movement(gain)).row.voided_at, null)
      }
    },
  )

  await scenario(
    'Las autorizaciones y el motivo se comprueban también en el servidor',
    async () => {
      const id = await rpc(db, 'record_inventory_movement', adjustment(15, 20))
      const ctx = await context(id)
      const before = await counts()
      for (const who of [
        admin,
        operator,
        warehouse,
        viewer,
        inactive,
        outsider,
      ]) {
        await identity(db, who)
        await rejects(() => context(id), { code: '42501' })
        await rejects(
          () => rpc(db, 'void_inventory_adjustment', voidInput(ctx)),
          {
            code: '42501',
          },
        )
      }
      await identity(db, null, 'anon')
      await rejects(() => context(id), { code: '42501' })
      await rejects(
        () => rpc(db, 'void_inventory_adjustment', voidInput(ctx)),
        {
          code: '42501',
        },
      )
      await identity(db, superadmin)
      for (const reason of ['', '   ', 'x'.repeat(2001)])
        await rejects(
          () =>
            rpc(db, 'void_inventory_adjustment', voidInput(ctx, { reason })),
          /motivo|razón|longitud/i,
        )
      eq(await counts(), before)
      eq((await state()).quantity, 15)
    },
  )

  await scenario(
    'Un ajuste de jornada cerrada se revierte hoy, sin reabrir ni reescribir ayer',
    async () => {
      const id = await rpc(db, 'record_inventory_movement', adjustment(15, 20))
      const current = (await one('select public.get_business_day($1) r', [day]))
        .r
      await call('close_business_day', {
        day,
        expectedRevision: current.revision,
        expectedStateToken: current.stateToken,
        countedNio: current.report.expectedNio,
        countedUsd: current.report.expectedUsd,
        note: 'Cierre anterior',
      })
      const closed = await owner(
        'select to_jsonb(d) row from public.business_days d where day=$1',
        [day],
      )
      await db.exec('reset role')
      await db.exec(`create or replace function pg_catalog.now() returns timestamptz language sql stable
     as $$select '2026-11-08T20:00:00Z'::timestamptz$$; discard plans`)
      await identity(db, superadmin)
      await blocked(id, /jornada|abre|abierta/i)
      await call('open_business_day', {
        expectedDay: '2026-11-08',
        openingNio: 1000,
        openingUsd: 0,
      })
      const result = await rpc(
        db,
        'void_inventory_adjustment',
        voidInput(await context(id)),
      )
      eq((await detail(result.journalEntryId)).occurred_on, '2026-11-08')
      eq(account(await book(day, '2026-11-08'), '5150').closing, 0)
      eq((await digest(day, '2026-11-08')).ledger.inventoryWriteOffNio, 0)
      eq(
        account(await book(day, day), '5150').closing,
        500,
        'El período original conserva la pérdida que se registró entonces',
      )
      eq(
        await owner(
          'select to_jsonb(d) row from public.business_days d where day=$1',
          [day],
        ),
        closed,
      )
      eq((await state()).quantity, 20)
    },
  )

  await scenario(
    'No se anulan conteos iniciales, operaciones de venta ni revisiones de recepción',
    async () => {
      const initial = await rpc(
        db,
        'record_inventory_movement',
        adjustment(7, null, { productId: unknown }),
      )
      await blocked(initial, /inicial|conteo|base|anular/i)
      const exit = await call('record_inventory_movement', {
        productId: product,
        location: 'store',
        type: 'EXIT',
        quantity: 1,
        note: 'Salida real, no ajuste manual',
      })
      await blocked(exit, /ajuste|manual|original|anular/i)
      const invoice = await sale(1)
      await one('select public.delete_invoice($1,$2)', [
        invoice.id,
        'Factura anulada para probar el origen del movimiento',
      ])
      const invoiceReversal = await owner(
        `select id from public.inventory_movements
     where product_id=$1 and is_invoice_reversal order by created_at desc limit 1`,
        [product],
      )
      await blocked(invoiceReversal.id, /ajuste|manual|factura|origen|anular/i)
      const receipt = await call('record_shipment', {
        incurredOn: day,
        supplier: 'Proveedor QA',
        agency: '',
        reference: 'VOID-RECEIPT',
        note: '',
        currency: 'NIO',
        exchangeRate: 1,
        account: 'pending',
        shippingAmount: 0,
        lines: [
          {
            productId: product,
            location: 'store',
            quantity: 1,
            unitPrice: 100,
          },
        ],
      })
      const before = await state()
      const revision = await call('revise_purchase_receipt', {
        shipmentId: receipt,
        expectedRevision: 0,
        incurredOn: day,
        supplier: 'Proveedor QA',
        reference: 'VOID-RECEIPT',
        note: '',
        currency: 'NIO',
        exchangeRate: 1,
        shippingAmount: 0,
        counterpart: '1120-003',
        costAccount: '5150',
        lines: [
          {
            productId: product,
            location: 'store',
            quantity: 2,
            unitPrice: 100,
          },
        ],
        impacts: [
          {
            productId: product,
            expectedStore: before.quantity,
            expectedWarehouse: 0,
            expectedValueNio: Number(before.value_nio),
            targetValueNio: Number(before.value_nio) + 100,
          },
        ],
      })
      const receiptMovement = await owner(
        'select movement_id from private.receipt_inventory_changes where revision_id=$1',
        [revision.id],
      )
      await blocked(
        receiptMovement.movement_id,
        /ajuste|manual|recepci|origen|anular/i,
      )
    },
  )

  await scenario(
    'Un sobrante adoptado como compra conserva el flujo de su recepción',
    async () => {
      const gain = await rpc(
        db,
        'record_inventory_movement',
        adjustment(25, 20),
      )
      await call('adopt_inventory_counts_as_purchase', {
        movementIds: [gain],
        expectedTotalNio: 500,
      })
      await blocked(gain, /compra|recepci|regulariz|anular|adopt/i)
      eq((await state()).quantity, 25)
      eq((await movement(gain)).row.voided_at, null)
    },
  )

  console.log(
    `PASS anulaciones de ajustes: ${checks} comprobaciones de reversión exacta, historial, ventas, períodos, permisos, reintentos y concurrencia`,
  )
} finally {
  await db.close()
}

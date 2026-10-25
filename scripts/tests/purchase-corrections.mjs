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
} from './database-fixture.mjs'

const db = await database()
const day = '2026-10-25'
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
const other = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'
const empty = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003'
let checks = 0
const scenarios = []
const equal = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
}
const one = async (sql, values = []) => (await db.query(sql, values)).rows[0]
const owner = async (sql, values = []) => {
  const role = (await one('select current_user as role')).role
  await db.exec('reset role')
  try {
    if (/^(create|drop) /i.test(sql)) {
      await db.exec(sql)
      return []
    }
    return (await db.query(sql, values)).rows
  } finally {
    await db.exec('set role ' + role)
  }
}
const clock = async (at = day, minute = 0) =>
  db.query("select set_config('lcp.test_now',$1,false)", [
    new Date(
      new Date(`${at}T14:00:00Z`).getTime() + minute * 60000,
    ).toISOString(),
  ])
const call = (name, input) => rpc(db, name, input)
const buy = (changes = {}) => ({
  requestId: crypto.randomUUID(),
  incurredOn: day,
  supplier: 'Proveedor de auditoría',
  agency: '',
  reference: 'COMPRA-QA',
  note: 'Compra aislada',
  currency: 'NIO',
  exchangeRate: 1,
  account: 'caja',
  shippingAmount: 0,
  lines: [
    { productId: product, location: 'store', quantity: 10, unitPrice: 120 },
  ],
  ...changes,
})
const correct = (id, changes = {}) => ({
  requestId: crypto.randomUUID(),
  shipmentId: id,
  reason: 'Error al registrar la compra',
  refundConfirmed: true,
  ...changes,
})
const snapshot = async () =>
  (
    await owner(
      `select jsonb_build_object(${[
        'public.purchase_shipments',
        'public.purchase_shipment_lines',
        'public.purchase_corrections',
        'public.inventory_balances',
        'public.inventory_movements',
        'public.product_costs',
        'public.product_prices',
        'public.finance_entries',
        'private.inventory_value_balances',
        'private.purchase_product_revisions',
        'private.purchase_before_states',
        'private.purchase_correction_refunds',
        'private.purchase_payment_reallocations',
        'private.rate_limits',
      ]
        .map(
          (table) =>
            `'${table}',(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from ${table} t)`,
        )
        .join(',')}) r`,
    )
  )[0].r
const state = async (id = product) => ({
  stock: (
    await db.query(
      'select location,quantity from public.inventory_balances where product_id=$1 order by location',
      [id],
    )
  ).rows,
  cost: (
    await db.query(
      'select average_cost_nio::text value from public.product_costs where product_id=$1',
      [id],
    )
  ).rows,
  value: (
    await owner(
      'select quantity,value_nio::text value from private.inventory_value_balances where product_id=$1',
      [id],
    )
  )[0],
})
const ledger = async (at = day) =>
  (await one('select public.ledger_report($1,$1) r', [at])).r
const balance = (book, account) =>
  book.accounts.find((a) => a.code === account).closing
const credits = async (at = day) =>
  (await one('select public.credit_accounts($1) r', [at])).r
const open = async (at = day) =>
  call('open_business_day', {
    requestId: crypto.randomUUID(),
    expectedDay: at,
    openingNio: 10000,
    openingUsd: 1000,
  })
const close = async (at = day) => {
  const s = (await one('select public.get_business_day(null) r')).r
  return call('close_business_day', {
    requestId: crypto.randomUUID(),
    day: at,
    expectedRevision: s.revision,
    expectedStateToken: s.stateToken,
    countedNio: s.report.expectedNio,
    countedUsd: s.report.expectedUsd,
    note: '',
  })
}
async function rejected(work, pattern, label) {
  const before = await snapshot()
  await db.exec('savepoint rejected_purchase')
  try {
    await assert.rejects(work, pattern, label)
    checks++
  } finally {
    await db.exec(
      'rollback to savepoint rejected_purchase; release savepoint rejected_purchase',
    )
  }
  equal(await snapshot(), before, label + ': transacción íntegra')
}
async function scenario(name, run) {
  await db.exec('begin')
  try {
    await clock()
    await identity(db, admin)
    await open()
    await run()
    scenarios.push(name)
    console.log('PASS ' + name)
  } finally {
    await db.exec('rollback')
    await identity(db, admin)
  }
}
try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.test_now')::timestamptz$$",
  )
  await clock()
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Propietario QA','superadmin'),($2,'Caja QA','operator'),($3,'Bodega QA','warehouse'),($4,'Consulta QA','viewer')",
    [admin, operator, warehouse, viewer],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Compras aisladas'); insert into public.brands(name) values('Marca QA');",
  )
  for (const [id, sku] of [
    [product, 'QA-COMPRA'],
    [other, 'QA-OTRO'],
    [empty, 'QA-NUEVO'],
  ]) {
    await db.query(
      "insert into public.products(id,sku,name,brand_id,size,unit) values($1,$2,$2,(select id from public.brands limit 1),100,'ml')",
      [id, sku],
    )
    await db.query(
      "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',$2),($1,'warehouse',$3)",
      [id, id === empty ? 0 : 10, id === empty ? 0 : 5],
    )
    if (id !== empty)
      await db.query(
        'insert into public.product_costs(product_id,average_cost_nio) values($1,100)',
        [id],
      )
    await db.query(
      "insert into public.product_prices(product_id,tier_code,currency,amount) select $1,t,c,case when c='USD' then 20 else 732 end from unnest(array['emprendedor','vip','premium']) t cross join unnest(array['NIO','USD']) c",
      [id],
    )
  }
  await identity(db, admin)
  await call('record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: day,
    description: 'Saldos iniciales QA',
    reference: 'QA',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1110-001', debit: 10000, credit: 0 },
      { account: '1110-002', debit: 36600, credit: 0 },
      { account: '1130', debit: 3000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 49600 },
    ],
  })

  await scenario('Permisos, RLS, banco obligatorio y moneda', async () => {
    for (const [id, role] of [
      [operator, 'authenticated'],
      [warehouse, 'authenticated'],
      [viewer, 'authenticated'],
      ['', 'anon'],
    ]) {
      await identity(db, id, role)
      await rejected(
        () => call('record_shipment', buy()),
        /permission|privilege|denied/i,
        'Compra sin permiso',
      )
      await rejected(
        () => call('correct_purchase', correct(crypto.randomUUID())),
        /permission|privilege|denied/i,
        'Corrección sin permiso',
      )
    }
    await identity(db, admin)
    await rejected(
      () => call('record_shipment', buy({ account: 'banco' })),
      /Selecciona BAC/,
      'Banco obligatorio',
    )
    await rejected(
      () =>
        call(
          'record_shipment',
          buy({ account: 'banco', bankLedgerAccount: '1120-002' }),
        ),
      /moneda/,
      'Banco moneda equivocada',
    )
    await rejected(
      () => call('record_shipment', buy({ bankLedgerAccount: '1120-001' })),
      /solo corresponde/,
      'Banco en caja',
    )
    for (const [bank, currency] of [
      ['1120-001', 'NIO'],
      ['1120-002', 'USD'],
      ['1120-003', 'NIO'],
      ['1120-004', 'USD'],
      ['1120-005', 'NIO'],
      ['1120-006', 'USD'],
    ]) {
      await clock(day, checks)
      const input = buy({
        account: 'banco',
        currency,
        exchangeRate: currency === 'NIO' ? 1 : 36.6,
        bankLedgerAccount: bank,
      })
      const id = await call('record_shipment', input)
      equal(
        await call('record_shipment', input),
        id,
        'Reintento no duplica compra',
      )
      const book = await ledger()
      equal(
        balance(book, bank),
        -(currency === 'NIO' ? 1200 : 43920),
        'Salida al banco correcto',
      )
      await call('correct_purchase', correct(id))
      equal(balance(await ledger(), bank), 0, 'Devolución al banco original')
    }
  })

  await scenario(
    'Promedio y valor exactos, anulación, precios intactos y reintento',
    async () => {
      const prices = (await snapshot())['public.product_prices']
      const input = buy({
        shippingAmount: 2,
        lines: [
          {
            productId: product,
            location: 'store',
            quantity: 3,
            unitPrice: 111.123456,
          },
          {
            productId: other,
            location: 'warehouse',
            quantity: 2,
            unitPrice: 43.123456,
          },
        ],
      })
      const id = await call('record_shipment', input)
      const value = await owner(
        'select sum(value_nio)::text value from private.inventory_value_balances',
      )
      equal(
        value[0].value,
        '3421.62',
        'Costo total compra coincide con cabecera redondeada',
      )
      equal(balance(await ledger(), '1130'), 3421.62)
      equal((await snapshot())['public.product_prices'], prices)
      const correction = correct(id)
      await rejected(
        () =>
          call('correct_purchase', { ...correction, refundConfirmed: false }),
        /devolución real/,
        'No inventar reintegro de dinero',
      )
      const result = await call('correct_purchase', correction)
      const done = await snapshot()
      equal(await call('correct_purchase', correction), result)
      equal(await snapshot(), done, 'Replay sin una escritura adicional')
      equal((await state()).value, { quantity: 15, value: '1500.00' })
      equal((await state()).cost, [{ value: '100.000000' }])
      equal(balance(await ledger(), '1130'), 3000)
      equal((await snapshot())['public.product_prices'], prices)
      await rejected(
        () => call('correct_purchase', correct(id)),
        /ya fue anulada/,
        'No doble anulación',
      )
      await rejected(
        () =>
          call('correct_purchase', { ...correction, reason: 'Otro motivo' }),
        /solicitud.*cambió/,
        'Mismo UUID no admite otro contenido',
      )
      await close()
      equal(
        await call('correct_purchase', correction),
        result,
        'Confirmación tras cierre conserva resultado',
      )
    },
  )

  await scenario('Reemplazo atómico y rollback de último perfume', async () => {
    const id = await call('record_shipment', buy())
    await rejected(
      () =>
        call(
          'correct_purchase',
          correct(id, {
            replacement: buy({
              lines: [
                {
                  productId: product,
                  location: 'store',
                  quantity: 2,
                  unitPrice: 90,
                },
                {
                  productId: crypto.randomUUID(),
                  location: 'store',
                  quantity: 1,
                  unitPrice: 90,
                },
              ],
            }),
          }),
        ),
      /conteo|Producto/,
      'Último renglón falla y conserva original',
    )
    const result = await call(
      'correct_purchase',
      correct(id, {
        replacement: buy({
          account: 'banco',
          bankLedgerAccount: '1120-003',
          lines: [
            {
              productId: product,
              location: 'warehouse',
              quantity: 2,
              unitPrice: 150,
            },
          ],
        }),
      }),
    )
    equal((await state()).stock, [
      { location: 'store', quantity: 10 },
      { location: 'warehouse', quantity: 7 },
    ])
    equal((await state()).value, { quantity: 17, value: '1800.00' })
    equal(balance(await ledger(), '1130'), 3300)
    equal(balance(await ledger(), '1120-003'), -300)
    equal(
      (await one('select count(*)::int n from public.purchase_shipments')).n,
      2,
    )
    equal(
      (
        await one(
          'select replacement_id from public.purchase_corrections where shipment_id=$1',
          [id],
        )
      ).replacement_id,
      result.replacementId,
    )
  })

  await scenario(
    'Crédito parcialmente pagado, reintegro por cuenta y auxiliares',
    async () => {
      const id = await call(
        'record_shipment',
        buy({
          account: 'credito',
          lines: [
            {
              productId: product,
              location: 'store',
              quantity: 10,
              unitPrice: 100,
            },
          ],
        }),
      )
      for (const [account, amount, bank] of [
        ['caja', 100, null],
        ['banco', 200, '1120-005'],
      ])
        await call('record_finance_entry', {
          requestId: crypto.randomUUID(),
          occurredOn: day,
          kind: 'supplier_payment',
          account,
          toAccount: null,
          amount,
          currency: 'NIO',
          exchangeRate: 1,
          counterparty: '',
          description: 'Abono QA',
          reference: '',
          shipmentId: id,
          bankLedgerAccount: bank,
        })
      equal(
        (await credits()).rows.find((r) => r.shipmentId === id).balanceNio,
        700,
      )
      await call('correct_purchase', correct(id))
      equal(
        (await credits()).rows.some((r) => r.shipmentId === id),
        false,
        'Deuda anulada ya no admite abonos',
      )
      equal(balance(await ledger(), '2111'), 0)
      equal(balance(await ledger(), '1120-005'), 0)
      equal(balance(await ledger(), '1110-001'), 10000)
      const flow = (await one('select public.finance_cashflow($1,$1) r', [day]))
        .r
      equal(flow.closing.caja, 46600)
      equal(flow.closing.banco, 0)
      const daily = (await one('select public.get_business_day(null) r')).r
      equal(daily.report.expectedNio, 10000)
      await rejected(
        () =>
          call('record_finance_entry', {
            requestId: crypto.randomUUID(),
            occurredOn: day,
            kind: 'supplier_payment',
            account: 'caja',
            toAccount: null,
            amount: 1,
            currency: 'NIO',
            exchangeRate: 1,
            counterparty: '',
            description: 'Pago indebido',
            reference: '',
            shipmentId: id,
          }),
        /anulada/,
        'No volver a pagar original',
      )
      const payment = (
        await one(
          'select id from public.finance_entries where shipment_id=$1 limit 1',
          [id],
        )
      ).id
      await rejected(
        () =>
          db.query('select public.void_finance_entry($1,$2)', [
            payment,
            'No se puede anular de nuevo',
          ]),
        /anulada/,
        'Pago ya compensado conserva historial',
      )
    },
  )

  await scenario(
    'Jornada posterior conserva reportes históricos y bloquea cierre actual',
    async () => {
      const id = await call('record_shipment', buy({ account: 'credito' }))
      const before = await ledger()
      const debt = await credits()
      await close()
      await clock('2026-10-26')
      await rejected(
        () => call('correct_purchase', correct(id)),
        /Abre la jornada/,
        'Corrección requiere jornada abierta actual',
      )
      await open('2026-10-26')
      await call('correct_purchase', correct(id))
      equal(await ledger(), before, 'Mayor de jornada anterior intacto')
      equal(await credits(), debt, 'Auxiliar histórico intacto')
      equal(
        (await credits('2026-10-26')).rows.some((r) => r.shipmentId === id),
        false,
      )
      equal(balance(await ledger('2026-10-26'), '1130'), 3000)
      const yesterday = (
        await one('select public.purchase_report_events($1,$1,0,500) r', [day])
      ).r
      const today = (
        await one('select public.purchase_report_events($1,$1,0,500) r', [
          '2026-10-26',
        ])
      ).r
      equal(yesterday.count, 1)
      equal(today.count, 1)
      equal(today.rows[0].event_kind, 'cancellation')
      equal(today.rows[0].goods_nio, -1200)
      equal(today.rows[0].units, -10)
    },
  )

  await scenario(
    'Actividad posterior no se reescribe y primera compra recupera costo desconocido',
    async () => {
      const id = await call('record_shipment', buy())
      await call('transfer_inventory', {
        requestId: crypto.randomUUID(),
        productId: product,
        fromLocation: 'store',
        toLocation: 'warehouse',
        quantity: 1,
        note: 'Traslado posterior QA',
      })
      await rejected(
        () => call('correct_purchase', correct(id)),
        /posteriores/,
        'Traslado posterior protege costo e historial',
      )
      const first = await call(
        'record_shipment',
        buy({
          account: 'credito',
          lines: [
            { productId: empty, location: 'store', quantity: 2, unitPrice: 10 },
          ],
        }),
      )
      await call('correct_purchase', correct(first))
      equal((await state(empty)).stock, [
        { location: 'store', quantity: 0 },
        { location: 'warehouse', quantity: 0 },
      ])
      equal(
        (await state(empty)).cost,
        [],
        'Costo desconocido se conserva desconocido',
      )
      equal((await state(empty)).value, { quantity: 0, value: '0.00' })
    },
  )

  await scenario(
    'Cadena de anulaciones, historial paginado y rollback inyectado',
    async () => {
      const first = await call('record_shipment', buy())
      await clock(day, 1)
      const second = await call('record_shipment', buy())
      await rejected(
        () => call('correct_purchase', correct(first)),
        /posteriores/,
        'Primero deshacer compra posterior',
      )
      await call('correct_purchase', correct(second))
      await call('correct_purchase', correct(first))
      equal((await state()).value, { quantity: 15, value: '1500.00' })
      await clock(day, 2)
      const third = await call('record_shipment', buy())
      await owner(
        "create function private.fail_purchase_restore() returns trigger language plpgsql as $$begin raise exception 'Fallo de prueba al restaurar'; end$$; create trigger fail_restore before update on public.inventory_balances for each row execute function private.fail_purchase_restore()",
      )
      await rejected(
        () => call('correct_purchase', correct(third)),
        /Fallo de prueba/,
        'Rollback después de registrar corrección',
      )
      await owner(
        'drop trigger fail_restore on public.inventory_balances; drop function private.fail_purchase_restore()',
      )
      const history = (await one('select public.purchase_history(null,null) r'))
        .r
      equal(history.length, 3)
      equal(history[0].id, third)
      equal(
        history.find((r) => r.id === first).correction.reason,
        'Error al registrar la compra',
      )
    },
  )

  await scenario(
    'Pagos en monedas distintas conservan importes y cuentas originales',
    async () => {
      const id = await call(
        'record_shipment',
        buy({ account: 'credito', currency: 'USD', exchangeRate: 36.6 }),
      )
      await call('record_finance_entry', {
        requestId: crypto.randomUUID(),
        occurredOn: day,
        kind: 'supplier_payment',
        account: 'banco',
        toAccount: null,
        amount: 53,
        currency: 'USD',
        exchangeRate: 36.65,
        bankLedgerAccount: '1120-004',
        counterparty: '',
        description: 'Abono dólares QA',
        reference: '',
        shipmentId: id,
      })
      await call('record_finance_entry', {
        requestId: crypto.randomUUID(),
        occurredOn: day,
        kind: 'supplier_payment',
        account: 'caja',
        toAccount: null,
        amount: 345.67,
        currency: 'NIO',
        exchangeRate: 1,
        counterparty: '',
        description: 'Abono córdobas QA',
        reference: '',
        shipmentId: id,
      })
      const request = correct(id)
      const result = await call('correct_purchase', request)
      const refunded = await owner(
        'select currency,amount::text,amount_nio::text,ledger_account from private.purchase_correction_refunds where correction_id=$1 order by currency',
        [result.id],
      )
      equal(refunded, [
        {
          currency: 'NIO',
          amount: '345.67',
          amount_nio: '345.67',
          ledger_account: '1110-001',
        },
        {
          currency: 'USD',
          amount: '53.00',
          amount_nio: '1942.45',
          ledger_account: '1120-004',
        },
      ])
      equal(balance(await ledger(), '2111'), 0)
      equal(balance(await ledger(), '1120-004'), 0)
      const events = (
        await one('select public.purchase_report_events($1,$1,0,500) r', [day])
      ).r
      equal(
        events.rows.reduce(
          (sum, row) => sum + row.goods_nio + row.shipping_nio,
          0,
        ),
        0,
      )
      const compensation = events.rows.find(
        (row) => row.event_kind === 'cancellation',
      ).refund_entries
      equal(
        compensation.map((row) => row.amount_nio).sort((a, b) => a - b),
        [-1942.45, -345.67],
      )
    },
  )

  await scenario(
    'Conservar abonos reales sin reintegro ficticio y limitar nuevos pagos',
    async () => {
      const id = await call(
        'record_shipment',
        buy({
          account: 'credito',
          lines: [
            {
              productId: product,
              location: 'store',
              quantity: 10,
              unitPrice: 100,
            },
          ],
        }),
      )
      const payment = await call('record_finance_entry', {
        requestId: crypto.randomUUID(),
        occurredOn: day,
        kind: 'supplier_payment',
        account: 'caja',
        toAccount: null,
        amount: 300,
        currency: 'NIO',
        exchangeRate: 1,
        counterparty: '',
        description: 'Abono real QA',
        reference: '',
        shipmentId: id,
      })
      const historical = await credits()
      await close()
      await clock('2026-10-26')
      await open('2026-10-26')
      const replacement = buy({
        account: 'credito',
        lines: [
          {
            productId: product,
            location: 'store',
            quantity: 9,
            unitPrice: 100,
          },
        ],
      })
      await rejected(
        () =>
          call(
            'correct_purchase',
            correct(id, { paymentTreatment: 'recording_error', replacement }),
          ),
        /otra jornada/,
        'No simular efectivo recibido de pagos históricos',
      )
      await rejected(
        () =>
          call(
            'correct_purchase',
            correct(id, {
              paymentTreatment: 'keep_payments',
              replacement: buy({
                account: 'credito',
                lines: [
                  {
                    productId: product,
                    location: 'store',
                    quantity: 1,
                    unitPrice: 100,
                  },
                ],
              }),
            }),
          ),
        /abonos superan/,
        'Importe corregido no absorbe todos los abonos',
      )
      const request = correct(id, {
        paymentTreatment: 'keep_payments',
        replacement,
      })
      const result = await call('correct_purchase', request)
      equal(await call('correct_purchase', request), result)
      equal(
        (await credits('2026-10-26')).rows.find(
          (row) => row.shipmentId === result.replacementId,
        ).balanceNio,
        600,
      )
      equal(await credits(), historical, 'Auxiliar de ayer intacto')
      equal(
        (await one('select count(*)::int n from public.finance_entries')).n,
        1,
        'Un solo pago real',
      )
      equal(
        (
          await owner(
            'select count(*)::int n from private.purchase_correction_refunds',
          )
        )[0].n,
        0,
        'No se inventa devolución',
      )
      equal(
        (await one('select public.get_business_day(null) r')).r.report
          .expectedNio,
        10000,
        'La caja física de hoy no recibe dinero de ayer',
      )
      equal(balance(await ledger('2026-10-26'), '2111'), -600)
      const nextPayment = {
        requestId: crypto.randomUUID(),
        occurredOn: '2026-10-26',
        kind: 'supplier_payment',
        account: 'caja',
        toAccount: null,
        amount: 601,
        currency: 'NIO',
        exchangeRate: 1,
        counterparty: '',
        description: 'Liquidación QA',
        reference: '',
        shipmentId: result.replacementId,
      }
      await rejected(
        () => call('record_finance_entry', nextPayment),
        /supera el saldo/,
        'Nuevo abono cuenta pago trasladado',
      )
      await call('record_finance_entry', {
        ...nextPayment,
        requestId: crypto.randomUUID(),
        amount: 600,
      })
      equal(
        (await credits('2026-10-26')).rows.find(
          (row) => row.shipmentId === result.replacementId,
        ).balanceNio,
        0,
      )
      const second = await call(
        'correct_purchase',
        correct(result.replacementId, {
          paymentTreatment: 'keep_payments',
          replacement: buy({
            account: 'credito',
            lines: [
              {
                productId: product,
                location: 'store',
                quantity: 10,
                unitPrice: 100,
              },
            ],
          }),
        }),
      )
      equal(
        (await credits('2026-10-26')).rows.find(
          (row) => row.shipmentId === second.replacementId,
        ).balanceNio,
        100,
        'Cadena conserva también nuevos abonos',
      )
      equal(
        (await one('select count(*)::int n from public.finance_entries')).n,
        2,
      )
      equal(
        (
          await owner(
            'select count(*)::int n from private.purchase_correction_refunds',
          )
        )[0].n,
        0,
      )
      await rejected(
        () =>
          db.query('select public.void_finance_entry($1,$2)', [
            payment,
            'No eliminar un abono real trasladado',
          ]),
        /anulada|cerrada/,
        'No deshacer por fuera un pago ya trasladado',
      )
    },
  )

  await scenario(
    'Error de registro en caja actual, revisión sin cambios y protección histórica',
    async () => {
      const id = await call('record_shipment', buy())
      const preview = (
        await one('select public.inventory_valuation_preview() r')
      ).r
      await call('reconcile_inventory_value', {
        requestId: crypto.randomUUID(),
        expectedToken: preview.token,
        note: 'Revisión sin cambiar cantidades ni valores',
      })
      const result = await call(
        'correct_purchase',
        correct(id, {
          paymentTreatment: 'recording_error',
          replacement: buy({
            lines: [
              {
                productId: product,
                location: 'store',
                quantity: 9,
                unitPrice: 100,
              },
            ],
          }),
        }),
      )
      equal(
        (await one('select public.get_business_day(null) r')).r.report
          .expectedNio,
        9100,
      )
      const flow = (await one('select public.finance_cashflow($1,$1) r', [day]))
        .r
      equal(
        flow.rows.some(
          (row) =>
            row.category === 'purchase_correction' && row.inflowNio === 1200,
        ),
        true,
        'Ajuste de registro separado de devolución real',
      )
      await close()
      await clock('2026-10-26')
      await open('2026-10-26')
      await rejected(
        () =>
          call(
            'correct_purchase',
            correct(result.replacementId, {
              paymentTreatment: 'recording_error',
            }),
          ),
        /otra jornada/,
        'Error histórico no aumenta caja física actual',
      )
      await call(
        'correct_purchase',
        correct(result.replacementId, { paymentTreatment: 'refund' }),
      )
      equal(
        (await one('select public.get_business_day(null) r')).r.report
          .expectedNio,
        10900,
        'Devolución física real sí entra hoy',
      )
    },
  )

  await scenario(
    '500 compras y anulaciones entre bancos, monedas e idempotencia',
    async () => {
      const prices = (await snapshot())['public.product_prices']
      for (let index = 0; index < 500; index++) {
        await clock(day, index)
        const usd = index % 2 === 1
        const bank = [
          '1120-001',
          '1120-002',
          '1120-003',
          '1120-004',
          '1120-005',
          '1120-006',
        ][index % 6]
        const input = buy({
          account: 'banco',
          bankLedgerAccount: bank,
          currency: usd ? 'USD' : 'NIO',
          exchangeRate: usd ? 36.612345 : 1,
          shippingAmount: 0.01,
          lines: [
            {
              productId: product,
              location: index % 3 === 0 ? 'store' : 'warehouse',
              quantity: (index % 7) + 1,
              unitPrice: 111.123456,
            },
          ],
        })
        const id = await call('record_shipment', input)
        equal(await call('record_shipment', input), id)
        const correction = correct(id)
        const result = await call('correct_purchase', correction)
        equal(await call('correct_purchase', correction), result)
        equal((await state()).value, { quantity: 15, value: '1500.00' })
        equal((await state()).stock, [
          { location: 'store', quantity: 10 },
          { location: 'warehouse', quantity: 5 },
        ])
        if (index % 50 === 0) {
          const book = await ledger()
          equal(balance(book, '1130'), 3000)
          equal(
            book.accounts.reduce((sum, row) => sum + row.debit - row.credit, 0),
            0,
          )
        }
      }
      const book = await ledger()
      for (const bank of [
        '1120-001',
        '1120-002',
        '1120-003',
        '1120-004',
        '1120-005',
        '1120-006',
      ])
        equal(balance(book, bank), 0)
      equal((await snapshot())['public.product_prices'], prices)
      const first = (
        await one('select public.purchase_report_events($1,$1,0,500) r', [day])
      ).r
      const second = (
        await one('select public.purchase_report_events($1,$1,500,500) r', [
          day,
        ])
      ).r
      equal(first.count, 1000)
      equal(first.rows.length, 500)
      equal(second.rows.length, 500)
      const all = [...first.rows, ...second.rows]
      equal(new Set(all.map((row) => row.id)).size, 1000)
      equal(
        Math.abs(
          Math.round(
            all.reduce(
              (sum, row) => sum + row.goods_nio + row.shipping_nio,
              0,
            ) * 100,
          ),
        ),
        0,
      )
      const history = (await one('select public.purchase_history(null,null) r'))
        .r
      equal(history.length, 51)
      const next = (
        await one('select public.purchase_history($1,$2) r', [
          history[49].created_at,
          history[49].id,
        ])
      ).r
      equal(next.length, 51)
      equal(
        next.some((row) => row.id === history[49].id),
        false,
      )
    },
  )

  await mkdir('output/purchase-corrections', { recursive: true })
  await writeFile(
    'output/purchase-corrections/results.json',
    JSON.stringify({ checks, scenarios, productionWrites: 0 }, null, 2),
  )
  console.log(
    JSON.stringify({
      checks,
      scenarios: scenarios.length,
      productionWrites: 0,
    }),
  )
} finally {
  await db.close()
}

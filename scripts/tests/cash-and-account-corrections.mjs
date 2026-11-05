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
let checks = 0
const eq = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
}
const reject = async (p, pattern) => {
  await assert.rejects(p, pattern)
  checks++
}
const one = async (s, args = []) => (await db.query(s, args)).rows[0]
const day = async () =>
  (await one("select public.get_business_day('2026-11-05') r")).r
const ledger = async () =>
  (await one("select public.ledger_report('2026-11-01','2026-11-05') r")).r
const history = async () =>
  (await one("select public.get_business_day_history('2026-11-05') r")).r
const call = (name, input) =>
  rpc(db, name, { requestId: crypto.randomUUID(), ...input })
const funds = async () =>
  (await ledger()).accounts
    .filter((a) => a.code.startsWith('1110-'))
    .map((a) => [a.code, a.closing])
const movement = async (changes = {}) => {
  const d = await day()
  return {
    requestId: crypto.randomUUID(),
    day: d.day,
    expectedRevision: d.revision,
    expectedStateToken: d.stateToken,
    type: 'expense',
    currency: 'NIO',
    exchangeRate: 1,
    amount: 100,
    counterpart: '5130-001',
    description: 'Gasto real registrado desde caja',
    ...changes,
  }
}
const correct = async (changes = {}) => {
  const d = await day()
  return {
    requestId: crypto.randomUUID(),
    day: d.day,
    expectedRevision: d.revision,
    countedNio: 800,
    countedUsd: 100,
    ...changes,
  }
}
try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.test_now')::timestamptz$$",
  )
  await db.query(
    "select set_config('lcp.test_now','2026-11-05T15:00:00Z',false)",
  )
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Admin','admin'),($2,'Caja','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer'),($5,'Superadmin','superadmin')",
    [admin, operator, warehouse, viewer, outsider],
  )
  await identity(db, admin)
  await call('record_journal_entry', {
    kind: 'opening',
    occurredOn: '2026-11-05',
    description: 'Apertura aislada',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1110-001', debit: 1000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 1000 },
    ],
  })
  await call('open_business_day', { openingNio: 1000, openingUsd: 100 })
  await db.query(
    "select set_config('lcp.test_now','2026-11-05T16:00:00Z',false)",
  )
  const input = await movement()
  for (const uid of [operator, warehouse, viewer]) {
    await identity(db, uid)
    await reject(
      rpc(db, 'record_cash_movement', input),
      /permission|insufficient/i,
    )
    await reject(
      rpc(db, 'correct_closing_business_day', await correct()),
      /permission|insufficient/i,
    )
  }
  await identity(db, '', 'anon')
  await reject(rpc(db, 'record_cash_movement', input), /permission/i)
  await reject(rpc(db, 'correct_closing_business_day', {}), /permission/i)
  await identity(db, admin)
  for (const changes of [
    { amount: 0 },
    { amount: -1 },
    { amount: 0.001 },
    { counterpart: '1110-001' },
    { counterpart: '2117' },
    { type: 'deposit', counterpart: '5130-001' },
    { type: 'owner_withdrawal', counterpart: '2117' },
    { type: 'bad' },
    { currency: 'EUR' },
    { description: ' ' },
    { expectedRevision: 99 },
    { expectedStateToken: 'stale' },
  ])
    await reject(
      rpc(db, 'record_cash_movement', { ...input, ...changes }),
      /importe|mayor|cuenta|tipo|concepto|jornada cambió|decimal|monto|numérico|revisa|Selecciona/i,
    )
  const id = await rpc(db, 'record_cash_movement', input)
  eq(
    await rpc(db, 'record_cash_movement', input),
    id,
    'reintento no duplica el comprobante',
  )
  eq((await day()).report.expectedNio, 900)
  eq((await funds()).find((a) => a[0] === '1110-001')[1], 900)
  await reject(
    rpc(db, 'record_cash_movement', { ...input, amount: 101 }),
    /solicitud.*cambió/,
  )
  for (const [type, counterpart, amount, expected] of [
    ['deposit', '1120-001', 200, 700],
    ['bank_withdrawal', '1120-001', 50, 750],
    ['income', '3110-001', 100, 850],
    ['owner_withdrawal', '3110-001', 25, 825],
    ['other_out', '2117', 25, 800],
  ]) {
    await rpc(
      db,
      'record_cash_movement',
      await movement({ type, counterpart, amount }),
    )
    eq((await day()).report.expectedNio, expected, type)
    eq(
      (await funds()).find((a) => a[0] === '1110-001')[1],
      expected,
      'caja física y contabilidad concuerdan',
    )
  }
  await rpc(
    db,
    'record_cash_movement',
    await movement({
      type: 'bank_withdrawal',
      counterpart: '1120-002',
      currency: 'USD',
      exchangeRate: 37,
      amount: 20,
    }),
  )
  eq((await day()).report.expectedUsd, 120)
  eq(
    (await funds()).find((a) => a[0] === '1110-002')[1],
    740,
    'balanza siempre se expresa en NIO',
  )
  await reject(
    rpc(
      db,
      'record_cash_movement',
      await movement({
        type: 'deposit',
        counterpart: '1120-001',
        currency: 'USD',
        exchangeRate: 37,
      }),
    ),
    /moneda/,
  )
  let d = await day()
  const close = await call('close_business_day', {
    day: d.day,
    expectedRevision: d.revision,
    expectedStateToken: d.stateToken,
    countedNio: 700,
    countedUsd: 120,
    note: 'Conteo escrito incorrectamente',
  })
  const immutable = await funds()
  const fix = await correct({ countedNio: 800, countedUsd: 120 })
  const fixed = await rpc(db, 'correct_closing_business_day', fix)
  eq(fixed.status, 'closed')
  eq(
    fixed.closedAt,
    close.closedAt,
    'editar conteo conserva el instante del cierre',
  )
  eq(fixed.report.differenceNio, 0)
  eq(await funds(), immutable, 'corregir conteo no inventa dinero contable')
  eq(
    (await history()).find((e) => e.event === 'close').report.countedNio,
    700,
    'cierre original intacto',
  )
  eq((await history())[0].event, 'closing_corrected')
  eq((await history())[0].report.countedNio, 800)
  eq(
    (await rpc(db, 'correct_closing_business_day', fix)).revision,
    fixed.revision,
  )
  await reject(
    rpc(db, 'correct_closing_business_day', { ...fix, countedNio: 801 }),
    /solicitud.*cambió/,
  )
  await reject(
    rpc(
      db,
      'correct_closing_business_day',
      await correct({ expectedRevision: 0 }),
    ),
    /jornada cambió/,
  )
  for (const countedNio of [-1, 0.001])
    await reject(
      rpc(db, 'correct_closing_business_day', await correct({ countedNio })),
      /importe|decimal|monto|numérico|revisa/i,
    )
  await rpc(db, 'record_cash_movement', await movement({ amount: 50 }))
  d = await day()
  eq(d.status, 'closed')
  eq(d.closedAt, close.closedAt)
  eq(d.report.expectedNio, 750)
  eq(d.report.countedNio, 800, 'un gasto tardío conserva el conteo físico')
  eq(d.report.differenceNio, 50)
  eq((await funds()).find((a) => a[0] === '1110-001')[1], 750)
  eq((await history())[0].event, 'cash_movement')
  await db.query(
    "select set_config('lcp.test_now','2026-11-06T15:00:00Z',false)",
  )
  eq(
    (
      await rpc(
        db,
        'correct_closing_business_day',
        await correct({ countedNio: 750, countedUsd: 120 }),
      )
    ).report.differenceNio,
    0,
    'corregir día anterior sin reabrir',
  )
  const retired = await correct({ countedNio: 700, countedUsd: 120 })
  await one(
    "select public.retire_unconfirmed_operation('business-day-correct_closing',$1) r",
    [retired.requestId],
  )
  await reject(rpc(db, 'correct_closing_business_day', retired), /descartada/)
  eq(
    (await day()).report.countedNio,
    750,
    'corrección descartada no se aplica tarde',
  )
  eq(
    (
      await one(
        "select public.get_operation_confirmation('business-day-correct_closing',$1) r",
        [fix.requestId],
      )
    ).r.status,
    'confirmed',
  )
  const retiredMove = await movement({ amount: 10 })
  await one("select public.retire_unconfirmed_operation('journal',$1) r", [
    retiredMove.requestId,
  ])
  await reject(rpc(db, 'record_cash_movement', retiredMove), /descartada/)
  const accounts = async () =>
    (await one('select public.ledger_accounts_list() r')).r
  const a = (await accounts()).find((a) => a.code === '2117')
  const rename = {
    requestId: crypto.randomUUID(),
    action: 'rename',
    code: '2117',
    newCode: '2118',
    name: a.name,
    expectedRevision: a.revision,
  }
  await rpc(db, 'change_ledger_account', rename)
  const updated = (await accounts()).find((a) => a.code === '2117')
  eq(updated.displayCode, '2118')
  eq(updated.revision, 1)
  eq(
    (await ledger()).accounts.find((a) => a.code === '2117').displayCode,
    '2118',
  )
  eq(
    (await one('select public.get_journal_entry($1) r', [id])).r.lines[0]
      .displayAccount,
    '1110-001',
  )
  for (const newCode of ['1118', '2111', '2118-abc'])
    await reject(
      call('change_ledger_account', {
        action: 'rename',
        code: '2117',
        newCode,
        name: a.name,
        expectedRevision: 1,
      }),
      /tipo|registrado/,
    )
  await reject(
    call('change_ledger_account', {
      action: 'create',
      code: '2118',
      parent: '2100',
      name: 'Duplicada',
    }),
    /registrado/,
  )
  await reject(
    call('change_ledger_account', {
      action: 'deactivate',
      code: '2117',
      expectedRevision: 1,
    }),
    /necesaria/,
  )
  await rpc(db, 'change_ledger_account', rename)
  eq(
    (await accounts()).find((a) => a.code === '2117').revision,
    1,
    'reintento de número no repite auditoría',
  )
  await reject(
    call('change_ledger_account', {
      action: 'rename',
      code: '2117',
      newCode: '2119',
      name: a.name,
      expectedRevision: 0,
    }),
    /cuenta cambió/,
  )
  await identity(db, outsider)
  await call('change_ledger_account', {
    action: 'rename',
    code: '2117',
    newCode: '2119',
    name: a.name,
    expectedRevision: 1,
  })
  eq(
    (await accounts()).find((a) => a.code === '2117').displayCode,
    '2119',
    'superadmin también puede editar',
  )
  await reject(
    call('record_journal_entry', {
      kind: 'adjustment',
      occurredOn: '2026-11-05',
      description: 'No saltarse el cierre',
      currency: 'NIO',
      exchangeRate: 1,
      lines: [
        { account: '1110-001', debit: 10, credit: 0 },
        { account: '2117', debit: 0, credit: 10 },
      ],
      cashMovementInput: input,
    }),
    /jornada está cerrada/,
  )
  await call('open_business_day', { openingNio: 750, openingUsd: 120 })
  await db.exec(
    "reset role; insert into public.business_settings(name) values('Tienda aislada');insert into public.brands(name) values('Marca aislada');insert into public.exchange_rates(id,usd_to_nio) values(true,37) on conflict(id) do update set usd_to_nio=37;insert into public.products(id,sku,name,brand_id) values('aaaaaaaa-aaaa-4aaa-8aaa-000000000001','QA-ENVIO','Perfume',(select id from public.brands limit 1));insert into public.inventory_balances(product_id,location,quantity) values('aaaaaaaa-aaaa-4aaa-8aaa-000000000001','store',3),('aaaaaaaa-aaaa-4aaa-8aaa-000000000001','warehouse',0);insert into public.product_costs(product_id,average_cost_nio) values('aaaaaaaa-aaaa-4aaa-8aaa-000000000001',50);insert into public.product_prices(product_id,tier_code,currency,amount) values('aaaaaaaa-aaaa-4aaa-8aaa-000000000001','emprendedor','NIO',100)",
  )
  await identity(db, outsider)
  await call('create_document', {
    kind: 'invoice',
    customerName: 'Cliente aislado',
    tier: 'emprendedor',
    currency: 'NIO',
    exchangeRate: 1,
    location: 'store',
    paymentMethod: 'cash',
    notes: '',
    items: [{ productId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', quantity: 1 }],
    shippingMethod: 'moto',
    shippingAmount: 10,
  })
  const next = (
    await one("select public.ledger_report('2026-11-06','2026-11-06') r")
  ).r
  eq(next.accounts.find((a) => a.code === '2117').displayCode, '2119')
  eq(
    next.accounts.find((a) => a.code === '2117').credit,
    10,
    'los envíos siguen abonando la misma cuenta después de renumerarla',
  )
  const automatic = (
    await one(
      "select public.sales_journal_entries('2026-11-06','2026-11-06') r",
    )
  ).r
  eq(
    automatic.flatMap((a) => a.lines).find((l) => l.account === '2117')
      .displayAccount,
    '2119',
    'el comprobante automático usa la numeración visible',
  )
  const nextOpening = (
    await one("select public.get_business_day('2026-11-06') r")
  ).r.openingNio
  await rpc(
    db,
    'correct_closing_business_day',
    await correct({ countedNio: 740, countedUsd: 120 }),
  )
  eq(
    (await one("select public.get_business_day('2026-11-06') r")).r.openingNio,
    nextOpening,
    'editar ayer no pisa la apertura de hoy',
  )
  console.log(
    `PASS caja y numeración: ${checks} verificaciones de permisos, movimientos, arqueo, historial, monedas, códigos, concurrencia y recuperación.`,
  )
} finally {
  await db.close()
}

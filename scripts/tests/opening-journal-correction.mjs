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
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const reject = async (operation, pattern) => {
  await assert.rejects(operation, pattern)
  checks++
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const call = (name, input) => rpc(db, name, input)
const detail = async (id) =>
  (await one('select public.get_journal_entry($1) r', [id])).r
const ledger = async (from = '2026-11-01', to = '2026-11-02') =>
  (await one('select public.ledger_report($1,$2) r', [from, to])).r
const balances = async (...args) =>
  (await ledger(...args)).accounts
    .filter((a) => a.postable)
    .map((a) => [a.code, a.opening, a.debit, a.credit, a.closing])
const lines = (cash = 1000, bank = 2000, receivable = 500) => [
  { account: '1130', debit: 10000, credit: 0 },
  { account: '1110-001', debit: cash, credit: 0 },
  { account: '1120-003', debit: bank, credit: 0 },
  { account: '1140', debit: receivable, credit: 0 },
  { account: '3110-001', debit: 0, credit: 10000 + cash + bank + receivable },
]
try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.opening_edit_now')::timestamptz$$",
  )
  await db.query(
    "select set_config('lcp.opening_edit_now','2026-11-01T15:00:00Z',false)",
  )
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Administrador','admin'),($2,'Caja','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer'),($5,'Propietario','superadmin')",
    [admin, operator, warehouse, viewer, outsider],
  )
  await identity(db, admin)
  const originalInput = {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: '2026-11-01',
    description: 'Apertura original',
    reference: 'APERTURA-ORIGINAL',
    currency: 'NIO',
    exchangeRate: 1,
    lines: lines(),
  }
  const id = await call('record_journal_entry', originalInput)
  const original = await detail(id)
  const correction = (changes = {}) => ({
    requestId: crypto.randomUUID(),
    entryId: id,
    expectedRevision: 0,
    description: original.description,
    reference: original.reference,
    lines: lines(1200, 2300),
    ...changes,
  })
  const request = correction()
  for (const uid of [operator, warehouse, viewer]) {
    await identity(db, uid)
    await reject(
      call('correct_opening_journal', request),
      /permission|insufficient/i,
    )
    await reject(
      db.query('select public.get_journal_entry($1)', [id]),
      /permission|insufficient/i,
    )
  }
  await identity(db, '', 'anon')
  await reject(call('correct_opening_journal', request), /permission/)
  await identity(db, admin)
  for (const overrides of [
    { entryId: crypto.randomUUID() },
    { expectedRevision: null },
    { expectedRevision: 99 },
    { lines: lines(1200.001, 2300) },
    { lines: lines(-1) },
    {
      lines: [
        ...lines().slice(0, -1),
        { account: '3110-001', debit: 0, credit: 100 },
      ],
    },
    {
      lines: [
        { account: '4110', debit: 1000, credit: 0 },
        { account: '3110-001', debit: 0, credit: 1000 },
      ],
    },
    {
      lines: [
        { account: '1000', debit: 1000, credit: 0 },
        { account: '3110-001', debit: 0, credit: 1000 },
      ],
    },
    { description: '' },
    { reference: 'x'.repeat(201) },
    { lines: [] },
    { lines: lines() },
    {
      lines: [
        { account: '1130', debit: 10500, credit: 0 },
        ...lines().slice(1, -1),
        { account: '3110-001', debit: 0, credit: 14000 },
      ],
    },
  ])
    await reject(
      call('correct_opening_journal', correction(overrides)),
      /apertura|comprobante|concepto|referencia|valor|importe|Debe|inventario|cuentas|cambios/i,
    )
  eq(
    (await detail(id)).revision,
    0,
    'los rechazos no dejan escrituras parciales',
  )
  eq(await call('correct_opening_journal', request), id)
  const edited = await detail(id)
  eq(edited.number, original.number)
  eq(edited.id, id)
  eq(edited.occurred_on, original.occurred_on)
  eq(edited.created_at, original.created_at)
  eq(edited.currency, original.currency)
  eq(edited.revision, 1)
  eq(edited.lines.find((l) => l.account === '1110-001').debit, 1200)
  eq(edited.openingHistory.length, 1)
  eq(edited.openingHistory[0].before.lines, original.lines)
  eq(edited.openingHistory[0].after.lines, edited.lines)
  eq(edited.openingHistory[0].actorName, 'Administrador')
  eq(await call('correct_opening_journal', request), id)
  eq((await detail(id)).openingHistory.length, 1)
  await reject(
    call('correct_opening_journal', {
      ...request,
      description: 'Otro concepto',
    }),
    /solicitud.*cambió/,
  )
  await reject(call('correct_opening_journal', correction()), /apertura cambió/)
  eq(
    (
      await one('select public.get_operation_confirmation($1,$2) r', [
        'opening-journal-correction',
        request.requestId,
      ])
    ).r.status,
    'confirmed',
  )
  const retired = correction({ expectedRevision: 1, lines: lines(1300, 2300) })
  eq(
    (
      await one('select public.retire_unconfirmed_operation($1,$2) r', [
        'opening-journal-correction',
        retired.requestId,
      ])
    ).r.status,
    'retired',
  )
  await reject(call('correct_opening_journal', retired), /descartada/)
  eq((await detail(id)).revision, 1)
  await reject(
    db.query('update public.journal_entries set description=$1 where id=$2', [
      'Cambio directo',
      id,
    ]),
    /permission/,
  )
  await reject(
    db.query('delete from public.journal_lines where entry_id=$1', [id]),
    /permission/,
  )
  await reject(
    db.query('select * from private.opening_journal_corrections'),
    /permission/,
  )
  let day = await call('open_business_day', {
    requestId: crypto.randomUUID(),
    expectedDay: '2026-11-01',
    openingNio: 400,
    openingUsd: 0,
  })
  day = await call('close_business_day', {
    requestId: crypto.randomUUID(),
    day: day.day,
    expectedRevision: day.revision,
    expectedStateToken: day.stateToken,
    countedNio: 400,
    countedUsd: 0,
    note: '',
  })
  const dayHistory = (
    await one('select public.get_business_day_history($1) r', [day.day])
  ).r
  await db.query(
    "select set_config('lcp.opening_edit_now','2026-11-02T15:00:00Z',false)",
  )
  const historicalDayBeforeEdit = (
    await one('select public.get_business_day($1) r', [day.day])
  ).r
  await identity(db, outsider)
  const second = correction({
    expectedRevision: 1,
    lines: lines(1500, 3000),
    description: 'Apertura corregida por propietario',
  })
  eq(await call('correct_opening_journal', second), id)
  const final = await detail(id)
  eq(final.revision, 2)
  eq(final.number, original.number)
  eq(final.openingHistory[0].actorName, 'Propietario')
  eq(
    final.openingHistory[1].before.lines,
    original.lines,
    'las versiones anteriores siguen intactas',
  )
  eq(
    (await one('select public.get_business_day($1) r', [day.day])).r,
    historicalDayBeforeEdit,
    'no cambia el cierre ni su conteo físico',
  )
  eq(
    (await one('select public.get_business_day_history($1) r', [day.day])).r,
    dayHistory,
  )
  eq(
    (await one('select public.get_business_day(null) r')).r.status,
    'not_opened',
    'editar apertura no abre la tienda',
  )
  const nextMonth = await ledger('2026-12-01', '2026-12-31')
  eq(
    nextMonth.accounts.find((a) => a.code === '1110-001').opening,
    1500,
    'el mes siguiente arrastra el saldo corregido',
  )
  eq(nextMonth.accounts.find((a) => a.code === '1120-003').opening, 3000)
  const report = await ledger()
  const totals = report.accounts
    .filter((a) => a.postable)
    .reduce(
      (a, b) => ({ debit: a.debit + b.debit, credit: a.credit + b.credit }),
      { debit: 0, credit: 0 },
    )
  eq(totals.debit, totals.credit)
  eq(report.missingCosts, 0)
  const cashflow = (
    await one('select public.finance_cashflow($1,$2) r', [
      '2026-11-01',
      '2026-11-02',
    ])
  ).r
  eq(
    JSON.stringify(cashflow).includes('1500'),
    true,
    'flujo de efectivo usa la apertura corregida',
  )
  const beforeRejection = await balances()
  await reject(
    call(
      'correct_opening_journal',
      correction({ expectedRevision: 2, lines: lines(1500, 3000, -10) }),
    ),
    /Valor|positivo/,
  )
  eq(await balances(), beforeRejection)
  await db.exec('reset role')
  eq(
    await one(
      'select (select count(*) from public.journal_entries) entries,(select count(*) from private.opening_journal_corrections) edits,(select count(*) from public.documents) invoices,(select count(*) from public.inventory_movements) movements',
    ),
    { entries: 1, edits: 2, invoices: 0, movements: 0 },
  )
  console.log(
    `PASS edición de apertura contable: ${checks} verificaciones, permisos, historial, cierres intactos, recuperación y arrastre mensual`,
  )
} finally {
  await db.close()
}

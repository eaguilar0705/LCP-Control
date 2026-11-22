import assert from 'node:assert/strict'
import {
  admin,
  database,
  identity,
  operator,
  outsider,
  rpc,
  viewer,
  warehouse,
} from './database-fixture.mjs'

const db = await database()
const account = '1120-001'
const openingDay = '2026-11-03'
const movementDay = '2026-11-04'
const balances = ({ opening, debit, credit, closing }) => [
  opening,
  debit,
  credit,
  closing,
]
const cents = (amount) => Math.round(amount * 100)
const command = (name, input) =>
  rpc(db, name, { requestId: crypto.randomUUID(), ...input })
const journal = (kind, day, reference, lines) =>
  command('record_journal_entry', {
    kind,
    occurredOn: day,
    description: reference,
    reference,
    currency: 'NIO',
    exchangeRate: 1,
    lines: lines.map(([code, debit, credit]) => ({
      account: code,
      debit,
      credit,
    })),
  })
const history = async (
  from = null,
  offset = 0,
  code = account,
  to = movementDay,
) =>
  (
    await db.query(
      'select public.ledger_account_movements($1,$2,$3,$4) result',
      [code, from, to, offset],
    )
  ).rows[0].result
const ledger = async (from, to = movementDay) =>
  (await db.query('select public.ledger_report($1,$2) result', [from, to]))
    .rows[0].result

try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$ select '2026-11-04T15:00:00Z'::timestamptz $$",
  )
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Administrador','admin'),($2,'Caja','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer'),($5,'Propietario','superadmin')",
    [admin, operator, warehouse, viewer, outsider],
  )
  await identity(db, admin)

  await journal('opening', openingDay, 'QA-APERTURA', [
    [account, 1000, 0],
    ['3110-001', 0, 1000],
  ])
  await command('record_finance_entry', {
    kind: 'capital',
    occurredOn: openingDay,
    account: 'banco',
    bankLedgerAccount: account,
    amount: 12.34,
    currency: 'NIO',
    exchangeRate: 1,
    description: 'Aporte operativo anterior',
    reference: 'QA-APORTE',
  })
  for (let index = 1; index <= 51; index++) {
    await journal('income', movementDay, `QA-INGRESO-${index}`, [
      [account, 1.01, 0],
      ['4190', 0, 1.01],
    ])
  }
  const expense = await journal('expense', movementDay, 'QA-GASTO', [
    ['5130-002', 18.12, 0],
    [account, 0, 18.12],
  ])
  await journal('expense', movementDay, 'QA-OTRA-CUENTA', [
    ['5130-002', 43, 0],
    ['1110-001', 0, 43],
  ])
  const voided = await journal('income', movementDay, 'QA-ANULADO', [
    [account, 500, 0],
    ['4190', 0, 500],
  ])
  await identity(db, outsider)
  await db.query('select public.void_journal_entry($1,$2)', [
    voided,
    'Ingreso anulado para la prueba',
  ])
  await identity(db, admin)

  const first = await history()
  const second = await history(null, 50)
  assert.deepEqual(
    [first.account, first.from, first.to, first.offset, first.total],
    [account, null, movementDay, 0, 53],
  )
  assert.deepEqual(
    [first.rows.length, second.offset, second.total, second.rows.length],
    [50, 50, 53, 3],
  )
  assert.deepEqual(balances(first), [1000, 63.85, 18.12, 1045.73])
  assert.deepEqual(balances(second), balances(first))
  assert.ok(first.revision)
  assert.equal(second.revision, first.revision)
  assert.deepEqual(
    second,
    await history(null, 50),
    'el orden entre páginas es estable',
  )

  const rows = [...first.rows, ...second.rows]
  assert.equal(new Set(rows.map((row) => row.id)).size, 53)
  assert.deepEqual(
    new Set(rows.map((row) => row.reference)),
    new Set([
      'QA-APORTE',
      'QA-GASTO',
      ...Array.from({ length: 51 }, (_, index) => `QA-INGRESO-${index + 1}`),
    ]),
    'solo incluye movimientos vigentes de la cuenta seleccionada',
  )
  assert.deepEqual(
    rows.map((row) => row.day),
    [openingDay, ...Array(52).fill(movementDay)],
    'las páginas conservan el orden por fecha contable',
  )
  assert.equal(rows[0].description, 'Aporte operativo anterior')
  assert.equal(rows[0].source, 'Aporte de capital')
  assert.equal(
    rows.find((row) => row.reference === 'QA-GASTO').source,
    'Comprobante de egreso',
  )
  let running = cents(first.opening)
  for (const row of rows) {
    running += cents(row.debit) - cents(row.credit)
    assert.equal(cents(row.balance), running, row.reference)
  }
  assert.equal(running, cents(first.closing))

  const filtered = await history(movementDay)
  assert.deepEqual(balances(filtered), [1012.34, 51.51, 18.12, 1045.73])
  assert.equal(filtered.total, 52)
  assert.ok(filtered.rows.every((row) => row.day === movementDay))
  for (const [from, result] of [
    [openingDay, first],
    [movementDay, filtered],
  ]) {
    const report = await ledger(from)
    assert.deepEqual(
      balances(result),
      balances(report.accounts.find((row) => row.code === account)),
      'saldo inicial, cargos, abonos y saldo final coinciden con la balanza',
    )
  }

  const capital = await history(null, 0, '3110-001')
  assert.deepEqual(balances(capital), [1000, 0, 12.34, 1012.34])
  assert.equal(capital.rows[0].balance, 1012.34)
  const inactive = await history(null, 0, '4120')
  assert.deepEqual(balances(inactive), [0, 0, 0, 0])
  assert.equal(inactive.total, 0)
  assert.deepEqual(inactive.rows, [])
  assert.equal((await history(null, 100)).rows.length, 0)

  // Simula una edición entre páginas y una merma anterior al costo obligatorio.
  const product = crypto.randomUUID()
  await db.exec('reset role')
  await db.query(
    'update public.journal_entries set description=$1 where id=$2',
    ['Gasto con descripción actualizada', expense],
  )
  await db.exec("insert into public.brands(name) values('Marca de prueba')")
  await db.query(
    "insert into public.products(id,sku,name,brand_id) values($1,'QA-COSTO','Perfume de prueba',(select id from public.brands limit 1))",
    [product],
  )
  await db.query(
    "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',2),($1,'warehouse',0)",
    [product],
  )
  await db.query(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,50)',
    [product],
  )
  await identity(db, admin)
  const writeoff = await command('record_inventory_movement', {
    productId: product,
    location: 'store',
    type: 'DAMAGED',
    quantity: 1,
    expectedQuantity: 2,
    note: 'Merma sin costo histórico',
    reference: 'QA-MERMA',
  })
  await db.exec('reset role')
  await db.query(
    'update public.inventory_movement_costs set unit_cost_nio=null,total_cost_nio=null where movement_id=$1',
    [writeoff],
  )
  await identity(db, admin)

  const changed = await history()
  assert.equal(changed.total, first.total)
  assert.deepEqual(balances(changed), balances(first))
  assert.notEqual(changed.revision, first.revision)
  const incomplete = await history(null, 0, '5150')
  assert.deepEqual(balances(incomplete), [0, null, 0, null])
  assert.equal(incomplete.total, 1)
  const [loss] = incomplete.rows
  assert.equal(loss.source, 'Salida de inventario')
  assert.equal(loss.reference, 'QA-MERMA')
  assert.deepEqual([loss.debit, loss.credit, loss.balance], [null, 0, null])

  for (const id of [operator, warehouse, viewer, '']) {
    await identity(db, id)
    await assert.rejects(() => history(), { code: '42501' })
  }
  await identity(db, '', 'anon')
  await assert.rejects(() => history(), { code: '42501' })

  console.log(
    'PASS movimientos por cuenta: saldos iniciales, balanza, fuentes, paginación, anulaciones, costos faltantes y permisos',
  )
} finally {
  await db.close()
}

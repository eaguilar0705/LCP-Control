import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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

// PGlite is in-memory and never connects to a deployed Supabase project.
const db = await database()
let checks = 0
const get = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const call = (name, input) => rpc(db, name, input)
const equal = (actual, expected, message) => {
  assert.equal(actual, expected, message)
  checks++
}
async function rejects(work, pattern) {
  await db.exec('savepoint expected_rejection')
  try {
    await assert.rejects(work, pattern)
    checks++
  } finally {
    await db.exec(
      'rollback to savepoint expected_rejection; release savepoint expected_rejection',
    )
  }
}
async function scenario(name, work) {
  await db.exec('begin')
  try {
    await work()
    console.log(`PASS ${name}`)
  } finally {
    await db.exec('rollback')
  }
}
try {
  if (process.argv.includes('--baseline')) {
    // Reproduce the original cashflow error using the exact pre-fix functions.
    const sql = await readFile(
      'backend/supabase/migrations/20261003220730_cashflow_cash_closing.sql',
      'utf8',
    )
    await db.exec(
      sql
        .slice(0, sql.indexOf('create table public.cash_closings'))
        .replaceAll(
          'create function private.',
          'create or replace function private.',
        ),
    )
  }
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Contador','superadmin'),($2,'Ventas','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer')",
    [admin, operator, warehouse, viewer],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Auditoría contable aislada'); insert into public.brands(name) values('Auditoría');",
  )
  const product = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  await db.query(
    "insert into public.products(id,sku,name,brand_id) values($1,'AUDIT-001','Perfume',(select id from public.brands limit 1))",
    [product],
  )
  await db.query(
    "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',10),($1,'warehouse',0)",
    [product],
  )
  await db.query(
    "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',150)",
    [product],
  )
  await db.query(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,100) on conflict(product_id) do update set average_cost_nio=100',
    [product],
  )
  const { today, yesterday, beforeYesterday } = await get(
    "select (now() at time zone 'America/Managua')::date::text today,((now() at time zone 'America/Managua')::date-1)::text yesterday,((now() at time zone 'America/Managua')::date-2)::text \"beforeYesterday\"",
  )
  const voucher = (kind, lines, changes = {}) => ({
    requestId: crypto.randomUUID(),
    kind,
    occurredOn: today,
    description: 'Auditoría aislada',
    reference: 'AUDIT',
    currency: 'NIO',
    exchangeRate: 1,
    lines,
    ...changes,
  })
  const finance = (kind, amount, changes = {}) => ({
    requestId: crypto.randomUUID(),
    kind,
    amount,
    occurredOn: today,
    account: 'caja',
    currency: 'NIO',
    exchangeRate: 1,
    description: 'Auditoría aislada',
    ...changes,
  })
  const opening = (changes = {}) =>
    voucher(
      'opening',
      [
        { account: '1110-001', debit: 1000, credit: 0 },
        { account: '1120-001', debit: 500, credit: 0 },
        { account: '1130', debit: 1000, credit: 0 },
        { account: '1140', debit: 200, credit: 0 },
        { account: '1142', debit: 100, credit: 0 },
        { account: '2111', debit: 0, credit: 100 },
        { account: '3110-001', debit: 0, credit: 2700 },
      ],
      { occurredOn: beforeYesterday, ...changes },
    )
  const invoice = (method) => ({
    requestId: crypto.randomUUID(),
    kind: 'invoice',
    customerName: 'Cliente auditoría',
    tier: 'emprendedor',
    currency: 'NIO',
    location: 'store',
    paymentMethod: method,
    notes: '',
    items: [{ productId: product, quantity: 1 }],
  })
  const flow = async () =>
    (
      await get('select public.finance_cashflow($1,$2) r', [
        beforeYesterday,
        today,
      ])
    ).r
  const ledger = async () =>
    (
      await get('select public.ledger_report($1,$2) r', [
        beforeYesterday,
        today,
      ])
    ).r
  const credits = async () =>
    (await get('select public.credit_accounts($1) r', [today])).r
  const balance = async (code) =>
    (await ledger()).accounts.find((a) => a.code === code).closing
  const settlement = (amount, date = today) =>
    voucher(
      'card_settlement',
      [
        { account: '1120-001', debit: amount, credit: 0 },
        { account: '1142', debit: 0, credit: amount },
      ],
      {
        gross: amount,
        commissionRate: 0,
        withholdingRate: 0,
        withholdingBase: 'gross',
        bankAccount: '1120-001',
        occurredOn: date,
      },
    )
  await identity(db, admin)

  await scenario(
    'journal cash-flow opening, POS and voids reconcile to the general ledger',
    async () => {
      await call('record_journal_entry', opening())
      equal(
        (await flow()).closing.caja,
        1000,
        'la apertura journal debe habilitar caja',
      )
      equal(
        (await flow()).closing.banco,
        500,
        'la apertura journal debe habilitar bancos',
      )
      await call('open_business_day', {
        requestId: crypto.randomUUID(),
        openingNio: 1000,
        openingUsd: 0,
      })
      await call('create_document', invoice('card_pos'))
      equal(
        (await flow()).closing.banco,
        500,
        'POS pendiente no es dinero bancario',
      )
      equal(await balance('1142'), 250)
      const expense = await call(
        'record_journal_entry',
        voucher('expense', [
          { account: '5130-002', debit: 25, credit: 0 },
          { account: '1110-001', debit: 0, credit: 25 },
        ]),
      )
      equal((await flow()).closing.caja, 975, 'egreso manual incluido en flujo')
      equal(
        (await flow()).closing.caja,
        await balance('1110-001'),
        'caja flujo = mayor',
      )
      const transfer = await call(
        'record_journal_entry',
        voucher('transfer', [
          { account: '1120-003', debit: 50, credit: 0 },
          { account: '1110-001', debit: 0, credit: 50 },
        ]),
      )
      equal((await flow()).closing.caja, 925)
      equal((await flow()).closing.banco, 550)
      equal(
        (await flow()).totals.netNio,
        -25,
        'transferencia interna excluida del flujo externo',
      )
      const id = await call('record_journal_entry', settlement(150))
      equal((await flow()).closing.banco, 700, 'banco aumenta al liquidar POS')
      equal(await balance('1142'), 100)
      const bankTotal = (await ledger()).accounts
        .filter((a) => a.code.startsWith('1120-'))
        .reduce((sum, a) => sum + a.closing, 0)
      equal((await flow()).closing.banco, bankTotal, 'bancos flujo = mayor')
      await db.query('select public.void_journal_entry($1,$2)', [
        id,
        'Reversión auditoría',
      ])
      equal(
        (await flow()).closing.banco,
        550,
        'anulación revierte banco en flujo',
      )
      await db.query('select public.void_journal_entry($1,$2)', [
        transfer,
        'Reversión auditoría',
      ])
      await db.query('select public.void_journal_entry($1,$2)', [
        expense,
        'Reversión auditoría',
      ])
      equal((await flow()).closing.caja, 1000)
      const total = (await ledger()).accounts.reduce(
        (sum, a) => sum + a.debit - a.credit,
        0,
      )
      equal(total, 0, 'partida doble sigue equilibrada')
    },
  )

  await scenario(
    'debt adjustments reconcile auxiliaries and protect dependent settlements',
    async () => {
      await call('record_journal_entry', opening())
      const adjust = await call(
        'record_journal_entry',
        voucher('adjustment', [
          { account: '1140', debit: 100, credit: 0 },
          { account: '3190', debit: 0, credit: 100 },
        ]),
      )
      equal(
        (await credits()).rows.find((r) => r.id === 'opening:receivable')
          .balanceNio,
        300,
      )
      equal(await balance('1140'), 300, 'mayor y auxiliar clientes concilian')
      await call('record_finance_entry', finance('collection', 250))
      equal(
        (await credits()).rows.find((r) => r.id === 'opening:receivable')
          .balanceNio,
        50,
      )
      equal(await balance('1140'), 50)
      await rejects(
        () =>
          db.query('select public.void_journal_entry($1,$2)', [
            adjust,
            'Anular ajuste cobrado',
          ]),
        /negativo|abonos/,
      )
      equal(
        await balance('1140'),
        50,
        'anulación rechazada sin afectar registros',
      )
      await rejects(
        () =>
          call(
            'record_journal_entry',
            voucher('adjustment', [
              { account: '3190', debit: 51, credit: 0 },
              { account: '1140', debit: 0, credit: 51 },
            ]),
          ),
        /negativo/,
      )
      const supplier = await call(
        'record_journal_entry',
        voucher('adjustment', [
          { account: '3190', debit: 100, credit: 0 },
          { account: '2111', debit: 0, credit: 100 },
        ]),
      )
      equal(
        (await credits()).rows.find((r) => r.id === 'opening:payable')
          .balanceNio,
        200,
      )
      await call('record_finance_entry', finance('supplier_payment', 150))
      equal(
        (await credits()).rows.find((r) => r.id === 'opening:payable')
          .balanceNio,
        50,
      )
      equal(await balance('2111'), -50)
      await rejects(
        () =>
          db.query('select public.void_journal_entry($1,$2)', [
            supplier,
            'Anular ajuste pagado',
          ]),
        /negativo|abonos/,
      )
    },
  )

  await scenario(
    'backdated adjustments and POS settlements cannot overspend later balances',
    async () => {
      await call('record_journal_entry', opening())
      await call('record_finance_entry', finance('collection', 200))
      await rejects(
        () =>
          call(
            'record_journal_entry',
            voucher(
              'adjustment',
              [
                { account: '3190', debit: 1, credit: 0 },
                { account: '1140', debit: 0, credit: 1 },
              ],
              { occurredOn: yesterday },
            ),
          ),
        /negativo/,
      )
      await call('record_journal_entry', settlement(100))
      await rejects(
        () => call('record_journal_entry', settlement(1, yesterday)),
        /negativo|posteriores/,
      )
      equal(
        await balance('1142'),
        0,
        'rechazo de liquidación retroactiva atómico',
      )
    },
  )

  await scenario(
    'backdated debt payments respect later journal adjustments',
    async () => {
      await call('record_journal_entry', opening())
      await call(
        'record_journal_entry',
        voucher('adjustment', [
          { account: '3190', debit: 200, credit: 0 },
          { account: '1140', debit: 0, credit: 200 },
        ]),
      )
      await rejects(
        () =>
          call(
            'record_finance_entry',
            finance('collection', 1, { occurredOn: yesterday }),
          ),
        /negativo/,
      )
      equal(
        await balance('1140'),
        0,
        'cobro retroactivo rechazado sin sobregiro',
      )
      await call(
        'record_journal_entry',
        voucher('adjustment', [
          { account: '2111', debit: 100, credit: 0 },
          { account: '3190', debit: 0, credit: 100 },
        ]),
      )
      await rejects(
        () =>
          call(
            'record_finance_entry',
            finance('supplier_payment', 1, { occurredOn: yesterday }),
          ),
        /negativo/,
      )
      equal(
        await balance('2111'),
        0,
        'pago retroactivo rechazado sin sobregiro',
      )
    },
  )

  await scenario(
    'deleting an old POS invoice cannot spend a later invoice against an earlier settlement',
    async () => {
      await call('record_journal_entry', opening())
      await call('open_business_day', {
        requestId: crypto.randomUUID(),
        openingNio: 1000,
        openingUsd: 0,
      })
      const historical = await call('create_document', invoice('card_pos'))
      // Historical documents predate the day-session migration. Simulate the
      // old timestamp as the database owner; the customer RPC has no date input.
      await db.exec('reset role')
      await db.query(
        "update public.documents set created_at=($2::date::timestamp at time zone 'America/Managua') where id=$1",
        [historical.id, beforeYesterday],
      )
      await identity(db, admin)
      await call('record_journal_entry', settlement(250, yesterday))
      const current = await call('create_document', invoice('card_pos'))
      equal(await balance('1142'), 150)
      await rejects(
        () =>
          db.query('select public.delete_invoice($1,$2)', [
            historical.id,
            'Factura histórica liquidada',
          ]),
        /negativo|posteriores/,
      )
      equal(
        (
          await get(
            'select count(*)::int count from public.documents where id=$1',
            [historical.id],
          )
        ).count,
        1,
        'factura histórica conservada',
      )
      equal(
        (
          await get(
            "select quantity from public.inventory_balances where product_id=$1 and location='store'",
            [product],
          )
        ).quantity,
        8,
        'rechazo restaura inventario',
      )
      await db.query('select public.delete_invoice($1,$2)', [
        current.id,
        'Factura actual sin liquidar',
      ])
      equal(await balance('1142'), 0, 'factura no liquidada se puede anular')
    },
  )

  await scenario(
    'legacy opening adoption retains balances, date and no duplicate cash',
    async () => {
      await call(
        'record_finance_entry',
        finance('opening', 1000, { occurredOn: beforeYesterday }),
      )
      await call(
        'record_finance_entry',
        finance('opening', 200, {
          occurredOn: beforeYesterday,
          account: 'cobrar',
        }),
      )
      await call('record_finance_entry', finance('collection', 50))
      equal((await flow()).closing.caja, 1050, 'modo legacy sigue disponible')
      await rejects(
        () => call('record_journal_entry', opening({ occurredOn: yesterday })),
        /conservar la fecha/,
      )
      await rejects(
        () =>
          call(
            'record_journal_entry',
            voucher(
              'opening',
              [
                { account: '1110-001', debit: 1000, credit: 0 },
                { account: '1140', debit: 100, credit: 0 },
                { account: '3110-001', debit: 0, credit: 1100 },
              ],
              { occurredOn: beforeYesterday },
            ),
          ),
        /conservar el saldo/,
      )
      await call('record_journal_entry', opening())
      equal(
        (await flow()).closing.caja,
        1050,
        'apertura legacy no duplica apertura journal',
      )
      equal(
        (await credits()).rows.find((r) => r.id === 'opening:receivable')
          .balanceNio,
        150,
        'abono legacy conservado',
      )
      equal(await balance('1140'), 150)
    },
  )

  await scenario(
    'opening cash and bank currency controls are enforced in PostgreSQL',
    async () => {
      await rejects(
        () =>
          call(
            'record_journal_entry',
            voucher(
              'opening',
              [
                { account: '3110-001', debit: 1, credit: 0 },
                { account: '1110-001', debit: 0, credit: 1 },
              ],
              { occurredOn: beforeYesterday },
            ),
          ),
        /caja.*negativo|cada caja/,
      )
      await call('record_journal_entry', opening())
      await rejects(
        () =>
          call(
            'record_journal_entry',
            voucher('income', [
              { account: '1120-002', debit: 1, credit: 0 },
              { account: '4190', debit: 0, credit: 1 },
            ]),
          ),
        /moneda/,
      )
      await rejects(
        () =>
          call(
            'record_journal_entry',
            voucher(
              'income',
              [
                { account: '1120-001', debit: 1, credit: 0 },
                { account: '4190', debit: 0, credit: 1 },
              ],
              { currency: 'USD', exchangeRate: 36.6 },
            ),
          ),
        /moneda/,
      )
      await rejects(
        () =>
          call(
            'record_finance_entry',
            finance('collection', 1, {
              account: 'banco',
              bankLedgerAccount: '1120-002',
            }),
          ),
        /moneda/,
      )
      await call(
        'record_finance_entry',
        finance('collection', 1, {
          account: 'banco',
          bankLedgerAccount: '1120-002',
          currency: 'USD',
          exchangeRate: 36.6,
        }),
      )
      equal(await balance('1120-002'), 36.6)
    },
  )

  await scenario(
    'roles and direct table privileges protect all accounting endpoints',
    async () => {
      for (const uid of [operator, warehouse, viewer, outsider]) {
        await identity(db, uid)
        await rejects(() =>
          db.query('select public.finance_cashflow($1,$2)', [yesterday, today]),
        )
        await rejects(() =>
          db.query('select public.credit_accounts($1)', [today]),
        )
        await rejects(() => call('record_journal_entry', opening()))
        equal(
          (await db.query('select * from public.journal_entries')).rows.length,
          0,
          'RLS oculta asientos',
        )
        await rejects(() =>
          db.query(
            "insert into public.journal_lines(entry_id,line_no,account,debit,credit,debit_nio,credit_nio) values(gen_random_uuid(),1,'1140',1,0,1,0)",
          ),
        )
      }
      await identity(db, '', 'anon')
      await rejects(() =>
        db.query('select public.finance_cashflow($1,$2)', [yesterday, today]),
      )
      await identity(db, admin)
    },
  )
  console.log(
    `PASS database accounting audit: ${checks} assertions, isolated in-memory database`,
  )
} catch (error) {
  console.error(`FAIL database accounting audit: ${error.message}`)
  process.exitCode = 1
} finally {
  await db.close()
}

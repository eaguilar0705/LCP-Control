import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
} from './database-fixture.mjs'

const migration = '20261107010000_compras_con_inventario_fijo.sql'
const db = await database({ beforeMigration: migration })
const day = '2026-11-06'
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const rejects = async (action, pattern) => {
  await assert.rejects(action, pattern)
  checks++
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const call = (name, input) =>
  rpc(db, name, { requestId: crypto.randomUUID(), ...input })
const line = (account, debit, credit, currency = 'NIO', exchangeRate = 1) => ({
  account,
  debit,
  credit,
  currency,
  exchangeRate,
})
const ledger = async () =>
  (await one('select public.ledger_report($1,$1) r', [day])).r
const balance = (book, account) =>
  book.accounts.find((a) => a.code === account)?.closing ?? 0
const detail = async (id) =>
  (await one('select public.get_journal_entry($1) r', [id])).r
const classification = (shipmentId, lines, extra = {}) => ({
  shipmentId,
  occurredOn: day,
  description: 'Compra QA',
  reference: 'QA',
  currency: 'NIO',
  exchangeRate: 1,
  linkedPayments: [],
  lines,
  ...extra,
})

try {
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select '2026-11-06T20:00:00Z'::timestamptz$$",
  )
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'SuperAdmin QA','superadmin'),($2,'Caja QA','operator')",
    [admin, operator],
  )
  await db.exec(
    "insert into public.business_settings(name) values('QA'); insert into public.brands(name) values('QA')",
  )
  await db.query(
    "insert into public.products(id,sku,name,brand_id,size,unit) values($1,'QA-ORIGIN','Perfume QA',(select id from public.brands limit 1),100,'ml')",
    [product],
  )
  await db.query(
    "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',0),($1,'warehouse',0);",
    [product],
  )
  await db.query(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,0)',
    [product],
  )
  await identity(db, admin)
  await call('open_business_day', {
    expectedDay: day,
    openingNio: 10000,
    openingUsd: 0,
  })
  await call('record_journal_entry', {
    occurredOn: day,
    kind: 'opening',
    description: 'Apertura QA',
    reference: 'QA',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1120-001', debit: 10000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 10000 },
    ],
  })
  const purchase = {
    incurredOn: day,
    supplier: 'Proveedor QA',
    agency: '',
    reference: 'LEGACY',
    note: '',
    currency: 'NIO',
    exchangeRate: 1,
    account: 'pending',
    shippingAmount: 0,
    lines: [
      { productId: product, location: 'store', quantity: 10, unitPrice: 100 },
    ],
  }
  const receipt = await call('record_shipment', purchase)
  const legacyInput = {
    requestId: crypto.randomUUID(),
    ...classification(receipt, [
      line('2190', 1000, 0),
      line('1120-001', 0, 600),
      line('2111', 0, 400),
    ]),
  }
  const entry = await rpc(db, 'classify_purchase', legacyInput)
  const payment = await call('record_finance_entry', {
    occurredOn: day,
    kind: 'supplier_payment',
    account: 'banco',
    bankLedgerAccount: '1120-001',
    toAccount: null,
    amount: 100,
    currency: 'NIO',
    exchangeRate: 1,
    description: 'Abono existente',
    reference: 'PAY',
    counterparty: '',
    shipmentId: receipt,
  })
  await call('record_inventory_movement', {
    productId: product,
    location: 'store',
    type: 'EXIT',
    quantity: 2,
    expectedQuantity: 10,
    reference: 'EXIT',
    note: 'Salida anterior al upgrade',
  })
  const correction = await call('revise_purchase_receipt', {
    shipmentId: receipt,
    expectedRevision: 0,
    incurredOn: day,
    supplier: 'Proveedor QA',
    reference: 'CORRECTED',
    note: '',
    currency: 'NIO',
    exchangeRate: 1,
    shippingAmount: 0,
    counterpart: '2190',
    costAccount: '5150',
    lines: [
      { productId: product, location: 'store', quantity: 10, unitPrice: 120 },
    ],
    impacts: [
      {
        productId: product,
        expectedStore: 8,
        expectedWarehouse: 0,
        expectedValueNio: 800,
        targetValueNio: 960,
      },
    ],
  })
  const prepared = await call('record_shipment', {
    ...purchase,
    reference: 'PREPARED',
    lines: [
      { productId: product, location: 'store', quantity: 1, unitPrice: 50 },
    ],
  })
  const draftInput = {
    requestId: crypto.randomUUID(),
    draftId: crypto.randomUUID(),
    expectedRevision: -1,
    data: {
      kind: 'adjustment',
      date: day,
      description: 'Borrador previo',
      reference: 'DRAFT',
      submitName: 'classify_purchase',
      extraInput: { shipmentId: prepared, linkedPayments: [] },
      // Historical drafts allowed the counterparty before the inventory source.
      lines: [line('1120-001', 0, 50), line('2190', 50, 0)],
    },
  }
  await rpc(db, 'save_accounting_draft', draftInput)
  const before = await ledger()
  const quantitiesBefore = (
    await db.query(
      'select location,quantity from public.inventory_balances where product_id=$1 order by location',
      [product],
    )
  ).rows
  const paymentsBefore = (
    await db.query('select * from public.finance_entries where id=$1', [
      payment,
    ])
  ).rows
  const purchaseBefore = (
    await db.query('select * from public.purchase_shipments order by id')
  ).rows
  const businessDay = (await one('select public.get_business_day($1) r', [day]))
    .r
  await call('close_business_day', {
    day,
    expectedRevision: businessDay.revision,
    expectedStateToken: businessDay.stateToken,
    countedNio: businessDay.report.expectedNio,
    countedUsd: businessDay.report.expectedUsd,
    note: '',
  })
  await db.exec('reset role')
  await db.exec(
    await readFile(`backend/supabase/migrations/${migration}`, 'utf8'),
  )
  eq(
    (
      await one(
        'select closed_at is not null closed from public.business_days where day=$1',
        [day],
      )
    ).closed,
    true,
    'upgrade también conserva jornadas cerradas',
  )
  // Restore only this disposable fixture's open state for the new-posting cases.
  await db.query(
    'update public.business_days set closed_at=null,closed_by=null,closing_request=null,closing_payload=null,report=null where day=$1',
    [day],
  )
  await identity(db, admin)

  const after = await ledger()
  eq(
    (
      await db.query(
        'select location,quantity from public.inventory_balances where product_id=$1 order by location',
        [product],
      )
    ).rows,
    quantitiesBefore,
    'upgrade conserva existencias',
  )
  await db.exec('reset role')
  eq(
    (
      await db.query('select * from public.finance_entries where id=$1', [
        payment,
      ])
    ).rows,
    paymentsBefore,
    'upgrade no reescribe pagos',
  )
  eq(
    (await db.query('select * from public.purchase_shipments order by id'))
      .rows,
    purchaseBefore,
    'upgrade conserva compras originales y payloads',
  )
  await identity(db, admin)
  eq(
    balance(after, '1120-001'),
    balance(before, '1120-001'),
    'upgrade no descuenta de nuevo banco',
  )
  eq(
    balance(after, '2111'),
    balance(before, '2111'),
    'upgrade conserva crédito',
  )
  eq(
    balance(after, '5150'),
    balance(before, '5150'),
    'upgrade conserva costo consumido',
  )
  eq(
    balance(after, '1130'),
    760,
    'diferencias pendientes no se sustituyen con un pasivo ficticio',
  )
  eq(
    after.accounts.some((a) => a.code === '2190'),
    false,
    'cuenta temporal sin saldo fuera de informes',
  )
  eq(after.purchaseAccounting, {
    pendingCount: 2,
    pendingTotalNio: 1250,
    unpostedDifferenceNio: 250,
  })
  eq(
    after.accounts
      .filter((a) => a.postable)
      .reduce((sum, a) => sum + a.closing, 0),
    0,
    'libro mantiene partida doble',
  )
  const migrated = await detail(entry.id)
  eq(migrated.lines[0].account, '1130')
  eq(migrated.lines[0].debit_nio, 1000)
  eq(
    migrated.purchaseInventoryDebit,
    1200,
    'edición usa importe vigente, aunque el comprobante esté pendiente de revisión',
  )
  eq(
    migrated.editHistory.at(-1).before.lines[0].account,
    '2190',
    'historial conserva origen anterior',
  )
  eq(migrated.editHistory.at(-1).after.lines[0].account, '1130')
  eq(
    (await detail(correction.journalEntryId)).purchaseInventoryDebit,
    null,
    'ajuste de recepción no se convierte en compra nueva',
  )
  eq(
    (await detail(correction.journalEntryId)).lines.some(
      (l) => l.account === '2190',
    ),
    false,
  )
  eq(
    (await rpc(db, 'classify_purchase', legacyInput)).id,
    entry.id,
    'reintento anterior sigue idempotente',
  )
  eq(
    (await rpc(db, 'classify_purchase', legacyInput)).lines[0].account,
    '1130',
    'respuesta recuperada entrega comprobante vigente',
  )
  eq(
    (await one('select public.credit_accounts($1) r', [day])).r.rows.find(
      (r) => r.shipmentId === receipt,
    ).balanceNio,
    300,
  )
  eq(
    (await one('select public.ledger_accounts_list() r')).r.some(
      (a) => a.code === '2190',
    ),
    false,
  )
  eq(
    (await one('select public.accounting_drafts(0) r')).r[0].data
      .fixedInventoryDebit,
    50,
  )
  eq(
    (await one('select public.accounting_drafts(0) r')).r[0].data.lines[0],
    line('1130', 50, 0),
  )
  eq(
    (await one('select public.accounting_drafts(0) r')).r[0].data.lines,
    [line('1130', 50, 0), line('1120-001', 0, 50)],
    'normalizar un borrador de orden libre conserva toda su contrapartida',
  )

  const valid = {
    entryId: entry.id,
    expectedRevision: migrated.revision,
    occurredOn: day,
    description: 'Pago revisado',
    reference: 'CORRECTED',
    lines: [
      line('1130', 1200, 0),
      line('1120-001', 0, 800),
      line('2111', 0, 400),
    ],
  }
  await rejects(
    call('correct_journal_entry', {
      ...valid,
      lines: [line('5120', 1200, 0), ...valid.lines.slice(1)],
    }),
    /primer renglón|Inventario/,
  )
  await rejects(
    call('correct_journal_entry', {
      ...valid,
      lines: [
        line('1130', 1300, 0),
        line('1120-001', 0, 900),
        line('2111', 0, 400),
      ],
    }),
    /primer renglón|Inventario/,
  )
  await rejects(
    call('correct_journal_entry', {
      ...valid,
      lines: [line('1130', 100, 0, 'USD', 12), ...valid.lines.slice(1)],
    }),
    /primer renglón|Inventario/,
  )
  await rejects(
    call('correct_journal_entry', {
      ...valid,
      lines: [
        line('1130', 1200, 0),
        line('1130', 0, 800),
        line('2111', 0, 400),
      ],
    }),
    /primer renglón|Inventario/,
  )
  await rejects(
    call('correct_journal_entry', {
      ...valid,
      lines: [line('2190', 1200, 0), ...valid.lines.slice(1)],
    }),
    /activa|retirada/,
  )
  await call('correct_journal_entry', valid)
  eq(
    balance(await ledger(), '1130'),
    960,
    'revisión reconoce diferencia una vez y conserva costo consumido',
  )
  eq((await ledger()).purchaseAccounting, {
    pendingCount: 1,
    pendingTotalNio: 50,
    unpostedDifferenceNio: 50,
  })
  await rejects(
    call('change_ledger_account', {
      code: '2190',
      action: 'activate',
      expectedRevision: 1,
    }),
    /retirada/,
  )
  await identity(db, operator)
  await rejects(
    call(
      'classify_purchase',
      classification(prepared, [line('1130', 50, 0), line('1120-001', 0, 50)]),
    ),
    /privilege|permission/,
  )
  await identity(db, admin)
  const preparedPost = await call(
    'classify_purchase',
    classification(prepared, [line('1130', 50, 0), line('1120-001', 0, 50)], {
      draftId: draftInput.draftId,
      draftRevision: 0,
    }),
  )
  eq((await detail(preparedPost.id)).lines[0].account, '1130')
  eq((await one('select public.accounting_drafts(0) r')).r.length, 0)
  eq(balance(await ledger(), '1130'), 1010)
  eq((await ledger()).purchaseAccounting, {
    pendingCount: 0,
    pendingTotalNio: 0,
    unpostedDifferenceNio: 0,
  })
  eq(
    (
      await db.query(
        'select location,quantity from public.inventory_balances where product_id=$1 order by location',
        [product],
      )
    ).rows,
    quantitiesBefore,
    'contabilizar no duplica stock',
  )
  console.log(
    `PASS ${checks} comprobaciones de cargo fijo, upgrade con historial, abonos y borradores`,
  )
} finally {
  await db.close()
}

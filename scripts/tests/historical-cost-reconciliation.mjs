import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { database, identity, rpc, admin } from './database-fixture.mjs'

const db = await database()
const migrations = (await readdir('backend/supabase/migrations')).filter(
  (file) => file.endsWith('_conciliar_costos_historicos_confirmados.sql'),
)
assert.equal(migrations.length, 1)
const source = await readFile(
  `backend/supabase/migrations/${migrations[0]}`,
  'utf8',
)
const product = 'e98a3acd-87dd-5b08-80b6-10fc58b07857'
const originalDocs = [
  '8949daf5-3864-4c2e-ac22-924ee97ba680',
  '121c06ee-e95e-4950-80a0-1f477bd1b493',
]
const originalItems = [
  'f3223c3c-a7bc-47a2-b82e-4e1c3c1c624d',
  'c59f5fad-1dbc-4f1a-afee-159cdbdab8f8',
]
let sql = source.replaceAll('375a183f-cd63-46a9-9e85-c76c1494b8b9', admin)
let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const query = async (statement, args = []) =>
  (await db.query(statement, args)).rows
async function owner(statement, args = []) {
  await db.exec('reset role')
  try {
    return await query(statement, args)
  } finally {
    await db.exec('set role authenticated')
  }
}
async function apply() {
  await db.exec('reset role')
  // Ante un rechazo, reject() restaura el savepoint y el rol inmediatamente.
  await db.exec(sql)
  await db.exec('set role authenticated')
}
async function reject(pattern) {
  await db.exec('savepoint rejected_reconciliation')
  try {
    await assert.rejects(apply, pattern)
    checks++
  } finally {
    await db.exec('rollback to savepoint rejected_reconciliation')
    await db.exec('release savepoint rejected_reconciliation')
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
async function state() {
  return (
    await owner(`select jsonb_build_object(
      'products',(select jsonb_agg(to_jsonb(t) order by id) from public.products t),
      'prices',(select jsonb_agg(to_jsonb(t) order by product_id,tier_code,currency) from public.product_prices t),
      'pricing',(select jsonb_agg(to_jsonb(t) order by product_id) from public.product_pricing t),
      'stock',(select jsonb_agg(to_jsonb(t) order by product_id,location) from public.inventory_balances t),
      'documents',(select jsonb_agg(to_jsonb(t) order by id) from public.documents t),
      'items',(select jsonb_agg(to_jsonb(t) order by id) from public.document_items t),
      'movements',(select jsonb_agg(to_jsonb(t) order by id) from public.inventory_movements t),
      'averages',(select jsonb_agg(to_jsonb(t) order by product_id) from public.product_costs t),
      'snapshots',(select jsonb_agg(to_jsonb(t) order by document_item_id) from public.document_item_costs t),
      'audit',(select jsonb_agg(to_jsonb(t) order by id) from private.catalog_changes t),
      'days',(select jsonb_agg(to_jsonb(t) order by day) from public.business_days t)
    ) r`)
  )[0].r
}
const ledger = async () =>
  (
    await query('select public.ledger_report($1,$2) r', [
      '2026-10-13',
      '2026-10-16',
    ])
  )[0].r

try {
  // La fuente exacta debe ser inofensiva en instalaciones sin esos documentos.
  await db.exec(source)
  eq(
    (await query('select count(*)::int n from public.document_item_costs'))[0]
      .n,
    0,
  )
  eq(
    (await query('select count(*)::int n from private.catalog_changes'))[0].n,
    0,
  )
  await db.exec(
    "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select '2026-10-13T16:00:00Z'::timestamptz$$",
  )
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Responsable','superadmin')",
    [admin],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Auditoría histórica'); insert into public.brands(name) values('Marca')",
  )
  await db.query(
    "insert into public.products(id,sku,name,brand_id) values($1,'LCP-0183','212',(select id from public.brands limit 1))",
    [product],
  )
  await db.query(
    "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',20),($1,'warehouse',0)",
    [product],
  )
  await db.query(
    "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',2500),($1,'emprendedor','USD',68.31)",
    [product],
  )
  await identity(db, admin)
  await rpc(db, 'record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: '2026-10-13',
    description: 'Apertura contable',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1130', debit: 38000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 38000 },
    ],
  })
  await rpc(db, 'open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 0,
    openingUsd: 0,
  })
  const docs = []
  for (let index = 0; index < 2; index++) {
    const result = await rpc(db, 'create_document', {
      requestId: crypto.randomUUID(),
      kind: 'invoice',
      customerName: 'Cliente histórico',
      tier: 'emprendedor',
      currency: 'NIO',
      exchangeRate: 1,
      paymentMethod: 'cash',
      location: 'store',
      notes: '',
      items: [{ productId: product, quantity: 1 }],
    })
    const item = (
      await query('select id from public.document_items where document_id=$1', [
        result.id,
      ])
    )[0].id
    sql = sql
      .replaceAll(originalDocs[index], result.id)
      .replaceAll(originalItems[index], item)
    await owner('update public.documents set number=$2 where id=$1', [
      result.id,
      index === 0 ? 'FAC-000075' : 'FAC-000076',
    ])
    docs.push({ id: result.id, item })
  }
  const lateTarget = [...docs].sort((a, b) => a.id.localeCompare(b.id))[1]
  const reconcileAudit = async () =>
    owner(
      "select before_data,after_data,actor_id from private.catalog_changes where action='historical_cost_reconciliation' order by after_data->'historicalCostReconciliation'->>'documentNumber'",
    )

  await scenario(
    'dos costos autorizados completan el libro sin tocar ventas ni existencias',
    async () => {
      eq((await ledger()).missingCosts, 2)
      const before = await state()
      await apply()
      const after = await state()
      for (const key of Object.keys(before).filter(
        (key) => !['snapshots', 'audit'].includes(key),
      ))
        eq(after[key], before[key], `${key} permanece intacto`)
      eq(after.snapshots.length, 2)
      eq(
        after.snapshots.map((row) => row.unit_cost_nio),
        [1900, 1900],
      )
      for (const row of after.snapshots) {
        const old = before.snapshots.find(
          (item) => item.document_item_id === row.document_item_id,
        )
        eq(
          { ...row, unit_cost_nio: null },
          old,
          'sólo cambia el costo unitario del snapshot',
        )
      }
      const audit = await reconcileAudit()
      eq(audit.length, 2)
      for (const row of audit) {
        eq(row.actor_id, admin)
        eq(row.before_data.unit_cost_nio, null)
        eq(row.after_data.unit_cost_nio, 1900)
        eq(row.after_data.historicalCostReconciliation.unitCostNio, 1900)
      }
      eq((await ledger()).missingCosts, 0)
      const vouchers = (
        await query('select public.sales_journal_entries($1,$2) r', [
          '2026-10-13',
          '2026-10-13',
        ])
      )[0].r
      const costs = vouchers.find((row) => row.kind === 'sales_cost')
      eq(costs.missingCosts, 0)
      eq(costs.lines.find((row) => row.account === '5120').debit, 3800)
      eq(costs.lines.find((row) => row.account === '1130').credit, 3800)
      const once = await state()
      await apply()
      eq(await state(), once, 'repetir no agrega auditorías ni cambia fechas')
    },
  )

  await scenario(
    'una factura ausente cancela toda la conciliación',
    async () => {
      await owner(
        'update public.inventory_movements set document_id=null where document_id=$1',
        [docs[1].id],
      )
      await owner(
        'delete from public.document_item_costs where document_id=$1',
        [docs[1].id],
      )
      await owner('delete from public.document_items where document_id=$1', [
        docs[1].id,
      ])
      await owner('delete from public.documents where id=$1', [docs[1].id])
      const before = await state()
      await reject(/Falta una de las facturas/)
      eq(await state(), before)
    },
  )
  await scenario(
    'un costo conocido diferente se conserva sin actualización parcial',
    async () => {
      await owner(
        'update public.document_item_costs set unit_cost_nio=1853.77 where document_item_id=$1',
        [lateTarget.item],
      )
      const before = await state()
      await reject(/ya cambió/)
      eq(await state(), before)
    },
  )
  await scenario(
    'un costo sin la auditoría correspondiente tampoco se sobreescribe',
    async () => {
      await owner(
        'update public.document_item_costs set unit_cost_nio=1900 where document_item_id=$1',
        [lateTarget.item],
      )
      const before = await state()
      await reject(/ya cambió/)
      eq(await state(), before)
    },
  )
  await scenario(
    'cantidades alteradas no reciben el costo confirmado para una unidad',
    async () => {
      await owner(
        'update public.document_item_costs set quantity=2 where document_item_id=$1',
        [lateTarget.item],
      )
      const before = await state()
      await reject(/Cambió el detalle/)
      eq(await state(), before)
    },
  )
  await scenario(
    'una fecha distinta impide conciliar por equivocación',
    async () => {
      await owner(
        "update public.documents set created_at='2026-10-14T16:00:00Z' where id=$1",
        [lateTarget.id],
      )
      const before = await state()
      await reject(/Cambió el detalle/)
      eq(await state(), before)
    },
  )
  await scenario(
    'una jornada cerrada conserva su reporte y snapshots',
    async () => {
      const day = (await query('select public.get_business_day(null) r'))[0].r
      await rpc(db, 'close_business_day', {
        requestId: crypto.randomUUID(),
        day: day.day,
        countedNio: day.report.expectedNio,
        countedUsd: day.report.expectedUsd,
        expectedRevision: day.revision,
        expectedStateToken: day.stateToken,
        note: '',
      })
      const before = await state()
      await reject(/jornada ya fue cerrada/)
      eq(await state(), before)
    },
  )
  await scenario(
    'una cuenta confirmante inactiva no puede atribuir la conciliación',
    async () => {
      await owner(
        'update public.staff_members set active=false where user_id=$1',
        [admin],
      )
      const before = await state()
      await reject(/cuenta que confirmó/)
      eq(await state(), before)
    },
  )
  console.log(
    `Conciliación histórica: ${checks} verificaciones correctas; sólo PostgreSQL local desechable.`,
  )
} finally {
  await db.close()
}

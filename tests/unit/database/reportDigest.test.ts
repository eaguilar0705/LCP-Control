// @vitest-environment node
/**
 * La base de datos y la aplicación calculan los reportes igual.
 *
 * Carga todas las migraciones en un PostgreSQL desechable (PGlite), emite
 * facturas, proformas y movimientos con las mismas funciones que usa la
 * aplicación y les reparte fechas al azar (con semilla fija). Después compara,
 * periodo por periodo, lo que devuelve `public.report_digest` con lo que calcula
 * `digestFromSource` a partir de las filas crudas leídas con el mismo usuario.
 */
import { readFile, readdir } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import {
  digestFromPayload,
  digestFromSource,
  type ReportData,
} from '@/features/reports/digest'
import { emptyAccounting, monthsOf } from '@/features/reports/accounting'
import {
  addDays,
  previousRange,
  type ReportRange,
  type ReportSource,
} from '@/features/reports/model'
import { managuaBounds } from '@/features/sales/period'
import type { DocumentKind } from '@/lib/domain'

const admin = '11111111-1111-4111-8111-111111111111'
const operator = '22222222-2222-4222-8222-222222222222'
const db = new PGlite()

/** Generador con semilla: los mismos datos en cada corrida. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = seeded(20260926)
const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]
const between = (min: number, max: number) =>
  min + Math.floor(random() * (max - min + 1))
const uuid = (prefix: string, index: number) =>
  `${prefix}-0000-4000-8000-${String(index).padStart(12, '0')}`

async function identity(uid: string) {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid])
  await db.exec('set role authenticated')
}
async function asOwner<T>(sql: string, params: unknown[] = []) {
  const uid = (
    await db.query<{ uid: string }>(
      "select current_setting('request.jwt.claim.sub',true) as uid",
    )
  ).rows[0].uid
  await db.exec('reset role')
  const result = await db.query<T>(sql, params)
  if (uid) await identity(uid)
  return result.rows
}
async function rpc<T>(name: string, input: unknown) {
  return (
    await db.query<{ result: T }>(`select public.${name}($1::jsonb) as result`, [
      JSON.stringify(input),
    ])
  ).rows[0].result
}

let today = ''
const products = Array.from({ length: 10 }, (_, index) => uuid('aaaaaaaa', index + 1))
const customers = Array.from({ length: 24 }, (_, index) => uuid('cccccccc', index + 1))

/** Una marca de tiempo en segundos exactos, `daysAgo` días antes en Managua. */
function moment(daysAgo: number, seconds = between(0, 86399)) {
  const start = new Date(`${addDays(today, -daysAgo)}T00:00:00-06:00`)
  return new Date(start.getTime() + seconds * 1000).toISOString()
}

beforeAll(async () => {
  await db.exec(`create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[],owner uuid references auth.users(id),owner_id text);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid references auth.users(id),owner_id text,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated,anon;
    grant select,insert,delete on storage.objects to authenticated;
    create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
    create table auth.sessions(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id) on delete cascade);`)
  await db.query('insert into auth.users(id) values($1),($2)', [admin, operator])
  for (const file of (await readdir('supabase/migrations')).sort())
    if (file.endsWith('.sql') && !file.includes('harden_platform_function_grants'))
      await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'))
  // Datos de prueba en ráfaga: sin el límite de operaciones por minuto.
  await db.exec(`create or replace function private.enforce_rate_limit(p_action text) returns void language plpgsql as $$ begin end $$;`)
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Admin','admin'),($2,'Ventas','operator')",
    [admin, operator],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Pruebas'); insert into public.brands(name) values('Marca');",
  )
  today = (
    await db.query<{ day: string }>(
      "select ((now() at time zone 'UTC') - interval '6 hours')::date::text as day",
    )
  ).rows[0].day

  for (const [index, id] of products.entries()) {
    await db.query(
      "insert into public.products(id,sku,name,brand_id) values($1::uuid,$2,$3,(select id from public.brands limit 1))",
      [id, `SKU-${index}`, `Perfume ${index + 1}`],
    )
    for (const tier of ['emprendedor', 'vip', 'premium']) {
      const nio = between(12, 90) * 25
      await db.query(
        "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,$2,'NIO',$3),($1,$2,'USD',$4)",
        [id, tier, nio, Math.round((nio / 36.62) * 100) / 100],
      )
    }
    await db.query(
      "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',5000),($1,'warehouse',5000)",
      [id],
    )
  }
  for (const [index, id] of customers.entries())
    await db.query(
      "insert into public.customers(id,name,created_at) values($1,$2,$3)",
      [id, `Cliente ${String.fromCharCode(65 + index)}`, moment(between(0, 150))],
    )

  await identity(admin)
  // Ocho productos con costo; uno por encima de su precio (ventas bajo costo)
  // y dos sin costo (unidades sin costo en la contabilidad).
  for (const [index, id] of products.slice(0, 8).entries())
    await rpc('set_opening_cost', {
      requestId: crypto.randomUUID(),
      productId: id,
      unitCost: index === 0 ? 4000 : between(8, 40) * 10 + 0.5,
      currency: 'NIO',
      exchangeRate: 1,
      note: 'Costo inicial',
    })

  const issue = async (
    who: string,
    kind: DocumentKind,
    daysAgo: number,
    seconds?: number,
  ) => {
    await identity(who)
    const currency = random() < 0.25 ? 'USD' : 'NIO'
    const byName = who === operator || random() < 0.1
    const lines = [...products]
      .sort(() => random() - 0.5)
      .slice(0, between(1, 4))
      .map((productId) => ({ productId, quantity: between(1, 3) }))
    const document = await rpc<{ id: string }>('create_document', {
      requestId: crypto.randomUUID(),
      kind,
      ...(byName
        ? { customerName: `Mostrador ${between(1, 5)}` }
        : { customerId: pick(customers) }),
      tier: who === operator ? 'emprendedor' : pick(['emprendedor', 'vip', 'premium']),
      currency,
      ...(currency === 'USD' ? { exchangeRate: pick([36.62, 36.7, 36.55]) } : {}),
      taxRate: pick([0, 15]),
      notes: '',
      items: lines,
      ...(kind === 'invoice'
        ? { location: pick(['store', 'warehouse']), paymentMethod: pick(['cash', 'card_pos', 'bank_transfer', 'pending']) }
        : { validUntil: '2099-01-01' }),
    })
    const at = moment(daysAgo, seconds)
    await asOwner('update public.documents set created_at=$2 where id=$1', [document.id, at])
    await asOwner('update public.inventory_movements set created_at=$2 where document_id=$1', [document.id, at])
    return document.id
  }
  for (let i = 0; i < 170; i++) await issue(admin, 'invoice', between(0, 130))
  for (let i = 0; i < 25; i++) await issue(operator, 'invoice', between(0, 60))
  for (let i = 0; i < 30; i++) await issue(pick([admin, operator]), 'proforma', between(0, 90))
  // Casos de borde: 11:59 p. m. y 12:00 a. m. en Managua, a ambos lados de un día.
  await issue(admin, 'invoice', 7, 86399)
  await issue(admin, 'invoice', 6, 0)

  await identity(admin)
  const move = async (type: string, quantity: number, daysAgo: number) => {
    const id = await rpc<string>('record_inventory_movement', {
      requestId: crypto.randomUUID(),
      productId: pick(products),
      location: pick(['store', 'warehouse']),
      type,
      quantity,
      note: 'Prueba',
    })
    const at = moment(daysAgo)
    await asOwner('update public.inventory_movements set created_at=$2 where id=$1', [id, at])
    await asOwner('update public.inventory_movement_costs set created_at=$2 where movement_id=$1', [id, at])
    return id
  }
  const legacy: string[] = []
  for (let i = 0; i < 30; i++) await move(pick(['DAMAGED', 'EXIT']), between(1, 4), between(0, 120))
  for (let i = 0; i < 8; i++) await move('ADJUSTMENT', between(4000, 5100), between(0, 120))
  for (let i = 0; i < 6; i++) legacy.push(await move('DAMAGED', between(1, 3), between(0, 120)))
  for (let i = 0; i < 5; i++) await move('ENTRY', between(1, 9), between(0, 120))
  // Salidas anteriores al libro contable: sin fila de costo.
  await asOwner('delete from public.inventory_movement_costs where movement_id = any($1::uuid[])', [legacy])
  // Costos congelados que no cuadran: cantidad distinta o costo desconocido.
  await asOwner(
    'update public.document_item_costs set quantity=quantity+1 where document_item_id in (select document_item_id from public.document_item_costs order by document_item_id limit 4)',
  )
  await asOwner(
    'update public.document_item_costs set unit_cost_nio=null where document_item_id in (select document_item_id from public.document_item_costs order by document_item_id desc limit 5)',
  )
}, 180_000)

afterAll(() => db.close())

/** Lo mismo que lee el adaptador de Supabase cuando la función no existe. */
async function rawSource(range: ReportRange, withLedger: boolean): Promise<ReportSource> {
  const window = { from: previousRange(range).from, to: range.to }
  const { from, until } = managuaBounds(window)
  type Row = Record<string, unknown>
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.query<Row>(sql, params)).rows
  const iso = (value: unknown) => new Date(value as string).toISOString()
  const documents = await q(
    'select * from public.documents where created_at >= $1 and created_at < $2 order by created_at, id',
    [from, until],
  )
  const items = await q(
    'select document_id, product_id, description, quantity, line_total from public.document_items where document_id = any($1::uuid[]) order by id',
    [documents.map((row) => row.id)],
  )
  const customerRows = await q('select id, name, created_at from public.customers order by id')
  const movements = await q(
    'select * from public.inventory_movements where created_at >= $1 and created_at < $2 order by created_at, id',
    [from, until],
  )
  const saleCosts = withLedger
    ? await q(
        'select c.* from public.document_item_costs c join public.documents d on d.id = c.document_id where d.created_at >= $1 and d.created_at < $2',
        [from, until],
      )
    : []
  const movementCosts = withLedger
    ? await q(
        'select * from public.inventory_movement_costs where created_at >= $1 and created_at < $2',
        [from, until],
      )
    : []
  const nullable = (value: unknown) => (value == null ? null : Number(value))
  return {
    documents: documents.map((row) => ({
      id: row.id as string,
      kind: row.kind as DocumentKind,
      number: row.number as string,
      createdAt: iso(row.created_at),
      currency: row.currency as 'NIO' | 'USD',
      total: Number(row.total),
      tier: row.tier_code as 'emprendedor',
      paymentMethod: row.payment_method as 'cash',
      location: row.location as 'store',
      customerId: row.customer_id as string,
      customerName: row.customer_name as string,
      items: items
        .filter((item) => item.document_id === row.id)
        .map((item) => ({
          productId: item.product_id as string,
          description: item.description as string,
          quantity: Number(item.quantity),
          lineTotal: Number(item.line_total),
        })),
    })),
    customers: customerRows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      createdAt: iso(row.created_at),
    })),
    movements: movements.map((row) => ({
      id: row.id as string,
      productId: row.product_id as string,
      type: row.type as string,
      quantity: Number(row.quantity),
      beforeQuantity: nullable(row.before_quantity),
      afterQuantity: Number(row.after_quantity),
      createdAt: iso(row.created_at),
    })),
    inventory: [],
    accounting: withLedger
      ? {
          available: true,
          costs: [],
          shipments: [],
          expenses: [],
          saleCosts: saleCosts.map((row) => ({
            documentId: row.document_id as string,
            productId: row.product_id as string,
            quantity: Number(row.quantity),
            unitCostNio: nullable(row.unit_cost_nio),
            netRevenueNio: nullable(row.net_revenue_nio),
            taxNio: nullable(row.tax_nio),
          })),
          movementCosts: movementCosts.map((row) => ({
            movementId: row.movement_id as string,
            productId: row.product_id as string,
            type: row.type as 'DAMAGED',
            quantity: Number(row.quantity),
            unitCostNio: nullable(row.unit_cost_nio),
            createdAt: iso(row.created_at),
          })),
          truncated: false,
        }
      : structuredClone(emptyAccounting),
    window,
    truncated: false,
  }
}

async function fromDatabase(range: ReportRange, withLedger: boolean): Promise<ReportData> {
  const payload = (
    await db.query<{ digest: unknown }>('select public.report_digest($1::date, $2::date) as digest', [
      range.from,
      range.to,
    ])
  ).rows[0].digest
  return digestFromPayload(payload, {
    range,
    inventory: [],
    accounting: withLedger
      ? { ...structuredClone(emptyAccounting), available: true }
      : structuredClone(emptyAccounting),
    truncated: false,
  })
}

/** Mismo orden para lo que no tiene uno propio, meses completos y fechas ISO. */
function comparable(report: ReportData) {
  const byKey = <T extends { key: string }>(rows: T[]) =>
    [...rows].sort((a, b) => (a.key < b.key ? -1 : 1))
  const zero = {
    revenueNio: 0, salesTaxNio: 0, costOfSalesNio: 0, missingCostUnits: 0,
    missingRevenueLines: 0, soldUnits: 0, inventoryWriteOffNio: 0, missingWriteOffUnits: 0,
  }
  return {
    sales: Object.fromEntries(
      Object.entries(report.sales).map(([code, sales]) => [
        code,
        { ...sales, payments: byKey(sales.payments), tiers: byKey(sales.tiers) },
      ]),
    ),
    movements: report.movements,
    ledger: report.ledger && {
      ...report.ledger,
      products: [...report.ledger.products].sort((a, b) => (a.productId < b.productId ? -1 : 1)),
      tiers: [...report.ledger.tiers].sort((a, b) => (a.tier < b.tier ? -1 : 1)),
      months: monthsOf(report.range).map(({ month }) => ({
        month,
        ...zero,
        ...report.ledger!.months.find((row) => row.month === month),
      })),
      belowCost: {
        ...report.ledger.belowCost,
        rows: report.ledger.belowCost.rows.map((row) => ({
          ...row,
          createdAt: new Date(row.createdAt).toISOString(),
        })),
      },
    },
  }
}

/** Igualdad exacta salvo el centavo que puede separar dos sumas de dinero. */
function expectSame(actual: unknown, expected: unknown, path = 'resumen') {
  if (typeof expected === 'number') {
    expect(typeof actual, path).toBe('number')
    expect(Math.abs((actual as number) - expected), `${path}: ${actual} ≠ ${expected}`).toBeLessThan(0.011)
    return
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true)
    expect((actual as unknown[]).length, `${path}.length`).toBe(expected.length)
    expected.forEach((item, index) => expectSame((actual as unknown[])[index], item, `${path}[${index}]`))
    return
  }
  if (expected && typeof expected === 'object') {
    expect(actual && typeof actual === 'object', path).toBeTruthy()
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual as object)])
    for (const key of keys)
      expectSame((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`)
    return
  }
  expect(actual, path).toEqual(expected)
}

describe('report_digest da las mismas cifras que el cálculo de la aplicación', () => {
  const periods = (): [string, ReportRange][] => [
    ['últimos 30 días', { from: addDays(today, -29), to: today }],
    ['últimos 7 días', { from: addDays(today, -6), to: today }],
    ['un solo día, justo después de medianoche', { from: addDays(today, -6), to: addDays(today, -6) }],
    ['un solo día, hasta las 11:59 p. m.', { from: addDays(today, -7), to: addDays(today, -7) }],
    ['90 días', { from: addDays(today, -89), to: today }],
    ['dos meses del pasado', { from: addDays(today, -75), to: addDays(today, -40) }],
    ['un periodo sin movimiento', { from: addDays(today, 1), to: addDays(today, 10) }],
  ]

  it('administración: ventas, movimientos y libro contable', async () => {
    await identity(admin)
    for (const [name, range] of periods()) {
      const database = await fromDatabase(range, true)
      const browser = digestFromSource(await rawSource(range, true), range)
      expectSame(comparable(database), comparable(browser), name)
    }
    // Que la prueba no pase en vacío.
    const month = await fromDatabase({ from: addDays(today, -29), to: today }, true)
    expect(month.sales.NIO.current.count).toBeGreaterThan(10)
    expect(month.sales.USD.current.count).toBeGreaterThan(0)
    expect(month.sales.NIO.lapsed.length + month.sales.NIO.visits.length).toBeGreaterThan(0)
    expect(month.ledger?.belowCost.count).toBeGreaterThan(0)
    expect(month.ledger?.missingCostUnits).toBeGreaterThan(0)
    expect(month.ledger?.missingWriteOffUnits).toBeGreaterThan(0)
    expect(month.movements.damaged).toBeGreaterThan(0)
  }, 60_000)

  it('ventas sólo ve sus propias facturas y no recibe el libro contable', async () => {
    await identity(operator)
    const range = { from: addDays(today, -29), to: today }
    const database = await fromDatabase(range, true)
    expect(database.ledger).toBeNull()
    const browser = digestFromSource(await rawSource(range, false), range)
    expectSame(comparable({ ...database, ledger: null }), comparable(browser), 'ventas')
    const everything = await (async () => {
      await identity(admin)
      return fromDatabase(range, true)
    })()
    expect(database.sales.NIO.current.count).toBeLessThan(everything.sales.NIO.current.count)
  })

  it('rechaza fechas invertidas y a quien no es del personal', async () => {
    await identity(admin)
    await expect(
      db.query("select public.report_digest('2026-09-30','2026-09-01')"),
    ).rejects.toThrow(/Desde/)
    await identity('33333333-3333-4333-8333-333333333333')
    await expect(
      db.query("select public.report_digest('2026-09-01','2026-09-30')"),
    ).rejects.toThrow(/permiso/)
  })
})

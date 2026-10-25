import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildCostImportSql } from '../import/costos-iniciales.mjs'
import {
  database,
  identity,
  rpc,
  admin,
  operator,
  outsider,
} from './database-fixture.mjs'

const db = await database()
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const invalid = (manifest, pattern) => {
  assert.throws(() => buildCostImportSql(manifest), pattern)
  checks++
}
async function rejects(sql, pattern) {
  try {
    await assert.rejects(db.exec(sql), pattern)
    checks++
  } finally {
    await db.exec('rollback; reset role;')
  }
}
const get = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const ids = Array.from({ length: 8 }, () => randomUUID())
const row = (index, changes = {}) => ({
  sku: `LCP-${9001 + index}`,
  productId: ids[index],
  expectedRevision: 1,
  costNio: '879.360000',
  costUSD: '24.01',
  sourcePage: 1,
  sourceRow: index + 2,
  ...changes,
})
const manifest = (rows, changes = {}) => ({
  source: { filename: 'Costos LCDP octubre 2026.pdf', sha256: 'a'.repeat(64) },
  actorId: admin,
  mode: 'initial-cost',
  rows,
  ...changes,
})
const state = () =>
  get(`select
 (select jsonb_agg(to_jsonb(x) order by x.product_id,x.location) from public.inventory_balances x) inventory,
 (select jsonb_agg(to_jsonb(x) order by x.product_id,x.tier_code,x.currency) from public.product_prices x) prices,
 (select jsonb_agg(to_jsonb(x) order by x.product_id) from public.product_pricing x) pricing,
 (select jsonb_agg(to_jsonb(x) order by x.id) from public.documents x) documents,
 (select jsonb_agg(to_jsonb(x) order by x.id) from public.document_items x) items,
 (select jsonb_agg(to_jsonb(x) order by x.document_item_id) from public.document_item_costs x) sale_costs,
 (select jsonb_agg(to_jsonb(x) order by x.movement_id) from public.inventory_movement_costs x) movement_costs,
 (select jsonb_agg(to_jsonb(x) order by x.id) from public.inventory_movements x) movements`)

try {
  await db.query(
    "insert into public.staff_members(user_id,display_name,role,active) values($1,'Responsable','superadmin',true),($2,'Vendedor','operator',true),($3,'Inactivo','admin',false)",
    [admin, operator, outsider],
  )
  await db.exec(
    "insert into public.business_settings(name) values('Pruebas locales de costos'); insert into public.brands(name) values('Pruebas');",
  )
  for (let index = 0; index < ids.length; index++) {
    await db.query(
      "insert into public.products(id,sku,name,brand_id,size,unit) values($1,$2,$3,(select id from public.brands limit 1),$4,'oz')",
      [
        ids[index],
        `LCP-${9001 + index}`,
        `Perfume ${index + 1}`,
        index === 3 ? null : 3.4,
      ],
    )
    await db.query(
      "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',$2),($1,'warehouse',$2)",
      [ids[index], index === 0 ? null : index === 4 ? 10 : 0],
    )
    await db.query(
      "insert into public.product_prices(product_id,tier_code,currency,amount) values($1,'emprendedor','NIO',1500),($1,'emprendedor','USD',41),($1,'vip','NIO',1400)",
      [ids[index]],
    )
    await db.query(
      "insert into public.product_pricing(product_id,purchase_price,purchase_currency,markup_emprendedor,updated_by) values($1,1200,'NIO',25,$2)",
      [ids[index], admin],
    )
  }
  // La migración original creó filas nulas antes de instalar el disparador.
  // Reproducimos ese estado heredado únicamente en esta base desechable.
  await db.exec(
    'alter table public.product_costs disable trigger sync_cost_prices;',
  )
  await db.query(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,1900),($2,null),($3,250)',
    [ids[1], ids[2], ids[3]],
  )
  await db.exec(
    'alter table public.product_costs enable trigger sync_cost_prices;',
  )
  await db.query(
    'insert into public.product_costs(product_id,average_cost_nio) values($1,100)',
    [ids[4]],
  )
  await identity(db, admin)
  await rpc(db, 'open_business_day', {
    requestId: randomUUID(),
    openingNio: 0,
    openingUsd: 0,
  })
  await rpc(db, 'create_document', {
    requestId: randomUUID(),
    kind: 'invoice',
    customerName: 'Venta anterior al costo',
    tier: 'emprendedor',
    currency: 'NIO',
    exchangeRate: 1,
    location: 'store',
    paymentMethod: 'cash',
    notes: '',
    items: [{ productId: ids[4], quantity: 1 }],
  })
  await rpc(db, 'record_inventory_movement', {
    requestId: randomUUID(),
    productId: ids[4],
    type: 'DAMAGED',
    quantity: 1,
    location: 'warehouse',
    note: 'Merma anterior al costo',
  })
  await db.exec(
    "reset role; select set_config('request.jwt.claim.sub','',false);",
  )
  // Estado histórico preparado como propietario; la aplicación ya no emite
  // ventas nuevas con costo desconocido ni modifica costos históricos.
  await db.query(
    'update public.document_item_costs set unit_cost_nio=null where product_id=$1',
    [ids[4]],
  )
  await db.query(
    'update public.inventory_movement_costs set unit_cost_nio=null where product_id=$1',
    [ids[4]],
  )
  await db.query('delete from public.product_costs where product_id=$1', [
    ids[4],
  ])
  equal(
    (await get('select unit_cost_nio from public.document_item_costs'))
      .unit_cost_nio,
    null,
    'La venta previa no tenía costo conocido',
  )
  equal(
    (await get('select unit_cost_nio from public.inventory_movement_costs'))
      .unit_cost_nio,
    null,
    'La merma previa no tenía costo conocido',
  )
  const before = await state()
  const input = manifest([
    row(0),
    row(1, { costNio: '1853.770000', costUSD: '50.62' }),
    row(2, { costNio: '1234.567891' }),
    row(3, { sizeOz: 3.4 }),
    row(4),
  ])

  invalid(
    { ...input, source: { filename: 'Fuente', sha256: 'incompleto' } },
    /SHA-256/,
  )
  invalid({ ...input, rows: [row(0), row(0)] }, /duplicado/)
  invalid(
    { ...input, rows: [row(0), row(1, { sku: row(0).sku })] },
    /duplicado/,
  )
  invalid({ ...input, rows: [row(0, { sku: 'DEMO-0001' })] }, /SKU LCP/)
  invalid({ ...input, rows: [row(0, { expectedRevision: 1.1 })] }, /revisión/)
  for (const costNio of ['0', '-1', 'NaN', '1.1234567', '1e3', 50])
    invalid(manifest([row(0, { costNio })]), /costos/)
  invalid(manifest([row(0, { costUSD: '24.011' })]), /costos/)
  invalid(manifest([row(0, { sizeOz: 3.4567 })]), /tamaño/)

  // Ninguna fila se escribe si otra del mismo lote está desactualizada.
  await rejects(
    buildCostImportSql(manifest([row(0), row(1, { expectedRevision: 99 })]), {
      commit: true,
    }),
    /Otro usuario/,
  )
  equal(
    await get(
      'select average_cost_nio from public.product_costs where product_id=$1',
      [ids[0]],
    ),
    undefined,
  )
  equal(
    (
      await get(
        "select count(*)::int n from private.catalog_changes where action='cost_import'",
      )
    ).n,
    0,
  )
  await rejects(
    buildCostImportSql(manifest([row(0), row(1, { productId: ids[2] })]), {
      commit: true,
    }),
    /UUID no corresponde/,
  )
  await rejects(
    buildCostImportSql(manifest([row(0, { sizeOz: 6.8 })]), { commit: true }),
    /tamaño/,
  )
  await rejects(
    buildCostImportSql(manifest([row(0)], { actorId: operator }), {
      commit: true,
    }),
    /admin o superadmin activo/,
  )
  await rejects(
    buildCostImportSql(manifest([row(0)], { actorId: outsider }), {
      commit: true,
    }),
    /admin o superadmin activo/,
  )
  await identity(db, admin)
  await rejects(
    buildCostImportSql(input, { commit: true }),
    /ejecutor administrativo/,
  )
  await db.exec("select set_config('request.jwt.claim.sub','',false);")

  // El ensayo incluye las escrituras y las revierte, incluida la reparación de talla.
  await db.exec(buildCostImportSql(input))
  equal(
    (
      await get(
        'select average_cost_nio from public.product_costs where product_id=$1',
        [ids[2]],
      )
    ).average_cost_nio,
    null,
  )
  equal(
    await get('select size,revision from public.products where id=$1', [
      ids[3],
    ]),
    { size: null, revision: 1 },
  )
  equal(
    (
      await get(
        "select count(*)::int n from private.catalog_changes where action='cost_import'",
      )
    ).n,
    0,
  )
  equal(
    await state(),
    before,
    'El ensayo conserva existencias, precios, compras e historial',
  )

  await db.exec(buildCostImportSql(input, { commit: true }))
  equal(
    (
      await get(
        'select average_cost_nio from public.product_costs where product_id=$1',
        [ids[0]],
      )
    ).average_cost_nio,
    '879.360000',
    'Puede guardar costo informado aunque la existencia sea desconocida',
  )
  equal(
    (
      await get(
        'select average_cost_nio from public.product_costs where product_id=$1',
        [ids[1]],
      )
    ).average_cost_nio,
    '1900.000000',
    'Preserva el promedio conocido de 1900 frente a la nueva lista de 1853.77',
  )
  equal(
    (
      await get(
        'select average_cost_nio from public.product_costs where product_id=$1',
        [ids[2]],
      )
    ).average_cost_nio,
    '1234.567891',
    'Conserva seis decimales exactos',
  )
  equal(
    (
      await get(
        'select average_cost_nio from public.product_costs where product_id=$1',
        [ids[3]],
      )
    ).average_cost_nio,
    '250.000000',
  )
  equal(
    await get(
      'select size,revision,size_needs_review from public.products where id=$1',
      [ids[3]],
    ),
    { size: '3.400', revision: 2, size_needs_review: false },
  )
  equal(
    (await get('select revision from public.products where id=$1', [ids[0]]))
      .revision,
    2,
  )
  equal(
    (await get('select revision from public.products where id=$1', [ids[1]]))
      .revision,
    1,
    'Con costo y talla ya conocidos no se altera el producto',
  )
  equal(
    await state(),
    before,
    'No modifica ventas, costos históricos, compras, listas ni inventario',
  )
  equal(
    (
      await get(
        "select count(*)::int n from private.catalog_changes where action='cost_import'",
      )
    ).n,
    5,
  )
  const audit = await get(
    "select actor_id,before_data,after_data from private.catalog_changes where product_id=$1 and action='cost_import'",
    [ids[0]],
  )
  equal(audit.actor_id, admin)
  equal(audit.before_data.averageCostNio, null)
  equal(audit.after_data.averageCostNio, 879.36)
  equal(audit.after_data.costImport.row.costUSD, '24.01')
  equal(audit.after_data.costImport.row.sourcePage, 1)
  equal(audit.after_data.costImport.row.sourceRow, 2)
  equal(audit.after_data.costImport.source, input.source)

  // Repetir el mismo PDF ni requiere la vieja revisión ni duplica el historial.
  await db.exec(buildCostImportSql(input, { commit: true }))
  equal(
    (
      await get(
        "select count(*)::int n from private.catalog_changes where action='cost_import'",
      )
    ).n,
    5,
  )
  equal(
    (await get('select revision from public.products where id=$1', [ids[0]]))
      .revision,
    2,
  )
  await rejects(
    buildCostImportSql(manifest([row(0, { costNio: '1.000000' })]), {
      commit: true,
    }),
    /otro modo o contenido/,
  )
  await rejects(
    buildCostImportSql(manifest([row(0)], { mode: 'purchase-reference' }), {
      commit: true,
    }),
    /otro modo o contenido/,
  )
  equal(await state(), before)

  // Una nueva fuente no puede sobrescribir un promedio conocido.
  const secondSource = { filename: 'Nueva lista.pdf', sha256: 'b'.repeat(64) }
  await db.exec(
    buildCostImportSql(
      manifest([row(0, { expectedRevision: 2, costNio: '1.000000' })], {
        source: secondSource,
      }),
      { commit: true },
    ),
  )
  equal(
    (
      await get(
        'select average_cost_nio from public.product_costs where product_id=$1',
        [ids[0]],
      )
    ).average_cost_nio,
    '879.360000',
  )
  equal(
    (await get('select revision from public.products where id=$1', [ids[0]]))
      .revision,
    2,
  )

  const trickySource = {
    filename:
      "Costos ' \\ $lcp_manifest_0$ $lcp_cost_import_0$; no ejecutar.pdf",
    sha256: 'c'.repeat(64),
  }
  const reference = manifest([row(5)], {
    mode: 'purchase-reference',
    source: trickySource,
  })
  await db.exec(buildCostImportSql(reference, { commit: true }))
  equal(
    await get(
      'select average_cost_nio from public.product_costs where product_id=$1',
      [ids[5]],
    ),
    undefined,
    'La referencia no establece un costo promedio',
  )
  equal(
    (await get('select revision from public.products where id=$1', [ids[5]]))
      .revision,
    1,
  )
  equal(
    (
      await get(
        "select after_data->'costImport'->'source' source from private.catalog_changes where product_id=$1 and action='cost_import'",
        [ids[5]],
      )
    ).source,
    trickySource,
    'El nombre fuente con comillas y delimitadores se conserva literalmente',
  )
  equal(await state(), before)
  equal(
    (
      await get(
        "select nullif(current_setting('request.jwt.claim.sub',true),'') subject",
      )
    ).subject,
    null,
    'El importador no suplanta Auth',
  )

  // Las validaciones SQL también frenan un manifiesto modificado tras generarlo.
  const normal = buildCostImportSql(
    manifest([row(6)], {
      source: { filename: 'Alterada.pdf', sha256: 'd'.repeat(64) },
    }),
    { commit: true },
  )
  await rejects(
    normal.replace('"sku":"LCP-9007"', '"sku":"DEMO-9007"'),
    /filas inválidas/,
  )
  equal(
    await get(
      'select average_cost_nio from public.product_costs where product_id=$1',
      [ids[6]],
    ),
    undefined,
  )
  console.log(
    `Importación de costos: ${checks} comprobaciones correctas; solo base local desechable.`,
  )
} catch (error) {
  console.error(
    `Importación de costos: ${error.code ?? 'ERROR'}: ${error.message}`,
  )
  process.exitCode = 1
} finally {
  await db.close()
}

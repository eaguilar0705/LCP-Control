import assert from 'node:assert/strict'
import { database, identity, admin, operator } from './database-fixture.mjs'
const db = await database()
let checks = 0
const equal = (a, b, m) => {
  assert.deepEqual(a, b, m)
  checks++
}
const rejects = async (p, re) => {
  await assert.rejects(p, re)
  checks++
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const read = async (token = null) =>
  (await one('select read_storefront_catalog($1) result', [token])).result
try {
  await db.query(
    "insert into staff_members(user_id,display_name,role) values($1,'Admin','superadmin'),($2,'Caja','operator')",
    [admin, operator],
  )
  await db.exec(
    "insert into price_tiers(code,name,sort_order) values('menudeo','Menudeo',4) on conflict do nothing; insert into private.storefront_catalog_links(tier_code) select 'menudeo' where not exists(select 1 from private.storefront_catalog_links where tier_code='menudeo')",
  )
  const product = crypto.randomUUID()
  await db.exec("insert into brands(name) values('Marca QA')")
  await db.query(
    "insert into products(id,sku,name,brand_id,size,unit,category,gender) values($1,'QA-4','Perfume',(select id from brands limit 1),100,'ml','arabian','male')",
    [product],
  )
  for (const [tier, amount] of [
    ['menudeo', 100],
    ['emprendedor', 80],
    ['vip', 70],
    ['premium', 60],
  ])
    await db.query(
      "insert into product_prices(product_id,tier_code,currency,amount) values($1,$2,'USD',$3)",
      [product, tier, amount],
    )
  await identity(db, admin)
  const links = (await one('select storefront_catalog_links() result')).result
  equal(links.length, 4, 'solo los administradores reciben los cuatro enlaces')
  const d = await one('select * from storefront_drafts where id=$1', [product])
  const content = {
    ...d.content,
    price: 999,
    images: [{ kind: 'local', path: 'images/productos/qa.webp' }],
  }
  const saved = (
    await one("select storefront_action('save',$1,$2,$3,$4) result", [
      d.id,
      d.revision,
      content,
      d.source_version,
    ])
  ).result
  await one("select storefront_action('publish',$1,$2,$3,$4)", [
    saved.id,
    saved.revision,
    saved.content,
    saved.source_version,
  ])
  await identity(db, '', 'anon')
  equal((await read()).name, 'Menudeo', 'la raíz conserva Menudeo')
  for (const [tier, amount] of [
    ['menudeo', 100],
    ['emprendedor', 80],
    ['vip', 70],
    ['premium', 60],
  ]) {
    const catalog = await read(links.find((l) => l.code === tier).token)
    equal(catalog.products.length, 1)
    equal(
      catalog.products[0].content.price,
      amount,
      `${tier}: precio propio del inventario, no el editorial`,
    )
    equal(
      Object.keys(catalog).sort(),
      ['name', 'products'],
      'no se filtran enlaces de otras listas',
    )
    equal(
      Object.keys(catalog.products[0]).sort(),
      ['content', 'id', 'published_at'],
      'no se filtra el origen privado',
    )
  }
  await rejects(read(crypto.randomUUID()), /no está disponible/)
  await rejects(
    db.query("select read_storefront_catalog(p_tier=>'vip')"),
    /does not exist/,
  )
  await rejects(
    db.query('select storefront_catalog_links()'),
    /permission|insufficient_privilege/,
  )
  await rejects(
    db.query('select * from private.storefront_catalog_links'),
    /permission/,
  )
  await rejects(db.query('select * from product_prices'), /permission/)
  await rejects(db.query('select * from inventory_balances'), /permission/)
  await identity(db, operator)
  await rejects(
    db.query('select storefront_catalog_links()'),
    /permission|insufficient_privilege/,
  )
  await db.exec('reset role')
  await db.query(
    "delete from product_prices where product_id=$1 and tier_code='menudeo'",
    [product],
  )
  await identity(db, '', 'anon')
  equal(
    (await read()).products[0].content.price,
    0,
    'un precio ausente se consulta; nunca se sustituye por otra lista',
  )
  await db.exec('reset role')
  await db.query(
    "update product_prices set amount=75 where product_id=$1 and tier_code='vip'",
    [product],
  )
  await identity(db, '', 'anon')
  equal(
    (await read(links.find((l) => l.code === 'vip').token)).products[0].content
      .price,
    75,
    'una edición de la lista actualiza su catálogo',
  )
  await db.exec('reset role')
  await db.query(
    'update storefront_publications set visible=false where id=$1',
    [product],
  )
  await identity(db, '', 'anon')
  equal(
    (await read()).products.length,
    0,
    'las fichas ocultas no se filtran por ningún enlace',
  )
  for (const link of links)
    equal(
      (await read(link.token)).products.length,
      0,
      'la ocultación se respeta en las cuatro listas',
    )
  await db.exec('reset role')
  await db.query(
    "update private.storefront_catalog_links set enabled=false where tier_code='vip'",
  )
  await identity(db, '', 'anon')
  await rejects(
    read(links.find((l) => l.code === 'vip').token),
    /no está disponible/,
  )
  console.log(
    JSON.stringify({ suite: 'storefront-catalogs', checks, passed: true }),
  )
} finally {
  await db.close()
}

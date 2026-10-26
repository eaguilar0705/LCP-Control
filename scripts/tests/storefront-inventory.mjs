import assert from 'node:assert/strict'
import { database, identity, admin, operator } from './database-fixture.mjs'
const db = await database()
let checks = 0
const equal = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
}
const reject = async (p, re) => {
  await assert.rejects(p, re)
  checks++
}
const root = () => db.exec('reset role')
const draft = async (id) =>
  (await db.query('select * from public.storefront_drafts where id=$1', [id]))
    .rows[0]
const published = async (id) =>
  (
    await db.query('select * from public.storefront_publications where id=$1', [
      id,
    ])
  ).rows[0]
const action = async (name, d, content = d.content) =>
  (
    await db.query('select public.storefront_action($1,$2,$3,$4,$5) d', [
      name,
      d.id,
      d.revision,
      content,
      d.source_version,
    ])
  ).rows[0].d
try {
  await db.query(
    "insert into staff_members(user_id,display_name,role) values($1,'Admin','superadmin'),($2,'Caja','operator')",
    [admin, operator],
  )
  const brand = crypto.randomUUID(),
    id = crypto.randomUUID()
  await db.query("insert into brands(id,name) values($1,'Marca de prueba')", [
    brand,
  ])
  await db.query(
    "insert into products(id,brand_id,sku,name,size,unit,category,gender) values($1,$2,'TEST-WEB','Perfume de prueba',100,'ml','arabian','unisex')",
    [id, brand],
  )
  let d = await draft(id)
  equal(d.inventory_state, 'unknown', 'missing rows are not zero stock')
  equal(d.inventory_managed, true)
  await identity(db, admin)
  d = await action('save', d, {
    ...d.content,
    price: 35.5,
    hide_unavailable: true,
  })
  d = await action('publish', d)
  equal(
    (await published(id)).visible,
    false,
    'unknown availability stays hidden when selected',
  )
  await root()
  await db.query(
    "insert into inventory_balances(product_id,location,quantity) values($1,'store',3),($1,'warehouse',null)",
    [id],
  )
  equal(
    (await draft(id)).inventory_state,
    'available',
    'known positive stock suffices even with another unknown location',
  )
  equal((await published(id)).content.availability, 'available')
  equal(
    (await published(id)).visible,
    true,
    'restock reveals approved publication',
  )
  equal(
    (await draft(id)).revision,
    d.revision,
    'stock movement does not invalidate editorial revisions',
  )
  equal((await published(id)).content.price, 35.5)
  await db.query(
    "update inventory_balances set quantity=0 where product_id=$1 and location='store'",
    [id],
  )
  equal(
    (await draft(id)).inventory_state,
    'unknown',
    'zero plus uncounted is not confirmed sold out',
  )
  await db.query(
    'update inventory_balances set quantity=0 where product_id=$1',
    [id],
  )
  equal((await draft(id)).inventory_state, 'unavailable')
  equal((await published(id)).visible, false)
  await identity(db, admin)
  d = await action('save', await draft(id), {
    ...d.content,
    hide_unavailable: false,
  })
  equal(
    (await published(id)).visible,
    false,
    'draft setting does not change approved setting',
  )
  d = await action('publish', d)
  equal(
    (await published(id)).visible,
    true,
    'show sold-out card when hide option is off',
  )
  equal((await published(id)).content.availability, 'unavailable')
  d = await action('hide', d)
  await root()
  await db.query(
    'update inventory_balances set quantity=4 where product_id=$1',
    [id],
  )
  equal(
    (await published(id)).visible,
    false,
    'restock never undoes manual hide',
  )
  await identity(db, admin)
  d = await action('save', await draft(id))
  d = await action('publish', d)
  await root()
  await db.query('update products set active=false where id=$1', [id])
  equal((await draft(id)).removal_state, 'pending')
  equal(
    (await published(id)).visible,
    true,
    'removal awaits editorial approval',
  )
  equal(
    (await published(id)).content.availability,
    'unavailable',
    'retired source never stays advertised as available',
  )
  d = await draft(id)
  await identity(db, operator)
  await reject(action('accept_removal', d), /privilege|permission/)
  await identity(db, admin)
  d = await action('keep_removed', await draft(id))
  equal(d.removal_state, 'kept')
  equal((await published(id)).visible, true)
  await reject(action('accept_removal', d), /ya fue revisada/)
  d = await action('save', d, {
    ...d.content,
    availability: 'available',
    inventory_managed: false,
  })
  d = await action('publish', d)
  equal(
    (await published(id)).content.availability,
    'unavailable',
    'manual mode cannot advertise removed source',
  )
  await root()
  await db.query('update products set active=true where id=$1', [id])
  equal((await draft(id)).removal_state, null)
  await identity(db, admin)
  d = await action('save', await draft(id), {
    ...d.content,
    inventory_managed: true,
  })
  d = await action('publish', d)
  await root()
  await db.query('delete from inventory_balances where product_id=$1', [id])
  await db.query('delete from products where id=$1', [id])
  d = await draft(id)
  equal(d.source_missing, true)
  equal(d.source_product_id, null)
  equal(d.removal_state, 'pending')
  equal((await published(id)).visible, true)
  await identity(db, admin)
  d = await action('accept_removal', d)
  equal(d.status, 'archived')
  equal((await published(id)).visible, false)
  await reject(action('publish', d), /retirado/)
  await identity(db, '', 'anon')
  equal(
    (
      await db.query(
        'select id,content,visible from storefront_publications where id=$1',
        [id],
      )
    ).rows.length,
    0,
  )
  await reject(
    db.query('select inventory_state from storefront_drafts'),
    /permission/,
  )
  await reject(
    db.query('select inventory_managed from storefront_publications'),
    /permission/,
  )
  await reject(
    db.query('select quantity from inventory_balances'),
    /permission/,
  )
  console.log(JSON.stringify({ suite: 'storefront-inventory', checks }))
} finally {
  await db.close()
}

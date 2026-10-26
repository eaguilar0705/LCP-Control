import assert from 'node:assert/strict'
import {
  database,
  identity,
  admin,
  operator,
  outsider,
} from './database-fixture.mjs'
const db = await database()
let checks = 0
const equal = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
}
const rejects = async (p, re) => {
  await assert.rejects(p, re)
  checks++
}
const root = async () => {
  await db.exec('reset role')
}
const read = async (id) =>
  (await db.query('select * from public.storefront_drafts where id=$1', [id]))
    .rows[0]
const action = async (a, d, content = d.content, version = d.source_version) =>
  (
    await db.query('select public.storefront_action($1,$2,$3,$4,$5) result', [
      a,
      d.id,
      d.revision,
      content,
      version,
    ])
  ).rows[0].result
const content = {
  name: 'Perfume público',
  brand: 'Marca',
  size: '100',
  unit: 'ml',
  price: 49.99,
  gender: 'unisex',
  category: 'arabian',
  availability: 'on_request',
  description: 'Descripción editorial',
  featured: true,
  images: [],
}
const id = crypto.randomUUID(),
  brand = crypto.randomUUID(),
  image = `${admin}/${crypto.randomUUID()}.webp`
try {
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Admin','superadmin'),($2,'Caja','operator')",
    [admin, operator],
  )
  await db.query(
    "insert into public.brands(id,name) values($1,'Marca de origen')",
    [brand],
  )
  await db.query(
    "insert into public.products(id,sku,name,brand_id,size,unit,category,gender,image_path) values($1,'QA-SITE','Nombre interno',$2,100,'ml','arabian','unisex','catalog-private.webp')",
    [id, brand],
  )
  equal(
    (await read(id)).status,
    'pending',
    'new inventory item is only a draft',
  )
  equal(
    (
      await db.query(
        'select count(*)::int n from public.storefront_publications',
      )
    ).rows[0].n,
    0,
  )
  await identity(db, '', 'anon')
  await rejects(
    db.query('select * from public.storefront_drafts'),
    /permission|insufficient_privilege/,
  )
  await rejects(
    db.query('select public.storefront_sync()'),
    /permission|insufficient_privilege/,
  )
  await rejects(
    db.query(
      'insert into public.storefront_publications(id,content) values($1,$2)',
      [id, content],
    ),
    /permission|insufficient_privilege/,
  )
  equal(
    (
      await db.query(
        'select id,content,visible from public.storefront_publications',
      )
    ).rows.length,
    0,
  )
  await identity(db, operator)
  equal(
    (await db.query('select * from public.storefront_drafts')).rows.length,
    0,
  )
  await rejects(
    db.query('select public.storefront_sync()'),
    /permission|insufficient_privilege/,
  )
  await identity(db, outsider)
  await rejects(
    db.query('select public.storefront_action($1,$2,0,$3,0)', [
      'save',
      crypto.randomUUID(),
      content,
    ]),
    /permission|insufficient_privilege/,
  )
  await identity(db, admin)
  let draft = await read(id)
  await rejects(action('publish', draft), /Revisa y guarda/)
  draft = await action('save', draft, content)
  await rejects(
    action('save', { ...draft, revision: draft.revision - 1 }, content),
    /cambió/,
  )
  await rejects(action('save', draft, { ...content, price: -1 }), /precio/)
  await rejects(
    action('save', draft, {
      ...content,
      images: [{ kind: 'local', path: '../private.webp' }],
    }),
    /fotografía/,
  )
  await rejects(action('save', draft, content, 99), /LCP-Control/)
  await root()
  await db.query(
    "insert into storage.objects(bucket_id,name) values('storefront-media',$1)",
    [image],
  )
  await db.exec(
    "select set_config('storage.operation','object.get_authenticated',false)",
  )
  await identity(db, '', 'anon')
  equal(
    (
      await db.query(
        "select * from storage.objects where bucket_id='storefront-media'",
      )
    ).rows.length,
    0,
    'unpublished media is private',
  )
  await identity(db, admin)
  draft = await action('save', draft, {
    ...content,
    images: [{ kind: 'upload', path: image }],
    cost: 4,
    source_snapshot: { secret: true },
  })
  equal(
    Object.hasOwn(draft.content, 'cost'),
    false,
    'whitelist removes injected private fields',
  )
  draft = await action('publish', draft)
  await identity(db, '', 'anon')
  let publication = (
    await db.query(
      'select id,content,visible from public.storefront_publications where id=$1',
      [id],
    )
  ).rows[0]
  equal(publication.content.price, 49.99)
  equal(Object.hasOwn(publication.content, 'source_snapshot'), false)
  equal(
    (
      await db.query(
        "select name from storage.objects where bucket_id='storefront-media'",
      )
    ).rows.length,
    1,
    'published media can be downloaded',
  )
  await db.exec("select set_config('storage.operation','object.sign',false)")
  equal(
    (
      await db.query(
        "select name from storage.objects where bucket_id='storefront-media'",
      )
    ).rows.length,
    0,
    'public signed URL generation denied',
  )
  await db.exec("select set_config('storage.operation','object.list',false)")
  equal(
    (
      await db.query(
        "select name from storage.objects where bucket_id='storefront-media'",
      )
    ).rows.length,
    0,
    'public bucket listing denied',
  )
  await identity(db, operator)
  equal(
    (
      await db.query(
        'select id,content,visible from public.storefront_publications',
      )
    ).rows.length,
    1,
    'non-admin signed-in visitor sees approved catalog',
  )
  await identity(db, admin)
  draft = await action('save', draft, {
    ...draft.content,
    name: 'Borrador nuevo',
    price: 65,
  })
  await identity(db, '', 'anon')
  publication = (
    await db.query(
      'select content from public.storefront_publications where id=$1',
      [id],
    )
  ).rows[0]
  equal(
    publication.content.name,
    'Perfume público',
    'editing draft does not alter publication',
  )
  equal(publication.content.price, 49.99)
  await root()
  await db.query(
    "update public.products set name='Cambio desde Control' where id=$1",
    [id],
  )
  await identity(db, admin)
  await rejects(action('publish', draft), /cambió/)
  draft = await read(id)
  equal(draft.status, 'pending')
  equal(draft.content.price, 65, 'source changes preserve editorial price')
  equal(
    draft.content.name,
    'Borrador nuevo',
    'source changes preserve editorial content',
  )
  equal(draft.source_snapshot.name, 'Cambio desde Control')
  await rejects(action('publish', draft), /Revisa y guarda/)
  draft = await action('save', draft, draft.content)
  draft = await action('publish', draft)
  const beforeSync = draft.revision
  await db.query('select public.storefront_sync()')
  equal((await read(id)).revision, beforeSync, 'unchanged sync is idempotent')
  await root()
  await db.query('update public.products set revision=revision+1 where id=$1', [
    id,
  ])
  equal(
    (await read(id)).revision,
    beforeSync,
    'unrelated inventory revision does not create a review',
  )
  await db.query("update public.brands set name='Nueva marca' where id=$1", [
    brand,
  ])
  equal(
    (await read(id)).source_snapshot.brand,
    'Nueva marca',
    'brand rename synchronizes',
  )
  await identity(db, admin)
  draft = await read(id)
  draft = await action('hide', draft)
  await identity(db, '', 'anon')
  equal(
    (
      await db.query(
        'select id,content,visible from public.storefront_publications',
      )
    ).rows.length,
    0,
    'hide removes public record',
  )
  await db.exec(
    "select set_config('storage.operation','object.get_authenticated',false)",
  )
  equal(
    (
      await db.query(
        "select * from storage.objects where bucket_id='storefront-media'",
      )
    ).rows.length,
    0,
    'hide removes public media permission',
  )
  await identity(db, admin)
  draft = await action('save', draft, draft.content)
  draft = await action('publish', draft)
  await root()
  await db.query('update public.products set active=false where id=$1', [id])
  equal(
    (
      await db.query(
        'select visible from public.storefront_publications where id=$1',
        [id],
      )
    ).rows[0].visible,
    true,
    'retirement awaits approval while availability becomes unavailable',
  )
  await identity(db, admin)
  draft = await read(id)
  draft = await action('save', draft, draft.content)
  await rejects(action('publish', draft), /retirado/)
  await root()
  await db.query('delete from public.products where id=$1', [id])
  equal((await read(id)).source_missing, true)
  equal((await read(id)).source_product_id, null)
  await identity(db, admin)
  draft = await read(id)
  draft = await action('save', draft, draft.content)
  await rejects(action('publish', draft), /retirado/)
  const manualId = crypto.randomUUID()
  let manual = await action('save', {
    id: manualId,
    revision: 0,
    source_version: 0,
    content,
  })
  manual = await action('publish', manual)
  manual = await action('archive', manual)
  await rejects(action('publish', manual), /recuperarlo/)
  manual = await action('save', manual, content)
  manual = await action('publish', manual)
  await rejects(
    db.query('update public.storefront_drafts set revision=0'),
    /permission|insufficient_privilege/,
  )
  await rejects(
    db.query('delete from storage.objects where name=$1', [image]).then((r) => {
      if (r.affectedRows === 0) throw Error('permission')
    }),
    /permission|insufficient_privilege/,
  )
  await root()
  await db.query(
    'update public.staff_members set active=false where user_id=$1',
    [admin],
  )
  await identity(db, admin)
  equal(
    (await db.query('select * from public.storefront_drafts')).rows.length,
    0,
  )
  await rejects(action('hide', manual), /permission|insufficient_privilege/)
  console.log(JSON.stringify({ checks, passed: true }))
} finally {
  await db.close()
}

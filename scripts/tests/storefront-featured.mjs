import assert from 'node:assert/strict'
import { database, identity, admin, operator } from './database-fixture.mjs'

const db = await database()
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const rejects = async (operation, pattern) => {
  await assert.rejects(operation, pattern)
  checks++
}
const read = async (id) =>
  (await db.query('select * from storefront_drafts where id=$1', [id])).rows[0]
const published = async (id) =>
  (
    await db.query('select content from storefront_publications where id=$1', [
      id,
    ])
  ).rows[0].content
const act = async (action, d, content = d.content) =>
  (
    await db.query('select storefront_action($1,$2,$3,$4,$5) result', [
      action,
      d.id,
      d.revision,
      content,
      d.source_version,
    ])
  ).rows[0].result
const content = {
  name: 'Perfume de portada',
  brand: 'Marca',
  size: '100',
  unit: 'ml',
  price: 40,
  gender: 'unisex',
  category: 'arabian',
  availability: 'unavailable',
  description: 'Aprobado',
  featured: true,
  images: [{ kind: 'local', path: 'images/productos/qa.webp' }],
}
try {
  await db.query(
    "insert into staff_members(user_id,display_name,role) values($1,'Admin','superadmin'),($2,'Caja','operator')",
    [admin, operator],
  )
  await identity(db, admin)
  let first = await act('save', {
    id: crypto.randomUUID(),
    revision: 0,
    source_version: 0,
    content,
  })
  first = await act('publish', first)
  let second = await act('save', {
    id: crypto.randomUUID(),
    revision: 0,
    source_version: 0,
    content: { ...content, name: 'Segundo', featured: false },
  })
  second = await act('publish', second)
  equal(
    (await published(first.id)).featured,
    true,
    'la primera portada sigue seleccionada',
  )
  second = await act('save', second, {
    ...second.content,
    name: 'Nombre pendiente',
    price: 99,
  })
  const pendingVersion = second.reviewed_source_version
  const oldFirst = first
  second = await act('feature', second)
  equal(
    (await published(first.id)).featured,
    false,
    'cambiar destacado retira el anterior',
  )
  equal(
    (await published(second.id)).featured,
    true,
    'se destaca aunque esté agotado',
  )
  equal(
    (await published(second.id)).name,
    'Segundo',
    'destacar no publica el nombre pendiente',
  )
  equal(
    (await published(second.id)).price,
    40,
    'destacar no publica el precio pendiente',
  )
  equal(second.content.price, 99, 'el borrador conserva su precio pendiente')
  equal(second.status, 'draft', 'destacar conserva el estado editorial')
  equal(
    second.reviewed_source_version,
    pendingVersion,
    'destacar no aprueba cambios de origen',
  )
  await rejects(act('publish', oldFirst), /cambió/)
  first = await read(first.id)
  equal(
    first.content.featured,
    false,
    'el borrador anterior deja de estar destacado',
  )
  first = await act('save', first, { ...first.content, featured: true })
  equal(
    (await published(second.id)).featured,
    true,
    'guardar otro destacado como borrador no cambia portada',
  )
  first = await act('publish', first)
  equal(
    (await published(second.id)).featured,
    false,
    'publicar desde editor también mantiene un solo destacado',
  )
  equal(
    (await read(second.id)).content.name,
    'Nombre pendiente',
    'reemplazar destacado conserva otras ediciones',
  )
  equal(
    (
      await db.query(
        "select count(*)::int n from storefront_publications where content->>'featured'='true'",
      )
    ).rows[0].n,
    1,
    'solo una publicación está destacada',
  )
  await identity(db, operator)
  await rejects(act('feature', first), /permission|insufficient_privilege/)
  await identity(db, '', 'anon')
  await rejects(act('feature', first), /permission|insufficient_privilege/)
  await identity(db, admin)
  second = await read(second.id)
  second = await act('hide', second)
  await rejects(act('feature', second), /visible/)
  await db.exec('reset role')
  await rejects(
    db.query(
      "update storefront_publications set content=jsonb_set(content,'{featured}','true') where id=$1",
      [second.id],
    ),
    /unique|duplicate/,
  )
  equal(
    (await published(second.id)).featured,
    false,
    'la restricción impide duplicar el destacado incluso por SQL',
  )
  console.log(
    JSON.stringify({ suite: 'storefront-featured', checks, passed: true }),
  )
} finally {
  await db.close()
}

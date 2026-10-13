import assert from 'node:assert/strict'
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
const db = await database()
let checks = 0
const equal = (a, b, m) => {
  assert.equal(a, b, m)
  checks++
}
const rejects = async (p, re) => {
  await assert.rejects(p, re)
  checks++
}
const call = (name, input) => rpc(db, name, input)
try {
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Principal','superadmin'),($2,'Vendedor','operator'),($3,'Bodega','warehouse'),($4,'Consulta','viewer'),($5,'Administrador','admin')",
    [admin, operator, warehouse, viewer, outsider],
  )
  await db.query(
    "update auth.users set email=case when id=$1 then 'admin@example.test' when id=$2 then 'other@example.test' else id||'@example.test' end",
    [admin, outsider],
  )
  await db.exec(
    "insert into public.business_settings(name) values('QA'); insert into public.exchange_rates(id,usd_to_nio) values(true,36.6) on conflict(id) do update set usd_to_nio=36.6",
  )
  await identity(db, admin)
  const product = {
    id: crypto.randomUUID(),
    revision: 0,
    name: 'Perfume QA',
    brand: 'Marca QA',
    category: 'arabian',
    gender: 'unisex',
    size: 100,
    unit: 'ml',
    manufacturerBarcode: '1234567890128',
    minimumStock: 2,
    active: true,
    imagePath: null,
    prices: {
      emprendedor: { USD: 10, NIO: 1 },
      vip: { USD: 9, NIO: 1 },
      premium: { USD: 8, NIO: 1 },
    },
  }
  equal(await call('save_catalog_product', product), product.id)
  equal(
    (
      await db.query(
        'select amount from public.product_prices where product_id=$1 and tier_code=$2 and currency=$3',
        [product.id, 'emprendedor', 'NIO'],
      )
    ).rows[0].amount,
    '366.00',
    'NIO derives from actual exchange rate',
  )
  equal(
    (
      await db.query(
        'select count(*)::int n from public.inventory_balances where product_id=$1 and quantity is null',
        [product.id],
      )
    ).rows[0].n,
    2,
    'new stock is unknown, not invented zero',
  )
  await rejects(
    call('save_catalog_product', { ...product, name: 'Stale change' }),
    /Otro usuario/,
  )
  await rejects(
    call('save_catalog_product', { ...product, id: crypto.randomUUID() }),
    /pertenece a otro producto/,
  )
  await rejects(
    call('save_catalog_product', {
      ...product,
      revision: 1,
      imagePath: 'not-uploaded.webp',
    }),
    /imagen/,
  )
  const edit = {
    ...product,
    revision: 1,
    name: 'Perfume editado',
    prices: { ...product.prices, vip: { USD: 12, NIO: 1 } },
  }
  equal(await call('save_catalog_product', edit), product.id)
  equal(
    (
      await db.query('select revision from public.products where id=$1', [
        product.id,
      ])
    ).rows[0].revision,
    2,
  )
  await call('record_inventory_movement', {
    requestId: crypto.randomUUID(),
    productId: product.id,
    type: 'ADJUSTMENT',
    quantity: 2,
    location: 'store',
    note: 'Conteo inicial',
  })
  await rejects(
    db.query('select public.remove_catalog_product($1,$2)', [product.id, 2]),
    /existencias/,
  )
  await call('record_inventory_movement', {
    requestId: crypto.randomUUID(),
    productId: product.id,
    type: 'EXIT',
    quantity: 2,
    location: 'store',
    note: 'Salida controlada',
  })
  equal(
    (
      await db.query('select public.remove_catalog_product($1,$2) result', [
        product.id,
        2,
      ])
    ).rows[0].result,
    'archived',
    'history retained',
  )
  const unused = {
    ...product,
    id: crypto.randomUUID(),
    manufacturerBarcode: '',
    name: 'Creado por error',
  }
  await call('save_catalog_product', unused)
  equal(
    (
      await db.query('select public.remove_catalog_product($1,$2) result', [
        unused.id,
        1,
      ])
    ).rows[0].result,
    'deleted',
  )
  for (const kind of ['customer', 'supplier']) {
    const c = {
      id: crypto.randomUUID(),
      revision: 0,
      name: 'Contacto QA',
      phone: kind === 'customer' ? '88887777' : '88886666',
      email: 'qa@example.test',
      taxId: 'RUC-QA',
      address: 'Managua',
      notes: '',
      active: true,
      priceTier: 'emprendedor',
    }
    equal(await call('save_' + kind, c), c.id)
    await call('save_' + kind, { ...c, revision: 1, name: 'Contacto editado' })
    await rejects(call('save_' + kind, { ...c, revision: 1 }), /Otro usuario/)
    await rejects(
      db.query('select public.delete_' + kind + '($1,$2)', [c.id, 1]),
      /Otro usuario/,
    )
    equal(
      (
        await db.query('select public.delete_' + kind + '($1,$2) result', [
          c.id,
          2,
        ])
      ).rows[0].result,
      'deleted',
    )
  }
  await db.query('select public.save_my_drafts($1,$2,$3)', [
    'lcp.drafts.invoice.v2',
    JSON.stringify([{ id: 'invoice' }]),
    0,
  ])
  await db.query('select public.save_my_drafts($1,$2,$3)', [
    'lcp.drafts.proforma.v2',
    JSON.stringify([{ id: 'quote' }]),
    0,
  ])
  equal(
    (await db.query('select count(*)::int n from public.user_drafts')).rows[0]
      .n,
    2,
    'separate draft namespaces',
  )
  await rejects(
    db.query('select public.save_my_drafts($1,$2,$3)', [
      'lcp.drafts.invoice.v2',
      '[]',
      0,
    ]),
    /otro equipo/,
  )
  for (const uid of [operator, warehouse, viewer]) {
    await identity(db, uid)
    await rejects(
      call('save_catalog_product', { ...unused, id: crypto.randomUUID() }),
    )
    await rejects(db.query('select public.list_staff_accounts()'))
    await rejects(db.query('select public.set_exchange_rate(37)'))
    equal(
      (await db.query('select * from public.product_costs')).rows.length,
      0,
      'cost privacy',
    )
    equal(
      (await db.query('select * from public.user_drafts')).rows.length,
      0,
      'other user drafts private',
    )
    if (uid !== operator)
      await rejects(
        call('save_customer', {
          id: crypto.randomUUID(),
          revision: 0,
          name: 'No',
          active: true,
          priceTier: 'emprendedor',
        }),
      )
  }
  await identity(db, operator)
  await rejects(
    call('save_customer', {
      id: crypto.randomUUID(),
      revision: 0,
      name: 'No',
      active: true,
      priceTier: 'premium',
    }),
  )
  await identity(db, outsider)
  await rejects(
    db.query('select public.save_staff_account($1,$2,$3,$4)', [
      'new@example.test',
      'No',
      'superadmin',
      true,
    ]),
  )
  await rejects(
    db.query('select public.delete_staff_account($1,$2,$3)', [
      'admin@example.test',
      admin,
      'superadmin',
    ]),
  )
  await identity(db, admin)
  await rejects(
    db.query('select public.delete_staff_account($1,$2,$3)', [
      'admin@example.test',
      admin,
      'superadmin',
    ]),
    /propia/,
  )
  await rejects(
    db.query('select public.save_staff_account($1,$2,$3,$4)', [
      'admin@example.test',
      'Principal',
      'viewer',
      true,
    ]),
    /propios/,
  )
  await db.query('select public.save_staff_account($1,$2,$3,$4)', [
    'new@example.test',
    'Nuevo',
    'operator',
    true,
  ])
  await db.exec('reset role')
  const newId = crypto.randomUUID()
  await db.query('insert into auth.users(id,email) values($1,$2)', [
    newId,
    'new@example.test',
  ])
  await identity(db, admin)
  equal(
    (
      await db.query(
        'select role from public.list_staff_accounts() where email=$1',
        ['new@example.test'],
      )
    ).rows[0].role,
    'operator',
    'authorized signup gets role',
  )
  await db.query('select public.delete_staff_account($1,$2,$3)', [
    'new@example.test',
    newId,
    'operator',
  ])
  await db.exec('reset role')
  equal(
    (
      await db.query('select count(*)::int n from auth.users where id=$1', [
        newId,
      ])
    ).rows[0].n,
    0,
    'user removed from Auth and staff',
  )
  await rejects(
    db.query('insert into auth.users(id,email) values($1,$2)', [
      crypto.randomUUID(),
      'unauthorized@example.test',
    ]),
    /no autorizada/,
  )
  console.log(
    `PASS catalog/access: ${checks} checks; product CRUD, stock safeguards, contacts, revisions, drafts, roles and account provisioning/deletion`,
  )
} finally {
  await db.close()
}

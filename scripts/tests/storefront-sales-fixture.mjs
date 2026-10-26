import { database, identity, rpc, admin } from './database-fixture.mjs'

// Disposable database only. All inventory changes use the application's RPCs.
export async function storefrontSalesFixture() {
  const db = await database()
  const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
  const other = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'
  const one = async (sql, values = []) => (await db.query(sql, values)).rows[0]
  const call = (name, input) => rpc(db, name, input)
  await db.query(
    "insert into staff_members(user_id,display_name,role) values($1,'Auditoría aislada','superadmin')",
    [admin],
  )
  await db.exec(
    "insert into business_settings(name) values('La Casa del Perfume · Prueba aislada'); insert into brands(name) values('Lattafa'); insert into exchange_rates(id,usd_to_nio) values(true,36.6) on conflict(id) do update set usd_to_nio=36.6",
  )
  for (const [id, sku, name] of [
    [
      product,
      'QA-WEB-001',
      'Perfume Oriental de nombre largo para revisar presentación',
    ],
    [other, 'QA-WEB-002', 'Perfume sin publicar'],
  ]) {
    await db.query(
      "insert into products(id,sku,name,brand_id,size,unit,category,gender) values($1,$2,$3,(select id from brands limit 1),100,'ml','arabian','unisex')",
      [id, sku, name],
    )
    await db.query(
      "insert into inventory_balances(product_id,location,quantity) values($1,'store',0),($1,'warehouse',0)",
      [id],
    )
    await db.query(
      "insert into product_prices(product_id,tier_code,currency,amount) select $1,t,c,case when c='NIO' then 366 else 10 end from unnest(array['emprendedor','vip','premium']) t cross join unnest(array['NIO','USD']) c",
      [id],
    )
  }
  await identity(db, admin)
  const day = (
    await one(
      "select (now() at time zone 'America/Managua')::date::text as day",
    )
  ).day
  await call('record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: day,
    description: 'Apertura de prueba aislada',
    currency: 'NIO',
    exchangeRate: 1,
    lines: [
      { account: '1110-001', debit: 10000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 10000 },
    ],
  })
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 10000,
    openingUsd: 0,
  })
  const buy = (quantity, location = 'store') =>
    call('record_shipment', {
      requestId: crypto.randomUUID(),
      incurredOn: day,
      supplier: 'Proveedor QA',
      agency: '',
      reference: 'QA-WEB',
      note: 'Compra de prueba aislada',
      currency: 'NIO',
      exchangeRate: 1,
      account: 'caja',
      shippingAmount: 0,
      lines: [{ productId: product, location, quantity, unitPrice: 100 }],
    })
  const saleInput = (quantity, location = 'store') => ({
    requestId: crypto.randomUUID(),
    kind: 'invoice',
    customerName: 'Cliente QA',
    tier: 'emprendedor',
    currency: 'NIO',
    exchangeRate: 1,
    location,
    paymentMethod: 'cash',
    notes: 'Venta de prueba aislada',
    items: [{ productId: product, quantity }],
  })
  const draft = () =>
    one('select * from storefront_drafts where id=$1', [product])
  const publication = async () => {
    await identity(db, '', 'anon')
    try {
      return await one(
        'select id,content,visible from storefront_publications where id=$1',
        [product],
      )
    } finally {
      await identity(db, admin)
    }
  }
  const action = async (name, content) => {
    const d = await draft()
    return (
      await one('select public.storefront_action($1,$2,$3,$4,$5) d', [
        name,
        product,
        d.revision,
        content ?? d.content,
        d.source_version,
      ])
    ).d
  }
  return {
    db,
    product,
    other,
    one,
    call,
    buy,
    saleInput,
    draft,
    publication,
    action,
    close: () => db.close(),
  }
}

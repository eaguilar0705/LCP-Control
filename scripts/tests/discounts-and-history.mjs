import assert from 'node:assert/strict'
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
const eq = (a, b, label) => {
  assert.deepEqual(a, b, label)
  checks++
}
const reject = async (work, re) => {
  await assert.rejects(work, re)
  checks++
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const call = (name, payload) => rpc(db, name, payload)
const p = crypto.randomUUID(),
  p2 = crypto.randomUUID()
try {
  await db.query(
    "insert into staff_members(user_id,display_name,role) values($1,'Propietario','superadmin'),($2,'Caja','operator'),($3,'Administrador','admin')",
    [admin, operator, outsider],
  )
  await db.exec(
    "insert into business_settings(name) values('QA aislada'); insert into brands(name) values('Marca'); insert into price_tiers(code,name,sort_order) values('menudeo','Menudeo',4) on conflict do nothing;insert into private.storefront_catalog_links(tier_code) values('menudeo') on conflict do nothing",
  )
  for (const id of [p, p2]) {
    await db.query(
      "insert into products(id,sku,name,brand_id) values($1,$2,'Perfume',(select id from brands limit 1))",
      [id, 'QA-' + id.slice(0, 8)],
    )
    await db.query(
      "insert into inventory_balances(product_id,location,quantity) values($1,'store',1000),($1,'warehouse',0)",
      [id],
    )
    await db.query(
      'insert into product_costs(product_id,average_cost_nio) values($1,100)',
      [id],
    )
    for (const [tier, usd] of [
      ['emprendedor', 42.1],
      ['vip', 39.01],
      ['premium', 38],
      ['menudeo', 50.5],
    ]) {
      await db.query(
        "insert into product_prices(product_id,tier_code,currency,amount) values($1,$2,'NIO',300),($1,$2,'USD',$3)",
        [id, tier, usd],
      )
    }
  }
  await identity(db, admin)
  const today = (
    await one(
      "select (now() at time zone 'America/Managua')::date::text as day",
    )
  ).day
  await call('record_journal_entry', {
    requestId: crypto.randomUUID(),
    kind: 'opening',
    occurredOn: today,
    currency: 'NIO',
    exchangeRate: 1,
    description: 'Apertura aislada',
    lines: [
      { account: '1110-001', debit: 100000, credit: 0 },
      { account: '1130', debit: 200000, credit: 0 },
      { account: '3110-001', debit: 0, credit: 300000 },
    ],
  })
  await call('open_business_day', {
    requestId: crypto.randomUUID(),
    openingNio: 100000,
    openingUsd: 1000,
  })
  const invoice = (patch = {}) => ({
    requestId: crypto.randomUUID(),
    kind: 'invoice',
    customerName: 'Cliente QA',
    tier: 'emprendedor',
    currency: 'NIO',
    exchangeRate: 1,
    location: 'store',
    paymentMethod: 'cash',
    notes: '',
    items: [
      {
        productId: p,
        quantity: 3,
        expectedUnitPrice: 300,
        finalUnitPrice: 280,
      },
    ],
    invoiceDiscount: 40,
    expectedTotal: 800,
    ...patch,
  })
  const payload = invoice()
  const d = await call('create_document', payload)
  eq(Number(d.total), 800, 'precio individual y descuento global')
  eq(Number(d.original_total), 900, 'importe original congelado')
  eq(Number(d.discount_amount), 100, 'descuento total congelado')
  eq(Number(d.items[0].line_total), 800, 'renglón neto')
  eq((await call('create_document', payload)).id, d.id, 'reintento no duplica')
  const ledger = (await one('select ledger_report($1,$1) r', [today])).r
  eq(
    Number(ledger.accounts.find((a) => a.code === '4110').credit),
    800,
    'mayor reconoce la venta después de descuentos',
  )
  eq(
    Number(ledger.accounts.find((a) => a.code === '1110-001').closing),
    100800,
    'caja recibe el importe neto',
  )
  eq(
    Number(
      (
        await one(
          'select net_revenue_nio from document_item_costs where document_id=$1',
          [d.id],
        )
      ).net_revenue_nio,
    ),
    800,
    'ingreso contable neto',
  )
  await reject(
    call('create_document', invoice({ invoiceDiscount: 840 })),
    /descuento total/,
  )
  await reject(
    call(
      'create_document',
      invoice({
        items: [
          {
            productId: p,
            quantity: 3,
            expectedUnitPrice: 300,
            finalUnitPrice: 301,
          },
        ],
      }),
    ),
    /no superar/,
  )
  await reject(
    call(
      'create_document',
      invoice({
        items: [
          {
            productId: p,
            quantity: 3,
            expectedUnitPrice: 299,
            finalUnitPrice: 280,
          },
        ],
      }),
    ),
    /precios cambiaron/,
  )
  await reject(
    call('create_document', invoice({ expectedTotal: 799 })),
    /precios cambiaron/,
  )
  const ret = (quantity) => ({
    requestId: crypto.randomUUID(),
    documentId: d.id,
    reason: 'Revisión autorizada',
    refundMethod: 'cash',
    items: [{ itemId: d.items[0].id, quantity, restock: true }],
  })
  const r1 = await call('record_sales_return', ret(1))
  const r2 = await call('record_sales_return', ret(2))
  eq(r1.refundNio, 266.67, 'devolución parcial neta al centavo')
  eq(r2.refundNio, 533.33, 'última devolución conserva el total')
  eq(
    Math.round((r1.refundNio + r2.refundNio) * 100),
    80000,
    'no se devuelve más de lo cobrado',
  )
  const usd = await call(
    'create_document',
    invoice({
      currency: 'USD',
      exchangeRate: 37,
      items: [
        {
          productId: p,
          quantity: 3,
          expectedUnitPrice: 42.1,
          finalUnitPrice: 25.55,
        },
      ],
      invoiceDiscount: 0.02,
      expectedTotal: 76.63,
      payments: [
        { method: 'cash', currency: 'USD', amount: 50, exchangeRate: 37 },
        { method: 'bac_usd', currency: 'USD', amount: 26.63, exchangeRate: 37 },
      ],
    }),
  )
  eq(Number(usd.total), 76.63, 'descuento en dólares y pago dividido')
  eq(
    Number(
      (
        await one(
          'select sum(amount_nio) amount from invoice_payments where document_id=$1',
          [usd.id],
        )
      ).amount,
    ),
    2835.31,
    'pagos netos en contabilidad',
  )
  const usdRet = (quantity) => ({
    requestId: crypto.randomUUID(),
    documentId: usd.id,
    reason: 'Revisión autorizada',
    refundMethod: 'cash',
    items: [{ itemId: usd.items[0].id, quantity, restock: true }],
  })
  const usdR1 = await call('record_sales_return', usdRet(1)),
    usdR2 = await call('record_sales_return', usdRet(2))
  eq(
    Math.round((usdR1.amount + usdR2.amount) * 100),
    7663,
    'devoluciones en USD conservan el total neto',
  )
  eq(
    Math.round((usdR1.refundNio + usdR2.refundNio) * 100),
    283531,
    'devoluciones NIO conservan el total histórico convertido',
  )
  for (let n = 1; n <= 17; n++) {
    const quantity = (n % 5) + 1,
      reduction = n / 100
    const total = quantity * 280 + 300 - reduction
    const sale = await call(
      'create_document',
      invoice({
        items: [
          { productId: p2, quantity: 1, expectedUnitPrice: 300 },
          {
            productId: p,
            quantity,
            expectedUnitPrice: 300,
            finalUnitPrice: 280,
          },
        ],
        invoiceDiscount: reduction,
        expectedTotal: total,
      }),
    )
    eq(
      Math.round(
        sale.items.reduce((sum, l) => sum + Number(l.line_total), 0) * 100,
      ),
      Math.round(total * 100),
      'reparto estable entre productos',
    )
  }
  const stockBefore = (
    await one(
      "select quantity from inventory_balances where product_id=$1 and location='store'",
      [p],
    )
  ).quantity
  const proforma = await call(
    'create_document',
    invoice({
      kind: 'proforma',
      validUntil: today,
      paymentMethod: null,
      location: null,
    }),
  )
  eq(Number(proforma.total), 800, 'proforma conserva ambos descuentos')
  eq(
    (
      await one(
        "select quantity from inventory_balances where product_id=$1 and location='store'",
        [p],
      )
    ).quantity,
    stockBefore,
    'proforma no descuenta inventario',
  )
  eq(
    Number(
      (
        await one(
          'select count(*) n from document_item_costs where document_id=$1',
          [proforma.id],
        )
      ).n,
    ),
    0,
    'proforma no genera costo contable',
  )
  await identity(db, outsider)
  for (const signature of [
    'delete_invoice',
    'void_expense',
    'void_finance_entry',
    'void_journal_entry',
    'void_cash_closing',
  ]) {
    await reject(
      db.query(`select public.${signature}($1,$2)`, [
        crypto.randomUUID(),
        'Corrección',
      ]),
      /Solo un SuperAdmin/,
    )
  }
  await reject(
    call('correct_purchase', { requestId: crypto.randomUUID() }),
    /Solo un SuperAdmin/,
  )
  await identity(db, admin)
  const draft = await one('select * from storefront_drafts where id=$1', [p])
  const content = {
    ...draft.content,
    images: [{ kind: 'local', path: 'images/productos/qa.webp' }],
  }
  const saved = (
    await one("select storefront_action('save',$1,$2,$3,$4) r", [
      p,
      draft.revision,
      content,
      draft.source_version,
    ])
  ).r
  await one("select storefront_action('publish',$1,$2,$3,$4)", [
    p,
    saved.revision,
    saved.content,
    saved.source_version,
  ])
  const links = (await one('select storefront_catalog_links() r')).r
  const offer = {
    draftId: p,
    tier: 'vip',
    revision: 0,
    expectedBase: 40,
    finalPrice: 35,
  }
  const offerSaved = await call('save_storefront_offer', offer)
  await reject(call('save_storefront_offer', offer), /otra sesión/)
  await reject(
    call('save_storefront_offer', {
      ...offer,
      revision: offerSaved.revision,
      finalPrice: 35.5,
    }),
    /numérico inválido/,
  )
  await identity(db, '', 'anon')
  for (const [tier, price] of [
    ['emprendedor', 43],
    ['vip', 35],
    ['premium', 38],
    ['menudeo', 51],
  ]) {
    const catalog = (
      await one('select read_storefront_catalog($1) r', [
        links.find((l) => l.code === tier).token,
      ])
    ).r
    eq(
      catalog.products[0].content.price,
      price,
      'redondeo y aislamiento de oferta ' + tier,
    )
    eq(
      catalog.products[0].content.originalPrice,
      tier === 'vip' ? 40 : undefined,
      'solo el catálogo elegido recibe el descuento',
    )
  }
  await reject(call('save_storefront_offer', offer), /permission denied/)
  await reject(db.query('select storefront_offers()'), /permission denied/)
  await identity(db, admin)
  await call('save_storefront_offer', {
    ...offer,
    revision: offerSaved.revision,
    finalPrice: null,
  })
  const historyBefore = [
    { tier_code: 'menudeo', currency: 'USD', amount: 48 },
    { tier_code: 'menudeo', currency: 'NIO', amount: 1776 },
  ]
  const historyAfter = [
    { tier_code: 'menudeo', currency: 'USD', amount: 50.5 },
    { tier_code: 'menudeo', currency: 'NIO', amount: 1868.5 },
  ]
  await db.exec('reset role')
  await db.query(
    "insert into private.catalog_changes(product_id,action,before_data,after_data,actor_id) values($1,'catalog_completion',$2,$3,$4)",
    [p, { prices: historyBefore }, { prices: historyAfter }, admin],
  )
  await identity(db, admin)
  const history = (
    await db.query('select * from public.list_price_changes($1)', [p])
  ).rows
  eq(
    history.some(
      (h) =>
        h.tier === 'menudeo' &&
        Number(h.before_usd) === 48 &&
        Number(h.after_usd) === 50.5,
    ),
    true,
    'historial lee importaciones y listas adicionales',
  )
  await db.exec('reset role')
  const costProduct = crypto.randomUUID()
  await db.query(
    "insert into products(id,sku,name,brand_id) values($1,'COSTO-QA','Costo de cinco decimales',(select id from brands limit 1))",
    [costProduct],
  )
  await db.query(
    "insert into inventory_balances(product_id,location,quantity) values($1,'store',0),($1,'warehouse',0)",
    [costProduct],
  )
  await identity(db, admin)
  const purchase = {
    requestId: crypto.randomUUID(),
    incurredOn: today,
    currency: 'NIO',
    exchangeRate: 1,
    account: 'credito',
    shippingAmount: 0.01,
    supplier: 'QA',
    lines: [
      {
        productId: costProduct,
        location: 'store',
        quantity: 3,
        unitPrice: 1.01,
      },
    ],
  }
  await call('record_shipment', purchase)
  eq(
    Number(
      (
        await one(
          'select average_cost_nio from product_costs where product_id=$1',
          [costProduct],
        )
      ).average_cost_nio,
    ),
    1.01333,
    'promedio nuevo con cinco decimales',
  )
  await reject(
    call('record_shipment', {
      ...purchase,
      requestId: crypto.randomUUID(),
      lines: [{ ...purchase.lines[0], unitPrice: 1.011 }],
    }),
    /numérico inválido/,
  )
  console.log(
    JSON.stringify({ suite: 'discounts-and-history', checks, passed: true }),
  )
} finally {
  await db.close()
}

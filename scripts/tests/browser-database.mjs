import { database, identity, admin } from './database-fixture.mjs'

// Browser requests execute the real migrations/RPCs in a disposable PostgreSQL
// instance. Auth delivery and Storage transport are stubbed; nothing reaches
// production, and no invitation or recovery email is sent.
export async function browserDatabase(page) {
  const db = await database()
  const failures = []
  const user = {
    id: admin,
    email: 'auditoria@example.test',
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  }
  const token = [
    { alg: 'HS256', typ: 'JWT' },
    { sub: admin, exp: Math.floor(Date.now() / 1000) + 3600 },
    'local-test',
  ]
    .map((v) =>
      Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString(
        'base64url',
      ),
    )
    .join('.')
  await db.query('update auth.users set email=$1 where id=$2', [
    user.email,
    admin,
  ])
  await db.query(
    "insert into public.staff_members(user_id,display_name,role) values($1,'Auditoría','superadmin')",
    [admin],
  )
  await db.exec(`insert into public.business_settings(name,legal_name,tax_id,address,phone,email) values('La Casa del Perfume','Perfumería de auditoría','RUC-AUDITORIA','Managua','88888888','tienda@example.test');
    insert into public.exchange_rates(id,usd_to_nio) values(true,36.6) on conflict(id) do update set usd_to_nio=36.6;
    insert into public.brands(name) values('Lattafa');
    insert into public.products(id,sku,name,brand_id,size,unit,category,gender,minimum_stock)
      select ('aaaaaaaa-aaaa-4aaa-8aaa-'||lpad(i::text,12,'0'))::uuid,'QA-'||lpad(i::text,4,'0'),
      case when i=1 then 'Perfume Oriental de nombre largo para revisar presentación' else 'Perfume '||i end,
      (select id from public.brands limit 1),100,'ml','arabian','unisex',5 from generate_series(1,260) i;
    insert into public.inventory_balances(product_id,location,quantity) select p.id,l,case when l='store' then 20 else 10 end from public.products p cross join unnest(array['store','warehouse']) l;
    insert into public.product_costs(product_id,average_cost_nio) select id,100 from public.products;
    insert into public.product_prices(product_id,tier_code,currency,amount) select p.id,t,c,case when c='NIO' then 366 else 10 end from public.products p cross join unnest(array['emprendedor','vip','premium']) t cross join unnest(array['NIO','USD']) c;
    insert into public.customers(name,phone,price_tier) values('Cliente Auditoría','88887777','emprendedor');
    insert into public.suppliers(name,phone,email) values('Proveedor Auditoría','88886666','proveedor@example.test');`)
  await identity(db, admin)
  const today = (
    await db.query(
      "select (now() at time zone 'America/Managua')::date::text as day",
    )
  ).rows[0].day
  await db.query('select public.record_journal_entry($1::jsonb)', [
    JSON.stringify({
      requestId: crypto.randomUUID(),
      kind: 'opening',
      occurredOn: today,
      description: 'Apertura de auditoría',
      reference: 'QA',
      currency: 'NIO',
      exchangeRate: 1,
      lines: [
        { account: '1110-001', debit: 1000, credit: 0 },
        { account: '1130', debit: 780000, credit: 0 },
        { account: '3110-001', debit: 0, credit: 781000 },
      ],
    }),
  ])
  const tables = new Set([
    'products',
    'product_costs',
    'product_pricing',
    'customers',
    'suppliers',
    'staff_members',
    'business_settings',
    'exchange_rates',
    'documents',
    'inventory_movements',
    'inventory_transfers',
    'document_item_costs',
    'inventory_cost_losses',
    'expense_records',
    'purchase_shipments',
    'purchase_shipment_lines',
    'finance_entries',
    'user_drafts',
    'product_prices',
    'price_tiers',
    'business_days',
  ])
  await page.route('**/*.supabase.co/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url())
    const body = req.postDataJSON() ?? {}
    const send = (data, status = 200, headers = {}) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: {
          'access-control-expose-headers': 'content-range',
          ...headers,
        },
        body: JSON.stringify(data),
      })
    try {
      if (url.pathname.includes('/auth/v1/token'))
        return send({
          access_token: token,
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'local-only',
          user,
        })
      if (url.pathname === '/auth/v1/user') return send(user)
      if (
        url.pathname === '/auth/v1/recover' ||
        url.pathname === '/auth/v1/logout'
      )
        return send({})
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.split('/').at(-1),
          args = Object.keys(body)
        if (!/^[a-z_]+$/.test(name) || args.some((a) => !/^[a-z_]+$/.test(a)))
          throw new Error('Invalid fixture RPC')
        const values = args.map((k) =>
          typeof body[k] === 'object' && body[k] !== null
            ? JSON.stringify(body[k])
            : body[k],
        )
        // SETOF functions must use PostgREST's array representation.
        const isSet = (
          await db.query(
            "select proretset from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname=$1",
            [name],
          )
        ).rows[0]?.proretset
        const call = `public.${name}(${args.map((k, i) => `${k} => $${i + 1}`).join(',')})`
        const q = isSet
          ? `select to_jsonb(r) result from ${call} r`
          : `select ${call} result`
        const result = (await db.query(q, values)).rows.map((r) => r.result)
        return send(isSet ? result : result[0])
      }
      const table = url.pathname.split('/').at(-1)
      if (req.method() !== 'GET' || !tables.has(table))
        throw new Error(`Unhandled ${req.method()} ${url.pathname}`)
      let extra = ''
      if (table === 'products')
        extra = `,(select jsonb_build_object('name',name) from public.brands where id=t.brand_id) brands,
        (select coalesce(jsonb_agg(p),'[]') from public.product_prices p where p.product_id=t.id) product_prices,
        (select coalesce(jsonb_agg(b),'[]') from public.inventory_balances b where b.product_id=t.id) inventory_balances`
      if (table === 'documents')
        extra = `,(select coalesce(jsonb_agg(i),'[]') from public.document_items i where i.document_id=t.id) document_items`
      if (table === 'inventory_movements')
        extra = `,(select jsonb_build_object('sku',sku,'name',name) from public.products where id=t.product_id) products`
      const conditions = [],
        values = []
      for (const [key, value] of url.searchParams) {
        if (['select', 'order', 'limit', 'offset'].includes(key)) continue
        if (!/^[a-z_]+$/.test(key))
          throw new Error('Unhandled query key: ' + key)
        const dot = value.indexOf('.'),
          op = value.slice(0, dot),
          val = value.slice(dot + 1)
        if (op === 'in') {
          values.push(val.slice(1, -1).split(','))
          conditions.push(`t.${key}::text=any($${values.length}::text[])`)
          continue
        }
        const operators = {
          eq: '=',
          gte: '>=',
          lte: '<=',
          gt: '>',
          lt: '<',
          neq: '<>',
        }
        if (!operators[op]) throw new Error('Unhandled filter ' + value)
        values.push(val)
        conditions.push(`t.${key}${operators[op]}$${values.length}`)
      }
      const filtered = `from public.${table} t${conditions.length ? ' where ' + conditions.join(' and ') : ''}`
      let query = `select t.*${extra} ${filtered}`
      const order = url.searchParams.get('order')
      if (order) {
        const parts = order.split(',')
        if (parts.some((part) => !/^[a-z_]+\.(asc|desc)$/.test(part)))
          throw new Error('Unhandled order: ' + order)
        query +=
          ' order by ' +
          parts.map((part) => 't.' + part.replace('.', ' ')).join(',')
      }
      const limit = Number(url.searchParams.get('limit') ?? 2000),
        offset = Number(url.searchParams.get('offset') ?? 0)
      query += ` limit ${Math.min(limit, 5000)} offset ${offset}`
      const rows = (
        await db.query(`select to_jsonb(r) result from (${query}) r`, values)
      ).rows.map((r) => r.result)
      const headers = {}
      if (req.headers().prefer?.includes('count=exact')) {
        const count = (
          await db.query(`select count(*)::int n ${filtered}`, values)
        ).rows[0].n
        headers['content-range'] =
          `${rows.length ? `${offset}-${offset + rows.length - 1}` : '*'}/${count}`
      }
      return send(
        req.headers().accept?.includes('vnd.pgrst.object')
          ? (rows[0] ?? null)
          : rows,
        200,
        headers,
      )
    } catch (e) {
      failures.push(`${url.pathname}: ${e.message}`)
      return send({ code: e.code ?? 'TEST_ERROR', message: e.message }, 400)
    }
  })
  return { db, failures, today, close: () => db.close() }
}

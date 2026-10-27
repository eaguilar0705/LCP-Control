import http from 'node:http'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { storefrontSalesFixture } from './storefront-sales-fixture.mjs'
import { admin, identity } from './database-fixture.mjs'

// Local-only UI fixture: real SQL/RPCs, synthetic login, no production requests.
const f = await storefrontSalesFixture()
await f.buy(2)
// Referencias publicadas para comprobar el selector único de portada.
await f.action('save', {
  name: 'Oriental de portada',
  brand: 'Lattafa',
  size: '100',
  unit: 'ml',
  price: 40,
  gender: 'unisex',
  category: 'arabian',
  availability: 'available',
  description: '',
  featured: true,
  images: [{ kind: 'local', path: 'images/productos/catalog-0001.webp' }],
})
await f.action('publish')
const featureOther = (
  await f.db.query('select * from storefront_drafts where id=$1', [f.other])
).rows[0]
const savedOther = (
  await f.db.query('select storefront_action($1,$2,$3,$4,$5) d', [
    'save',
    featureOther.id,
    featureOther.revision,
    {
      ...featureOther.content,
      name: 'Segunda fragancia',
      brand: 'Lattafa',
      price: 50,
      featured: false,
      images: [{ kind: 'local', path: 'images/productos/catalog-0002.webp' }],
    },
    featureOther.source_version,
  ])
).rows[0].d
await f.db.query('select storefront_action($1,$2,$3,$4,$5)', [
  'publish',
  savedOther.id,
  savedOther.revision,
  savedOther.content,
  savedOther.source_version,
])
const user = {
  id: admin,
  email: 'qa@example.test',
  aud: 'authenticated',
  role: 'authenticated',
  app_metadata: {},
  user_metadata: {},
  created_at: new Date().toISOString(),
}
const token = [
  { alg: 'HS256', typ: 'JWT' },
  { sub: admin, exp: Math.floor(Date.now() / 1000) + 3600 },
  'qa-local',
]
  .map((v) =>
    Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString(
      'base64url',
    ),
  )
  .join('.')
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
  'storefront_drafts',
  'storefront_publications',
])
const errors = []
function frameHtml(width, src) {
  const size = [320, 390, 768, 1280].includes(Number(width))
    ? Number(width)
    : 390
  return `<html><head><title>Revisión a ${size}px</title></head><body style="margin:0;background:#e9e5df;font:13px system-ui"><p style="margin:10px">Prueba aislada · ${size}px · <a href="?width=320">320px</a> · <a href="?width=390">390px</a> · <a href="?width=768">768px</a></p><output style="display:block;margin:10px" id="metrics"></output><iframe title="Vista de prueba" src="${src}" style="display:block;width:${size}px;height:850px;border:0;margin:auto;background:white"></iframe><script>setInterval(()=>{const d=document.querySelector('iframe').contentDocument;if(!d)return;document.querySelector('#metrics').textContent=JSON.stringify({ancho:d.documentElement.clientWidth,contenido:d.documentElement.scrollWidth,desbordamiento:d.documentElement.scrollWidth>d.documentElement.clientWidth+1,dialogos:[...d.querySelectorAll('dialog[open]')].map(x=>({ancho:x.clientWidth,contenido:x.scrollWidth,desbordamiento:x.scrollWidth>x.clientWidth+1}))})},1000)</script></body></html>`
}
let queue = Promise.resolve()
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
}
async function gateway(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1:5175')
  res.setHeader('access-control-allow-origin', 'http://127.0.0.1:4180')
  res.setHeader(
    'access-control-allow-headers',
    'authorization,apikey,content-type,x-client-info,prefer,range,range-unit',
  )
  res.setHeader('access-control-expose-headers', 'content-range')
  res.setHeader('cache-control', 'no-store')
  const send = (data, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  if (req.method === 'OPTIONS') return send({})
  try {
    if (url.pathname.startsWith('/__qa')) {
      if (url.pathname === '/__qa/frame') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(frameHtml(url.searchParams.get('width'), '/storefront'))
      }
      await identity(f.db, admin)
      if (req.method === 'POST') {
        if (url.pathname === '/__qa/sale')
          await f.call('create_document', f.saleInput(1))
        else if (url.pathname === '/__qa/buy') await f.buy(1)
        else throw Error('Unknown fixture action')
        res.writeHead(303, { location: '/__qa' })
        return res.end()
      }
      const state = {
        draft: await f.draft(),
        publication: await f.publication(),
        errors,
      }
      if (url.pathname === '/__qa/state') return send(state)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(
        `<h1>Prueba aislada de tienda online</h1><p>Sin conexión con producción. Compra y venta usan las funciones reales del sistema.</p><form method="post" action="/__qa/sale"><button>Vender una unidad de prueba</button></form><form method="post" action="/__qa/buy"><button>Reponer una unidad de prueba</button></form><p><a href="/storefront">Abrir Control</a> · <a href="http://127.0.0.1:4180/#buscador">Abrir catálogo de prueba</a></p><pre>${JSON.stringify(state, null, 2).replaceAll('<', '&lt;')}</pre>`,
      )
    }
    const apiPath = url.pathname.replace('/__supabase', '')
    if (apiPath.startsWith('/auth/v1/token'))
      return send({
        access_token: token,
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'local-only',
        user,
      })
    if (apiPath === '/auth/v1/user') return send(user)
    if (apiPath === '/auth/v1/logout') return send({})
    await identity(
      f.db,
      req.headers.authorization === `Bearer ${token}` ? admin : '',
      req.headers.authorization === `Bearer ${token}`
        ? 'authenticated'
        : 'anon',
    )
    if (apiPath.startsWith('/rest/v1/rpc/')) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      const name = apiPath.split('/').at(-1),
        args = Object.keys(body)
      if (!/^[a-z_]+$/.test(name) || args.some((k) => !/^[a-z_]+$/.test(k)))
        throw Error('Invalid fixture RPC')
      const isSet = (
        await f.one(
          "select proretset from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname=$1",
          [name],
        )
      )?.proretset
      const call = `public.${name}(${args.map((k, i) => `${k} => $${i + 1}`).join(',')})`
      const rows = (
        await f.db.query(
          isSet
            ? `select to_jsonb(r) result from ${call} r`
            : `select ${call} result`,
          args.map((k) =>
            typeof body[k] === 'object' && body[k] !== null
              ? JSON.stringify(body[k])
              : body[k],
          ),
        )
      ).rows.map((r) => r.result)
      return send(isSet ? rows : rows[0])
    }
    const table = apiPath.split('/').at(-1)
    if (!['GET', 'HEAD'].includes(req.method) || !tables.has(table))
      throw Error(`Unhandled ${req.method} ${apiPath}`)
    let projection = 't.*'
    if (table === 'storefront_publications') {
      const columns = (url.searchParams.get('select') || '').split(',')
      if (
        columns.some(
          (c) =>
            !['id', 'content', 'visible', 'listed', 'published_at'].includes(c),
        )
      )
        throw Error('Invalid publication projection')
      projection = columns.map((c) => `t.${c}`).join(',')
    }
    if (table === 'products')
      projection += `,(select jsonb_build_object('name',name) from brands where id=t.brand_id) brands,(select coalesce(jsonb_agg(p),'[]') from product_prices p where p.product_id=t.id) product_prices,(select coalesce(jsonb_agg(b),'[]') from inventory_balances b where b.product_id=t.id) inventory_balances`
    if (table === 'documents')
      projection += `,(select coalesce(jsonb_agg(i),'[]') from document_items i where i.document_id=t.id) document_items,t.request_payload->'payments' payments`
    const conditions = [],
      values = []
    for (const [key, value] of url.searchParams) {
      if (['select', 'order', 'limit', 'offset'].includes(key)) continue
      if (
        key === 'or' &&
        value === '(status.eq.pending,removal_state.eq.pending)'
      ) {
        conditions.push("(t.status='pending' or t.removal_state='pending')")
        continue
      }
      if (!/^[a-z_]+$/.test(key)) throw Error('Invalid fixture filter')
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
      if (!operators[op]) throw Error('Invalid fixture operator')
      values.push(val)
      conditions.push(`t.${key}${operators[op]}$${values.length}`)
    }
    const filtered = `from public.${table} t${conditions.length ? ' where ' + conditions.join(' and ') : ''}`
    let sql = `select ${projection} ${filtered}`
    const order = url.searchParams.get('order')
    if (order) {
      const parts = order.split(',')
      if (parts.some((p) => !/^[a-z_]+\.(asc|desc)$/.test(p)))
        throw Error('Invalid fixture order')
      sql +=
        ' order by ' + parts.map((p) => 't.' + p.replace('.', ' ')).join(',')
    }
    const offset = Number(url.searchParams.get('offset') || 0),
      limit = Number(url.searchParams.get('limit') || 2000)
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit))
      throw Error('Invalid pagination')
    sql += ` limit ${Math.min(limit, 5000)} offset ${offset}`
    const rows = (
      await f.db.query(`select to_jsonb(r) result from (${sql}) r`, values)
    ).rows.map((r) => r.result)
    if (req.headers.prefer?.includes('count=exact')) {
      const n = (await f.one(`select count(*)::int n ${filtered}`, values)).n
      res.setHeader(
        'content-range',
        `${rows.length ? `${offset}-${offset + rows.length - 1}` : '*'}/${n}`,
      )
    }
    if (req.method === 'HEAD') {
      res.writeHead(200)
      return res.end()
    }
    return send(
      req.headers.accept?.includes('vnd.pgrst.object')
        ? (rows[0] ?? null)
        : rows,
    )
  } catch (e) {
    errors.push(`${url.pathname}: ${e.message}`)
    return send({ code: e.code ?? 'QA_ERROR', message: e.message }, 400)
  }
}
process.env.VITE_SUPABASE_URL = 'https://isolated.supabase.co'
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_isolated_test'
const vite = await createServer({
  configFile: 'frontend/vite.config.ts',
  server: { host: '127.0.0.1', port: 5175, strictPort: true },
  plugins: [
    {
      name: 'isolated-qa-transport',
      enforce: 'pre',
      transform(code, id) {
        if (id.replaceAll('\\', '/').endsWith('/src/lib/supabase.ts'))
          return code.replace(
            "fetch(input, { ...init, cache: 'no-store' })",
            "fetch(typeof input === 'string' ? input.replace('https://isolated.supabase.co', '/__supabase') : input, { ...init, cache: 'no-store' })",
          )
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (
            !req.url.startsWith('/__supabase') &&
            !req.url.startsWith('/__qa')
          )
            return next()
          queue = queue
            .then(() => gateway(req, res))
            .catch((e) => console.error(e.message))
        })
      },
    },
  ],
})
await vite.listen()
const catalogRoot = path.resolve('output/catalogo-review')
const { isPublic } =
  await import('../../output/catalogo-review/scripts/manifest.mjs')
const catalog = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1:4180')
    if (url.pathname === '/__qa/frame') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(frameHtml(url.searchParams.get('width'), '/#buscador'))
    }
    const relative = url.pathname.slice(1) || 'index.html'
    if (!isPublic(relative) || relative.startsWith('_')) {
      res.writeHead(404)
      return res.end()
    }
    let body = await readFile(path.join(catalogRoot, relative))
    if (relative === 'js/config.js')
      body = Buffer.from(
        body
          .toString()
          .replace(
            /https:\/\/[a-z]+\.supabase\.co/g,
            'http://127.0.0.1:5175/__supabase',
          ),
      )
    res.writeHead(200, {
      'content-type':
        types[path.extname(relative)] || 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end()
  }
})
catalog.listen(4180, '127.0.0.1', () =>
  console.log(
    'QA Control http://127.0.0.1:5175 · catálogo http://127.0.0.1:4180 · controles http://127.0.0.1:5175/__qa',
  ),
)
export async function closeReviewServer() {
  await queue
  await vite.close()
  await new Promise((resolve) => catalog.close(resolve))
  await f.close()
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => void closeReviewServer())

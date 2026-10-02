// Precios de venta desde el precio de compra de cada perfume, de punta a punta:
// la pantalla real en un navegador real contra la base de datos real (PGlite
// con todas las migraciones), detrás de una API de Supabase simulada.
//
//   precio de la lista = precio de compra × (1 + % / 100), al centavo
//
// en la moneda de la compra (C$ o US$); la otra moneda sale de la tasa del
// catálogo. Una lista con porcentaje y sin precio de compra queda pendiente
// («Falta precio de compra») y conserva su precio publicado; una sin
// porcentaje sigue «A mano» en dólares. El costo promedio del inventario sigue
// para la contabilidad (costo inicial, compras), pero ya no mueve precios.
// Recorre la ficha rápida y la ficha del perfume (US$ 20 con 25 % → US$ 25 /
// C$ 915; C$ 500 con 20 % → C$ 600 / US$ 16.39), compras y costo inicial que
// no cambian precios, la carga desde archivo con precio y moneda de compra, la
// plantilla, el cambio de tasa, una entrada sin costo, el historial, el
// teclado, el teléfono y los permisos.
//
//   npm run test:flows
//
// Arranca su propio servidor de Vite (puerto 5177) en modo Supabase apuntando a
// https://flujos.supabase.invalid. Playwright contesta esas peticiones y las
// convierte en consultas a PGlite con la identidad de quien inició sesión, así
// que RLS, permisos, validaciones y cálculo son los de la migración. Nada sale
// a la red ni toca la base real. Navegador: Chrome instalado;
// PLAYWRIGHT_CHANNEL=chromium o PLAYWRIGHT_EXECUTABLE_PATH=<ruta> para otro.
// SHOTS=<carpeta> guarda capturas de cada pantalla revisada.
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { PGlite } from '@electric-sql/pglite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SUPABASE = 'https://flujos.supabase.invalid'
const PORT = 5177
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = process.env.SHOTS || ''
Object.assign(process.env, {
  VITE_DATA_MODE: 'supabase',
  VITE_SUPABASE_URL: SUPABASE,
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_flujos_de_prueba',
})

const owner = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'duena@example.com',
  password: 'Clave-de-prueba-2026',
  role: 'superadmin',
  name: 'Dueña',
}
const sales = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'ventas@example.com',
  password: 'Clave-de-ventas-2026',
  role: 'operator',
  name: 'Ventas',
}
const users = [owner, sales]
const perfumes = [
  ['aaaaaaaa-0000-4000-8000-000000000001', 'Casa Ámbar', 'Oud Nocturno', 35],
  ['aaaaaaaa-0000-4000-8000-000000000002', 'Casa Ámbar', 'Jazmín Blanco', 30],
  ['aaaaaaaa-0000-4000-8000-000000000003', 'Estudio Nácar', 'Cedro Azul', 40],
  [
    'aaaaaaaa-0000-4000-8000-000000000004',
    'Estudio Nácar',
    'Vainilla Suave',
    25,
  ],
  ['aaaaaaaa-0000-4000-8000-000000000005', 'Taller Índigo', 'Cítrico Vivo', 28],
]
const [oud, jazmin, cedro, vainilla, citrico] = perfumes.map(([id]) => id)

// --- Base de datos -----------------------------------------------------------

const db = new PGlite()
let busy = Promise.resolve()
/** PGlite atiende una consulta a la vez: todo pasa por esta fila. */
function serial(task) {
  const run = busy.then(task, task)
  busy = run.catch(() => {})
  return run
}
/** Ejecuta como la persona de la sesión (o anónimo), igual que PostgREST. */
function asUser(sub, task) {
  return serial(async () => {
    await db.exec('reset role')
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      sub ?? '',
    ])
    await db.exec(sub ? 'set role authenticated' : 'set role anon')
    try {
      return await task()
    } finally {
      await db.exec('reset role')
    }
  })
}
const asOwner = (sql, params = []) =>
  serial(async () => {
    await db.exec('reset role')
    return (await db.query(sql, params)).rows
  })

async function setupDatabase() {
  await db.exec(`create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[],owner uuid references auth.users(id),owner_id text);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid references auth.users(id),owner_id text,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated,anon;
    grant select,insert,delete on storage.objects to authenticated;
    create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
    create table auth.sessions(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id) on delete cascade);`)
  for (const user of users)
    await db.query('insert into auth.users(id,email) values($1,$2)', [
      user.id,
      user.email,
    ])
  for (const file of (await readdir('supabase/migrations')).sort())
    if (
      file.endsWith('.sql') &&
      !file.includes('harden_platform_function_grants')
    )
      await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'))
  for (const user of users)
    await db.query(
      'insert into public.staff_members(user_id,display_name,role) values($1,$2,$3)',
      [user.id, user.name, user.role],
    )
  await db.exec(
    "insert into public.business_settings(name,address,phone) values('Negocio de prueba','Managua','5555-0100')",
  )
  await asUser(owner.id, async () => {
    await db.query('select public.set_exchange_rate(36.6)')
    for (const [id, brand, name, usd] of perfumes)
      await db.query('select public.save_catalog_product($1::jsonb)', [
        JSON.stringify({
          id,
          revision: 0,
          name,
          brand,
          size: 100,
          unit: 'ml',
          category: 'arabian',
          gender: 'unisex',
          manufacturerBarcode: '',
          minimumStock: 0,
          active: true,
          imagePath: null,
          prices: {
            emprendedor: { USD: usd, NIO: 0 },
            vip: { USD: usd - 1, NIO: 0 },
            premium: { USD: usd - 2, NIO: 0 },
          },
        }),
      ])
  })
}

// --- API de Supabase simulada ------------------------------------------------

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
  'access-control-expose-headers': 'content-range',
}
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const now = () => Math.floor(Date.now() / 1000)
const tokenFor = (user) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, role: 'authenticated', exp: now() + 3600 })}.firmaSimulada0123456789`
function subject(request) {
  const token = (request.headers()['authorization'] ?? '').replace(
    /^Bearer\s+/i,
    '',
  )
  try {
    const sub = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString(),
    ).sub
    return users.some((user) => user.id === sub) ? sub : null
  } catch {
    return null
  }
}
const authUser = (user) => ({
  id: user.id,
  aud: 'authenticated',
  role: 'authenticated',
  email: user.email,
  app_metadata: { provider: 'email' },
  user_metadata: {},
  created_at: new Date().toISOString(),
})
const identifier = /^[a-z_][a-z0-9_]*$/
const unknown = new Set()
const operators = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
}
/** Filtros, orden y página de una lectura de PostgREST, como SQL. */
function readQuery(url, alias) {
  const where = []
  const params = []
  let order = ''
  let limit = ''
  let offset = ''
  for (const [key, raw] of url.searchParams) {
    if (key === 'select') continue
    if (key === 'order') {
      order = raw
        .split(',')
        .map((part) => {
          const [column, direction = 'asc'] = part.split('.')
          if (!identifier.test(column)) throw new Error(`orden ${part}`)
          return `${alias}.${column} ${direction === 'desc' ? 'desc' : 'asc'}`
        })
        .join(',')
      continue
    }
    if (key === 'limit') {
      limit = String(Number(raw))
      continue
    }
    if (key === 'offset') {
      offset = String(Number(raw))
      continue
    }
    if (!identifier.test(key)) throw new Error(`filtro ${key}`)
    const [op, ...rest] = raw.split('.')
    const value = rest.join('.')
    // Sin conversión: PostgreSQL deduce el tipo del parámetro por la columna.
    if (op in operators) {
      params.push(value)
      where.push(`${alias}.${key} ${operators[op]} $${params.length}`)
    } else if (op === 'is' && value === 'null')
      where.push(`${alias}.${key} is null`)
    else if (op === 'in') {
      params.push(value.replace(/^\(|\)$/g, '').split(','))
      where.push(`${alias}.${key}::text = any($${params.length}::text[])`)
    } else throw new Error(`operador ${raw}`)
  }
  return {
    where: where.length ? `where ${where.join(' and ')}` : '',
    order: order ? `order by ${order}` : '',
    page: `${limit ? `limit ${limit}` : ''} ${offset ? `offset ${offset}` : ''}`,
    params,
  }
}
/** Separa «a,b,hijo(c,d)» por las comas de primer nivel. */
function splitSelect(select) {
  const parts = []
  let depth = 0
  let current = ''
  for (const character of select) {
    if (character === '(') depth++
    if (character === ')') depth--
    if (character === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
    } else current += character
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}
const foreignKey = `select a.attname as child_column, af.attname as parent_column
  from pg_constraint c
  join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
  join pg_attribute af on af.attrelid=c.confrelid and af.attnum=c.confkey[1]
  where c.contype='f' and c.conrelid=to_regclass($1) and c.confrelid=to_regclass($2)`
/**
 * Las columnas pedidas, con los recursos incrustados de un nivel como hace
 * PostgREST: «precios(…)» de una tabla hija es una lista y «marca(…)» de una
 * tabla madre es un objeto. Se sigue la clave foránea entre las dos.
 */
async function selection(table, select) {
  const columns = []
  for (const part of splitSelect(select)) {
    if (part === '*' || identifier.test(part)) {
      columns.push(part === '*' ? 't.*' : `t.${part}`)
      continue
    }
    const nested = /^([a-z_][a-z0-9_]*)\((.*)\)$/.exec(part)
    const fields = nested ? splitSelect(nested[2]) : []
    if (!nested || !fields.every((field) => identifier.test(field))) {
      unknown.add(`${table}: ${part}`)
      continue
    }
    const [child, inner] = [nested[1], fields]
    const object = `json_build_object(${inner.map((field) => `'${field}',x.${field}`).join(',')})`
    const [many] = await asOwner(foreignKey, [
      `public.${child}`,
      `public.${table}`,
    ])
    if (many) {
      columns.push(
        `coalesce((select json_agg(${object}) from public.${child} x where x.${many.child_column}=t.${many.parent_column}),'[]') as ${child}`,
      )
      continue
    }
    const [one] = await asOwner(foreignKey, [
      `public.${table}`,
      `public.${child}`,
    ])
    if (one) {
      columns.push(
        `(select ${object} from public.${child} x where x.${one.parent_column}=t.${one.child_column}) as ${child}`,
      )
      continue
    }
    unknown.add(`${table}: ${part}`)
  }
  return columns.join(',') || 't.*'
}
async function readTable(sub, table, url, prefer) {
  const columns = await selection(table, url.searchParams.get('select') ?? '*')
  const query = readQuery(url, 't')
  return asUser(sub, async () => {
    const rows = (
      await db.query(
        `select ${columns} from public.${table} t ${query.where} ${query.order} ${query.page}`,
        query.params,
      )
    ).rows
    let total = rows.length
    if (prefer?.includes('count=exact'))
      total = (
        await db.query(
          `select count(*)::int as n from public.${table} t ${query.where}`,
          query.params,
        )
      ).rows[0].n
    return { rows, total }
  })
}
async function callFunction(sub, name, args) {
  if (!identifier.test(name)) throw new Error(`función ${name}`)
  const [info] = await asOwner(
    `select p.proretset as set, p.proargnames as names,
       array(select format_type(t,null) from unnest(p.proargtypes) t) as types
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname=$1`,
    [name],
  )
  if (!info) {
    const error = new Error(`Could not find the function public.${name}`)
    error.code = 'PGRST202'
    throw error
  }
  // proargnames también nombra las columnas de salida (RETURNS TABLE); los
  // argumentos de entrada son los primeros.
  const names = (info.names ?? []).slice(0, info.types.length)
  const values = names.map((arg) => {
    const value = args?.[arg]
    return value !== null && typeof value === 'object'
      ? JSON.stringify(value)
      : value
  })
  const call = names
    .map((arg, index) => `${arg} => $${index + 1}::${info.types[index]}`)
    .join(',')
  return asUser(sub, async () => {
    if (info.set)
      return (await db.query(`select * from public.${name}(${call})`, values))
        .rows
    return (await db.query(`select public.${name}(${call}) as result`, values))
      .rows[0].result
  })
}
async function answer(route) {
  const request = route.request()
  const url = new URL(request.url())
  const json = (body, status = 200, headers = {}) =>
    route.fulfill({
      status,
      headers: { ...CORS, ...headers },
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  if (request.method() === 'OPTIONS')
    return route.fulfill({ status: 204, headers: CORS })
  try {
    if (url.pathname === '/auth/v1/token') {
      const body = request.postDataJSON() ?? {}
      const user = users.find(
        (item) => item.email === body.email && item.password === body.password,
      )
      if (!user)
        return json(
          { code: 'invalid_credentials', message: 'Invalid login credentials' },
          400,
        )
      return json({
        access_token: tokenFor(user),
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: now() + 3600,
        refresh_token: `renovacion-${user.id}`,
        user: authUser(user),
      })
    }
    if (url.pathname === '/auth/v1/user') {
      const user = users.find((item) => item.id === subject(request))
      return user ? json(authUser(user)) : json({ message: 'sin sesión' }, 401)
    }
    if (url.pathname === '/auth/v1/logout')
      return route.fulfill({ status: 204, headers: CORS })
    if (url.pathname.startsWith('/storage/v1/')) return json([])
    if (url.pathname.startsWith('/rest/v1/rpc/'))
      return json(
        await callFunction(
          subject(request),
          url.pathname.slice('/rest/v1/rpc/'.length),
          request.postDataJSON(),
        ),
      )
    if (url.pathname.startsWith('/rest/v1/') && request.method() === 'GET') {
      const table = url.pathname.slice('/rest/v1/'.length)
      if (!identifier.test(table)) throw new Error(`tabla ${table}`)
      const { rows, total } = await readTable(
        subject(request),
        table,
        url,
        request.headers()['prefer'],
      )
      const start = Number(url.searchParams.get('offset') ?? 0)
      return json(rows, 200, {
        'content-range': `${start}-${start + Math.max(rows.length - 1, 0)}/${total}`,
      })
    }
    unknown.add(`${request.method()} ${url.pathname}`)
    return json([])
  } catch (error) {
    const code = error.code ?? 'XX000'
    if (!['P0001', '42501', 'PGRST202'].includes(code))
      console.log(`  (API simulada) ${url.pathname}: ${code} ${error.message}`)
    // Como PostgREST: sin tabla o función, 404; sin permiso, 403; el resto, 400.
    const status =
      code.startsWith('PGRST2') || code === '42P01'
        ? 404
        : code === '42501'
          ? 403
          : 400
    return json(
      { code, message: error.message, details: null, hint: null },
      status,
    )
  }
}

// --- Comprobaciones ----------------------------------------------------------

let failures = 0
let checks = 0
function check(ok, text) {
  checks++
  console.log(`${ok ? '✔' : '✘'} ${text}`)
  if (!ok) failures++
}
async function prices(id) {
  const rows = await asOwner(
    'select tier_code,currency,amount from public.product_prices where product_id=$1',
    [id],
  )
  const result = {}
  for (const row of rows)
    (result[row.tier_code] ??= {})[row.currency] = Number(row.amount)
  return result
}
const pricing = async (id) =>
  (
    await asOwner('select * from public.product_pricing where product_id=$1', [
      id,
    ])
  )[0] ?? null
/** Igualdad sin importar el orden de las claves (las filas llegan sin orden). */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  return value
}
const same = (a, b) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
/** Navegar sin recargar: la sesión vive sólo en la memoria de la pestaña. */
async function go(page, path) {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}
async function shot(page, name) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true })
}
async function noOverflow(page, where) {
  const extra = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  )
  check(extra <= 0, `${where}: sin desplazamiento horizontal (${extra} px)`)
}
async function login(page, user) {
  await page.goto(`${BASE}/login`)
  await page.getByLabel('Correo electrónico').fill(user.email)
  await page.getByLabel('Contraseña', { exact: true }).fill(user.password)
  await page.getByRole('button', { name: 'Iniciar sesión' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), {
    timeout: 20000,
  })
}
/**
 * El aviso de validación enlazado al campo, como lo lee un lector de pantalla.
 * Espera a que la pantalla lo pinte (hasta 5 s); nulo si nunca aparece.
 */
async function fieldError(locator) {
  for (let waited = 0; waited < 5000; waited += 100) {
    const id = await locator.getAttribute('aria-describedby')
    if (id) return locator.page().locator(`[id="${id}"]`).textContent()
    await locator.page().waitForTimeout(100)
  }
  return null
}

// --- Recorrido ---------------------------------------------------------------

await setupDatabase()
const server = await createServer({
  mode: 'test',
  cacheDir: 'output/cache/vite-flows',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: PORT, strictPort: true },
})
await server.listen()
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? undefined
    : process.env.PLAYWRIGHT_CHANNEL || 'chrome',
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
})
const consoleErrors = []
let lastPage = null
async function open(viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({
    viewport,
    acceptDownloads: true,
    locale: 'es-NI',
  })
  await context.route(`${SUPABASE}/**`, answer)
  const page = await context.newPage()
  lastPage = page
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(String(error)))
  return { context, page }
}

try {
  // Existencias contadas: Oud 13 (5 en tienda y 8 en bodega, como el Excel
  // del cliente), Cedro 4 y Cítrico 2 sin costo, Jazmín en cero y Vainilla sin
  // conteo.
  await asOwner(
    `update public.inventory_balances b set quantity=c.q from (values
      ($1::uuid,'store',5),($1,'warehouse',8),($2,'store',0),($2,'warehouse',0),
      ($3,'store',4),($3,'warehouse',0),($4,'store',2),($4,'warehouse',0)) as c(id,loc,q)
     where b.product_id=c.id and b.location=c.loc`,
    [oud, jazmin, cedro, citrico],
  )
  const { context, page } = await open()
  await login(page, owner)
  const menu = page.getByRole('navigation', { name: 'Navegación principal' })
  await menu.getByRole('link', { name: 'Precios' }).waitFor()
  check(true, 'la dueña ve «Precios» en el menú')

  // 1. Pantalla Precios con los datos de la base.
  await page.getByRole('link', { name: 'Precios' }).first().click()
  await page
    .getByRole('button', { name: 'Editar precios de Oud Nocturno' })
    .waitFor()
  check(
    await page.getByRole('button', { name: /Sin porcentajes\s*5/ }).isVisible(),
    'los 5 perfumes empiezan sin porcentajes',
  )
  await shot(page, '01-precios-vacio')
  const oudSeeded = await prices(oud)

  // 2. Apartado del inventario: costo inicial de las 13 unidades de Oud. Es
  // contabilidad: no cambia ningún precio.
  const sections = page.getByRole('navigation', {
    name: 'Apartados de precios',
  })
  await sections.getByRole('button', { name: 'Costo de inventario' }).click()
  await page.waitForURL(`${BASE}/prices?apartado=costo`)
  const costs = page.getByRole('region', { name: 'Costo promedio por perfume' })
  await costs.waitFor()
  const summaryText = (
    await page
      .getByRole('group', { name: 'Resumen de costos' })
      .or(page.locator('[aria-label="Resumen de costos"]'))
      .textContent()
  ).replace(/\s+/g, ' ')
  check(
    /Con costo\s*0/.test(summaryText) &&
      /Sin costo\s*4/.test(summaryText) &&
      /Sin conteo completo\s*1/.test(summaryText),
    `resumen de costos: 0 con costo, 4 sin costo, 1 sin conteo${/Sin costo\s*4/.test(summaryText) ? '' : ` — se leyó «${summaryText}»`}`,
  )
  await shot(page, '02-costo-inventario')
  await page
    .getByRole('button', { name: 'Cargar costo inicial de Oud Nocturno' })
    .click()
  const openingDialog = page.getByRole('dialog', {
    name: 'Costo inicial · Oud Nocturno',
  })
  await openingDialog.getByLabel('Costo por unidad (C$)').fill('15.675')
  await openingDialog
    .getByLabel('Origen del costo / comprobante')
    .fill('Formulas.xlsx, Hoja 1!F10')
  await openingDialog.getByText('13 u. contadas').waitFor()
  const openingText = (await openingDialog.textContent()).replace(/\s+/g, ' ')
  check(
    openingText.includes('costo promedio C$ 15.675') &&
      !/Emprendedor|VIP|Premium/.test(openingText),
    'costo inicial: la vista previa enseña 13 u. contadas → C$ 15.675, sin precios',
  )
  await openingDialog
    .getByRole('button', { name: 'Guardar costo inicial' })
    .click()
  await page.getByText('Costo inicial de «Oud Nocturno» registrado.').waitFor()
  const averageOf = async (id) =>
    Number(
      (
        await asOwner(
          'select average_cost_nio from public.product_costs where product_id=$1',
          [id],
        )
      )[0]?.average_cost_nio ?? NaN,
    )
  check(
    (await averageOf(oud)) === 15.675 && same(await prices(oud), oudSeeded),
    'la base guardó el costo promedio C$ 15.675 y los precios de Oud no se movieron',
  )

  // 3. Ficha rápida: precio de compra, moneda y porcentajes. Validaciones y el
  // ejemplo: US$ 20 con 25 % Emprendedor y 20 % VIP, Premium a mano.
  await sections.getByRole('button', { name: 'Precios de venta' }).click()
  await page
    .getByRole('button', { name: 'Editar precios de Oud Nocturno' })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Oud Nocturno' })
  const markup = (tier) => dialog.getByLabel(`% de ganancia · ${tier}`)
  const purchase = dialog.getByLabel('Precio de compra', { exact: true })
  const purchaseCurrency = dialog.getByLabel('Moneda de compra')
  const save = dialog.getByRole('button', { name: 'Guardar precios' })
  const labelsOf = (locator) =>
    locator.evaluateAll((inputs) =>
      inputs.map((input) => input.labels?.[0]?.textContent?.trim() ?? ''),
    )
  const inputLabels = await labelsOf(dialog.locator('input'))
  const currencyOptions = await purchaseCurrency
    .locator('option')
    .evaluateAll((options) => options.map((option) => option.value))
  check(
    same(inputLabels, [
      'Precio de compra',
      '% de ganancia · Emprendedor',
      '% de ganancia · VIP',
      '% de ganancia · Premium',
    ]) && same(currencyOptions, ['USD', 'NIO']),
    `la ficha rápida pide precio de compra, moneda (US$/C$) y un % por lista; el costo promedio no se escribe${inputLabels.length === 4 ? '' : ` — se leyó «${inputLabels.join(' | ')}»`}`,
  )
  const cases = [
    [() => markup('VIP'), 'VIP', '1000.5', 'Usa un porcentaje de hasta 1000.'],
    [() => markup('VIP'), 'VIP', '-1', 'El porcentaje no puede ser negativo.'],
    [() => markup('VIP'), 'VIP', '12.345', 'Usa hasta dos decimales.'],
    [
      () => purchase,
      'precio de compra',
      '-5',
      'El precio de compra debe ser mayor que cero.',
    ],
    [() => purchase, 'precio de compra', '12.345', 'Usa hasta dos decimales.'],
  ]
  for (const [field, name, value, message] of cases) {
    await purchase.fill('')
    for (const each of ['Emprendedor', 'VIP', 'Premium'])
      await markup(each).fill('')
    await field().fill(value)
    await save.click()
    const shown = await fieldError(field())
    check(
      shown === message &&
        (await field().getAttribute('aria-invalid')) === 'true',
      `ficha rápida: ${name} ${value} → «${shown}»`,
    )
  }
  check((await pricing(oud)) === null, 'ningún valor inválido llegó a la base')
  await purchase.fill('')
  await markup('Emprendedor').fill('25')
  await markup('VIP').fill('20')
  await markup('Premium').fill('')
  const emprendedor = dialog.getByRole('group', { name: 'Emprendedor' })
  await emprendedor.getByText('Falta precio de compra').waitFor()
  check(
    (await dialog.locator('[aria-invalid="true"]').count()) === 0 &&
      (await dialog.getByRole('alert').count()) === 0,
    'al corregir los datos los avisos se quitan sin volver a pulsar Guardar',
  )
  check(
    true,
    'con porcentaje y sin precio de compra la lista queda «Falta precio de compra»',
  )
  await purchase.fill('20')
  await purchaseCurrency.selectOption('USD')
  await emprendedor.getByText('Calculado').waitFor()
  const groupText = async (tier) =>
    (await dialog.getByRole('group', { name: tier }).textContent()).replace(
      /\s+/g,
      ' ',
    )
  const emprendedorText = await groupText('Emprendedor')
  const vipText = await groupText('VIP')
  check(
    emprendedorText.includes('USD 25.00') &&
      emprendedorText.includes('NIO 915.00') &&
      emprendedorText.includes('USD 5.00') &&
      vipText.includes('USD 24.00') &&
      vipText.includes('NIO 878.40'),
    `ficha rápida: US$ 20 × 1.25 = US$ 25 (C$ 915, gana US$ 5); VIP 20 % → US$ 24 (C$ 878.40)${emprendedorText.includes('USD 25.00') ? '' : ` — se leyó «${emprendedorText}»`}`,
  )
  check(
    (await groupText('Premium')).includes('A mano'),
    'Premium sin porcentaje queda «A mano»',
  )
  await shot(page, '03-ficha-rapida')
  await save.click()
  await page.getByText('Precios de «Oud Nocturno» guardados.').waitFor()
  const oudPricing = await pricing(oud)
  check(
    same(await prices(oud), {
      emprendedor: { USD: 25, NIO: 915 },
      vip: { USD: 24, NIO: 878.4 },
      premium: oudSeeded.premium,
    }) &&
      Number(oudPricing?.purchase_price) === 20 &&
      oudPricing?.purchase_currency === 'USD',
    'la base guardó la compra US$ 20 y US$ 25 / C$ 915 y US$ 24 / C$ 878.40; Premium a mano sin cambios',
  )

  // 4. Compra del Excel: 20 unidades a C$ 16.675. El promedio pasa a
  // 16.281061, pero los precios siguen saliendo del precio de compra.
  const oudPriced = await prices(oud)
  await sections.getByRole('button', { name: 'Costo de inventario' }).click()
  await page
    .getByRole('button', { name: 'Registrar compra de Oud Nocturno' })
    .click()
  const buy = page.getByRole('dialog', { name: 'Registrar compra' })
  await buy.getByLabel('Factura o referencia').fill('FAC-778')
  await buy.getByLabel('Unidades').fill('20')
  await buy.getByLabel('Costo por unidad (C$)').fill('16.675')
  await buy.getByText('costo promedio C$ 16.281061').waitFor()
  const outcome = (await buy.locator('.pricing-outcome').textContent()).replace(
    /\s+/g,
    ' ',
  )
  check(
    outcome.includes('13 u. × C$ 15.675 + 20 u. × C$ 16.675') &&
      !/Emprendedor|VIP|Premium/.test(outcome),
    `vista previa de la compra: 13 × 15.675 + 20 × 16.675 → 16.281061, sin precios${outcome.includes('16.281061') ? '' : ` — se leyó «${outcome}»`}`,
  )
  await shot(page, '04-registrar-compra')
  await buy.getByRole('button', { name: 'Registrar compra' }).click()
  await page
    .getByText(
      'Compra registrada: 20 unidades en inventario y costo promedio actualizado.',
    )
    .waitFor()
  check(
    (await averageOf(oud)) === 16.281061 && same(await prices(oud), oudPriced),
    'la base: promedio 16.281061 y los precios de Oud quedan en US$ 25 / US$ 24 / a mano',
  )
  await sections.getByRole('button', { name: 'Precios de venta' }).click()
  const oudRow = page
    .getByRole('button', { name: 'Oud Nocturno', exact: true })
    .locator('xpath=ancestor::tr')
  await oudRow.getByText('25 % · gana USD 5.00').waitFor()
  const oudRowText = (await oudRow.textContent()).replace(/\s+/g, ' ')
  check(
    oudRowText.includes('USD 20.00') &&
      oudRowText.includes('NIO 915.00') &&
      oudRowText.includes('20 % · gana USD 4.00') &&
      oudRowText.includes('A mano'),
    'la lista lee la base: compra US$ 20, Emprendedor C$ 915 «25 % · gana US$ 5», Premium a mano',
  )

  // 5. Porcentaje sin precio de compra: queda pendiente y no inventa precio,
  // ni siquiera cuando se carga el costo del inventario. Con su precio de
  // compra en córdobas, C$ 500 con 20 % → C$ 600 (US$ 16.39).
  await page
    .getByRole('button', { name: 'Editar precios de Cedro Azul' })
    .click()
  const cedroDialog = page.getByRole('dialog', { name: 'Cedro Azul' })
  await cedroDialog.getByLabel('% de ganancia · Emprendedor').fill('20')
  await cedroDialog
    .getByRole('group', { name: 'Emprendedor' })
    .getByText('Falta precio de compra')
    .waitFor()
  const cedroBefore = await prices(cedro)
  await cedroDialog.getByRole('button', { name: 'Guardar precios' }).click()
  await page.getByText('Precios de «Cedro Azul» guardados.').waitFor()
  check(
    same(await prices(cedro), cedroBefore) &&
      Number((await pricing(cedro))?.markup_emprendedor) === 20 &&
      (await pricing(cedro))?.purchase_price === null,
    'Cedro sin precio de compra: el 20 % se guarda y el precio publicado no cambia',
  )
  const cedroRow = page
    .getByRole('button', { name: 'Cedro Azul', exact: true })
    .locator('xpath=ancestor::tr')
  await cedroRow.getByText('20 % · falta compra').waitFor()
  check(true, 'la lista marca «20 % · falta compra»')
  await sections.getByRole('button', { name: 'Costo de inventario' }).click()
  await page
    .getByRole('button', { name: 'Cargar costo inicial de Cedro Azul' })
    .click()
  const cedroOpening = page.getByRole('dialog', {
    name: 'Costo inicial · Cedro Azul',
  })
  await cedroOpening.getByLabel('Costo por unidad (C$)').fill('100')
  await cedroOpening
    .getByLabel('Origen del costo / comprobante')
    .fill('Lista del proveedor')
  await cedroOpening.getByText('costo promedio C$ 100').waitFor()
  await cedroOpening
    .getByRole('button', { name: 'Guardar costo inicial' })
    .click()
  await page.getByText('Costo inicial de «Cedro Azul» registrado.').waitFor()
  check(
    (await averageOf(cedro)) === 100 && same(await prices(cedro), cedroBefore),
    'al cargar su costo promedio (C$ 100), Cedro sigue pendiente: ningún precio cambia',
  )
  await sections.getByRole('button', { name: 'Precios de venta' }).click()
  await page
    .getByRole('button', { name: 'Editar precios de Cedro Azul' })
    .click()
  await cedroDialog.getByLabel('Precio de compra', { exact: true }).fill('500')
  await cedroDialog.getByLabel('Moneda de compra').selectOption('NIO')
  const cedroEmprendedor = cedroDialog.getByRole('group', {
    name: 'Emprendedor',
  })
  await cedroEmprendedor.getByText('Calculado').waitFor()
  const cedroText = (await cedroEmprendedor.textContent()).replace(/\s+/g, ' ')
  check(
    cedroText.includes('NIO 600.00') &&
      cedroText.includes('USD 16.39') &&
      cedroText.includes('NIO 100.00'),
    `Cedro: C$ 500 × 1.20 = C$ 600 (US$ 16.39, gana C$ 100)${cedroText.includes('NIO 600.00') ? '' : ` — se leyó «${cedroText}»`}`,
  )
  await cedroDialog.getByRole('button', { name: 'Guardar precios' }).click()
  await page.getByText('Precios de «Cedro Azul» guardados.').waitFor()
  check(
    same(await prices(cedro), {
      ...cedroBefore,
      emprendedor: { NIO: 600, USD: 16.39 },
    }) && (await pricing(cedro))?.purchase_currency === 'NIO',
    'la base: Cedro Emprendedor C$ 600 / US$ 16.39; VIP y Premium siguen a mano',
  )

  // 6. Ficha completa del perfume: Jazmín, sin existencias ni precio de compra.
  await page
    .getByRole('button', { name: 'Editar precios de Jazmín Blanco' })
    .click()
  await page
    .getByRole('dialog', { name: 'Jazmín Blanco' })
    .getByRole('link', { name: 'Editar perfume' })
    .click()
  await page.waitForURL(
    `${BASE}/products/${jazmin}/edit?volver=precios#precios`,
  )
  await page.getByRole('heading', { name: 'Editar perfume' }).waitFor()
  const card = page.locator('#precios')
  const cardPurchase = card.getByLabel('Precio de compra', { exact: true })
  await cardPurchase.waitFor()
  check(
    (await cardPurchase.inputValue()) === '' &&
      (await card.getByLabel('Moneda de compra').count()) === 1,
    'ficha del perfume: pide el precio de compra y su moneda',
  )
  await card.getByLabel('% de ganancia · Emprendedor').fill('25')
  await card
    .getByRole('group', { name: 'Emprendedor' })
    .getByText('Falta precio de compra')
    .waitFor()
  const vipUsd = card.getByLabel('VIP USD', { exact: true })
  await vipUsd.fill('')
  await page.getByRole('button', { name: 'Guardar perfume' }).click()
  check(
    (await vipUsd.getAttribute('aria-invalid')) === 'true',
    'ficha del perfume: la lista a mano sin precio no se deja guardar',
  )
  await vipUsd.fill('31.5')
  await shot(page, '05-ficha-perfume')
  await page.getByRole('button', { name: 'Guardar perfume' }).click()
  await page.waitForURL(`${BASE}/prices`)
  check(
    same(await prices(jazmin), {
      emprendedor: { USD: 30, NIO: 1098 },
      vip: { USD: 31.5, NIO: 1152.9 },
      premium: { USD: 28, NIO: 1024.8 },
    }) &&
      Number((await pricing(jazmin))?.markup_emprendedor) === 25 &&
      (await pricing(jazmin))?.purchase_price === null,
    'Jazmín: 25 % guardado y pendiente; su precio publicado se conserva',
  )

  // 7. Compra en dólares con envío: el primer costo promedio de Jazmín, sin
  // tocar precios. Después, su precio de compra desde la ficha del perfume.
  await sections.getByRole('button', { name: 'Costo de inventario' }).click()
  await page
    .getByRole('button', { name: 'Registrar compra de Jazmín Blanco' })
    .click()
  await buy.getByLabel('Moneda de la compra').selectOption('USD')
  await buy.getByLabel('Tasa del pedido (C$ por dólar)').fill('36.5')
  await buy.getByLabel('Envío de todo el pedido (US$)').fill('3')
  await buy.getByLabel('Unidades').fill('3')
  await buy.getByLabel('Costo por unidad (US$)').fill('2')
  await buy.getByText('costo promedio C$ 109.5').waitFor()
  const jazminBefore = await prices(jazmin)
  await buy.getByRole('button', { name: 'Registrar compra' }).click()
  await page.getByText(/Compra registrada: 3 unidades/).waitFor()
  check(
    (await averageOf(jazmin)) === 109.5 &&
      same(await prices(jazmin), jazminBefore),
    'compra en US$: (2 + 1 de envío) × 36.5 = C$ 109.5 de costo; Jazmín sigue pendiente y sin cambios',
  )
  await go(page, `/products/${jazmin}/edit?volver=precios#precios`)
  await cardPurchase.waitFor()
  await cardPurchase.fill('20')
  await card.getByLabel('Moneda de compra').selectOption('USD')
  const jazminEmprendedor = card.getByRole('group', { name: 'Emprendedor' })
  await jazminEmprendedor.getByText('Calculado').waitFor()
  const jazminText = (await jazminEmprendedor.textContent()).replace(
    /\s+/g,
    ' ',
  )
  check(
    jazminText.includes('USD 25.00') &&
      jazminText.includes('NIO 915.00') &&
      jazminText.includes('Margen sobre el costo promedio'),
    `ficha del perfume: US$ 20 con 25 % → US$ 25 / C$ 915, con su margen sobre el costo promedio${jazminText.includes('USD 25.00') ? '' : ` — se leyó «${jazminText}»`}`,
  )
  await page.getByRole('button', { name: 'Guardar perfume' }).click()
  await page.waitForURL(`${BASE}/prices`)
  check(
    same(await prices(jazmin), {
      ...jazminBefore,
      emprendedor: { USD: 25, NIO: 915 },
    }) &&
      Number((await pricing(jazmin))?.purchase_price) === 20 &&
      (await averageOf(jazmin)) === 109.5,
    'la base: Jazmín Emprendedor US$ 25 / C$ 915 desde la compra de US$ 20; el costo promedio sigue en C$ 109.5',
  )

  // 8. Carga desde CSV: precio de compra, moneda y porcentajes; el costo
  // promedio de una plantilla anterior se ignora.
  const csv = join(tmpdir(), `precios-de-compra-${Date.now()}.csv`)
  writeFileSync(
    csv,
    [
      'Código;Marca;Perfume;Tamaño;Costo promedio C$ (informativo, no se importa);Precio de compra;Moneda de compra;% Emprendedor;% VIP;% Premium',
      'LCP-0003;Estudio Nácar;Cedro Azul;100 ml;999;550;C$;40;35;',
      ';Estudio Nácar;Vainilla Suave;;;;;"10,5%";10%;10%',
      'LCP-9999;;;;;;;1;1;1',
      'LCP-0005;;;;;;;diez;;',
      'LCP-0001;;;;;;EUR;;;',
    ].join('\r\n'),
    'latin1',
  )
  await page.getByRole('button', { name: 'Cargar archivo' }).click()
  const upload = page.getByRole('dialog', {
    name: 'Cargar precios desde un archivo',
  })
  await upload.getByLabel('Archivo con los precios').setInputFiles(csv)
  const summary = upload.locator('.pricing-import-summary')
  await summary.filter({ hasText: '2 perfumes cambian' }).waitFor()
  const preview = (await upload.textContent()).replace(/\s+/g, ' ')
  check(
    preview.includes('3 filas no se pueden usar') &&
      preview.includes('No hay ningún perfume con el código «LCP-9999»') &&
      preview.includes('El porcentaje de Emprendedor «diez» no es un número') &&
      preview.includes('La moneda «EUR» no se reconoce. Usa C$ o US$.'),
    'CSV en Windows-1252 con ; y coma decimal: 2 cambios y 3 filas explicadas',
  )
  check(
    preview.includes(
      'La columna «Costo promedio C$ (informativo, no se importa)» no se importa.',
    ) &&
      preview.includes(
        'Un perfume no tiene precio de compra: conservan su precio hasta que lo tengan.',
      ) &&
      preview.includes('NIO 550.00'),
    'la vista previa lee la compra C$ 550, ignora la columna del costo promedio y dice que Vainilla queda pendiente',
  )
  await shot(page, '06-carga-vista-previa')
  // Otra persona cambia Cedro Azul mientras se revisa el archivo. Sólo manda
  // porcentajes: el precio de compra guardado se conserva.
  const cedroRevision = (
    await asOwner('select revision from public.products where id=$1', [cedro])
  )[0].revision
  await asUser(owner.id, () =>
    db.query('select public.save_product_pricing($1::jsonb)', [
      JSON.stringify([
        {
          productId: cedro,
          revision: cedroRevision,
          pricing: { markups: { emprendedor: 31, vip: null, premium: null } },
        },
      ]),
    ]),
  )
  check(
    Number((await pricing(cedro))?.purchase_price) === 500 &&
      (await prices(cedro)).emprendedor.NIO === 655 &&
      (await prices(cedro)).emprendedor.USD === 17.9,
    'guardar sólo porcentajes conserva la compra C$ 500: 31 % → C$ 655 (US$ 17.90)',
  )
  await upload.getByRole('button', { name: 'Guardar 2 perfumes' }).click()
  await upload
    .getByRole('alert')
    .filter({ hasText: 'Otro usuario cambió' })
    .waitFor()
  check(
    (await pricing(vainilla)) === null,
    'un cambio simultáneo detiene la carga completa: nada a medias',
  )
  await upload.getByRole('button', { name: 'Cancelar' }).click()
  await page.getByRole('link', { name: 'Inventario' }).first().click()
  await page.getByRole('link', { name: 'Precios' }).first().click()
  await page.getByRole('button', { name: 'Cargar archivo' }).click()
  await upload.getByLabel('Archivo con los precios').setInputFiles(csv)
  await summary.filter({ hasText: '2 perfumes cambian' }).waitFor()
  await upload.getByRole('button', { name: 'Guardar 2 perfumes' }).click()
  await page.getByText('Precios cargados: 2 perfumes actualizados.').waitFor()
  const cedroSaved = await pricing(cedro)
  check(
    same(await prices(cedro), {
      emprendedor: { NIO: 770, USD: 21.04 },
      vip: { NIO: 742.5, USD: 20.29 },
      premium: cedroBefore.premium,
    }) &&
      Number(cedroSaved?.purchase_price) === 550 &&
      cedroSaved?.purchase_currency === 'NIO' &&
      cedroSaved?.markup_premium === null &&
      (await averageOf(cedro)) === 100,
    'Cedro: C$ 550 con 40 % y 35 % → C$ 770 y C$ 742.50; el «999» del archivo no tocó el costo promedio',
  )
  check(
    Number((await pricing(vainilla))?.markup_emprendedor) === 10.5 &&
      (await pricing(vainilla))?.purchase_price === null &&
      same(await prices(vainilla), {
        emprendedor: { USD: 25, NIO: 915 },
        vip: { USD: 24, NIO: 878.4 },
        premium: { USD: 23, NIO: 841.8 },
      }),
    'Vainilla sin precio de compra: 10.5 % guardado y sus precios publicados sin cambios',
  )
  check(
    (await pricing(citrico)) === null &&
      same(await prices(oud), oudPriced) &&
      Number((await pricing(oud))?.purchase_price) === 20,
    'las filas con «diez» y «EUR» no tocaron Cítrico Vivo ni Oud Nocturno',
  )

  // 9. La plantilla trae lo guardado y se vuelve a cargar sin cambios.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Descargar plantilla' }).click(),
  ])
  check(
    /^precios-de-compra-\d{4}-\d{2}-\d{2}\.xlsx$/.test(
      download.suggestedFilename(),
    ),
    `la plantilla se descarga como ${download.suggestedFilename()}`,
  )
  const template = join(
    tmpdir(),
    `${Date.now()}-${download.suggestedFilename()}`,
  )
  await download.saveAs(template)
  await page.getByRole('button', { name: 'Cargar archivo' }).click()
  await upload.getByLabel('Archivo con los precios').setInputFiles(template)
  await summary.filter({ hasText: '0 perfumes cambian' }).waitFor()
  const roundTrip = (await summary.textContent()).replace(/\s+/g, ' ')
  check(
    roundTrip.includes('5 sin cambios') &&
      !roundTrip.includes('no se pueden usar'),
    `la plantilla (Código, Marca, Perfume, Tamaño, Precio de compra, Moneda de compra y los %) se lee sin cambios${roundTrip.includes('5 sin cambios') ? '' : ` — se leyó «${roundTrip}»`}`,
  )
  await upload.getByRole('button', { name: 'Cancelar' }).click()

  // 10. Cambio de tasa: queda fijo el precio en la moneda de la compra y se
  // mueve el de la otra; las listas a mano mantienen el dólar.
  await asUser(owner.id, () => db.query('select public.set_exchange_rate(37)'))
  check(
    same(await prices(oud), {
      emprendedor: { USD: 25, NIO: 925 },
      vip: { USD: 24, NIO: 888 },
      premium: { USD: 33, NIO: 1221 },
    }) && (await averageOf(oud)) === 16.281061,
    'con la tasa en 37: Oud (compra en US$) sigue en US$ 25 → C$ 925; Premium a mano US$ 33 → C$ 1221',
  )
  check(
    (await prices(cedro)).emprendedor.NIO === 770 &&
      (await prices(cedro)).emprendedor.USD === 20.81,
    'con la tasa en 37: Cedro (compra en C$) sigue en C$ 770 → US$ 20.81',
  )

  // 11. Una entrada manual de un perfume con costo se rechaza y lo explica.
  await go(page, `/products/${oud}/edit`)
  await page.getByRole('heading', { name: 'Cantidades del perfume' }).waitFor()
  const stock = page.locator('.product-stock-editor')
  await stock.getByLabel('Cómo cambiar las cantidades').selectOption('ENTRY')
  await stock.getByText('regístralo como compra').waitFor()
  await stock.getByLabel('Unidades a mover').fill('2')
  await stock.getByLabel(/Motivo/).fill('Llegó mercadería')
  await stock
    .getByRole('button', { name: /Guardar|Registrar/ })
    .last()
    .click()
  await stock
    .getByRole('alert')
    .filter({ hasText: 'ya tiene costo promedio' })
    .waitFor()
  check(
    (await averageOf(oud)) === 16.281061 &&
      Number(
        (
          await asOwner(
            'select sum(quantity)::int as n from public.inventory_balances where product_id=$1',
            [oud],
          )
        )[0].n,
      ) === 33,
    'una entrada sin costo de Oud se rechaza: ni existencias ni costo cambian',
  )

  // 12. Historial: el precio dice con qué porcentaje y sobre qué compra, y
  // ninguna compra ni costo inicial aparece como cambio automático.
  await page.getByRole('heading', { name: 'Historial de precios' }).waitFor()
  await page.locator('.price-history-record').first().waitFor()
  const history = (await page.locator('.price-history').textContent()).replace(
    /\s+/g,
    ' ',
  )
  check(
    history.includes('25 % sobre la compra de USD 20.00') &&
      history.includes('20 % sobre la compra de USD 20.00') &&
      history.includes('Dueña') &&
      !history.includes('Automático') &&
      !history.includes('costo promedio'),
    `el historial marca el 25 % sobre la compra de US$ 20 hecho por la dueña, sin cambios automáticos${history.includes('sobre la compra') ? '' : ` — se leyó «${history.slice(0, 700)}»`}`,
  )
  await shot(page, '07-historial')

  // 13. Sólo con teclado en la ficha rápida: precio de compra y porcentaje.
  await page.getByRole('link', { name: 'Precios' }).first().click()
  const focusedName = () =>
    page.evaluate(() => {
      const element = document.activeElement
      const labelled = element?.getAttribute('aria-labelledby')
      return (
        element?.getAttribute('aria-label') ||
        (labelled ? document.getElementById(labelled)?.textContent : '') ||
        element?.textContent ||
        ''
      ).trim()
    })
  const focused = async (name) => {
    for (let waited = 0; waited < 3000; waited += 100) {
      if ((await focusedName()) === name) return true
      await page.waitForTimeout(100)
    }
    return false
  }
  const tabTo = async (name, limit) => {
    for (let presses = 0; presses < limit; presses++) {
      await page.keyboard.press('Tab')
      if ((await focusedName()) === name) return true
    }
    return false
  }
  const keyboardDialog = page.getByRole('dialog', { name: 'Cítrico Vivo' })
  await page
    .getByRole('button', { name: 'Editar precios de Cítrico Vivo' })
    .focus()
  await page.keyboard.press('Enter')
  await keyboardDialog.waitFor()
  await page.keyboard.press('Escape')
  await keyboardDialog.waitFor({ state: 'detached' })
  check(
    await focused('Editar precios de Cítrico Vivo'),
    'con el teclado: Escape cierra la ficha y el foco vuelve a su botón',
  )
  await page.keyboard.press('Enter')
  await keyboardDialog.waitFor()
  const reachedPurchase = await tabTo('Precio de compra', 8)
  await page.keyboard.type('30')
  const reachedMarkup = await tabTo('% de ganancia · Emprendedor', 4)
  await page.keyboard.type('10')
  await page.keyboard.press('Enter')
  await keyboardDialog.waitFor({ state: 'detached' })
  const citricoPricing = await pricing(citrico)
  check(
    reachedPurchase &&
      reachedMarkup &&
      Number(citricoPricing?.purchase_price) === 30 &&
      Number(citricoPricing?.markup_emprendedor) === 10 &&
      (await prices(citrico)).emprendedor.USD === 33 &&
      (await prices(citrico)).emprendedor.NIO === 1221 &&
      (await focused('Editar precios de Cítrico Vivo')),
    'con el teclado: Tab llega a la compra y al porcentaje, Enter guarda US$ 33 / C$ 1221 y el foco vuelve a la fila',
  )
  await context.close()

  // 14. Teléfono.
  const phone = await open({ width: 390, height: 844 })
  await login(phone.page, owner)
  await go(phone.page, '/prices')
  await phone.page
    .getByRole('button', { name: 'Editar precios de Oud Nocturno' })
    .waitFor()
  await noOverflow(phone.page, 'Precios en el teléfono')
  await shot(phone.page, '08-precios-telefono')
  await phone.page
    .getByRole('button', { name: 'Editar precios de Oud Nocturno' })
    .click()
  await phone.page
    .getByRole('dialog', { name: 'Oud Nocturno' })
    .getByLabel('Precio de compra', { exact: true })
    .waitFor()
  await noOverflow(phone.page, 'ficha rápida en el teléfono')
  await shot(phone.page, '09-ficha-telefono')
  await phone.page.keyboard.press('Escape')
  await go(phone.page, '/prices?apartado=costo')
  await phone.page
    .getByRole('region', { name: 'Costo promedio por perfume' })
    .waitFor()
  await noOverflow(phone.page, 'Costo de inventario en el teléfono')
  await shot(phone.page, '10-costos-telefono')
  await phone.page
    .getByRole('button', { name: 'Registrar compra', exact: true })
    .click()
  await phone.page.getByRole('dialog', { name: 'Registrar compra' }).waitFor()
  await noOverflow(phone.page, 'registrar compra en el teléfono')
  await shot(phone.page, '11-compra-telefono')
  await phone.context.close()

  // 15. Ventas no ve precios de compra, costos ni porcentajes, ni por la
  // pantalla ni por la API, y no puede guardarlos.
  const seller = await open()
  await login(seller.page, sales)
  check(
    (await seller.page.getByRole('link', { name: 'Precios' }).count()) === 0,
    'Ventas no tiene «Precios» en el menú',
  )
  await go(seller.page, '/prices?apartado=costo')
  await seller.page.getByText('No tienes permiso para esta pantalla.').waitFor()
  check(true, 'Ventas que abre /prices lee «No tienes permiso»')
  await go(seller.page, `/products/${oud}/edit`)
  await seller.page
    .getByText('Solo los administradores pueden editar el catálogo.')
    .waitFor()
  check(
    (await seller.page.getByLabel('Precio de compra').count()) === 0 &&
      (await seller.page.getByText('USD 20.00').count()) === 0,
    'Ventas que abre la ficha del perfume no ve el precio de compra',
  )
  const read = (table) =>
    seller.page.evaluate(
      async ([url, key, token, name]) => {
        const response = await fetch(`${url}/rest/v1/${name}?select=*`, {
          headers: { apikey: key, authorization: `Bearer ${token}` },
        })
        return response.json()
      },
      [
        SUPABASE,
        process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        tokenFor(sales),
        table,
      ],
    )
  const [pricingRows, costRows] = [
    await read('product_pricing'),
    await read('product_costs'),
  ]
  check(
    Array.isArray(pricingRows) &&
      pricingRows.length === 0 &&
      Array.isArray(costRows) &&
      costRows.length === 0,
    'precios de compra, porcentajes y costos responden vacíos a Ventas (RLS)',
  )
  const call = (name, body) =>
    seller.page.evaluate(
      async ([url, key, token, fn, payload]) => {
        const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
          method: 'POST',
          headers: {
            apikey: key,
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        })
        return response.status
      },
      [
        SUPABASE,
        process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        tokenFor(sales),
        name,
        body,
      ],
    )
  const oudRevision = (
    await asOwner('select revision from public.products where id=$1', [oud])
  )[0].revision
  const denied = await call('save_product_pricing', {
    p_rows: [
      {
        productId: oud,
        revision: oudRevision,
        pricing: {
          purchasePrice: 1,
          purchaseCurrency: 'USD',
          markups: { emprendedor: 1, vip: 1, premium: 1 },
        },
      },
    ],
  })
  const deniedProduct = await call('save_catalog_product', {
    p_payload: {
      id: oud,
      revision: oudRevision,
      name: 'Oud Nocturno',
      brand: 'Casa Ámbar',
      size: 100,
      unit: 'ml',
      category: 'arabian',
      gender: 'unisex',
      manufacturerBarcode: '',
      minimumStock: 0,
      active: true,
      imagePath: null,
      prices: oudSeeded,
      pricing: {
        purchasePrice: 1,
        purchaseCurrency: 'USD',
        markups: { emprendedor: 1, vip: null, premium: null },
      },
    },
  })
  const shipment = await call('record_shipment', {
    p_input: {
      requestId: crypto.randomUUID(),
      incurredOn: '2026-09-26',
      supplier: '',
      agency: '',
      reference: '',
      note: '',
      currency: 'NIO',
      exchangeRate: 1,
      shippingAmount: 0,
      lines: [{ productId: oud, location: 'store', quantity: 1, unitPrice: 1 }],
    },
  })
  check(
    denied === 403 &&
      deniedProduct === 403 &&
      shipment === 403 &&
      Number((await pricing(oud))?.purchase_price) === 20,
    `Ventas no puede guardar precio de compra ni porcentajes, ni registrar compras (HTTP ${denied}, ${deniedProduct} y ${shipment})`,
  )
  await seller.context.close()

  const appErrors = consoleErrors.filter(
    (text) => !text.startsWith('Failed to load resource'),
  )
  check(
    appErrors.length === 0,
    `sin errores del programa en la consola${appErrors.length ? `: ${appErrors.join(' | ')}` : ''}`,
  )
  console.log(
    `  (${consoleErrors.length - appErrors.length} respuestas 4xx esperadas en la consola)`,
  )
  if (unknown.size)
    console.log(`Peticiones sin simular: ${[...unknown].join(', ')}`)
} catch (error) {
  failures++
  console.error('✘ El recorrido se detuvo:', error)
  if (lastPage && !lastPage.isClosed()) {
    console.error(`  Pantalla: ${lastPage.url()}`)
    const failure = join(SHOTS || tmpdir(), 'flujo-fallido.png')
    mkdirSync(SHOTS || tmpdir(), { recursive: true })
    await lastPage.screenshot({ path: failure, fullPage: true }).catch(() => {})
    console.error(`  Captura: ${failure}`)
  }
} finally {
  await browser.close()
  await server.close()
  await db.close()
}
console.log(
  `${checks - failures} de ${checks} comprobaciones del recorrido de precios.`,
)
process.exitCode = failures ? 1 : 0

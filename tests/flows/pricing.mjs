// Precios desde el costo promedio y porcentaje de ganancia, de punta a punta:
// la pantalla real en un navegador real contra la base de datos real (PGlite
// con todas las migraciones), detrás de una API de Supabase simulada. Recorre
// el caso de Formulas.xlsx (13 u. a 15.675 + 20 u. a 16.675 → 16.281061 → C$
// 20.35 con 25 %), compras en dólares, porcentajes pendientes de costo, la
// carga desde archivo, el cambio de tasa, una entrada sin costo, el historial,
// el teclado, el teléfono y los permisos.
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

  // 2. Apartado del inventario: costo inicial de las 13 unidades de Oud.
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
  check(
    (await openingDialog.textContent()).includes('C$ 15.675'),
    'costo inicial: la vista previa enseña 13 u. contadas → C$ 15.675',
  )
  await openingDialog
    .getByRole('button', { name: 'Guardar costo inicial' })
    .click()
  await page.getByText('Costo inicial de «Oud Nocturno» registrado').waitFor()
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
    (await averageOf(oud)) === 15.675,
    'la base guardó el costo promedio C$ 15.675',
  )

  // 3. Porcentajes: validaciones y el ejemplo del cliente (25 % Emprendedor,
  // 20 % VIP, Premium a mano).
  await sections.getByRole('button', { name: 'Porcentajes y precios' }).click()
  await page
    .getByRole('button', { name: 'Editar precios de Oud Nocturno' })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Oud Nocturno' })
  const markup = (tier) =>
    dialog.getByLabel(`% de ganancia sobre el costo · ${tier}`)
  const save = dialog.getByRole('button', { name: 'Guardar precios' })
  check(
    (await dialog.locator('output').textContent()).replace(/\s+/g, ' ') ===
      'NIO 15.68' &&
      (await dialog.textContent()).includes('C$ 15.675 por unidad'),
    'la ficha rápida enseña el costo promedio como dato calculado (NIO 15.68, exacto C$ 15.675)',
  )
  check(
    (await dialog.locator('input').count()) === 3 &&
      (await dialog
        .locator('input')
        .evaluateAll((inputs) =>
          inputs.every((input) =>
            /% de ganancia/.test(input.labels?.[0]?.textContent ?? ''),
          ),
        )),
    'el costo no se puede escribir: sólo hay tres campos, uno por lista',
  )
  const cases = [
    ['VIP', '1000.5', 'Usa un porcentaje de hasta 1000.'],
    ['VIP', '-1', 'El porcentaje no puede ser negativo.'],
    ['VIP', '12.345', 'Usa hasta dos decimales.'],
  ]
  for (const [tier, value, message] of cases) {
    for (const each of ['Emprendedor', 'VIP', 'Premium'])
      await markup(each).fill('')
    await markup(tier).fill(value)
    await save.click()
    const shown = await fieldError(markup(tier))
    check(
      shown === message &&
        (await markup(tier).getAttribute('aria-invalid')) === 'true',
      `ficha rápida: % ${tier} ${value} → «${shown}»`,
    )
  }
  check((await pricing(oud)) === null, 'ningún valor inválido llegó a la base')
  await markup('Emprendedor').fill('25')
  await markup('VIP').fill('20')
  await markup('Premium').fill('')
  const emprendedor = dialog.getByRole('group', { name: 'Emprendedor' })
  await emprendedor.getByText('NIO 19.59').waitFor()
  check(
    (await dialog.locator('[aria-invalid="true"]').count()) === 0 &&
      (await dialog.getByRole('alert').count()) === 0,
    'al corregir los datos los avisos se quitan sin volver a pulsar Guardar',
  )
  check(
    (
      await dialog.getByRole('group', { name: 'Premium' }).textContent()
    ).includes('A mano'),
    'Premium sin porcentaje queda «A mano»',
  )
  await shot(page, '03-ficha-rapida')
  await save.click()
  await page.getByText('Precios de «Oud Nocturno» guardados.').waitFor()
  check(
    same(await prices(oud), {
      emprendedor: { NIO: 19.59, USD: 0.54 },
      vip: { NIO: 18.81, USD: 0.51 },
      premium: { USD: 33, NIO: 1207.8 },
    }),
    'la base guardó 19.59 / 18.81 desde el costo y Premium a mano',
  )

  // 4. Compra del Excel: 20 unidades a C$ 16.675. Promedio 16.281060… y
  // Emprendedor 25 % → C$ 20.35, calculados en la misma operación.
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
      outcome.includes('Emprendedor 25 %: NIO 19.59 → NIO 20.35') &&
      outcome.includes('VIP 20 %: NIO 18.81 → NIO 19.54'),
    `vista previa de la compra: 13 × 15.675 + 20 × 16.675 → 16.281061; Emprendedor 19.59 → 20.35${outcome.includes('NIO 20.35') ? '' : ` — se leyó «${outcome}»`}`,
  )
  await shot(page, '04-registrar-compra')
  await buy.getByRole('button', { name: 'Registrar compra' }).click()
  await page.getByText(/Compra registrada: 20 unidades/).waitFor()
  check(
    (await averageOf(oud)) === 16.281061 &&
      same(await prices(oud), {
        emprendedor: { NIO: 20.35, USD: 0.56 },
        vip: { NIO: 19.54, USD: 0.53 },
        premium: { USD: 33, NIO: 1207.8 },
      }),
    'la base: promedio 16.281061, Emprendedor C$ 20.35 y VIP C$ 19.54; Premium a mano sin cambios',
  )
  await sections.getByRole('button', { name: 'Porcentajes y precios' }).click()
  const oudRow = page
    .getByRole('button', { name: 'Oud Nocturno', exact: true })
    .locator('xpath=ancestor::tr')
  await oudRow.getByText('25 % · gana NIO 4.07').waitFor()
  check(
    (await oudRow.textContent()).replace(/\s+/g, ' ').includes('NIO 20.35'),
    'la lista vuelve a leer la base: Emprendedor NIO 20.35, «25 % · gana NIO 4.07»',
  )

  // 5. Porcentajes sin costo: quedan pendientes y no inventan precio.
  await page
    .getByRole('button', { name: 'Editar precios de Cedro Azul' })
    .click()
  const cedroDialog = page.getByRole('dialog', { name: 'Cedro Azul' })
  await cedroDialog.getByText('Sin costo todavía').waitFor()
  await cedroDialog
    .getByLabel('% de ganancia sobre el costo · Emprendedor')
    .fill('30')
  await cedroDialog
    .getByRole('group', { name: 'Emprendedor' })
    .getByText('Pendiente de costo')
    .waitFor()
  const cedroBefore = await prices(cedro)
  await cedroDialog.getByRole('button', { name: 'Guardar precios' }).click()
  await page.getByText('Precios de «Cedro Azul» guardados.').waitFor()
  check(
    same(await prices(cedro), cedroBefore) &&
      Number((await pricing(cedro))?.markup_emprendedor) === 30,
    'Cedro sin costo: el 30 % se guarda y el precio publicado no cambia',
  )
  const cedroRow = page
    .getByRole('button', { name: 'Cedro Azul', exact: true })
    .locator('xpath=ancestor::tr')
  await cedroRow.getByText('30 % · pendiente de costo').waitFor()
  check(true, 'la lista marca «30 % · pendiente de costo»')
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
  await cedroOpening.getByText('Emprendedor 30 %').waitFor()
  await cedroOpening
    .getByRole('button', { name: 'Guardar costo inicial' })
    .click()
  await page.getByText('Costo inicial de «Cedro Azul» registrado').waitFor()
  check(
    (await prices(cedro)).emprendedor.NIO === 130 &&
      (await prices(cedro)).vip.USD === cedroBefore.vip.USD,
    'al cargar su costo, Cedro Emprendedor pasa solo a C$ 130; VIP sigue a mano',
  )

  // 6. Ficha completa del perfume: Jazmín, sin existencias ni costo.
  await sections.getByRole('button', { name: 'Porcentajes y precios' }).click()
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
  await card.getByText('Sin costo todavía').waitFor()
  check(
    (await card.getByRole('link', { name: /Costo de inventario/ }).count()) ===
      1,
    'ficha del perfume: sin costo enseña el camino para registrarlo',
  )
  await card.getByLabel('% de ganancia sobre el costo · Emprendedor').fill('25')
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
    }) && Number((await pricing(jazmin))?.markup_emprendedor) === 25,
    'Jazmín: 25 % guardado y pendiente; su precio publicado se conserva',
  )

  // 7. Compra en dólares con envío: el primer costo de Jazmín y su precio.
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
  await buy.getByRole('button', { name: 'Registrar compra' }).click()
  await page.getByText(/Compra registrada: 3 unidades/).waitFor()
  check(
    (await averageOf(jazmin)) === 109.5 &&
      (await prices(jazmin)).emprendedor.NIO === 136.88 &&
      (await prices(jazmin)).emprendedor.USD === 3.74,
    'compra en US$: (2 + 1 de envío) × 36.5 = C$ 109.5; Emprendedor 25 % → C$ 136.88 (US$ 3.74)',
  )

  // 8. Carga desde CSV: sólo porcentajes; el costo del archivo se ignora.
  await sections.getByRole('button', { name: 'Porcentajes y precios' }).click()
  const csv = join(tmpdir(), `porcentajes-${Date.now()}.csv`)
  writeFileSync(
    csv,
    [
      'Código;Marca;Perfume;Costo promedio C$ (informativo, no se importa);Precio de compra;% Emprendedor;% VIP;% Premium',
      'LCP-0003;Estudio Nácar;Cedro Azul;100;999;40;35;',
      ';Estudio Nácar;Vainilla Suave;;;"10,5%";10%;10%',
      'LCP-9999;;;;;1;1;1',
      'LCP-0005;;;;;diez;;',
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
    preview.includes('2 filas no se pueden usar') &&
      preview.includes('No hay ningún perfume con el código «LCP-9999»') &&
      preview.includes('El porcentaje de Emprendedor «diez» no es un número'),
    'CSV en Windows-1252 con ; y coma decimal: 2 cambios y 2 filas explicadas',
  )
  check(
    preview.includes(
      '«Costo promedio C$ (informativo, no se importa)», «Precio de compra» no se importan',
    ) && preview.includes('Un perfume todavía no tiene costo promedio'),
    'la vista previa dice que las columnas de costo no se importan y que Vainilla queda pendiente',
  )
  await shot(page, '06-carga-vista-previa')
  // Otra persona cambia Cedro Azul mientras se revisa el archivo.
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
    (await prices(cedro)).emprendedor.NIO === 140 &&
      (await prices(cedro)).vip.NIO === 135 &&
      Number(cedroSaved?.markup_premium ?? -1) === -1 &&
      (await averageOf(cedro)) === 100,
    'Cedro: 40 % y 35 % sobre C$ 100 → C$ 140 y C$ 135; el «999» del archivo no tocó el costo',
  )
  check(
    Number((await pricing(vainilla))?.markup_emprendedor) === 10.5 &&
      same(await prices(vainilla), {
        emprendedor: { USD: 25, NIO: 915 },
        vip: { USD: 24, NIO: 878.4 },
        premium: { USD: 23, NIO: 841.8 },
      }),
    'Vainilla sin costo: 10.5 % guardado y sus precios a mano sin cambios',
  )
  check(
    (await pricing(citrico)) === null,
    'la fila con «diez» no tocó Cítrico Vivo',
  )

  // 9. La plantilla trae lo guardado, con el costo como dato informativo.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Descargar plantilla' }).click(),
  ])
  check(
    /^porcentajes-de-ganancia-\d{4}-\d{2}-\d{2}\.xlsx$/.test(
      download.suggestedFilename(),
    ),
    `la plantilla se descarga como ${download.suggestedFilename()}`,
  )

  // 10. Cambio de tasa: el costo y el córdoba quedan; se mueve el dólar.
  await asUser(owner.id, () => db.query('select public.set_exchange_rate(37)'))
  check(
    (await prices(oud)).emprendedor.NIO === 20.35 &&
      (await prices(oud)).emprendedor.USD === 0.55 &&
      (await averageOf(oud)) === 16.281061 &&
      Number((await pricing(oud)).markup_emprendedor) === 25,
    'con la tasa en 37: Oud sigue en C$ 20.35 (US$ 0.55), con el mismo costo y porcentaje',
  )

  // 11. Una entrada manual de un perfume con costo se rechaza y lo explica.
  await go(page, `/products/${oud}/edit`)
  await page.getByRole('heading', { name: 'Cantidades del perfume' }).waitFor()
  const stock = page.locator('.product-stock-editor')
  await stock.getByLabel('Cómo cambiar las cantidades').selectOption('ENTRY')
  await stock.getByText('se registra como compra').waitFor()
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

  // 12. Historial: cambios automáticos distinguidos de los manuales.
  await page.getByRole('heading', { name: 'Historial de precios' }).waitFor()
  await page.locator('.price-history-record').first().waitFor()
  const history = (await page.locator('.price-history').textContent()).replace(
    /\s+/g,
    ' ',
  )
  check(
    history.includes('Automático') &&
      history.includes('Compra FAC-778 · registrada por Dueña') &&
      history.includes('25 % sobre el costo promedio de NIO 16.28') &&
      history.includes('Dueña'),
    `el historial marca la compra FAC-778 como automática y el 25 % sobre el costo${history.includes('Compra FAC-778') ? '' : ` — se leyó «${history.slice(0, 700)}»`}`,
  )
  await shot(page, '07-historial')

  // 13. Sólo con teclado en la ficha rápida.
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
  let reached = false
  for (let presses = 0; presses < 6 && !reached; presses++) {
    await page.keyboard.press('Tab')
    reached =
      (await focusedName()) === '% de ganancia sobre el costo · Emprendedor'
  }
  await page.keyboard.type('10')
  await page.keyboard.press('Enter')
  await keyboardDialog.waitFor({ state: 'detached' })
  check(
    reached &&
      Number((await pricing(citrico))?.markup_emprendedor) === 10 &&
      (await focused('Editar precios de Cítrico Vivo')),
    'con el teclado: Tab llega al porcentaje, Enter guarda y el foco vuelve a la fila',
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

  // 15. Ventas no ve costos ni porcentajes, ni por la pantalla ni por la API.
  const seller = await open()
  await login(seller.page, sales)
  check(
    (await seller.page.getByRole('link', { name: 'Precios' }).count()) === 0,
    'Ventas no tiene «Precios» en el menú',
  )
  await go(seller.page, '/prices?apartado=costo')
  await seller.page.getByText('No tienes permiso para esta pantalla.').waitFor()
  check(true, 'Ventas que abre /prices lee «No tienes permiso»')
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
    'porcentajes y costos responden vacíos a Ventas (RLS)',
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
  const denied = await call('save_product_pricing', {
    p_rows: [
      {
        productId: oud,
        revision: 99,
        pricing: { markups: { emprendedor: 1, vip: 1, premium: 1 } },
      },
    ],
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
    denied === 403 && shipment === 403,
    `Ventas no puede guardar porcentajes ni registrar compras (HTTP ${denied} y ${shipment})`,
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

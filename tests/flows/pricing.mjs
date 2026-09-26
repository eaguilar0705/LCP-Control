// Precio de compra y porcentaje de ganancia, de punta a punta: la pantalla real
// en un navegador real contra la base de datos real (PGlite con todas las
// migraciones), detrás de una API de Supabase simulada.
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
    await page
      .getByRole('button', { name: /Sin precio de compra\s*5/ })
      .isVisible(),
    'los 5 perfumes empiezan sin precio de compra',
  )
  await shot(page, '01-precios-vacio')

  // 2. Validaciones de la ficha rápida.
  await page
    .getByRole('button', { name: 'Editar precios de Oud Nocturno' })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Oud Nocturno' })
  const purchase = dialog.getByLabel('Precio de compra', { exact: true })
  const markup = (tier) => dialog.getByLabel(`% de ganancia ${tier}`)
  const save = dialog.getByRole('button', { name: 'Guardar precios' })
  const cases = [
    ['0', null, 'El precio de compra debe ser mayor que cero.'],
    ['-5', null, 'El precio de compra debe ser mayor que cero.'],
    ['12.345', null, 'Usa hasta dos decimales.'],
    ['10000001', null, 'El precio de compra es demasiado alto.'],
    ['500', ['VIP', '1000.5'], 'Usa un porcentaje de hasta 1000.'],
    ['500', ['VIP', '-1'], 'El porcentaje no puede ser negativo.'],
    ['500', ['VIP', '12.345'], 'Usa hasta dos decimales.'],
  ]
  for (const [price, percent, message] of cases) {
    await purchase.fill(price)
    for (const tier of ['Emprendedor', 'VIP', 'Premium'])
      await markup(tier).fill('')
    if (percent) await markup(percent[0]).fill(percent[1])
    await save.click()
    const target = percent ? markup(percent[0]) : purchase
    const shown = await fieldError(target)
    check(
      shown === message &&
        (await target.getAttribute('aria-invalid')) === 'true',
      `ficha rápida: ${percent ? `% ${percent[0]} ${percent[1]}` : `compra ${price}`} → «${shown}»`,
    )
  }
  check((await pricing(oud)) === null, 'ningún valor inválido llegó a la base')

  // El ejemplo del dueño: C$ 500 con 20 %, 15 % y 10 %.
  await purchase.fill('500')
  await dialog.getByLabel('Moneda de compra').selectOption('NIO')
  await markup('Emprendedor').fill('20')
  await markup('VIP').fill('15')
  await markup('Premium').fill('10')
  const emprendedor = dialog.getByRole('group', { name: 'Emprendedor' })
  await emprendedor.getByText('NIO 600.00').waitFor()
  // Corregido el dato, el aviso se va sin tener que volver a guardar.
  check(
    (await dialog.locator('[aria-invalid="true"]').count()) === 0 &&
      (await dialog.getByRole('alert').count()) === 0,
    'al corregir los datos los avisos se quitan sin volver a pulsar Guardar',
  )
  const breakdown = (await emprendedor.textContent()).replace(/\s+/g, ' ')
  const expected = [
    'NIO 500.00',
    'NIO 100.00',
    '20 % de la compra',
    'NIO 600.00',
    'USD 16.39',
  ]
  check(
    expected.every((text) => breakdown.includes(text)),
    `desglose: compra C$ 500, 20 %, ganancia C$ 100, venta C$ 600 (US$ 16.39)${expected.every((text) => breakdown.includes(text)) ? '' : ` — se leyó «${breakdown}»`}`,
  )
  await shot(page, '02-ficha-rapida')
  await save.click()
  await page.getByText('Precios de «Oud Nocturno» guardados.').waitFor()
  check(
    same(await prices(oud), {
      emprendedor: { NIO: 600, USD: 16.39 },
      vip: { NIO: 575, USD: 15.71 },
      premium: { NIO: 550, USD: 15.03 },
    }),
    'la base guardó 600 / 575 / 550 córdobas y su equivalente en dólares',
  )
  const oudRow = page
    .getByRole('button', { name: 'Oud Nocturno', exact: true })
    .locator('xpath=ancestor::tr')
  await oudRow.getByText('20 % · gana NIO 100.00').waitFor()
  const rowText = (await oudRow.textContent()).replace(/\s+/g, ' ')
  check(
    rowText.includes('NIO 600.00'),
    `la lista vuelve a leer la base: Emprendedor NIO 600.00, «20 % · gana NIO 100.00»${rowText.includes('NIO 600.00') ? '' : ` — se leyó «${rowText}»`}`,
  )

  // 3. Ficha completa del perfume: compra en dólares, VIP a mano. Se llega
  // desde la ficha rápida, con «Editar perfume».
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
  // La ficha rápida también tiene «Precio de compra»: se espera a la ficha del
  // perfume y se trabaja dentro de su tarjeta de precios.
  await page.getByRole('heading', { name: 'Editar perfume' }).waitFor()
  const card = page.locator('#precios')
  const editorPurchase = card.getByLabel('Precio de compra', { exact: true })
  await editorPurchase.waitFor()
  await editorPurchase.fill('-1')
  await page.getByRole('button', { name: 'Guardar perfume' }).click()

  check(
    (await fieldError(editorPurchase)) ===
      'El precio de compra debe ser mayor que cero.',
    'ficha del perfume: una compra negativa se marca en su campo',
  )
  await editorPurchase.fill('20')
  await card.getByLabel('Moneda de compra').selectOption('USD')
  await card.getByLabel('% de ganancia Emprendedor').fill('25')
  await card.getByLabel('% de ganancia Premium').fill('10')
  const vipUsd = card.getByLabel('VIP USD', { exact: true })
  await vipUsd.fill('')
  await page.getByRole('button', { name: 'Guardar perfume' }).click()
  check(
    (await fieldError(vipUsd)) === 'Escribe el precio.' ||
      (await vipUsd.getAttribute('aria-invalid')) === 'true',
    'ficha del perfume: la lista a mano sin precio no se deja guardar',
  )
  await vipUsd.fill('31.5')
  await shot(page, '03-ficha-perfume')
  await page.getByRole('button', { name: 'Guardar perfume' }).click()
  await page.waitForURL(`${BASE}/prices`)
  check(
    same(await prices(jazmin), {
      emprendedor: { USD: 25, NIO: 915 },
      vip: { USD: 31.5, NIO: 1152.9 },
      premium: { USD: 22, NIO: 805.2 },
    }),
    'la base guardó Emprendedor y Premium calculados en dólares y VIP a mano',
  )
  const saved = await pricing(jazmin)
  check(
    Number(saved?.purchase_price) === 20 &&
      saved?.purchase_currency === 'USD' &&
      saved?.markup_vip === null,
    'el precio de compra y los porcentajes quedaron en product_pricing',
  )

  // 4. Carga desde CSV: vista previa, errores y guardado todo junto.
  const csv = join(tmpdir(), `precios-${Date.now()}.csv`)
  writeFileSync(
    csv,
    [
      'Código;Marca;Perfume;Precio de compra;Moneda;% Emprendedor;% VIP;% Premium',
      'LCP-0003;Estudio Nácar;Cedro Azul;700;C$;30;25;20',
      ';Estudio Nácar;Vainilla Suave;"1.250,50";córdobas;10%;10%;10%',
      'LCP-9999;;;10;C$;1;1;1',
      'LCP-0005;;;diez;C$;;;',
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
  const preview = await upload.textContent()
  check(
    preview.includes('2 filas no se pueden usar') &&
      preview.includes('No hay ningún perfume con el código «LCP-9999»') &&
      preview.includes('El precio de compra «diez» no es un número'),
    'CSV en Windows-1252 con ; y coma decimal: 2 cambios y 2 filas explicadas',
  )
  await shot(page, '04-carga-vista-previa')

  // Otra persona cambia Cedro Azul mientras se revisa el archivo.
  await asUser(owner.id, () =>
    db.query('select public.save_product_pricing($1::jsonb)', [
      JSON.stringify([
        {
          productId: cedro,
          revision: 1,
          pricing: {
            purchasePrice: 1,
            purchaseCurrency: 'USD',
            markups: { emprendedor: 1, vip: 1, premium: 1 },
          },
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
    Number((await pricing(vainilla))?.purchase_price ?? 0) === 0,
    'un cambio simultáneo detiene la carga completa: nada a medias',
  )
  await upload.getByRole('button', { name: 'Cancelar' }).click()
  // Volver a abrir la pantalla lee otra vez los perfumes con su revisión.
  await page.getByRole('link', { name: 'Inventario' }).first().click()
  await page.getByRole('link', { name: 'Precios' }).first().click()
  await page.getByRole('button', { name: 'Cargar archivo' }).click()
  await upload.getByLabel('Archivo con los precios').setInputFiles(csv)
  await summary.filter({ hasText: '2 perfumes cambian' }).waitFor()
  await upload.getByRole('button', { name: 'Guardar 2 perfumes' }).click()
  await page.getByText('Precios cargados: 2 perfumes actualizados.').waitFor()
  check(
    (await prices(cedro)).emprendedor.NIO === 910 &&
      (await prices(vainilla)).premium.NIO === 1375.55,
    'al volver a cargarlo: Cedro Azul C$ 700 + 30 % = C$ 910; Vainilla C$ 1,250.50 + 10 % = C$ 1,375.55',
  )
  check(
    (await pricing(citrico)) === null &&
      same(await prices(citrico), {
        emprendedor: { USD: 28, NIO: 1024.8 },
        vip: { USD: 27, NIO: 988.2 },
        premium: { USD: 26, NIO: 951.6 },
      }),
    'la fila con «diez» no tocó Cítrico Vivo: sin precio de compra y con sus precios a mano',
  )

  // 5. La plantilla trae lo guardado.
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

  // 6. Cambio de tasa: la compra en córdobas conserva el córdoba.
  await asUser(owner.id, () => db.query('select public.set_exchange_rate(37)'))
  check(
    (await prices(oud)).emprendedor.NIO === 600 &&
      (await prices(oud)).emprendedor.USD === 16.22 &&
      (await prices(jazmin)).emprendedor.NIO === 925,
    'con la tasa en 37: Oud sigue en C$ 600 (US$ 16.22) y Jazmín pasa a C$ 925',
  )

  // 7. Sólo con teclado. El foco vuelve al botón que abrió la ficha: si se
  // quedara en <body>, habría que recorrer otra vez la pantalla desde arriba.
  const focused = async (name) => {
    for (let waited = 0; waited < 3000; waited += 100) {
      const label = await page.evaluate(
        () => document.activeElement?.getAttribute('aria-label') ?? '',
      )
      if (label === name) return true
      await page.waitForTimeout(100)
    }
    return false
  }
  const citricoButton = page.getByRole('button', {
    name: 'Editar precios de Cítrico Vivo',
  })
  const keyboardDialog = page.getByRole('dialog', { name: 'Cítrico Vivo' })
  await citricoButton.focus()
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
  await page.keyboard.press('Tab') // Precio de compra
  await page.keyboard.type('100')
  await page.keyboard.press('Tab') // Moneda de compra
  await page.keyboard.press('Tab') // % de ganancia Emprendedor
  await page.keyboard.type('10')
  await page.keyboard.press('Enter')
  await keyboardDialog.waitFor({ state: 'detached' })
  const typed = await pricing(citrico)
  check(
    Number(typed?.purchase_price) === 100 &&
      Number(typed?.markup_emprendedor) === 10 &&
      (await focused('Editar precios de Cítrico Vivo')),
    'con el teclado: Tab recorre la ficha, Enter guarda y el foco vuelve a la fila',
  )

  // 8. Historial con porcentaje y precio de compra.
  await page
    .getByRole('button', { name: 'Editar precios de Oud Nocturno' })
    .click()
  await page
    .getByRole('dialog', { name: 'Oud Nocturno' })
    .getByRole('link', { name: 'Editar perfume' })
    .click()
  await page.getByRole('heading', { name: 'Historial de precios' }).waitFor()
  await page.locator('.price-history-record').first().waitFor()
  const history = (await page.locator('.price-history').textContent()).replace(
    /\s+/g,
    ' ',
  )
  check(
    history.includes('20 % sobre la compra de NIO 500.00'),
    `el historial dice «20 % sobre la compra de NIO 500.00»${history.includes('20 % sobre la compra de NIO 500.00') ? '' : ` — se leyó «${history.slice(0, 600)}»`}`,
  )
  await context.close()

  // 9. Teléfono.
  const phone = await open({ width: 390, height: 844 })
  await login(phone.page, owner)
  await go(phone.page, '/prices')
  await phone.page
    .getByRole('button', { name: 'Editar precios de Oud Nocturno' })
    .waitFor()
  await noOverflow(phone.page, 'Precios en el teléfono')
  await shot(phone.page, '05-precios-telefono')
  await phone.page
    .getByRole('button', { name: 'Editar precios de Oud Nocturno' })
    .click()
  await noOverflow(phone.page, 'ficha rápida en el teléfono')
  await shot(phone.page, '06-ficha-telefono')
  await phone.context.close()

  // 10. Ventas no ve precios de compra, ni por la pantalla ni por la API.
  const seller = await open()
  await login(seller.page, sales)
  check(
    (await seller.page.getByRole('link', { name: 'Precios' }).count()) === 0,
    'Ventas no tiene «Precios» en el menú',
  )
  await go(seller.page, '/prices')
  await seller.page.getByText('No tienes permiso para esta pantalla.').waitFor()
  check(true, 'Ventas que abre /prices lee «No tienes permiso»')
  const direct = await seller.page.evaluate(
    async ([url, key, token]) => {
      const response = await fetch(`${url}/rest/v1/product_pricing?select=*`, {
        headers: { apikey: key, authorization: `Bearer ${token}` },
      })
      return response.json()
    },
    [SUPABASE, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, tokenFor(sales)],
  )
  check(
    Array.isArray(direct) && direct.length === 0,
    'la tabla de precios de compra responde vacía a Ventas (RLS)',
  )
  const denied = await seller.page.evaluate(
    async ([url, key, token, id]) => {
      const response = await fetch(`${url}/rest/v1/rpc/save_product_pricing`, {
        method: 'POST',
        headers: {
          apikey: key,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          p_rows: [
            {
              productId: id,
              revision: 99,
              pricing: {
                purchasePrice: 1,
                purchaseCurrency: 'NIO',
                markups: { emprendedor: 1, vip: 1, premium: 1 },
              },
            },
          ],
        }),
      })
      return response.status
    },
    [SUPABASE, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, tokenFor(sales), oud],
  )
  check(
    denied === 403,
    `Ventas no puede guardar precios de compra (HTTP ${denied})`,
  )
  await seller.context.close()

  // Las respuestas 4xx buscadas (conflicto, Ventas sin permiso) las anota el
  // navegador como «Failed to load resource»; no son errores del programa.
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

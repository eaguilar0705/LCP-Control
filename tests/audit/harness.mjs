// Banco de pruebas de la auditoría: PostgreSQL desechable (PGlite) con todas
// las migraciones del repositorio y una API de Supabase simulada que convierte
// las peticiones del navegador en consultas con la identidad de quien inició
// sesión. RLS, permisos, validaciones y funciones son los de las migraciones.
// Nada sale a la red ni toca la base real.
import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'

export const USERS = {
  owner: {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'duena@example.com',
    password: 'Clave-de-prueba-2026',
    role: 'superadmin',
    name: 'Dueña de prueba',
  },
  admin: {
    id: '44444444-4444-4444-8444-444444444444',
    email: 'admin@example.com',
    password: 'Clave-de-admin-2026',
    role: 'admin',
    name: 'Administración de prueba',
  },
  sales: {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'ventas@example.com',
    password: 'Clave-de-ventas-2026',
    role: 'operator',
    name: 'Ventas de prueba',
  },
  warehouse: {
    id: '33333333-3333-4333-8333-333333333333',
    email: 'bodega@example.com',
    password: 'Clave-de-bodega-2026',
    role: 'warehouse',
    name: 'Bodega de prueba',
  },
}

const BOOTSTRAP = `create role anon; create role authenticated;
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
  create table auth.sessions(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id) on delete cascade);`

/** PostgREST conserva DATE como yyyy-mm-dd; PGlite lo entrega como Date UTC. */
export function postgrestRows(result) {
  const dates = result.fields.filter((field) => field.dataTypeID === 1082)
  return result.rows.map((row) => {
    const normalized = { ...row }
    for (const { name } of dates)
      if (normalized[name] instanceof Date)
        normalized[name] = normalized[name].toISOString().slice(0, 10)
    return normalized
  })
}

export async function createDatabase({ users = Object.values(USERS) } = {}) {
  let db = new PGlite()
  let busy = Promise.resolve()
  /** PGlite atiende una consulta a la vez: todo pasa por esta fila. */
  const serial = (task) => {
    const run = busy.then(task, task)
    busy = run.catch(() => {})
    return run
  }
  /** Ejecuta como la persona de la sesión (o anónimo), igual que PostgREST. */
  const asUser = (sub, task) =>
    serial(async () => {
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
  const asOwner = (sql, params = []) =>
    serial(async () => {
      await db.exec('reset role')
      return (await db.query(sql, params)).rows
    })
  const rpc = (sub, name, args = {}) =>
    callFunction(() => db, asUser, asOwner, sub, name, args)

  await db.exec(BOOTSTRAP)
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
    "insert into public.business_settings(name,address,phone) values('Negocio de prueba','Managua','5555-0100') on conflict do nothing",
  )
  let saved = null
  const base = {
    get db() {
      return db
    },
    serial,
    asUser,
    asOwner,
    rpc,
    users,
    /** Guarda el estado actual para volver a él con `restore()`. */
    save: () =>
      serial(async () => {
        saved = await db.dumpDataDir('none')
      }),
    /** Vuelve al estado guardado: una base nueva desde la copia. */
    restore: () =>
      serial(async () => {
        const old = db
        db = new PGlite({ loadDataDir: saved })
        await db.waitReady
        await old.close().catch(() => {})
      }),
  }
  return base
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
const identifier = /^[a-z_][a-z0-9_]*$/
const operators = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }

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
          const [column, direction = 'asc', nulls] = part.split('.')
          if (!identifier.test(column)) throw new Error(`orden ${part}`)
          return `${alias}.${column} ${direction === 'desc' ? 'desc' : 'asc'}${nulls === 'nullslast' ? ' nulls last' : nulls === 'nullsfirst' ? ' nulls first' : ''}`
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
    if (key === 'or') {
      // or=(a.ilike.*x*,b.ilike.*x*)
      const parts = raw.replace(/^\(|\)$/g, '').split(',')
      const ors = []
      for (const part of parts) {
        const [column, op, ...rest] = part.split('.')
        if (!identifier.test(column)) throw new Error(`or ${part}`)
        const value = rest.join('.').replace(/\*/g, '%')
        if (op === 'ilike' || op === 'like') {
          params.push(value)
          ors.push(`${alias}.${column}::text ${op} $${params.length}`)
        } else if (op in operators) {
          params.push(value)
          ors.push(`${alias}.${column} ${operators[op]} $${params.length}`)
        } else throw new Error(`or ${part}`)
      }
      where.push(`(${ors.join(' or ')})`)
      continue
    }
    if (!identifier.test(key)) throw new Error(`filtro ${key}`)
    const [op, ...rest] = raw.split('.')
    const value = rest.join('.')
    if (op in operators) {
      params.push(value)
      where.push(`${alias}.${key} ${operators[op]} $${params.length}`)
    } else if (op === 'is' && value === 'null')
      where.push(`${alias}.${key} is null`)
    else if (op === 'not' && value === 'is.null')
      where.push(`${alias}.${key} is not null`)
    else if (op === 'is' && (value === 'true' || value === 'false'))
      where.push(`${alias}.${key} is ${value}`)
    else if (op === 'ilike' || op === 'like') {
      params.push(value.replace(/\*/g, '%'))
      where.push(`${alias}.${key}::text ${op} $${params.length}`)
    } else if (op === 'in') {
      params.push(
        value
          .replace(/^\(|\)$/g, '')
          .split(',')
          .map((item) => item.replace(/^"|"$/g, '')),
      )
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

async function selection(asOwner, unknown, table, select, alias = 't') {
  const columns = []
  for (const raw of splitSelect(select)) {
    // «alias:columna» o «alias:tabla(…)» o «tabla!inner(…)»
    let part = raw.replace(/!inner|!left/g, '')
    let label = null
    const renamed = /^([a-z_][a-z0-9_]*):(.*)$/.exec(part)
    if (renamed) [, label, part] = renamed
    if (part === '*' || identifier.test(part)) {
      columns.push(
        part === '*'
          ? `${alias}.*`
          : `${alias}.${part}${label ? ` as ${label}` : ''}`,
      )
      continue
    }
    // «alias:columna->clave» o «->>clave»: un valor dentro de un JSON.
    const path = /^([a-z_][a-z0-9_]*)(->>?)([A-Za-z0-9_]+)$/.exec(part)
    if (path) {
      columns.push(
        `${alias}.${path[1]}${path[2]}'${path[3]}' as ${label ?? path[3]}`,
      )
      continue
    }
    const nested = /^([a-z_][a-z0-9_]*)\((.*)\)$/.exec(part)
    if (!nested) {
      unknown.add(`${table}: ${raw}`)
      continue
    }
    const [child, inner] = [nested[1], nested[2]]
    const inside = `x_${child}`
    const fields = await selection(asOwner, unknown, child, inner, inside)
    const object = `(select to_jsonb(r) from (select ${fields}) r)`
    const name = label ?? child
    const [many] = await asOwner(foreignKey, [
      `public.${child}`,
      `public.${table}`,
    ])
    if (many) {
      columns.push(
        `coalesce((select json_agg(${object}) from public.${child} ${inside} where ${inside}.${many.child_column}=${alias}.${many.parent_column}),'[]') as ${name}`,
      )
      continue
    }
    const [one] = await asOwner(foreignKey, [
      `public.${table}`,
      `public.${child}`,
    ])
    if (one) {
      columns.push(
        `(select ${object} from public.${child} ${inside} where ${inside}.${one.parent_column}=${alias}.${one.child_column}) as ${name}`,
      )
      continue
    }
    unknown.add(`${table}: ${raw}`)
  }
  return columns.join(',') || `${alias}.*`
}

async function callFunction(getDb, asUser, asOwner, sub, name, args) {
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
    const db = getDb()
    if (info.set)
      return postgrestRows(
        await db.query(`select * from public.${name}(${call})`, values),
      )
    return postgrestRows(
      await db.query(`select public.${name}(${call}) as result`, values),
    )[0].result
  })
}

/**
 * Manejador de rutas de Playwright que imita a Supabase (Auth, PostgREST y
 * Storage) sobre la base desechable. `unknown` reúne lo que no sabe contestar
 * para que la auditoría lo informe en vez de ocultarlo.
 */
export function fakeSupabase(base) {
  const { asUser, asOwner, users } = base
  const unknown = new Set()
  const failures = []
  const subject = (request) => {
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
          (item) =>
            item.email === body.email && item.password === body.password,
        )
        if (!user)
          return json(
            {
              code: 'invalid_credentials',
              message: 'Invalid login credentials',
            },
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
        if (!user) return json({ message: 'sin sesión' }, 401)
        if (request.method() === 'PUT') {
          const body = request.postDataJSON() ?? {}
          if (body.password && body.password.length < 12)
            return json(
              {
                code: 'weak_password',
                message: 'Password should be at least 12 characters.',
              },
              422,
            )
          if (body.password) user.password = body.password
          return json(authUser(user))
        }
        return json(authUser(user))
      }
      if (url.pathname === '/auth/v1/logout')
        return route.fulfill({ status: 204, headers: CORS })
      if (
        url.pathname === '/auth/v1/recover' ||
        url.pathname === '/auth/v1/otp'
      )
        return json({})
      if (url.pathname.startsWith('/storage/v1/')) {
        if (url.pathname.includes('/object/sign/'))
          return json({
            signedURL: '/object/sign/product-images/x.webp?token=t',
          })
        return json([])
      }
      if (url.pathname.startsWith('/rest/v1/rpc/'))
        return json(
          await callFunction(
            () => base.db,
            asUser,
            asOwner,
            subject(request),
            url.pathname.slice('/rest/v1/rpc/'.length),
            request.postDataJSON(),
          ),
        )
      if (url.pathname.startsWith('/rest/v1/') && request.method() === 'GET') {
        const table = url.pathname.slice('/rest/v1/'.length)
        if (!identifier.test(table)) throw new Error(`tabla ${table}`)
        const columns = await selection(
          asOwner,
          unknown,
          table,
          url.searchParams.get('select') ?? '*',
        )
        const query = readQuery(url, 't')
        const prefer = request.headers()['prefer'] ?? ''
        const { rows, total } = await asUser(subject(request), async () => {
          const db = base.db
          const rows = postgrestRows(
            await db.query(
              `select ${columns} from public.${table} t ${query.where} ${query.order} ${query.page}`,
              query.params,
            ),
          )
          let total = rows.length
          if (prefer.includes('count=exact'))
            total = (
              await db.query(
                `select count(*)::int as n from public.${table} t ${query.where}`,
                query.params,
              )
            ).rows[0].n
          return { rows, total }
        })
        const start = Number(url.searchParams.get('offset') ?? 0)
        const accept = request.headers()['accept'] ?? ''
        if (accept.includes('vnd.pgrst.object')) {
          if (rows.length !== 1)
            return json(
              {
                code: 'PGRST116',
                message:
                  'JSON object requested, multiple (or no) rows returned',
              },
              406,
            )
          return json(rows[0])
        }
        return json(rows, 200, {
          'content-range': `${start}-${start + Math.max(rows.length - 1, 0)}/${total}`,
        })
      }
      unknown.add(`${request.method()} ${url.pathname}`)
      return json([])
    } catch (error) {
      const code = error.code ?? 'XX000'
      if (
        ![
          'P0001',
          '42501',
          'PGRST202',
          '23514',
          '23505',
          '22023',
          '22P02',
        ].includes(code)
      )
        failures.push(`${url.pathname}: ${code} ${error.message}`)
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
  return { answer, unknown, failures }
}

/** Huella de todas las tablas de datos: filas y contenido, para comparar antes y después. */
export async function fingerprint(asOwner, { exclude = [] } = {}) {
  const tables = await asOwner(
    `select n.nspname||'.'||c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where c.relkind='r' and n.nspname in ('public','private') order by 1`,
  )
  const result = {}
  for (const { name } of tables) {
    if (exclude.includes(name)) continue
    const [row] = await asOwner(
      `select count(*)::int as rows, coalesce(md5(string_agg(t::text, '|' order by t::text)),'') as hash from ${name} t`,
    )
    result[name] = row
  }
  return result
}

/**
 * Un negocio pequeño pero completo: perfumes con y sin conteo, con y sin
 * costo, porcentajes, clientes, proveedores, facturas, una proforma, una
 * compra y un gasto. Todo entra por las funciones del programa.
 */
export async function seedBusiness(base) {
  const { rpc } = base
  const { owner, sales } = USERS
  await rpc(owner.id, 'set_exchange_rate', { p_rate: 36.62 })
  const names = [
    ['Casa Ámbar', 'Oud Nocturno', 35],
    ['Casa Ámbar', 'Jazmín Blanco', 30],
    ['Estudio Nácar', 'Cedro Azul', 40],
    ['Estudio Nácar', 'Vainilla Suave', 25],
    ['Taller Índigo', 'Cítrico Vivo', 28],
    ['Taller Índigo', 'Rosa de Medianoche', 45],
    ['Casa Ámbar', 'Ámbar Real', 60],
    ['Estudio Nácar', 'Brisa Marina', 22],
  ]
  const products = []
  for (const [index, [brand, name, usd]] of names.entries()) {
    const id = `aaaaaaaa-0000-4000-8000-00000000000${index + 1}`
    products.push(id)
    await rpc(owner.id, 'save_catalog_product', {
      p_payload: {
        id,
        revision: 0,
        name,
        brand,
        size: 100,
        unit: 'ml',
        category: index % 3 ? 'designer' : 'arabian',
        gender: ['unisex', 'female', 'male'][index % 3],
        manufacturerBarcode: index === 0 ? '6291106063137' : '',
        minimumStock: 3,
        active: true,
        imagePath: null,
        prices: {
          emprendedor: { USD: usd, NIO: 0 },
          vip: { USD: usd - 2, NIO: 0 },
          premium: { USD: usd - 4, NIO: 0 },
        },
      },
    })
    // El último queda sin contar, como la mayoría del catálogo real.
    if (index < names.length - 1)
      for (const location of ['store', 'warehouse'])
        await rpc(owner.id, 'record_inventory_movement', {
          p_payload: {
            requestId: crypto.randomUUID(),
            productId: id,
            location,
            type: 'ADJUSTMENT',
            quantity: location === 'store' ? 8 + index : index % 2 ? 0 : 5,
            note: 'Conteo inicial',
          },
        })
  }
  for (const [index, id] of products.slice(0, 3).entries())
    await rpc(owner.id, 'set_opening_cost', {
      p_input: {
        requestId: crypto.randomUUID(),
        productId: id,
        unitCost: 700 + index * 100,
        currency: 'NIO',
        exchangeRate: 1,
        note: 'Factura de compra original',
      },
    })
  const revision = async (id) =>
    (
      await base.asOwner('select revision from public.products where id=$1', [
        id,
      ])
    )[0].revision
  await rpc(owner.id, 'save_product_pricing', {
    p_rows: [
      {
        productId: products[0],
        revision: await revision(products[0]),
        pricing: { markups: { emprendedor: 45, vip: 35, premium: 25 } },
      },
    ],
  })
  await rpc(owner.id, 'record_shipment', {
    p_input: {
      requestId: crypto.randomUUID(),
      incurredOn: '2026-09-10',
      supplier: 'Distribuidora Norte',
      agency: 'Agencia Rápida',
      reference: 'PED-100',
      note: '',
      currency: 'USD',
      exchangeRate: 36.62,
      shippingAmount: 12,
      lines: [
        {
          productId: products[1],
          location: 'warehouse',
          quantity: 4,
          unitPrice: 18,
        },
      ],
    },
  })
  const customers = []
  for (const [index, [name, phone, tier]] of [
    ['Ana López', '88881111', 'emprendedor'],
    ['Boutique Estrella', '88882222', 'vip'],
    ['Carlos Ruiz', '', 'premium'],
  ].entries()) {
    const id = `cccccccc-0000-4000-8000-00000000000${index + 1}`
    customers.push(id)
    await rpc(owner.id, 'save_customer', {
      p_payload: {
        id,
        revision: 0,
        name,
        phone,
        priceTier: tier,
        email: '',
        taxId: '',
        address: 'Managua',
        notes: '',
        active: true,
      },
    })
  }
  await rpc(owner.id, 'save_supplier', {
    p_payload: {
      id: 'dddddddd-0000-4000-8000-000000000001',
      revision: 0,
      name: 'Distribuidora Norte',
      contact: 'María',
      phone: '22220000',
      email: 'ventas@norte.example',
      active: true,
    },
  })
  for (const [index, customer] of customers.entries())
    await rpc(owner.id, 'create_document', {
      p_payload: {
        requestId: crypto.randomUUID(),
        kind: 'invoice',
        customerId: customer,
        customerName: ['Ana López', 'Boutique Estrella', 'Carlos Ruiz'][index],
        tier: ['emprendedor', 'vip', 'premium'][index],
        currency: index === 2 ? 'USD' : 'NIO',
        exchangeRate: index === 2 ? 36.62 : undefined,
        location: 'store',
        paymentMethod: ['cash', 'card_pos', 'bank_transfer'][index],
        notes: '',
        taxRate: 15,
        items: [
          { productId: products[index], quantity: 1 },
          { productId: products[3], quantity: 1 },
        ],
      },
    })
  await rpc(sales.id, 'create_document', {
    p_payload: {
      requestId: crypto.randomUUID(),
      kind: 'proforma',
      customerId: customers[0],
      customerName: 'Ana López',
      tier: 'emprendedor',
      currency: 'NIO',
      notes: 'Cotización',
      taxRate: 15,
      validUntil: '2099-01-01',
      items: [{ productId: products[2], quantity: 2 }],
    },
  })
  await rpc(owner.id, 'record_expense', {
    p_input: {
      requestId: crypto.randomUUID(),
      incurredOn: '2026-09-15',
      category: 'agua_luz',
      description: 'Energía de septiembre',
      amount: 1500,
      currency: 'NIO',
      exchangeRate: 1,
      reference: 'REC-9',
    },
  })
  return { products, customers }
}

// Comprueba en un navegador real que el programa no deja credenciales en el
// equipo: ni en localStorage, sessionStorage, IndexedDB, Cache Storage,
// cookies o service workers, ni escritas en el perfil del navegador en disco.
//
//   npm run test:credentials
//
// Arranca su propio servidor de Vite contra un Supabase simulado
// (https://credenciales.supabase.invalid): todas sus peticiones las contesta
// Playwright y nunca salen a la red. No usa cuentas ni datos reales.
// Navegador: Chrome instalado; PLAYWRIGHT_CHANNEL=chromium o
// PLAYWRIGHT_EXECUTABLE_PATH=<ruta> para usar otro.
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SUPABASE = 'https://credenciales.supabase.invalid'
const EMAIL = 'sonda.credenciales@example.com'
const PASSWORD = 'ClaveSonda-2026-XyZ!'
const REFRESH = 'refreshSondaCredenciales7777'
const PORT = 5176
const BASE = `http://127.0.0.1:${PORT}`

Object.assign(process.env, {
  VITE_DATA_MODE: 'supabase',
  VITE_SUPABASE_URL: SUPABASE,
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_sonda_credenciales',
})

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const now = () => Math.floor(Date.now() / 1000)
const user = {
  id: '11111111-2222-3333-4444-555555555555',
  aud: 'authenticated',
  role: 'authenticated',
  email: EMAIL,
  app_metadata: { provider: 'email' },
  user_metadata: {},
  created_at: new Date().toISOString(),
}
const ACCESS = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, role: 'authenticated', exp: now() + 3600 })}.firmaSimuladaCredenciales0123456789`
const secrets = {
  contraseña: PASSWORD,
  'token de acceso': ACCESS,
  'token de renovación': REFRESH,
}

const requests = []
async function fakeSupabase(context) {
  await context.route(`${SUPABASE}/**`, async (route) => {
    const request = route.request()
    const { pathname } = new URL(request.url())
    requests.push(`${request.method()} ${pathname}`)
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
    }
    if (request.method() === 'OPTIONS')
      return route.fulfill({ status: 204, headers })
    const json = (body) =>
      route.fulfill({
        status: 200,
        headers,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })
    if (pathname === '/auth/v1/token')
      return json({
        access_token: ACCESS,
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: now() + 3600,
        refresh_token: REFRESH,
        user,
      })
    if (pathname === '/auth/v1/user') return json(user)
    if (pathname === '/auth/v1/logout')
      return route.fulfill({ status: 204, headers })
    if (pathname === '/rest/v1/staff_members')
      return json([{ role: 'superadmin', active: true }])
    return json([])
  })
}

let failures = 0
function check(ok, text) {
  console.log(`${ok ? '✔' : '✘'} ${text}`)
  if (!ok) failures++
}

async function browserState(page) {
  const state = await page.evaluate(async () => {
    const entries = (store) =>
      Object.keys(store).map((key) => `${key}=${store.getItem(key)}`)
    const safe = async (read) => {
      try {
        return await read()
      } catch {
        return []
      }
    }
    return {
      local: entries(localStorage),
      session: entries(sessionStorage),
      cookie: document.cookie,
      indexedDB: await safe(async () =>
        (await indexedDB.databases()).map((db) => db.name),
      ),
      caches: await safe(() => caches.keys()),
      workers: await safe(async () =>
        (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope),
      ),
    }
  })
  return { ...state, cookies: await page.context().cookies() }
}

function checkClean(state, moment) {
  const text = JSON.stringify(state)
  for (const [name, value] of Object.entries(secrets))
    check(!text.includes(value), `${moment}: sin ${name} en el navegador`)
  check(
    !state.local.some((entry) => /^sb-.+-auth-token/.test(entry)),
    `${moment}: sin sesión de Supabase en localStorage`,
  )
  check(state.session.length === 0, `${moment}: sessionStorage vacío`)
  check(
    state.cookies.length === 0 && state.cookie === '',
    `${moment}: sin cookies`,
  )
  check(
    state.indexedDB.length === 0 &&
      state.caches.length === 0 &&
      state.workers.length === 0,
    `${moment}: sin IndexedDB, Cache Storage ni service workers`,
  )
}

function filesContaining(dir, needle) {
  const found = []
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name)
      let info
      try {
        info = statSync(full)
      } catch {
        continue
      }
      if (info.isDirectory()) walk(full)
      else if (info.size < 50_000_000) {
        try {
          if (readFileSync(full).includes(needle))
            found.push(full.slice(dir.length + 1))
        } catch {
          // Archivo bloqueado por el navegador: se omite.
        }
      }
    }
  }
  walk(dir)
  return found
}

function checkDisk(profile, moment) {
  for (const [name, value] of Object.entries(secrets)) {
    const files = filesContaining(profile, value)
    check(
      files.length === 0,
      `${moment}: sin ${name} en el disco${files.length ? ` (${files.join(', ')})` : ''}`,
    )
  }
}

async function login(page) {
  await page.goto(`${BASE}/login`)
  await page.getByLabel('Correo electrónico').fill(EMAIL)
  await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Iniciar sesión' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), {
    timeout: 20000,
  })
  await page.waitForTimeout(1000)
}

const server = await createServer({
  mode: 'test',
  cacheDir: 'output/cache/vite-credentials',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: PORT, strictPort: true },
})
await server.listen()
const profile = mkdtempSync(join(tmpdir(), 'lcp-credenciales-'))
const launch = () =>
  chromium.launchPersistentContext(profile, {
    channel: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? undefined
      : process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
    viewport: { width: 1280, height: 900 },
  })

try {
  let context = await launch()
  await fakeSupabase(context)
  let page = context.pages()[0] ?? (await context.newPage())

  await page.goto(`${BASE}/login`)
  await page.evaluate(() =>
    localStorage.setItem(
      'sb-credenciales-auth-token',
      '{"refresh_token":"sesionAnterior"}',
    ),
  )
  await page.reload()
  await page.waitForTimeout(500)
  check(
    (await page.evaluate(() =>
      localStorage.getItem('sb-credenciales-auth-token'),
    )) === null,
    'borra la sesión que dejó una versión anterior',
  )

  await login(page)
  check(new URL(page.url()).pathname === '/', 'inicia sesión y abre el panel')
  checkClean(await browserState(page), 'con la sesión abierta')

  await page.reload()
  await page.waitForTimeout(1000)
  check(
    new URL(page.url()).pathname === '/login',
    'recargar la página pide la contraseña otra vez',
  )

  await login(page)
  await context.close()
  checkDisk(profile, 'navegador cerrado sin cerrar sesión')

  context = await launch()
  await fakeSupabase(context)
  page = context.pages()[0] ?? (await context.newPage())
  await page.goto(`${BASE}/`)
  await page.waitForTimeout(1000)
  check(
    new URL(page.url()).pathname === '/login',
    'al reabrir el navegador no hay sesión abierta',
  )

  await login(page)
  requests.length = 0
  await page
    .getByRole('button', { name: /Cerrar sesión/ })
    .first()
    .click()
  await page.waitForURL(/\/login$/, { timeout: 10000 })
  check(
    requests.includes('POST /auth/v1/logout'),
    '«Cerrar sesión» revoca la sesión en Supabase',
  )
  checkClean(await browserState(page), 'después de cerrar sesión')
  await context.close()
  checkDisk(profile, 'después de cerrar sesión')
} finally {
  await server.close()
  rmSync(profile, { recursive: true, force: true })
}

console.log(
  failures
    ? `\n${failures} comprobaciones fallaron.`
    : '\nNinguna credencial queda guardada en el navegador ni en el disco.',
)
process.exit(failures ? 1 : 0)

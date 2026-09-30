// Arranque común de las auditorías de pantalla: base desechable con un negocio
// de ejemplo, Vite en modo Supabase contra una API simulada y Chromium.
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import {
  createDatabase,
  fakeSupabase,
  seedBusiness,
  USERS,
} from './harness.mjs'

export const SUPABASE = 'https://auditoria.supabase.invalid'

export async function startAudit({ port }) {
  Object.assign(process.env, {
    VITE_DATA_MODE: 'supabase',
    VITE_SUPABASE_URL: SUPABASE,
    VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_auditoria',
    VITE_AUTH_REDIRECT_URL: `http://127.0.0.1:${port}/auth/callback`,
  })
  const base = await createDatabase()
  const seed = await seedBusiness(base)
  await base.save()
  const api = fakeSupabase(base)
  const server = await createServer({
    mode: 'test',
    cacheDir: `output/cache/vite-audit-${port}`,
    logLevel: 'error',
    // Sin recarga en caliente: un cambio en el código mientras corre la
    // auditoría recargaría la pestaña y la sesión (sólo en memoria) se perdería.
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      hmr: false,
      watch: null,
    },
  })
  await server.listen()
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
    channel: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? undefined
      : process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-dev-shm-usage',
      '--enable-precise-memory-info',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-features=AutofillServerCommunication,OptimizationHints',
    ],
  })
  const origin = `http://127.0.0.1:${port}`
  const events = { errors: [], downloads: 0, popups: 0, prints: 0, files: 0 }

  async function open(
    viewport = { width: 1440, height: 1000 },
    mobile = false,
  ) {
    const context = await browser.newContext({
      viewport,
      isMobile: mobile,
      hasTouch: mobile,
      acceptDownloads: true,
      locale: 'es-NI',
      permissions: ['camera', 'clipboard-read', 'clipboard-write'],
    })
    await context.route(`${SUPABASE}/**`, api.answer)
    // Nada sale a internet: WhatsApp, fuentes o imágenes externas.
    await context.route(
      (url) =>
        !url.href.startsWith(origin) &&
        !url.href.startsWith(SUPABASE) &&
        !url.protocol.startsWith('blob') &&
        !url.protocol.startsWith('data'),
      (route) => route.fulfill({ status: 204, body: '' }),
    )
    await context.addInitScript(() => {
      window.print = () => {
        window.__audit_prints = (window.__audit_prints ?? 0) + 1
      }
    })
    const page = await context.newPage()
    context.on('page', (popup) => {
      if (popup === page) return
      events.popups++
      popup.close().catch(() => {})
    })
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const text = message.text()
        // Las respuestas 4xx de la API simulada son parte de las pruebas de validación.
        if (
          /Failed to load resource: the server responded with a status of 4\d\d/.test(
            text,
          )
        )
          return
        events.errors.push(`${page.url()} · consola: ${text}`)
      }
    })
    page.on('pageerror', (error) =>
      events.errors.push(`${page.url()} · excepción: ${error.message}`),
    )
    page.on('download', () => events.downloads++)
    page.on('filechooser', () => events.files++)
    return { context, page }
  }
  async function login(page, user) {
    for (let attempt = 0; ; attempt++) {
      try {
        await page.goto(`${origin}/login`)
        await page.getByLabel('Correo electrónico').waitFor({ timeout: 30000 })
        break
      } catch (error) {
        // La primera carga de Vite puede optimizar dependencias y recargar.
        if (attempt > 3) throw error
        await page.waitForTimeout(2000)
      }
    }
    await page.getByLabel('Correo electrónico').fill(user.email)
    await page.getByLabel('Contraseña', { exact: true }).fill(user.password)
    await page.getByRole('button', { name: 'Iniciar sesión' }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), {
      timeout: 20000,
    })
    await settle(page)
  }
  async function stop() {
    await browser.close().catch(() => {})
    await server.close().catch(() => {})
  }
  return { base, seed, api, origin, events, open, login, stop, USERS }
}

/** Navega sin recargar: la sesión vive sólo en la memoria de la pestaña. */
export async function go(page, path) {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
  await settle(page)
}

/** Espera a que desaparezcan los «Cargando…» y la red quede quieta. */
export async function settle(page, timeout = 8000) {
  const start = Date.now()
  await page.waitForTimeout(150)
  while (Date.now() - start < timeout) {
    const busy = await page
      .evaluate(() => {
        const text = document.body?.innerText ?? ''
        return (
          /Cargando…|Cargando\.\.\./.test(text) ||
          !!document.querySelector('[aria-busy="true"]')
        )
      })
      .catch(() => false)
    if (!busy) break
    await page.waitForTimeout(150)
  }
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
}

/** Textos que nunca deberían verse: mensajes internos o valores rotos. */
export const LEAKS =
  /\b(NaN|Infinity|undefined|null|\[object Object\]|violates|constraint|PGRST|syntax error|invalid input syntax|TypeError|ReferenceError|stack|SQLSTATE|duplicate key|permission denied for|insufficient_privilege)\b/

export async function screenText(page) {
  return page.evaluate(() => document.body?.innerText ?? '')
}
export async function brokenScreen(page) {
  const text = await screenText(page)
  if (/No pudimos mostrar esta pantalla/.test(text))
    return 'la pantalla cayó en el aviso de error'
  const leak = LEAKS.exec(text)
  if (leak) {
    const at = Math.max(0, leak.index - 60)
    return `texto interno visible: «…${text.slice(at, leak.index + 60).replace(/\s+/g, ' ')}…»`
  }
  return null
}

// Direcciones escritas a mano o dañadas: identificadores que no existen, texto
// en lugar de un identificador, parámetros raros. Ninguna debe romper la
// pantalla ni mostrar mensajes internos.
//
//   node tests/audit/urls.mjs
import { startAudit, go, brokenScreen, screenText } from './ui-support.mjs'

const audit = await startAudit({ port: Number(process.env.PORT ?? 5187) })
const { events, open, login, USERS } = audit
let checks = 0
let failures = 0
const check = (ok, text, detail = '') => {
  checks++
  console.log(`${ok ? '✔' : '✘'} ${text}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const PRIVATE = [
  '/products/no-es-un-id/edit',
  '/products/00000000-0000-4000-8000-000000000000/edit',
  "/products/'%20or%201=1--/edit",
  '/products/new?barcode=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
  '/products/new?barcode=' + '9'.repeat(500),
  '/prices?apartado=%3Cimg%20src=x%3E',
  '/prices?apartado=costo&volver=precios',
  '/sales/history?desde=ayer&hasta=2026-99-99',
  '/sales/history?periodo=%00',
  '/inventory?q=%E0%A4%A',
  '/inventory?q=' + 'x'.repeat(3000),
  '/customers/../../etc/passwd',
  '/reports?desde=2099-01-01&hasta=1999-01-01',
  '/documents/example/xyz?productos=-1',
  '/documents/example/invoice?productos=abc',
  '/staff#%3Cscript%3E',
  '/%F0%9F%98%80',
]
const PUBLIC = [
  '/auth/callback',
  '/auth/callback?code=basura',
  '/auth/callback#access_token=basura&refresh_token=x&type=recovery',
  '/reset-password?token=x',
  '/activate?email=%3Cscript%3E',
  '/login?redirect=https://ejemplo.invalid',
]
try {
  const { page } = await open()
  await login(page, USERS.owner)
  for (const path of PRIVATE) {
    const before = events.errors.length
    await go(page, path)
    await page.waitForTimeout(400)
    const broken = await brokenScreen(page)
    const heading = await page
      .locator('h1')
      .first()
      .textContent()
      .catch(() => null)
    check(
      !broken && events.errors.length === before && !!heading,
      `${(() => {
        try {
          return decodeURIComponent(path)
        } catch {
          return path
        }
      })().slice(0, 70)} → «${(heading ?? 'sin título').trim().slice(0, 40)}»`,
      broken ?? events.errors.slice(before).join(' | ') ?? 'sin encabezado',
    )
  }
  check(
    !(await page.evaluate(() => window.__xss)),
    'ningún parámetro ejecutó código',
  )
  const guest = await open()
  for (const path of PUBLIC) {
    const before = events.errors.length
    await guest.page.goto(`${audit.origin}${path}`)
    await guest.page.waitForTimeout(1200)
    const broken = await brokenScreen(guest.page)
    const text = (await screenText(guest.page))
      .replace(/\s+/g, ' ')
      .slice(0, 60)
    check(
      !broken &&
        events.errors.length === before &&
        new URL(guest.page.url()).hostname === '127.0.0.1',
      `sin sesión ${path.slice(0, 70)} → «${text}»`,
      broken ?? events.errors.slice(before).join(' | '),
    )
  }
} catch (error) {
  check(false, 'recorrido', error.stack)
} finally {
  console.log(
    `\n${checks - failures} de ${checks} direcciones sin romper la pantalla.`,
  )
  await audit.stop()
  process.exit(failures ? 1 : 0)
}

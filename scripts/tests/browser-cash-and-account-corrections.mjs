import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5198'
assert.ok(
  ['127.0.0.1', 'lcp-control.pages.dev'].includes(new URL(base).hostname),
)
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5198, strictPort: true },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const output = 'output/cash-and-account-review'
await mkdir(output, { recursive: true })
let checks = 0
const eq = (a, b, msg) => {
  assert.deepEqual(a, b, msg)
  checks++
}
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      isMobile: width < 500,
      hasTouch: width < 500,
      timezoneId: 'America/Managua',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const f = await browserDatabase(page)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const one = async (s, a = []) => (await f.db.query(s, a)).rows[0]
    const rpc = async (name, input) =>
      (await one(`select public.${name}($1::jsonb) r`, [JSON.stringify(input)]))
        .r
    const state = async () =>
      (await one('select public.get_business_day() r')).r
    const cash = async () =>
      (
        await one('select public.ledger_report($1,$1) r', [f.today])
      ).r.accounts.find((a) => a.code === '1110-001').closing
    await page.route('**/rest/v1/storefront_drafts*', (r) =>
      r.request().method() === 'HEAD'
        ? r.fulfill({
            status: 200,
            headers: { 'content-range': '*/0' },
            body: '',
          })
        : r.fallback(),
    )
    try {
      await rpc('open_business_day', {
        requestId: crypto.randomUUID(),
        openingNio: 1000,
        openingUsd: 0,
      })
      await page.goto(base + '/login')
      await page
        .getByLabel('Correo electrónico', { exact: true })
        .fill('auditoria@example.test')
      await page
        .getByLabel('Contraseña', { exact: true })
        .fill('Local-test-password!')
      await page
        .getByRole('button', { name: 'Iniciar sesión', exact: true })
        .click()
      await page.getByRole('heading', { name: 'Inicio', exact: true }).waitFor()
      await page
        .getByRole('button', {
          name: 'Registrar movimiento de caja',
          exact: true,
        })
        .click()
      let dialog = page.getByRole('dialog')
      await dialog.getByLabel('Tipo de movimiento', { exact: true }).waitFor()
      await dialog.getByLabel('Importe', { exact: true }).fill('100')
      await dialog
        .getByLabel('Cuenta de destino', { exact: true })
        .selectOption('5130-001')
      await dialog
        .getByLabel('Concepto', { exact: true })
        .fill('Pago de gastos de tienda')
      if (width === 1440) {
        let dropped = false
        await page.route('**/rest/v1/rpc/record_cash_movement', async (r) => {
          if (!dropped) {
            dropped = true
            await rpc(
              'record_cash_movement',
              r.request().postDataJSON().p_input,
            )
            return r.abort('connectionreset')
          }
          return r.fallback()
        })
        await dialog
          .getByRole('button', { name: 'Guardar movimiento', exact: true })
          .click()
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .waitFor()
        eq(
          await dialog.getByLabel('Importe', { exact: true }).isDisabled(),
          true,
        )
        await page.keyboard.press('Escape')
        eq(await dialog.isVisible(), true)
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .click()
        await page.unroute('**/rest/v1/rpc/record_cash_movement')
      } else
        await dialog
          .getByRole('button', { name: 'Guardar movimiento', exact: true })
          .click()
      await dialog.waitFor({ state: 'hidden' })
      eq(await cash(), 900)
      eq((await state()).report.expectedNio, 900)
      await page
        .getByRole('button', { name: 'Cerrar tienda', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      await dialog.getByLabel('Córdobas C$', { exact: true }).fill('800')
      await dialog.getByLabel('Dólares US$', { exact: true }).fill('0')
      await dialog
        .getByLabel('Observación / motivo de diferencia', { exact: true })
        .fill('Se escribió el conteo incorrectamente')
      await dialog
        .getByRole('button', { name: 'Confirmar cierre', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      eq((await state()).status, 'closed')
      const closedAt = (await state()).closedAt
      await page
        .getByRole('button', { name: 'Editar conteo del cierre', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      await dialog.getByLabel('Córdobas C$', { exact: true }).waitFor()
      eq(
        await dialog.getByLabel('Córdobas C$', { exact: true }).inputValue(),
        '800',
      )
      await dialog.getByLabel('Córdobas C$', { exact: true }).fill('900')
      await dialog
        .getByRole('button', { name: 'Guardar corrección', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      eq((await state()).report.differenceNio, 0)
      eq((await state()).closedAt, closedAt)
      eq(await cash(), 900, 'el conteo no crea ingresos')
      await page
        .getByRole('button', {
          name: 'Registrar movimiento de caja',
          exact: true,
        })
        .click()
      dialog = page.getByRole('dialog')
      await dialog
        .getByLabel('Tipo de movimiento', { exact: true })
        .selectOption('deposit')
      await dialog.getByLabel('Importe', { exact: true }).fill('200')
      await dialog
        .getByLabel('Cuenta de destino', { exact: true })
        .selectOption('1120-001')
      await dialog
        .getByLabel('Concepto', { exact: true })
        .fill('Depósito omitido al cerrar')
      await page.screenshot({
        path: `${output}/movimiento-${width}.png`,
        fullPage: true,
      })
      await dialog
        .getByRole('button', { name: 'Guardar movimiento', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      eq(await cash(), 700)
      eq((await state()).report.expectedNio, 700)
      eq((await state()).report.countedNio, 900)
      await page
        .getByText('Historial de la jornada', { exact: false })
        .first()
        .click()
      await page
        .getByText('Corrección de cierre · revisión', { exact: false })
        .waitFor()
      eq(
        await page
          .getByText('Movimiento de caja · revisión', { exact: false })
          .count(),
        2,
      )
      await page.screenshot({
        path: `${output}/historial-${width}.png`,
        fullPage: true,
      })
      await page.evaluate(() => {
        globalThis.history.pushState({}, '', '/accounting?section=catalog')
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      })
      await page
        .getByRole('button', { name: 'Administrar cuentas', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      await dialog.getByLabel('Buscar cuenta', { exact: true }).fill('2117')
      await dialog
        .getByRole('button', { name: 'Editar cuenta 2117', exact: true })
        .click()
      eq(await dialog.getByLabel('Código', { exact: true }).isEditable(), true)
      await dialog.getByLabel('Código', { exact: true }).fill('2118')
      await dialog
        .getByRole('button', { name: 'Guardar cuenta', exact: true })
        .click()
      await dialog
        .getByText('2118 · Envíos por pagar', { exact: true })
        .waitFor()
      await page.screenshot({
        path: `${output}/numeracion-${width}.png`,
        fullPage: true,
      })
      eq(
        await one(
          "select code,display_code from public.ledger_accounts where code='2117'",
        ),
        { code: '2117', display_code: '2118' },
      )
      await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click()
      await page
        .getByRole('heading', { name: 'Catálogo de cuentas', exact: true })
        .waitFor()
      eq(
        await page
          .locator('table tr')
          .filter({ hasText: 'Envíos por pagar' })
          .innerText()
          .then((s) => s.includes('2118')),
        true,
      )
      eq(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
        'sin desbordamiento',
      )
      eq(errors, [])
      eq(f.failures, [])
    } finally {
      await context.close()
      await f.db.close()
    }
  }
  await writeFile(
    `${output}/resultado.json`,
    JSON.stringify(
      { checks, widths: [1440, 390, 320], productionDataModified: false },
      null,
      2,
    ),
  )
  console.log(
    `PASS navegador caja y cuentas: ${checks} verificaciones en escritorio y móvil, API aislada.`,
  )
} finally {
  await browser.close()
  await server?.close()
}

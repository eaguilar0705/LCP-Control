import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

// Toda lectura y escritura usa PostgreSQL desechable. Ni el historial ni la
// apertura de una jornada de la tienda real se modifican en esta prueba.
const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5192'
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) ||
    new URL(base).origin === 'https://lcp-control.pages.dev',
)
const output = process.env.LCP_TEST_OUTPUT ?? 'output/business-day-history'
await mkdir(output, { recursive: true })
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5192, strictPort: true },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    let historyCalls = 0
    page.on('pageerror', (error) => errors.push(error.message))
    const fixture = await browserDatabase(page)
    const rpc = async (name, input) =>
      (
        await fixture.db.query(`select public.${name}($1::jsonb) result`, [
          JSON.stringify(input),
        ])
      ).rows[0].result
    const state = async (day = null) =>
      (
        await fixture.db.query('select public.get_business_day($1) result', [
          day,
        ])
      ).rows[0].result
    const history = async (day) =>
      (
        await fixture.db.query(
          'select public.get_business_day_history($1) result',
          [day],
        )
      ).rows[0].result
    try {
      const yesterday = (
        await fixture.db.query(
          "select ((now() at time zone 'America/Managua')::date-1)::text as day",
        )
      ).rows[0].day
      await fixture.db.exec(
        "reset role; create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select coalesce(nullif(current_setting('lcp.history_now',true),'')::timestamptz,statement_timestamp())$$; set role authenticated;",
      )
      await fixture.db.query("select set_config('lcp.history_now',$1,false)", [
        `${yesterday}T18:00:00Z`,
      ])
      let day = await rpc('open_business_day', {
        requestId: crypto.randomUUID(),
        expectedDay: yesterday,
        openingNio: 1234.56,
        openingUsd: 17.5,
      })
      const close = async (current, nio, usd, note) =>
        rpc('close_business_day', {
          requestId: crypto.randomUUID(),
          day: current.day,
          expectedRevision: current.revision,
          expectedStateToken: current.stateToken,
          countedNio: nio,
          countedUsd: usd,
          note,
        })
      day = await close(day, 1200, 15, 'Conteo antes de terminar las ventas')
      const firstClosure = (await history(yesterday))[0]
      day = await rpc('reopen_business_day', {
        requestId: crypto.randomUUID(),
        day: yesterday,
        expectedRevision: day.revision,
        reason: 'Cierre accidental antes de terminar la jornada',
      })
      day = await close(day, 1250, 20, 'Recuento físico completo al finalizar')
      const originalHistory = await history(yesterday)
      equal(originalHistory.length, 3)
      equal(
        originalHistory.map((event) => event.revision),
        [3, 2, 1],
      )
      equal(originalHistory[2], firstClosure)
      await fixture.db.query("select set_config('lcp.history_now',$1,false)", [
        `${fixture.today}T18:00:00Z`,
      ])

      let failHistory = false
      await page.route(
        '**/rest/v1/rpc/get_business_day_history',
        async (route) => {
          historyCalls++
          if (failHistory)
            return route.fulfill({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({
                code: 'XX000',
                message: 'Fallo temporal de lectura aislado',
              }),
            })
          return route.fallback()
        },
      )
      await page.goto(`${base}/login`)
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
      const panel = page.locator('.business-day-panel')
      const details = panel.locator('.day-history')
      await details.locator('summary').click()
      await details
        .getByText('Sin cierres ni reaperturas para esta fecha.', {
          exact: true,
        })
        .waitFor()
      equal(
        await panel
          .getByLabel('Consultar jornada', { exact: true })
          .inputValue(),
        fixture.today,
      )
      equal(
        await details.locator('.day-history-event').count(),
        0,
        'Hoy sin abrir no debe mezclar cierres de ayer',
      )

      failHistory = true
      await panel
        .getByLabel('Consultar jornada', { exact: true })
        .fill(yesterday)
      await details
        .getByRole('button', { name: 'Reintentar', exact: true })
        .waitFor({ state: 'attached' })
      equal(
        await details.evaluate((element) => element.open),
        true,
        'Consultar otra fecha debe mantener el historial desplegado',
      )
      equal(await details.locator('.day-history-event').count(), 0)
      const beforeRefresh = historyCalls
      failHistory = false
      await panel
        .getByRole('button', { name: 'Actualizar jornada', exact: true })
        .click()
      await details
        .getByRole('button', {
          name: 'PDF del cierre · revisión 1',
          exact: true,
        })
        .waitFor()
      equal(
        historyCalls > beforeRefresh,
        true,
        'Actualizar debe reconsultar el historial aunque la revisión no cambie',
      )
      equal(
        await details
          .getByRole('button', { name: 'Reintentar', exact: true })
          .count(),
        0,
      )
      equal(await details.locator('.day-history-event').count(), 3)
      await details
        .getByText('Reapertura · revisión 2', { exact: true })
        .waitFor()
      await details
        .getByText('Conteo antes de terminar las ventas', { exact: true })
        .waitFor()
      await details
        .getByText('Recuento físico completo al finalizar', { exact: true })
        .waitFor()
      equal(
        await details.locator('.day-history-date').isVisible(),
        true,
        'El historial debe identificar la fecha consultada',
      )
      await page.screenshot({
        path: `${output}/cierres-y-reapertura-${width}.png`,
        fullPage: true,
      })
      const downloadPromise = page.waitForEvent('download')
      await details
        .getByRole('button', {
          name: 'PDF del cierre · revisión 1',
          exact: true,
        })
        .click()
      const download = await downloadPromise
      const pdf = `${output}/cierre-original-${width}.pdf`
      await download.saveAs(pdf)
      equal((await readFile(pdf)).subarray(0, 4).toString(), '%PDF')
      equal(
        await history(yesterday),
        originalHistory,
        'Consultar y descargar no debe cambiar ningún cierre',
      )

      await panel
        .getByRole('button', { name: 'Volver a hoy', exact: true })
        .click()
      await details
        .getByText('Sin cierres ni reaperturas para esta fecha.', {
          exact: true,
        })
        .waitFor({ state: 'attached' })
      equal(
        await details.evaluate((element) => element.open),
        true,
        'Volver a hoy debe mantener el historial desplegado',
      )
      equal(await details.locator('.day-history-event').count(), 0)
      await panel
        .getByRole('button', { name: 'Abrir tienda', exact: true })
        .click()
      let dialog = page.getByRole('dialog')
      equal(
        await dialog.getByLabel('Dólares US$', { exact: true }).inputValue(),
        '0',
      )
      await dialog
        .getByRole('button', { name: 'Usar último cierre', exact: true })
        .click()
      equal(
        await dialog.getByLabel('Córdobas C$', { exact: true }).inputValue(),
        '1250',
      )
      equal(
        await dialog.getByLabel('Dólares US$', { exact: true }).inputValue(),
        '20',
      )
      await page.screenshot({
        path: `${output}/efectivo-sugerido-${width}.png`,
        fullPage: true,
      })
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        'El formulario de apertura debe caber en móvil',
      )
      await dialog.getByLabel('Córdobas C$', { exact: true }).fill('1100')
      equal(
        await dialog.getByLabel('Córdobas C$', { exact: true }).inputValue(),
        '1100',
        'La sugerencia debe poder corregirse tras el conteo físico',
      )
      equal(
        (await state()).status,
        'not_opened',
        'Usar la sugerencia nunca abre la tienda automáticamente',
      )
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      equal((await state()).status, 'not_opened')
      await panel
        .getByRole('button', { name: 'Abrir tienda', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      await dialog
        .getByRole('button', { name: 'Sin efectivo inicial', exact: true })
        .click()
      equal(
        await dialog.getByLabel('Córdobas C$', { exact: true }).inputValue(),
        '0',
      )
      equal(
        await dialog.getByLabel('Dólares US$', { exact: true }).inputValue(),
        '0',
      )
      equal(
        (await state()).status,
        'not_opened',
        'El atajo cero conserva el paso de confirmación',
      )
      await dialog.getByLabel('Córdobas C$', { exact: true }).fill('1000')
      await dialog
        .getByRole('button', { name: 'Confirmar apertura', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      await panel
        .getByRole('heading', { name: 'Tienda abierta', exact: true })
        .waitFor()
      equal((await state()).openingNio, 1000)
      equal((await state()).openingUsd, 0)
      equal(await history(yesterday), originalHistory)
      equal(
        await history(fixture.today),
        [],
        'Abrir no crea un cierre ficticio',
      )
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
      )
      equal(fixture.failures, [])
      equal(errors, [])
      await page.screenshot({
        path: `${output}/historial-y-apertura-${width}.png`,
        fullPage: true,
      })
      results.push({ width, status: 'correcto', checks })
      console.log(
        `PASS historial y apertura ${width}px: fecha, cierres y reapertura, PDF original, recuperación al actualizar, efectivo sugerido editable y apertura confirmada sin duplicar`,
      )
    } catch (error) {
      await page.screenshot({
        path: `${output}/fallo-${width}.png`,
        fullPage: true,
      })
      await writeFile(
        `${output}/fallo-${width}.json`,
        JSON.stringify(
          {
            historyCalls,
            errors,
            failures: fixture.failures,
            body: await page.locator('body').innerText(),
          },
          null,
          2,
        ),
      )
      throw error
    } finally {
      await fixture.close()
      await context.close()
    }
  }
  await writeFile(
    `${output}/resultados.json`,
    JSON.stringify({ checks, results }, null, 2),
  )
  console.log(`Historial y apertura: ${checks} comprobaciones correctas.`)
} finally {
  await browser.close()
  await server?.close()
}

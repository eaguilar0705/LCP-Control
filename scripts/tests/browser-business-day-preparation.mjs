import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

const output = 'output/business-day-preparation'
await mkdir(output, { recursive: true })
const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5197'
const allowed = new URL(base)
assert(
  ['127.0.0.1', 'localhost', 'lcp-control.pages.dev'].includes(
    allowed.hostname,
  ) || allowed.hostname.endsWith('.lcp-control.pages.dev'),
)
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5197, strictPort: true },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      acceptDownloads: true,
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const fixture = await browserDatabase(page)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const call = async (name, input) =>
      (
        await fixture.db.query(`select public.${name}($1::jsonb) r`, [
          JSON.stringify(input),
        ])
      ).rows[0].r
    const state = async () =>
      (await fixture.db.query('select public.get_business_day(null) r')).rows[0]
        .r
    const history = async () =>
      (
        await fixture.db.query('select public.get_business_day_history($1) r', [
          fixture.today,
        ])
      ).rows[0].r
    const overflow = async () =>
      eq(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        `sin desborde a ${width}px`,
      )
    try {
      let loseResponse = true
      await page.route('**/rest/v1/rpc/prepare_business_day', async (route) => {
        if (!loseResponse) return route.fallback()
        loseResponse = false
        await call(
          'prepare_business_day',
          route.request().postDataJSON().p_input,
        )
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'NETWORK_TEST',
            message: 'Respuesta perdida en prueba aislada',
          }),
        })
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
      const panel = page.locator('.business-day-panel')
      await panel
        .getByRole('button', { name: 'Editar efectivo inicial', exact: true })
        .click()
      let dialog = page.getByRole('dialog')
      await dialog
        .getByRole('heading', { name: 'Preparar efectivo inicial' })
        .waitFor()
      await dialog.getByLabel('Córdobas C$', { exact: true }).fill('1000')
      await dialog.getByLabel('Dólares US$', { exact: true }).fill('20')
      await overflow()
      const save = dialog.getByRole('button', {
        name: 'Guardar efectivo inicial',
        exact: true,
      })
      await save.click()
      await dialog.getByText(/No pudimos confirmar la operación/).waitFor()
      await save.click()
      await dialog.waitFor({ state: 'hidden' })
      eq((await state()).status, 'not_opened')
      eq(
        (await history()).length,
        1,
        'el reintento recupera una sola preparación',
      )
      await panel.getByText('Efectivo preparado', { exact: true }).waitFor()
      await page.reload()
      // La sesión es deliberadamente sólo de memoria; recargar pide entrar de nuevo.
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
      await panel
        .getByRole('button', { name: 'Abrir tienda', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      eq(
        await dialog.getByLabel('Córdobas C$', { exact: true }).inputValue(),
        '1000',
      )
      eq(
        await dialog.getByLabel('Dólares US$', { exact: true }).inputValue(),
        '20',
      )
      await call('prepare_business_day', {
        requestId: crypto.randomUUID(),
        day: fixture.today,
        expectedPreparationRevision: 1,
        openingNio: 1200,
        openingUsd: 25,
      })
      await page.evaluate(() =>
        globalThis.window.dispatchEvent(new Event('focus')),
      )
      await dialog
        .getByRole('button', { name: 'Actualizar jornada', exact: true })
        .waitFor()
      eq(
        await dialog
          .getByRole('button', { name: 'Confirmar apertura', exact: true })
          .isDisabled(),
        true,
        'no abre usando un efectivo obsoleto',
      )
      await dialog
        .getByRole('button', { name: 'Actualizar jornada', exact: true })
        .click()
      eq(
        await dialog.getByLabel('Córdobas C$', { exact: true }).inputValue(),
        '1200',
      )
      await dialog
        .getByRole('button', { name: 'Confirmar apertura', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      eq((await state()).openingNio, 1200)
      await call('create_document', {
        requestId: crypto.randomUUID(),
        kind: 'invoice',
        customerName: 'Cliente aislado',
        tier: 'emprendedor',
        currency: 'NIO',
        location: 'store',
        paymentMethod: 'cash',
        notes: '',
        items: [
          { productId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', quantity: 1 },
        ],
      })
      const beforeClose = await state()
      const closed = await call('close_business_day', {
        requestId: crypto.randomUUID(),
        day: fixture.today,
        expectedRevision: beforeClose.revision,
        expectedStateToken: beforeClose.stateToken,
        countedNio: beforeClose.report.expectedNio,
        countedUsd: beforeClose.report.expectedUsd,
        note: '',
      })
      const original = (await history()).find((e) => e.event === 'close')
      await panel
        .getByRole('button', { name: 'Actualizar jornada', exact: true })
        .click()
      await panel
        .getByRole('heading', { name: 'Jornada cerrada', exact: true })
        .waitFor()
      await panel
        .getByRole('button', { name: 'Editar efectivo inicial', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      await dialog.getByText(/La jornada seguirá cerrada/).waitFor()
      await dialog.getByLabel('Córdobas C$', { exact: true }).fill('1000')
      await dialog.getByLabel('Dólares US$', { exact: true }).fill('20')
      await dialog
        .getByLabel('Motivo de la corrección', { exact: true })
        .fill('Corrección del conteo inicial después de cerrar')
      await overflow()
      await page.screenshot({
        path: `${output}/correccion-cerrada-${width}.png`,
        fullPage: true,
      })
      await dialog
        .getByRole('button', { name: 'Guardar corrección', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      const corrected = await state()
      eq(corrected.status, 'closed')
      eq(corrected.closedAt, closed.closedAt)
      eq(corrected.report.invoices, 1)
      eq(corrected.report.countedNio, closed.report.countedNio)
      eq(corrected.report.differenceNio, 200)
      eq(corrected.report.differenceUsd, 5)
      eq(
        (await history()).find((e) => e.id === original.id),
        original,
      )
      await panel.getByText('Historial de la jornada', { exact: true }).click()
      await panel
        .locator('.day-history-event')
        .filter({ hasText: 'Corrección de apertura' })
        .waitFor()
      const download = page.waitForEvent('download')
      await panel
        .locator('.day-history-event')
        .filter({ hasText: 'Corrección de apertura' })
        .getByRole('button', { name: /PDF del cierre/ })
        .click()
      const pdf = await download
      eq(pdf.suggestedFilename().endsWith('.pdf'), true)
      await pdf.saveAs(`${output}/cierre-corregido-${width}.pdf`)
      await overflow()
      eq(errors, [])
      eq(fixture.failures, [])
      results.push({
        width,
        preparedBeforeOpening: true,
        savedAfterReload: true,
        lostResponseRecovered: true,
        staleOpeningPrevented: true,
        closedCorrectionPreservedCounts: true,
        originalHistoryPreserved: true,
        invoicePreserved: true,
        pdf: true,
      })
    } finally {
      await context.close()
      await fixture.close()
    }
  }
  await writeFile(
    `${output}/browser-results.json`,
    JSON.stringify({ checks, results }, null, 2),
  )
  console.log(
    `PASS navegador apertura preparada y corrección cerrada: ${checks} verificaciones, escritorio y móvil; ${base}`,
  )
} finally {
  await browser.close()
  await server?.close()
}

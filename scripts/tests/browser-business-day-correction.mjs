import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

const output = 'output/business-day-correction'
await mkdir(output, { recursive: true })
const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5196'
const allowed = new URL(base)
assert(
  ['127.0.0.1', 'localhost'].includes(allowed.hostname) ||
    allowed.hostname.endsWith('.lcp-control.pages.dev') ||
    allowed.hostname === 'lcp-control.pages.dev',
)
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5196, strictPort: true },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
let checks = 0
const eq = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
}
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
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
    try {
      await call('open_business_day', {
        requestId: crypto.randomUUID(),
        expectedDay: fixture.today,
        openingNio: 1000,
        openingUsd: 10,
      })
      const invoice = await call('create_document', {
        requestId: crypto.randomUUID(),
        kind: 'invoice',
        customerName: 'Cliente de auditoría',
        tier: 'emprendedor',
        currency: 'NIO',
        location: 'store',
        paymentMethod: 'cash',
        notes: '',
        items: [
          { productId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', quantity: 1 },
        ],
      })
      await call('record_expense', {
        requestId: crypto.randomUUID(),
        incurredOn: fixture.today,
        category: 'renta',
        description: 'Pago después de abrir',
        amount: 50,
        account: 'caja',
        currency: 'NIO',
        exchangeRate: 1,
      })
      eq((await state()).report.expectedNio, 1316)
      let lostResponse = true,
        writes = 0
      await page.route('**/rest/v1/rpc/correct_business_day', async (route) => {
        writes++
        if (lostResponse) {
          lostResponse = false
          await call(
            'correct_business_day',
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
        }
        return route.fallback()
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
      eq(
        await dialog.getByLabel('Córdobas C$', { exact: true }).inputValue(),
        '1000',
      )
      eq(
        await dialog.getByLabel('Dólares US$', { exact: true }).inputValue(),
        '10',
      )
      eq(
        await dialog
          .getByRole('button', { name: 'Guardar corrección', exact: true })
          .isDisabled(),
        true,
        'un formulario sin cambios no guarda',
      )
      await dialog.getByLabel('Córdobas C$', { exact: true }).fill('500')
      await dialog.getByLabel('Dólares US$', { exact: true }).fill('0')
      await dialog
        .getByLabel('Motivo de la corrección', { exact: true })
        .fill('Se transcribió mal el efectivo al abrir')
      eq(
        await dialog.evaluate((d) => d.scrollWidth > d.clientWidth + 1),
        false,
        'el diálogo cabe en móvil',
      )
      eq(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
      )
      await page.screenshot({
        path: `${output}/editar-apertura-${width}.png`,
        fullPage: true,
      })
      await dialog
        .getByRole('button', { name: 'Guardar corrección', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'No pudimos confirmar' })
        .waitFor()
      eq(
        (await history()).length,
        1,
        'la respuesta perdida ya guardó una corrección',
      )
      await dialog
        .getByRole('button', { name: 'Guardar corrección', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      eq(writes, 2)
      eq((await history()).length, 1, 'el reintento no duplica el historial')
      eq((await state()).report.expectedNio, 816)
      eq((await state()).openingUsd, 0)
      await panel.locator('.day-history summary').click()
      await panel
        .getByText('Corrección de apertura · revisión 1', { exact: true })
        .waitFor()
      await panel
        .getByText('Se transcribió mal el efectivo al abrir', { exact: true })
        .waitFor()
      eq(await panel.locator('.day-history-event').count(), 1)
      await page.screenshot({
        path: `${output}/historial-apertura-${width}.png`,
        fullPage: true,
      })
      await panel
        .getByRole('button', { name: 'Editar efectivo inicial', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      const before = await state()
      await call('correct_business_day', {
        requestId: crypto.randomUUID(),
        day: fixture.today,
        expectedRevision: before.revision,
        openingNio: 700,
        openingUsd: 0,
        reason: 'Corrección desde otra ventana de administración',
      })
      await page.evaluate(() =>
        globalThis.window.dispatchEvent(new Event('focus')),
      )
      await dialog
        .getByText('La jornada cambió desde que abriste este formulario.', {
          exact: true,
        })
        .waitFor()
      eq(
        await dialog
          .getByRole('button', { name: 'Guardar corrección', exact: true })
          .isDisabled(),
        true,
      )
      await dialog
        .getByRole('button', { name: 'Actualizar jornada', exact: true })
        .click()
      await page.waitForFunction(
        () =>
          globalThis.document.querySelector('.day-dialog input[type="number"]')
            ?.value === '700',
      )
      eq(
        await dialog.getByLabel('Córdobas C$', { exact: true }).inputValue(),
        '700',
        'actualizar recupera los importes nuevos',
      )
      await dialog.getByLabel('Córdobas C$', { exact: true }).fill('800')
      await dialog
        .getByLabel('Motivo de la corrección', { exact: true })
        .fill('Confirmar efectivo original contado al abrir')
      await dialog
        .getByRole('button', { name: 'Guardar corrección', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      eq((await state()).openingNio, 800)
      eq((await state()).report.invoices, 1)
      const saved = (
        await fixture.db.query('select id,number from public.documents')
      ).rows
      eq(
        saved,
        [{ id: invoice.id, number: invoice.number }],
        'la factura conserva su identidad',
      )
      eq((await history()).length, 3)
      const closing = await state()
      await call('close_business_day', {
        requestId: crypto.randomUUID(),
        day: fixture.today,
        expectedRevision: closing.revision,
        expectedStateToken: closing.stateToken,
        countedNio: closing.report.expectedNio,
        countedUsd: closing.report.expectedUsd,
        note: '',
      })
      await panel
        .getByRole('button', { name: 'Actualizar jornada', exact: true })
        .click()
      await panel
        .getByRole('button', { name: 'Reabrir jornada', exact: true })
        .waitFor()
      eq(
        await panel
          .getByRole('button', { name: 'Editar efectivo inicial', exact: true })
          .count(),
        0,
        'un cierre se conserva',
      )
      eq(errors, [])
      eq(fixture.failures, [])
      results.push({
        width,
        checks,
        corrections: 3,
        lostResponseRecovered: true,
        concurrencyProtected: true,
        invoicePreserved: true,
        overflow: false,
      })
    } finally {
      await context.close()
      await fixture.close()
    }
  }
  await writeFile(
    output + '/resultado.json',
    JSON.stringify({ checks, results }, null, 2),
  )
  console.log(
    `PASS navegador: ${checks} verificaciones de apertura en escritorio y móvil, recuperación y concurrencia`,
  )
} finally {
  await browser.close()
  await server?.close()
}

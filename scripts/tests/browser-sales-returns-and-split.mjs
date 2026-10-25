import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) ||
    new URL(base).origin === 'https://lcp-control.pages.dev',
)
const output = process.env.LCP_TEST_OUTPUT ?? 'output/sales-returns-split'
await mkdir(output, { recursive: true })
let checks = 0
const eq = (a, b, label) => {
  assert.deepEqual(a, b, label)
  checks++
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
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
    const fixture = await browserDatabase(page)
    // Install the isolated clock before any journey RPC prepares now(). Moving
    // the clock later then only changes its setting, as in the long-run suite.
    await fixture.db.exec('reset role')
    await fixture.db.exec(
      "create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select current_setting('lcp.browser_now')::timestamptz$$",
    )
    await fixture.db.query("select set_config('lcp.browser_now',$1,false)", [
      fixture.today + 'T14:00:00Z',
    ])
    await fixture.db.exec('set role authenticated')
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const get = async (sql, args = []) =>
      (await fixture.db.query(sql, args)).rows[0]
    const navigate = async (path) => {
      await page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      await page.locator('.main-content h1').first().waitFor()
    }
    const healthy = async (label) => {
      eq(errors, [], label + ': navegador sin errores')
      eq(fixture.failures, [], label + ': SQL/API sin errores')
      eq(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        label + ': página sin desborde',
      )
      for (const dialog of await page.getByRole('dialog').all())
        eq(
          await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
          false,
          label + ': diálogo sin desborde',
        )
    }
    try {
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
      await fixture.db.query('select public.open_business_day($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          openingNio: 1000,
          openingUsd: 0,
        }),
      ])
      await navigate('/sales')
      const details = page.locator('.document-customer-panel details')
      await details.waitFor()
      if ((await details.getAttribute('open')) === null)
        await details.locator(':scope > summary').click()
      await page
        .getByLabel('Cliente', { exact: true })
        .fill('Cliente pagos divididos')
      await page
        .getByLabel('Buscar en catálogo', { exact: true })
        .fill('Oriental')
      await page
        .getByRole('button', { name: /^Agregar Lattafa/ })
        .first()
        .click()
      await page
        .getByLabel(/^Cantidad de /)
        .first()
        .fill('4')
      await page
        .getByRole('button', { name: 'Dividir pago', exact: true })
        .click()
      const rows = page.locator('.split-payment-row')
      eq(await rows.count(), 2, 'dos tramos visibles')
      await rows
        .nth(0)
        .getByLabel('Importe recibido', { exact: true })
        .fill('464')
      await rows
        .nth(1)
        .getByLabel('Importe recibido', { exact: true })
        .fill('1000')
      await page
        .getByRole('button', { name: 'Guardar borrador', exact: true })
        .click()
      await page
        .getByText('Borrador guardado en tu cuenta.', { exact: true })
        .waitFor()
      await rows
        .nth(0)
        .getByLabel('Importe recibido', { exact: true })
        .fill('463')
      eq(
        await page.evaluate(() => {
          const event = new globalThis.Event('beforeunload', {
            cancelable: true,
          })
          globalThis.dispatchEvent(event)
          return event.defaultPrevented
        }),
        true,
        'cambiar sólo un tramo marca borrador modificado',
      )
      await rows
        .nth(0)
        .getByLabel('Importe recibido', { exact: true })
        .fill('464')
      await page.reload()
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
      await navigate('/sales')
      await page.locator('.saved-drafts button').first().click()
      if ((await details.getAttribute('open')) === null)
        await details.locator(':scope > summary').click()
      eq(
        await rows.count(),
        2,
        'borrador conserva pagos divididos tras recarga',
      )
      eq(
        await rows
          .nth(0)
          .getByLabel('Importe recibido', { exact: true })
          .inputValue(),
        '464',
        'importe de borrador restaurado',
      )
      eq(
        await rows
          .nth(1)
          .getByLabel('Importe recibido', { exact: true })
          .inputValue(),
        '1000',
        'segundo importe restaurado',
      )
      eq(
        await page
          .getByRole('button', { name: 'Emitir factura', exact: true })
          .isEnabled(),
        true,
        'total de tramos habilita emisión',
      )
      await healthy('pagos divididos')
      await page.screenshot({
        path: `${output}/pagos-${width}.png`,
        fullPage: true,
      })
      await page
        .getByRole('button', { name: 'Emitir factura', exact: true })
        .click()
      await page.getByText(/Factura FAC-.*emitida/).waitFor()
      eq(
        (await get('select count(*)::int n from public.invoice_payments')).n,
        2,
        'tramos guardados desde UI',
      )
      await page
        .getByRole('link', { name: 'Consultar facturas emitidas' })
        .click()
      await page
        .getByRole('heading', { name: 'Facturas emitidas', exact: true })
        .waitFor()
      await page
        .getByRole('button', { name: /Devolución \/ nota de crédito/ })
        .first()
        .click()
      let dialog = page.getByRole('dialog')
      const quantity = dialog.getByLabel(/disponibles: 4/)
      await quantity.waitFor()
      await quantity.fill('2')
      await dialog
        .getByLabel('Motivo de devolución', { exact: true })
        .fill('Presentación incorrecta; revisión autorizada')
      await healthy('nota de crédito')
      await page.screenshot({
        path: `${output}/nota-credito-${width}.png`,
        fullPage: true,
      })
      let responseStage = 0
      await page.route('**/rest/v1/rpc/record_sales_return', async (route) => {
        const stage = responseStage++
        if (stage > 2) return route.fallback()
        if (stage === 1)
          return route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({
              code: '42501',
              message: 'Permiso temporalmente no disponible',
            }),
          })
        if (stage === 2)
          return route.fulfill({
            status: 429,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 'LCP429',
              message: 'Espera antes de verificar',
            }),
          })
        const args = route.request().postDataJSON()
        await fixture.db.query('select public.record_sales_return($1::jsonb)', [
          JSON.stringify(args.p_input),
        ])
        await route.abort('connectionfailed')
      })
      await dialog
        .getByRole('button', { name: 'Registrar nota de crédito', exact: true })
        .click()
      await dialog
        .getByRole('button', { name: 'Verificar guardado', exact: true })
        .waitFor()
      eq(
        await dialog
          .getByLabel('Motivo de devolución', { exact: true })
          .isDisabled(),
        true,
        'datos congelados ante respuesta perdida',
      )
      for (const code of [403, 429]) {
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .click()
        await dialog.getByRole('alert').waitFor()
        await page.waitForFunction(
          () =>
            !globalThis.document.querySelector(
              '[role="dialog"] button[aria-busy="true"]',
            ),
        )
        eq(
          await dialog
            .getByLabel('Motivo de devolución', { exact: true })
            .isDisabled(),
          true,
          `respuesta ${code} al reintentar conserva datos congelados`,
        )
        eq(
          await page.evaluate(
            () =>
              JSON.parse(
                localStorage.getItem('lcp:pending-operation-ids:v1') ?? '[]',
              ).filter((r) => r.kind === 'sales-return').length,
          ),
          1,
          `respuesta ${code} conserva UUID pendiente`,
        )
      }
      await dialog
        .getByRole('button', { name: 'Verificar guardado', exact: true })
        .click()
      await page.getByText(/NC-000001 registrada/).waitFor()
      eq(
        (await get('select count(*)::int n from public.sales_returns')).n,
        1,
        'respuesta perdida y reintento no duplican NC',
      )
      eq(
        (await get('select count(*)::int n from public.documents')).n,
        1,
        'original conservado',
      )
      eq(
        (
          await get(
            "select quantity from public.inventory_balances where location='store' and product_id='aaaaaaaa-aaaa-4aaa-8aaa-000000000001'",
          )
        ).quantity,
        18,
        'dos unidades devueltas una sola vez',
      )
      await page
        .getByRole('button', { name: /Devolución \/ nota de crédito/ })
        .first()
        .click()
      dialog = page.getByRole('dialog')
      await dialog.getByText('NC-000001', { exact: true }).waitFor()
      eq(
        await dialog.getByLabel(/disponibles: 2/).getAttribute('max'),
        '2',
        'cantidad disponible refleja devolución parcial previa',
      )
      await healthy('historial y recuperación NC')
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Ver documento', exact: false })
        .first()
        .click()
      await page.getByText('Pago dividido', { exact: true }).first().waitFor()
      await healthy('relectura de factura')
      const state = (await get('select public.get_business_day(null) r')).r
      await fixture.db.query('select public.close_business_day($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          day: state.day,
          countedNio: state.report.expectedNio,
          countedUsd: state.report.expectedUsd,
          note: '',
          expectedRevision: state.revision,
          expectedStateToken: state.stateToken,
        }),
      ])
      const tomorrow = new Date(
        new Date(fixture.today + 'T12:00:00Z').getTime() + 86400000,
      )
        .toISOString()
        .slice(0, 10)
      await fixture.db.query("select set_config('lcp.browser_now',$1,false)", [
        tomorrow + 'T14:00:00Z',
      ])
      await fixture.db.query('select public.open_business_day($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          openingNio: state.report.expectedNio,
          openingUsd: 0,
        }),
      ])
      const originalItem = await get(
        'select id,document_id from public.document_items limit 1',
      )
      await fixture.db.query('select public.record_sales_return($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          documentId: originalItem.document_id,
          reason: 'Revisión en jornada siguiente',
          refundMethod: 'cash',
          items: [{ itemId: originalItem.id, quantity: 1, restock: true }],
        }),
      ])
      const negative = (
        await get('select public.report_digest($1,$1) r', [tomorrow])
      ).r
      eq(
        negative.sales.NIO.current.revenue,
        -366,
        'período de sólo NC conserva venta neta negativa',
      )
      eq(
        negative.sales.NIO.current.count,
        0,
        'NC histórica no crea factura nueva',
      )
      await navigate('/reports')
      await page.getByLabel('Desde', { exact: true }).fill(tomorrow)
      await page.getByLabel('Hasta', { exact: true }).fill(tomorrow)
      await page
        .getByText(/[-−].*366\.00/)
        .first()
        .waitFor()
      await healthy('reporte con sólo nota de crédito')
      eq(
        await page.getByText(/-1 por día/).count(),
        0,
        'una devolución sin ventas no sugiere demanda negativa para reponer',
      )
      eq(
        await page
          .locator('svg rect[height]')
          .evaluateAll((elements) =>
            elements.some(
              (el) =>
                !Number.isFinite(Number(el.getAttribute('height'))) ||
                Number(el.getAttribute('height')) < 0,
            ),
          ),
        false,
        'gráficos de NC sin alturas negativas o NaN',
      )
      await page.screenshot({
        path: `${output}/reporte-negativo-${width}.png`,
        fullPage: true,
      })
      console.log(`PASS ventas divididas, NC y respuesta perdida a ${width}px`)
    } finally {
      await fixture.close()
      await context.close()
    }
  }
  await writeFile(
    output + '/summary.json',
    JSON.stringify(
      { isolated: true, widths: [1440, 390, 320], assertions: checks },
      null,
      2,
    ),
  )
  console.log(`PASS UI ventas: ${checks} comprobaciones`)
} finally {
  await browser.close()
}

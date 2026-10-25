import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
import { admin, identity } from './database-fixture.mjs'

// El navegador carga la aplicación real; toda la API usa PostgreSQL desechable.
// No se abre, cierra ni modifica una jornada de producción.
const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5194'
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) ||
    new URL(base).origin === 'https://lcp-control.pages.dev',
)
const output = process.env.LCP_TEST_OUTPUT ?? 'output/daily-review'
await mkdir(output, { recursive: true })
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5194, strictPort: true },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let checks = 0
const results = []
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const money = (value, currency = 'NIO') =>
  new Intl.NumberFormat('es-NI', {
    style: 'currency',
    currency,
    currencyDisplay: 'code',
  }).format(value)
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      isMobile: width < 500,
      hasTouch: width < 500,
      timezoneId: 'America/Managua',
    })
    const fixture = await browserDatabase(context)
    const { db, today } = fixture
    const page = await context.newPage()
    page.setDefaultTimeout(20000)
    const errors = []
    const consoleErrors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (
        message.type() === 'error' &&
        !message.text().startsWith('Failed to load resource:')
      )
        consoleErrors.push(message.text())
    })
    const get = async (sql, args = []) => (await db.query(sql, args)).rows[0]
    const call = async (name, input) =>
      (await get(`select public.${name}($1::jsonb) r`, [JSON.stringify(input)]))
        .r
    const state = async (day = null) =>
      (await get('select public.get_business_day($1) r', [day])).r
    const login = async () => {
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
    }
    const navigate = async (path, heading) => {
      await page.evaluate((next) => {
        globalThis.history.pushState({}, '', next)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      await page.getByRole('heading', { name: heading, exact: true }).waitFor()
    }
    const rangeIs = async (from, to, message) => {
      const fromId = await page
        .getByLabel('Desde', { exact: true })
        .getAttribute('id')
      const toId = await page
        .getByLabel('Hasta', { exact: true })
        .getAttribute('id')
      await page.waitForFunction(
        ({ fromId, toId, from, to }) =>
          globalThis.document.getElementById(fromId)?.value === from &&
          globalThis.document.getElementById(toId)?.value === to,
        { fromId, toId, from, to },
      )
      equal(
        await page.getByLabel('Desde', { exact: true }).inputValue(),
        from,
        `${message}: desde`,
      )
      equal(
        await page.getByLabel('Hasta', { exact: true }).inputValue(),
        to,
        `${message}: hasta`,
      )
    }
    const healthy = async (message) => {
      equal(errors, [], `${message}: sin errores de JavaScript`)
      equal(consoleErrors, [], `${message}: sin errores de consola`)
      equal(fixture.failures, [], `${message}: sin errores de SQL/API`)
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        `${message}: página sin desbordamiento horizontal`,
      )
    }
    try {
      const yesterday = (
        await get(
          "select ((now() at time zone 'America/Managua')::date-1)::text as day",
        )
      ).day
      await db.exec(
        "reset role; create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select coalesce(nullif(current_setting('lcp.review_now',true),'')::timestamptz,statement_timestamp())$$; set role authenticated;",
      )
      const clock = (day) =>
        db.query("select set_config('lcp.review_now',$1,false)", [
          `${day}T18:00:00Z`,
        ])
      await clock(yesterday)
      let day = await call('open_business_day', {
        requestId: crypto.randomUUID(),
        expectedDay: yesterday,
        openingNio: 1000,
        openingUsd: 20,
      })
      await call('close_business_day', {
        requestId: crypto.randomUUID(),
        day: yesterday,
        expectedRevision: day.revision,
        expectedStateToken: day.stateToken,
        countedNio: 1000,
        countedUsd: 20,
        note: 'Cierre anterior de auditoría',
      })
      await clock(today)
      await call('open_business_day', {
        requestId: crypto.randomUUID(),
        expectedDay: today,
        openingNio: 1000,
        openingUsd: 20,
      })
      const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
      const invoice = (paymentMethod, quantity, currency = 'NIO') => ({
        requestId: crypto.randomUUID(),
        kind: 'invoice',
        customerName: 'Cliente revisión diaria',
        tier: 'emprendedor',
        currency,
        exchangeRate: currency === 'USD' ? 36.6 : 1,
        location: 'store',
        paymentMethod,
        notes: '',
        items: [
          {
            productId: product,
            quantity,
            expectedUnitPrice: currency === 'USD' ? 10 : 366,
          },
        ],
      })
      const cash = await call('create_document', invoice('cash', 3))
      const credit = await call('create_document', invoice('pending', 2))
      await call('create_document', invoice('bac_nio', 1))
      await call('create_document', invoice('cash', 1, 'USD'))
      await call('record_finance_entry', {
        requestId: crypto.randomUUID(),
        occurredOn: today,
        kind: 'collection',
        account: 'caja',
        amount: 200,
        currency: 'NIO',
        exchangeRate: 1,
        documentId: credit.id,
        counterparty: 'Cliente revisión diaria',
        description: 'Abono de la venta a crédito',
        reference: 'REVIEW-ABONO',
      })
      await call('record_expense', {
        requestId: crypto.randomUUID(),
        incurredOn: today,
        category: 'renta',
        description: 'Gasto diario de auditoría',
        amount: 80,
        currency: 'NIO',
        exchangeRate: 1,
        account: 'caja',
        reference: 'REVIEW-GASTO',
      })
      const detail = (
        await get('select public.invoice_return_detail($1) r', [cash.id])
      ).r
      await call('record_sales_return', {
        requestId: crypto.randomUUID(),
        documentId: cash.id,
        reason: 'Devolución parcial revisada por administración',
        refundMethod: 'cash',
        items: [{ itemId: detail.items[0].id, quantity: 1, restock: true }],
      })
      day = await state()
      equal(day.status, 'open')
      equal(day.report.invoices, 4, 'cuatro facturas efectivas')
      equal(
        day.report.netSalesNio,
        2196,
        'venta bruta 2562 menos devolución 366',
      )
      equal(
        day.report.expectedNio,
        1852,
        'caja inicial + ventas + abono - gasto - reembolso',
      )
      equal(
        day.report.expectedUsd,
        30,
        'caja inicial USD más venta de diez dólares',
      )
      equal(day.report.returnsCount, 1)
      equal(day.report.returnedNio, 366)
      const original = structuredClone(day)

      await login()
      let panel = page.locator('.business-day-panel')
      await panel
        .getByRole('heading', { name: 'Tienda abierta', exact: true })
        .waitFor()
      await panel
        .locator('.day-net-sales strong')
        .getByText(money(2196), { exact: true })
        .waitFor()
      equal(
        await panel.locator('.day-net-sales span').innerText(),
        'Venta neta del día',
      )
      for (const [label, value, currency] of [
        ['Efectivo esperado C$', 1852, 'NIO'],
        ['Efectivo esperado US$', 30, 'USD'],
      ]) {
        const metric = panel
          .locator('.day-metrics > div')
          .filter({ has: page.getByText(label, { exact: true }) })
        equal(
          await metric.locator('strong').innerText(),
          money(value, currency),
          label,
        )
      }
      equal(
        await panel
          .getByRole('link', { name: 'Ventas del día', exact: true })
          .getAttribute('href'),
        `/sales/history?day=${today}`,
      )
      equal(
        await panel
          .getByRole('link', { name: 'Cobros y pagos', exact: true })
          .getAttribute('href'),
        `/accounting?section=credits&day=${today}`,
      )
      await healthy('Inicio con venta, abono, gasto y nota de crédito')
      await page.screenshot({
        path: `${output}/inicio-${width}.png`,
        fullPage: true,
      })

      const downloadPromise = page.waitForEvent('download')
      await panel
        .getByRole('button', { name: 'Reporte diario', exact: true })
        .click()
      const download = await downloadPromise
      equal(download.suggestedFilename(), `reporte-diario-${today}.pdf`)
      const pdf = `${output}/reporte-provisional-${width}.pdf`
      await download.saveAs(pdf)
      equal((await readFile(pdf)).subarray(0, 4).toString(), '%PDF')
      equal(
        await state(),
        original,
        'descargar corte provisional no cierra ni cambia la jornada',
      )

      await panel
        .getByRole('link', { name: 'Ventas del día', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Facturas emitidas', exact: true })
        .waitFor()
      await rangeIs(today, today, 'enlace de ventas del día')
      await page
        .getByText('4 facturas en el período', { exact: true })
        .waitFor()
      equal(await page.locator('.record-card').count(), 4)
      await healthy('Historial de facturas del día')
      await navigate(`/sales/history?day=${yesterday}`, 'Facturas emitidas')
      await rangeIs(
        yesterday,
        yesterday,
        'historial misma pantalla cambia la fecha de URL',
      )
      await page
        .getByText('0 facturas en el período', { exact: true })
        .waitFor()
      await page.goBack()
      await rangeIs(
        today,
        today,
        'Atrás restaura fecha de hoy sin desmontar historial',
      )
      await page
        .getByText('4 facturas en el período', { exact: true })
        .waitFor()
      await page.goForward()
      await rangeIs(
        yesterday,
        yesterday,
        'Adelante restaura fecha anterior sin desmontar historial',
      )
      await navigate('/', 'Inicio')
      panel = page.locator('.business-day-panel')
      await panel
        .getByRole('link', { name: 'Cobros y pagos', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Contabilidad', exact: true })
        .waitFor()
      await rangeIs(today, today, 'enlace de cobros y pagos del día')
      equal(
        await page
          .getByRole('button', { name: 'Cobros y pagos', exact: true })
          .getAttribute('aria-pressed'),
        'true',
      )
      await page
        .getByRole('heading', { name: 'Abonos del período', exact: true })
        .waitFor()
      await page.getByText(/REVIEW-ABONO/).waitFor()
      equal(
        (
          await page
            .getByRole('region', { name: 'Abonos del período', exact: true })
            .innerText()
        ).includes(money(200)),
        true,
        'El abono real de 200 córdobas aparece en el día consultado',
      )
      await healthy('Cobros y pagos de la fecha exacta')
      await page.screenshot({
        path: `${output}/cobros-${width}.png`,
        fullPage: true,
      })
      await navigate(
        `/accounting?section=credits&day=${yesterday}`,
        'Contabilidad',
      )
      await rangeIs(
        yesterday,
        yesterday,
        'contabilidad misma pantalla cambia la fecha de URL',
      )
      await page
        .getByRole('heading', { name: 'Abonos del período', exact: true })
        .waitFor()
      equal(
        await page.getByText(/REVIEW-ABONO/).count(),
        0,
        'abono de hoy no aparece ayer',
      )
      await navigate(`/accounting?section=journal&day=${today}`, 'Contabilidad')
      await rangeIs(today, today, 'cambiar URL actualiza fecha de comprobantes')
      equal(
        await page
          .getByRole('button', { name: 'Comprobantes', exact: true })
          .getAttribute('aria-pressed'),
        'true',
        'sección de URL cambia sin desmontar contabilidad',
      )
      await page.goBack()
      await rangeIs(yesterday, yesterday, 'Atrás restaura día de contabilidad')
      equal(
        await page
          .getByRole('button', { name: 'Cobros y pagos', exact: true })
          .getAttribute('aria-pressed'),
        'true',
        'Atrás restaura sección de cobros',
      )
      await page.goForward()
      await rangeIs(today, today, 'Adelante restaura fecha de contabilidad')
      equal(
        await page
          .getByRole('button', { name: 'Comprobantes', exact: true })
          .getAttribute('aria-pressed'),
        'true',
        'Adelante restaura sección de comprobantes',
      )
      await page.getByLabel('Desde', { exact: true }).fill(yesterday)
      await page
        .getByRole('button', { name: 'Cobros y pagos', exact: true })
        .click()
      await rangeIs(
        yesterday,
        today,
        'cambiar pestaña conserva las fechas ajustadas a mano',
      )

      await navigate('/reports', 'Reportes')
      await page.getByRole('button', { name: 'Hoy', exact: true }).click()
      await rangeIs(today, today, 'Reportes Hoy con calendario de Managua')
      equal(
        await page
          .getByRole('button', { name: 'Hoy', exact: true })
          .getAttribute('aria-pressed'),
        'true',
      )
      await healthy('Reportes Hoy')

      await navigate('/', 'Inicio')
      panel = page.locator('.business-day-panel')
      const historicalOriginal = await state(yesterday)
      const historicalWithoutNet = async (route) => {
        if (route.request().postDataJSON()?.p_day !== yesterday)
          return route.fallback()
        const historical = await state(yesterday)
        delete historical.report.netSalesNio
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(historical),
        })
      }
      await page.route('**/rest/v1/rpc/get_business_day', historicalWithoutNet)
      await panel
        .getByLabel('Consultar jornada', { exact: true })
        .fill(yesterday)
      await panel
        .getByRole('heading', { name: 'Jornada cerrada', exact: true })
        .waitFor()
      equal(
        await panel.locator('.day-net-sales strong').innerText(),
        'Sin dato',
        'Un cierre histórico sin venta neta congelada no inventa un cero',
      )
      const historicalDownloadPromise = page.waitForEvent('download')
      await panel
        .getByRole('button', { name: 'Reporte diario', exact: true })
        .click()
      const historicalDownload = await historicalDownloadPromise
      const historicalPdf = `${output}/historico-sin-neto-${width}.pdf`
      await historicalDownload.saveAs(historicalPdf)
      equal((await readFile(historicalPdf)).subarray(0, 4).toString(), '%PDF')
      equal(
        await state(yesterday),
        historicalOriginal,
        'Leer un cierre antiguo sin neto y descargarlo no modifica su informe original',
      )
      await page.unroute(
        '**/rest/v1/rpc/get_business_day',
        historicalWithoutNet,
      )
      equal(
        await panel
          .getByRole('link', { name: 'Ventas del día', exact: true })
          .getAttribute('href'),
        `/sales/history?day=${yesterday}`,
      )
      equal(
        await panel
          .getByRole('link', { name: 'Cobros y pagos', exact: true })
          .getAttribute('href'),
        `/accounting?section=credits&day=${yesterday}`,
      )
      await panel
        .getByRole('link', { name: 'Ventas del día', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Facturas emitidas', exact: true })
        .waitFor()
      await rangeIs(
        yesterday,
        yesterday,
        'fecha consultada anterior propagada a ventas',
      )
      await page
        .getByText('0 facturas en el período', { exact: true })
        .waitFor()
      equal(
        await page.locator('.record-card').count(),
        0,
        'ayer no mezcla ventas de hoy',
      )

      for (const query of ['invalida', '2026-02-30', '2999-01-01']) {
        await navigate('/', 'Inicio')
        await navigate(`/sales/history?day=${query}`, 'Facturas emitidas')
        await rangeIs(
          today.slice(0, 7) + '-01',
          today,
          `historial rechaza fecha ${query}`,
        )
        await navigate('/', 'Inicio')
        await navigate(
          `/accounting?section=credits&day=${query}`,
          'Contabilidad',
        )
        await rangeIs(
          today.slice(0, 7) + '-01',
          today,
          `contabilidad rechaza fecha ${query}`,
        )
      }

      const failProducts = (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Lectura de catálogo temporalmente no disponible',
          }),
        })
      await page.route('**/rest/v1/products?**', failProducts)
      await navigate('/', 'Inicio')
      panel = page.locator('.business-day-panel')
      await panel
        .getByRole('heading', { name: 'Tienda abierta', exact: true })
        .waitFor()
      equal(
        await panel
          .getByRole('button', { name: 'Actualizar jornada', exact: true })
          .isVisible(),
        true,
        'fallo catálogo no oculta jornada',
      )
      equal(
        await panel
          .getByRole('button', { name: 'Reporte diario', exact: true })
          .isVisible(),
        true,
        'fallo catálogo permite corte provisional',
      )
      await panel
        .getByRole('button', { name: 'Actualizar jornada', exact: true })
        .click()
      await panel
        .getByRole('heading', { name: 'Tienda abierta', exact: true })
        .waitFor()
      equal(
        await panel.locator('.day-net-sales strong').innerText(),
        money(2196),
      )
      await healthy('Jornada disponible con fallo de inventario')
      await page.unroute('**/rest/v1/products?**', failProducts)

      await db.exec('reset role')
      await db.query(
        "update public.staff_members set role='operator' where user_id=$1",
        [admin],
      )
      await identity(db, admin)
      await login()
      panel = page.locator('.business-day-panel')
      await panel
        .getByRole('heading', { name: 'Tienda abierta', exact: true })
        .waitFor()
      equal(
        await panel.locator('.day-metrics').count(),
        0,
        'vendedor no ve caja global',
      )
      equal(
        await panel
          .getByRole('link', { name: 'Cobros y pagos', exact: true })
          .count(),
        0,
        'vendedor no recibe enlace contable administrativo',
      )
      equal(
        await panel
          .getByRole('button', { name: 'Reporte diario', exact: true })
          .count(),
        0,
        'vendedor no descarga caja global',
      )
      equal(
        await panel.getByLabel('Consultar jornada', { exact: true }).count(),
        0,
        'vendedor no consulta otras jornadas',
      )
      await healthy('Permisos de vendedor')
      results.push({
        width,
        status: 'correcto',
        netSalesNio: 2196,
        expectedNio: 1852,
        expectedUsd: 30,
      })
      console.log(
        `PASS consulta diaria ${width}px: cifras, NC, abonos, filtros exactos, PDF provisional, fechas inválidas, catálogo fallido y permisos`,
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
            errors,
            consoleErrors,
            failures: fixture.failures,
            url: page.url(),
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
  console.log(`Consulta diaria: ${checks} comprobaciones correctas.`)
} finally {
  await browser.close()
  await server?.close()
}

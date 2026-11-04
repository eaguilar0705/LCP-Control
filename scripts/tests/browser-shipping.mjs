import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5194'
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]', 'lcp-control.pages.dev'].includes(
    new URL(base).hostname,
  ),
)
const output = 'output/shipping-review'
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
const equal = (actual, expected, label) => {
  assert.deepEqual(actual, expected, label)
  checks++
}
function pdfText(bytes) {
  const source = bytes.toString('latin1')
  let content = ''
  const streams = /stream\r?\n/g
  while (streams.exec(source) !== null) {
    const end = source.indexOf('endstream', streams.lastIndex)
    if (end < 0) break
    try {
      content += inflateSync(bytes.subarray(streams.lastIndex, end)).toString(
        'latin1',
      )
    } catch {
      // Image streams use other filters; only text streams matter here.
    }
    streams.lastIndex = end + 9
  }
  return content
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
    const fixture = await browserDatabase(page)
    // Sidebar catalog counts are outside this invoice fixture.
    await page.route('**/rest/v1/storefront_drafts*', (route) =>
      route.request().method() === 'HEAD'
        ? route.fulfill({
            status: 200,
            headers: { 'content-range': '*/0' },
            body: '',
          })
        : route.fallback(),
    )
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const get = async (sql, args = []) =>
      (await fixture.db.query(sql, args)).rows[0]
    const navigate = async (path, title) => {
      await page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      await page.getByRole('heading', { name: title, exact: true }).waitFor()
    }
    const login = async () => {
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
    const openCustomer = async () => {
      const details = page.locator('.document-customer-panel details')
      await details.waitFor()
      if ((await details.getAttribute('open')) === null)
        await details.locator(':scope > summary').click()
    }
    try {
      await fixture.db.query('select public.open_business_day($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          openingNio: 1000,
          openingUsd: 0,
        }),
      ])
      await page.goto(base + '/login')
      await login()
      await navigate('/sales', 'Facturación')
      await page.getByLabel('Tipo de envío', { exact: true }).waitFor()
      equal(
        await page.getByLabel('Tipo de envío', { exact: true }).isVisible(),
        true,
        'envío junto al total sin desplegar datos del cliente',
      )
      await openCustomer()
      await page
        .getByLabel('Cliente', { exact: true })
        .fill('Cliente envío ' + width)
      await page
        .getByLabel('Buscar en catálogo', { exact: true })
        .fill('QA-0001')
      await page
        .getByRole('button', { name: /^Agregar Lattafa/ })
        .first()
        .click()
      await page
        .getByLabel('Tipo de envío', { exact: true })
        .selectOption('cargotrans')
      await page.getByLabel('Cobro por envío (C$)', { exact: true }).fill('80')
      await page.getByLabel('Moneda', { exact: true }).selectOption('USD')
      equal(
        await page
          .getByLabel('Cobro por envío (US$)', { exact: true })
          .inputValue(),
        '0',
        'cambio de moneda reinicia cobro',
      )
      await page
        .getByLabel('Cobro por envío (US$)', { exact: true })
        .fill('2.5')
      await page.getByLabel('Moneda', { exact: true }).selectOption('NIO')
      equal(
        await page
          .getByLabel('Cobro por envío (C$)', { exact: true })
          .inputValue(),
        '0',
        'volver a NIO no reinterpreta dólares',
      )
      await page
        .getByLabel('Cobro por envío (C$)', { exact: true })
        .fill('80.001')
      equal(
        await page
          .getByRole('button', { name: 'Emitir factura', exact: true })
          .isDisabled(),
        true,
        'monto con fracción de centavo bloquea emisión',
      )
      await page.getByLabel('Cobro por envío (C$)', { exact: true }).fill('80')
      await page
        .getByLabel('Forma de pago', { exact: true })
        .selectOption('bac_nio')
      equal(
        (await page.locator('.invoice-total strong').innerText()).replace(
          /\s/g,
          ' ',
        ),
        'NIO 446.00',
        'total suma envío',
      )
      await page
        .getByRole('button', { name: 'Guardar borrador', exact: true })
        .click()
      await page
        .getByText('Borrador guardado en tu cuenta.', { exact: true })
        .waitFor()
      await page.reload()
      await login()
      await navigate('/sales', 'Facturación')
      await page.locator('.saved-drafts button').first().click()
      equal(
        await page.getByLabel('Tipo de envío', { exact: true }).inputValue(),
        'cargotrans',
        'borrador conserva tipo',
      )
      equal(
        await page
          .getByLabel('Cobro por envío (C$)', { exact: true })
          .inputValue(),
        '80',
        'borrador conserva monto',
      )
      await openCustomer()
      await page.screenshot({
        path: `${output}/factura-envio-${width}.png`,
        fullPage: true,
      })
      await page
        .getByRole('button', { name: 'Emitir factura', exact: true })
        .click()
      await page.getByText(/Factura FAC-.*emitida/).waitFor()
      const document = await get(
        'select id,number,total,shipping_amount,shipping_method from public.documents',
      )
      equal(Number(document.total), 446, 'factura definitiva incluye envío')
      equal(Number(document.shipping_amount), 80, 'importe guardado')
      equal(document.shipping_method, 'cargotrans', 'tipo guardado')
      equal(
        (
          await get(
            'select quantity from public.inventory_balances where product_id=$1 and location=$2',
            ['aaaaaaaa-aaaa-4aaa-8aaa-000000000001', 'store'],
          )
        ).quantity,
        19,
        'envío no modifica inventario',
      )
      const ledger = (
        await get('select public.ledger_report($1,$1) r', [fixture.today])
      ).r
      equal(
        Number(ledger.accounts.find((row) => row.code === '2117').credit),
        80,
        'ingreso separado envío',
      )
      equal(
        Number(ledger.accounts.find((row) => row.code === '1120-001').debit),
        446,
        'total entra a BAC NIO',
      )
      await page
        .getByRole('link', { name: 'Consultar facturas emitidas' })
        .click()
      await page
        .getByRole('heading', { name: 'Facturas emitidas', exact: true })
        .waitFor()
      await page
        .getByRole('button', { name: 'Ver documento', exact: false })
        .first()
        .click()
      const printed = page.locator('.letter-document').first()
      await printed
        .getByText('Envío · CargoTrans', { exact: true })
        .waitFor({ state: 'attached' })
      equal(
        (await printed.locator('.letter-grand-total b').innerText()).replace(
          /\s/g,
          ' ',
        ),
        'NIO 446.00',
        'historial conserva total',
      )
      const downloadPromise = page.waitForEvent('download')
      await page
        .getByRole('button', { name: 'Descargar PDF', exact: true })
        .click()
      const download = await downloadPromise
      const pdfPath = `${output}/factura-envio-${width}.pdf`
      await download.saveAs(pdfPath)
      const { readFile } = await import('node:fs/promises')
      const text = pdfText(await readFile(pdfPath))
      equal(text.includes('CargoTrans'), true, 'PDF desglosa tipo de envío')
      equal(text.includes('80.00'), true, 'PDF desglosa importe de envío')
      equal(text.includes('446.00'), true, 'PDF conserva total')
      await navigate('/accounting', 'Contabilidad')
      await page
        .getByRole('button', { name: 'Comprobante de egreso', exact: true })
        .waitFor()
      equal(
        await page
          .getByRole('button', { name: 'Pago de envío', exact: true })
          .count(),
        0,
        'no se prepara automáticamente un gasto de envío',
      )
      await page
        .getByRole('button', { name: 'Comprobante de egreso', exact: true })
        .click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      await dialog.getByLabel('Cuenta 1', { exact: true }).selectOption('2117')
      await dialog
        .getByLabel('Cuenta 2', { exact: true })
        .selectOption('1120-001')
      await dialog.getByLabel('Debe', { exact: true }).nth(0).fill('70')
      await dialog.getByLabel('Haber', { exact: true }).nth(1).fill('70')
      await dialog
        .getByLabel('Concepto', { exact: true })
        .fill('Pago CargoTrans ' + document.number)
      await page.screenshot({
        path: `${output}/pago-envio-${width}.png`,
        fullPage: true,
      })
      await dialog
        .getByRole('button', { name: 'Guardar comprobante', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      const after = (
        await get('select public.ledger_report($1,$1) r', [fixture.today])
      ).r
      equal(
        Number(after.accounts.find((row) => row.code === '5130-011').debit),
        0,
        'el pago de la deuda no genera gasto',
      )
      equal(
        Number(after.accounts.find((row) => row.code === '2117').closing),
        -10,
        'queda la diferencia por aplicar manualmente',
      )
      equal(
        Number(after.accounts.find((row) => row.code === '4190-001').credit),
        0,
        'no hay ingreso automático por gestión',
      )
      equal(
        Number(after.accounts.find((row) => row.code === '1120-001').credit),
        70,
        'egreso sale de BAC NIO',
      )
      const digest = (
        await get('select public.report_digest($1,$1) r', [fixture.today])
      ).r
      equal(digest.ledger.shippingNio, 80, 'reportes incluyen cobro del envío')
      equal(
        digest.ledger.shippingExpenseNio,
        0,
        'pago contra pasivo no figura como gasto',
      )
      await page
        .getByRole('button', { name: 'Comprobante de ajuste', exact: true })
        .click()
      await dialog.getByLabel('Cuenta 1', { exact: true }).selectOption('2117')
      await dialog
        .getByLabel('Cuenta 2', { exact: true })
        .selectOption('4190-001')
      await dialog.getByLabel('Debe', { exact: true }).nth(0).fill('10')
      await dialog.getByLabel('Haber', { exact: true }).nth(1).fill('10')
      await dialog
        .getByLabel('Concepto', { exact: true })
        .fill('Gestión de envíos registrada manualmente')
      await dialog
        .getByRole('button', { name: 'Guardar comprobante', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      const managed = (
        await get('select public.ledger_report($1,$1) r', [fixture.today])
      ).r
      equal(
        Number(managed.accounts.find((row) => row.code === '2117').closing),
        0,
        'ajuste manual liquida la diferencia',
      )
      equal(
        Number(managed.accounts.find((row) => row.code === '4190-001').credit),
        10,
        'gestión ingresada manualmente',
      )
      await page
        .getByRole('button', { name: 'Catálogo de cuentas', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Catálogo de cuentas', exact: true })
        .waitFor()
      const catalog = page.locator('table.accounting-catalog')
      equal(
        await catalog.getByText('4120', { exact: true }).count(),
        0,
        'cuenta anterior retirada del catálogo',
      )
      equal(await catalog.getByText('2117', { exact: true }).count(), 1)
      equal(await catalog.getByText('4190-001', { exact: true }).count(), 1)
      equal(
        await catalog.getByText('5130-011', { exact: true }).count(),
        1,
        'se conserva el gasto que solicitó Miguel',
      )
      equal(errors, [], 'navegador sin errores')
      equal(fixture.failures, [], 'API aislada sin errores')
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        'sin desborde en móvil',
      )
      await page.screenshot({
        path: `${output}/contabilidad-envio-${width}.png`,
        fullPage: true,
      })
      if (width === 1440) {
        await navigate('/proformas', 'Proformas')
        await openCustomer()
        await page
          .getByLabel('Cliente', { exact: true })
          .fill('Cliente proforma envío')
        await page
          .getByLabel('Buscar en catálogo', { exact: true })
          .fill('QA-0001')
        await page
          .getByRole('button', { name: /^Agregar Lattafa/ })
          .first()
          .click()
        await page.getByLabel('Moneda', { exact: true }).selectOption('USD')
        await page
          .getByLabel('Tipo de envío', { exact: true })
          .selectOption('moto')
        await page
          .getByLabel('Cobro por envío (US$)', { exact: true })
          .fill('2')
        await page
          .getByLabel('Tipo de cambio (NIO por 1 USD)', { exact: true })
          .fill('')
        equal(
          await page
            .getByRole('button', { name: 'Emitir proforma', exact: true })
            .isDisabled(),
          true,
          'proforma con envío exige tasa',
        )
        await page
          .getByText('Registra el tipo de cambio para el envío.', {
            exact: true,
          })
          .waitFor()
        await page
          .getByLabel('Tipo de cambio (NIO por 1 USD)', { exact: true })
          .fill('36.6')
        equal(
          await page
            .getByRole('button', { name: 'Emitir proforma', exact: true })
            .isEnabled(),
          true,
          'tasa válida permite proforma con envío',
        )
      }
    } finally {
      await context.close()
      await fixture.close()
    }
  }
} finally {
  await browser.close()
  await server?.close()
}
await writeFile(
  `${output}/resultado.json`,
  JSON.stringify({ checks, widths: [1440, 390, 320] }, null, 2),
)
console.log(`${checks} comprobaciones de envío en factura, PDF y contabilidad.`)

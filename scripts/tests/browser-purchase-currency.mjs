import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { browserDatabase } from './browser-database.mjs'
import { identity, admin } from './database-fixture.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5201'
assert.ok(
  ['127.0.0.1', 'lcp-control.pages.dev'].includes(new URL(base).hostname),
)
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5201, strictPort: true },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
await mkdir('output/purchase-currency-review', { recursive: true })
let checks = 0
const eq = (a, b, m) => {
  assert.deepEqual(a, b, m)
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
    const fixture = await browserDatabase(page),
      errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const one = async (sql, args = []) =>
      (await fixture.db.query(sql, args)).rows[0]
    const rpc = async (name, p) =>
      (
        await one('select public.' + name + '($1::jsonb) r', [
          JSON.stringify({ requestId: crypto.randomUUID(), ...p }),
        ])
      ).r
    const navigate = (path) =>
      page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
    const setRate = async (rate) => {
      await fixture.db.exec('reset role')
      await fixture.db.query(
        'update public.exchange_rates set accounting_usd_to_nio=$1',
        [rate],
      )
      await identity(fixture.db, admin)
    }
    const healthy = async () => {
      eq(errors, [])
      eq(fixture.failures, [])
      eq(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
      )
      for (const d of await page.getByRole('dialog').all())
        eq(await d.evaluate((e) => e.scrollWidth > e.clientWidth + 1), false)
    }
    try {
      const products = [
        'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
        'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
      ]
      await setRate(37)
      await rpc('open_business_day', {
        expectedDay: fixture.today,
        openingNio: 1000,
        openingUsd: 0,
      })
      const receipt = await rpc('record_shipment', {
        incurredOn: fixture.today,
        supplier: 'Proveedor Auditoría',
        agency: '',
        reference: 'COSTOS-21360',
        note: '',
        currency: 'NIO',
        exchangeRate: 1,
        shippingAmount: 0,
        account: 'pending',
        lines: products.map((productId, i) => ({
          productId,
          location: 'store',
          quantity: 12,
          unitPrice: i === 0 ? 940 : 840,
        })),
      })
      const original = (
        await one("select public.receipt_edit_context($1)->'receipt' r", [
          receipt,
        ])
      ).r
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
      await navigate('/accounting')
      await page
        .getByRole('button', { name: 'Editar recepción', exact: true })
        .click()
      let dialog = page.getByRole('dialog', {
        name: 'Editar recepción de mercancía',
        exact: true,
      })
      let summary = dialog.locator('[aria-label="Importes de la compra"]')
      await summary.waitFor()
      eq(
        await dialog
          .getByLabel('Costo unitario 1', { exact: true })
          .inputValue(),
        '940',
      )
      eq(
        await dialog
          .getByLabel('Costo unitario 2', { exact: true })
          .inputValue(),
        '840',
      )
      eq((await summary.innerText()).includes('21,360.00'), true)
      eq((await summary.innerText()).includes('577.30'), true)
      await healthy()
      await summary.scrollIntoViewIfNeeded()
      await page.screenshot({
        path: `output/purchase-currency-review/compra-${width}.png`,
        fullPage: true,
      })
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      await setRate(38.5)
      await page
        .getByRole('button', { name: 'Editar recepción', exact: true })
        .click()
      dialog = page.getByRole('dialog', {
        name: 'Editar recepción de mercancía',
        exact: true,
      })
      summary = dialog.locator('[aria-label="Importes de la compra"]')
      await summary.waitFor()
      eq(
        (await summary.innerText()).includes('554.81'),
        true,
        'la equivalencia usa la nueva tasa del sistema',
      )
      eq(
        (await summary.innerText()).includes('21,360.00'),
        true,
        'el total original sigue siendo C$21,360',
      )
      await dialog
        .getByLabel('Moneda de compra', { exact: true })
        .selectOption('USD')
      eq(
        await dialog
          .getByLabel('Tipo de cambio de la compra', { exact: true })
          .inputValue(),
        '38.5',
        'no reutiliza el 1 contable de una compra NIO',
      )
      await dialog
        .getByLabel('Moneda de compra', { exact: true })
        .selectOption('NIO')
      eq((await summary.innerText()).includes('21,360.00'), true)
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      eq(
        (
          await one("select public.receipt_edit_context($1)->'receipt' r", [
            receipt,
          ])
        ).r,
        original,
        'consultar equivalencias y cambiar opciones sin guardar no altera el documento',
      )
      await rpc('record_shipment', {
        incurredOn: fixture.today,
        supplier: 'Proveedor Auditoría',
        agency: '',
        reference: 'USD-HIST',
        note: '',
        currency: 'USD',
        exchangeRate: 36.6,
        shippingAmount: 0,
        account: 'pending',
        lines: [
          {
            productId: products[0],
            location: 'store',
            quantity: 1,
            unitPrice: 100,
          },
        ],
      })
      await navigate('/inventory')
      await navigate('/accounting')
      await page
        .locator('.classification-receipts article')
        .filter({ hasText: 'USD-HIST' })
        .getByRole('button', { name: 'Editar recepción', exact: true })
        .click()
      dialog = page.getByRole('dialog', {
        name: 'Editar recepción de mercancía',
        exact: true,
      })
      await dialog
        .getByLabel('Tipo de cambio de la compra', { exact: true })
        .waitFor()
      eq(
        await dialog
          .getByLabel('Tipo de cambio de la compra', { exact: true })
          .inputValue(),
        '36.6',
        'conserva la tasa de un documento USD histórico',
      )
      await dialog
        .getByRole('button', {
          name: 'Usar tipo de cambio actual',
          exact: true,
        })
        .click()
      eq(
        await dialog
          .getByLabel('Tipo de cambio de la compra', { exact: true })
          .inputValue(),
        '38.5',
      )
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      await navigate('/inventory')
      await page.getByRole('button', { name: 'Compras', exact: true }).click()
      await page
        .getByRole('dialog', { name: 'Historial de compras', exact: true })
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      dialog = page.getByRole('dialog', {
        name: 'Registrar compra',
        exact: true,
      })
      await dialog
        .getByLabel('Moneda de la compra', { exact: true })
        .selectOption('USD')
      eq(
        await dialog
          .getByLabel('Tasa del pedido (C$ por dólar)', { exact: true })
          .inputValue(),
        '38.5',
        'las compras nuevas toman la tasa actual',
      )
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      await page
        .getByRole('dialog', { name: 'Historial de compras', exact: true })
        .getByRole('button', { name: 'Cerrar', exact: true })
        .click()
      await page.route('**/rest/v1/exchange_rates*', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 300))
        return route.fallback()
      })
      await page
        .getByRole('button', { name: 'Recibir mercadería', exact: true })
        .click()
      dialog = page.getByRole('dialog', {
        name: 'Recibir mercadería',
        exact: true,
      })
      await dialog
        .getByLabel('Moneda de la compra', { exact: true })
        .selectOption('USD')
      await page.waitForFunction(() =>
        [...globalThis.document.querySelectorAll('input')].some(
          (input) => input.value === '38.5',
        ),
      )
      eq(
        await dialog
          .getByLabel('Tasa del pedido (C$ por dólar)', { exact: true })
          .inputValue(),
        '38.5',
        'la recepción toma la tasa aunque se seleccione USD antes de terminar su carga',
      )
      await healthy()
      console.log(`PASS compras y tipo de cambio ${width}px`)
    } catch (e) {
      await page.screenshot({
        path: `output/purchase-currency-review/error-${width}.png`,
        fullPage: true,
      })
      console.error(await page.locator('body').innerText(), fixture.failures)
      throw e
    } finally {
      await fixture.close()
      await context.close()
    }
  }
  console.log(
    `PASS ${checks} comprobaciones de conversión y compras; API y datos aislados`,
  )
} finally {
  await browser.close()
  await server?.close()
}

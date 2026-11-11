import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { browserDatabase } from './browser-database.mjs'
import { identity, admin } from './database-fixture.mjs'

const server = await createServer({
  configFile: 'frontend/vite.config.ts',
  // Configuración ficticia: browserDatabase intercepta todas sus solicitudes.
  define: {
    'import.meta.env.VITE_DATA_MODE': JSON.stringify('supabase'),
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(
      'https://lcp-tests.supabase.co',
    ),
    'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(
      'sb_publishable_local_test_only',
    ),
  },
  server: { host: '127.0.0.1', port: 5211, strictPort: true },
})
await server.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
await mkdir('output/exchange-rates-review', { recursive: true })
let checks = 0
const eq = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
}
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      timezoneId: 'America/Managua',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const fixture = await browserDatabase(page)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const one = async (sql) => (await fixture.db.query(sql)).rows[0]
    const rates = async () => {
      const r = await one(
        'select usd_to_nio,accounting_usd_to_nio from public.exchange_rates',
      )
      return [Number(r.usd_to_nio), Number(r.accounting_usd_to_nio)]
    }
    const price = async () =>
      Number(
        (
          await one(
            "select amount from public.product_prices where product_id='aaaaaaaa-aaaa-4aaa-8aaa-000000000001' and tier_code='emprendedor' and currency='USD'",
          )
        ).amount,
      )
    const navigate = async (path) => {
      await page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
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
        `sin desbordamiento a ${width}px`,
      )
    }
    const change = async (accounting, value) => {
      const label = accounting ? 'Actualizar tasa contable' : 'Actualizar tasa'
      await page
        .getByLabel(
          accounting
            ? 'Córdobas por 1 dólar en contabilidad'
            : 'Córdobas por 1 dólar',
          { exact: true },
        )
        .fill(String(value))
      await page.getByRole('button', { name: label, exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: label, exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      await page
        .getByRole('status')
        .filter({
          hasText: accounting
            ? 'contable actualizado'
            : 'inventario actualizado',
        })
        .waitFor()
    }
    try {
      await fixture.db.exec(`reset role;
        update public.exchange_rates set usd_to_nio=36.6243,accounting_usd_to_nio=37;
        insert into public.product_pricing(product_id,purchase_price,purchase_currency,markup_emprendedor,markup_vip,markup_premium,updated_by)
        values('aaaaaaaa-aaaa-4aaa-8aaa-000000000001',705,'NIO',20,20,20,'11111111-1111-4111-8111-111111111111');
        select private.reprice_catalog(36.6243);`)
      await identity(fixture.db, admin)
      await page.goto('http://127.0.0.1:5211/login')
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
      await navigate('/settings')
      await page
        .getByRole('heading', {
          name: 'Tipo de cambio de inventario',
          exact: true,
        })
        .waitFor()
      await page
        .getByRole('heading', { name: 'Tipo de cambio contable', exact: true })
        .waitFor()
      eq(await rates(), [36.6243, 37])
      await change(true, 38.5)
      eq(await rates(), [36.6243, 38.5])
      eq(await price(), 24)
      await change(false, 37)
      eq(await rates(), [37, 38.5])
      eq(await price(), 23)
      await change(false, 36.6243)
      await change(true, 37)
      eq(await rates(), [36.6243, 37])
      eq(await price(), 24)
      await healthy()
      await page.screenshot({
        path: `output/exchange-rates-review/settings-${width}.png`,
        fullPage: true,
      })
      await navigate('/products/aaaaaaaa-aaaa-4aaa-8aaa-000000000001/edit')
      await page.getByLabel('Precio de compra', { exact: true }).waitFor()
      eq(
        await page.getByLabel('Precio de compra', { exact: true }).inputValue(),
        '705',
      )
      eq(
        (
          await page
            .getByRole('group', { name: 'Emprendedor', exact: true })
            .locator('.pricing-sale')
            .innerText()
        )
          .replaceAll('\u00a0', ' ')
          .includes('USD 24.00'),
        true,
      )
      await page
        .getByText(
          'Tipo de cambio de inventario: C$ 36.6243 por US$1. Se edita en Negocio.',
          { exact: true },
        )
        .waitFor()
      await healthy()
      await page.screenshot({
        path: `output/exchange-rates-review/product-${width}.png`,
        fullPage: true,
      })
      await navigate('/sales')
      await page
        .locator('.price-controls')
        .getByLabel('Moneda', { exact: true })
        .selectOption('USD')
      eq(
        await page
          .getByLabel('Tipo de cambio (NIO por 1 USD)', { exact: true })
          .inputValue(),
        '37',
        'la factura propone la tasa contable',
      )
      await healthy()
      await navigate('/accounting?section=trial')
      await page
        .getByLabel('Moneda del reporte', { exact: true })
        .selectOption('USD')
      await page
        .locator('.statement-heading')
        .getByText(/Tasa contable: C\$37 por US\$1/)
        .waitFor()
      eq(await rates(), [36.6243, 37])
      await healthy()
    } catch (error) {
      console.error({
        url: page.url(),
        errors,
        failures: fixture.failures,
        page: (await page.locator('body').innerText()).slice(0, 3000),
      })
      await page.screenshot({
        path: `output/exchange-rates-review/failure-${width}.png`,
        fullPage: true,
      })
      throw error
    } finally {
      await context.close()
      await fixture.close()
    }
  }
  console.log(
    `Tasas en Chrome: ${checks} comprobaciones correctas a 1440, 390 y 320 px.`,
  )
} finally {
  await browser.close()
  await server.close()
}

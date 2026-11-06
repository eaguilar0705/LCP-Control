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
await mkdir('output/count-purchase-review', { recursive: true })
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
    const fixture = await browserDatabase(page)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const one = async (sql, args = []) =>
      (await fixture.db.query(sql, args)).rows[0]
    const rpc = async (name, input) =>
      (
        await one('select public.' + name + '($1::jsonb) r', [
          JSON.stringify(input),
        ])
      ).r
    const navigate = async (path) =>
      page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
    try {
      const products = [
        'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
        'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
      ]
      await fixture.db.exec('reset role')
      await fixture.db.query(
        'update public.inventory_balances set quantity=0 where product_id=any($1::uuid[])',
        [products],
      )
      await fixture.db.query(
        "update public.products set name=case when id=$1 then 'Club de nuit intense' else 'Odyssey Mandaryn sky' end where id=any($2::uuid[])",
        [products[0], products],
      )
      await identity(fixture.db, admin)
      await rpc('open_business_day', {
        requestId: crypto.randomUUID(),
        expectedDay: fixture.today,
        openingNio: 1000,
        openingUsd: 0,
      })
      for (const productId of products)
        await rpc('record_inventory_movement', {
          requestId: crypto.randomUUID(),
          productId,
          location: 'store',
          type: 'ADJUSTMENT',
          quantity: 12,
          expectedQuantity: 0,
          note: 'Conteo físico',
        })
      const original = (
        await one('select sum(quantity)::int q from public.inventory_balances')
      ).q
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
      await navigate('/inventory')
      await page
        .getByRole('link', { name: 'Movimientos', exact: true })
        .first()
        .click()
      await page
        .locator('.movement-record')
        .filter({ hasText: 'Club de nuit intense' })
        .waitFor()
      eq(
        await page.locator('.movement-record').count(),
        2,
        'los dos ingresos aparecen en el día correcto',
      )
      eq(
        await page.getByLabel('Fecha de movimientos').inputValue(),
        fixture.today,
      )
      eq(
        await page
          .locator('.movement-record')
          .filter({ hasText: 'Club de nuit intense' })
          .locator('.movement-quantity strong')
          .innerText(),
        '0 → 12',
      )
      const productRow = page
        .locator('.movement-record')
        .filter({ hasText: 'Club de nuit intense' })
      await productRow
        .getByRole('link', { name: 'Ajustar existencias actuales' })
        .click()
      await page.getByLabel('Ubicación de las cantidades').waitFor()
      eq(
        await page.getByLabel('Ubicación de las cantidades').inputValue(),
        'store',
      )
      eq(
        (
          await one(
            'select sum(quantity)::int q from public.inventory_balances',
          )
        ).q,
        original,
        'abrir la edición no cambia existencias',
      )
      await navigate('/inventory/history')
      await page
        .locator('.movement-record')
        .filter({ hasText: 'Club de nuit intense' })
        .waitFor()
      let lose = true
      await page.route(
        '**/rest/v1/rpc/adopt_inventory_counts_as_purchase',
        async (route) => {
          if (!lose) return route.fallback()
          lose = false
          await rpc(
            'adopt_inventory_counts_as_purchase',
            route.request().postDataJSON().p_input,
          )
          return route.abort('failed')
        },
      )
      await page
        .locator('.movement-record')
        .filter({ hasText: 'Club de nuit intense' })
        .getByRole('button', { name: 'Revisar ingreso como compra' })
        .click()
      const confirmation = page.getByRole('dialog', {
        name: 'Registrar compra ya ingresada',
      })
      await confirmation.getByRole('checkbox').check()
      await confirmation
        .getByRole('button', {
          name: 'Registrar como compra sin duplicar unidades',
        })
        .click()
      await confirmation
        .getByRole('button', { name: 'Verificar guardado' })
        .click()
      const editor = page.getByRole('dialog', {
        name: 'Editar recepción de mercancía',
      })
      await editor.waitFor()
      await editor.getByLabel('Proveedor').waitFor()
      eq(
        (await one('select count(*)::int n from public.purchase_shipments')).n,
        1,
        'recuperar el guardado no duplica la compra',
      )
      eq(
        (
          await one(
            'select sum(quantity)::int q from public.inventory_balances',
          )
        ).q,
        original,
        'regularizar conserva todas las existencias',
      )
      eq(
        (await one('select count(*)::int n from public.finance_entries')).n,
        0,
        'no se inventa un pago',
      )
      await page.screenshot({
        path: `output/count-purchase-review/editor-${width}.png`,
        fullPage: true,
      })
      eq(
        await editor.evaluate((e) => e.scrollWidth > e.clientWidth + 1),
        false,
        'editor contenido',
      )
      await editor.getByRole('button', { name: 'Cerrar', exact: true }).click()
      await page
        .locator('.movement-record')
        .filter({ hasText: 'Club de nuit intense' })
        .getByRole('button', { name: 'Revisar ingreso como compra' })
        .click()
      await page
        .getByRole('dialog', { name: 'Editar recepción de mercancía' })
        .waitFor()
      eq(
        await page
          .getByRole('dialog', { name: 'Registrar compra ya ingresada' })
          .count(),
        0,
        'una compra regularizada abre su edición directamente',
      )
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cerrar', exact: true })
        .click()
      // La página no debe esconder el registro 51 o cortar el historial en 200.
      await fixture.db.exec('reset role')
      await fixture.db.query(
        `insert into public.inventory_movements(request_id,product_id,location,type,quantity,before_quantity,after_quantity,actor_id,note,created_at)
    select gen_random_uuid(),$1,'store','SALE',1,1,0,$2,'Movimiento anterior',($3::date-1)::timestamp at time zone 'America/Managua' from generate_series(1,61)`,
        [products[0], admin, fixture.today],
      )
      await identity(fixture.db, admin)
      await page
        .getByRole('button', { name: 'Todas las fechas', exact: true })
        .click()
      await page.waitForFunction(
        () =>
          globalThis.document.querySelectorAll('.movement-record').length ===
          50,
      )
      await page.getByRole('button', { name: 'Siguiente', exact: true }).click()
      await page.waitForFunction(
        () =>
          globalThis.document.querySelectorAll('.movement-record').length ===
          13,
      )
      eq(
        await page
          .getByRole('button', { name: 'Siguiente', exact: true })
          .isDisabled(),
        true,
      )
      await page.getByRole('button', { name: 'Hoy', exact: true }).click()
      await page.waitForFunction(
        () =>
          globalThis.document.querySelectorAll('.movement-record').length === 2,
      )
      await page.screenshot({
        path: `output/count-purchase-review/history-${width}.png`,
        fullPage: true,
      })
      eq(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        'historial sin desbordamientos',
      )
      eq(errors, [], 'sin errores de React')
      eq(fixture.failures, [], 'sin errores de API')
      console.log(`PASS historial y regularización ${width}px`)
    } catch (e) {
      await page.screenshot({
        path: `output/count-purchase-review/error-${width}.png`,
        fullPage: true,
      })
      console.error(
        'Estado:',
        await page.locator('body').innerText(),
        fixture.failures,
      )
      throw e
    } finally {
      await fixture.close()
      await context.close()
    }
  }
  console.log(
    `PASS ${checks} comprobaciones de historial, edición y recuperación; datos y API aislados`,
  )
} finally {
  await browser.close()
  await server?.close()
}

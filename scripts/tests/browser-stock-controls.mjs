import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5196'
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) ||
    new URL(base).origin === 'https://lcp-control.pages.dev',
)
const output = process.env.LCP_TEST_OUTPUT ?? 'output/stock-controls'
await mkdir(output, { recursive: true })
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5196, strictPort: true },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
let checks = 0
const equal = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
}
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      timezoneId: 'America/Managua',
      isMobile: width < 500,
      hasTouch: width < 500,
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const fixture = await browserDatabase(page)
    const one = async (sql, args = []) =>
      (await fixture.db.query(sql, args)).rows[0]
    const quantity = async () =>
      (
        await one(
          "select quantity from public.inventory_balances where product_id=$1 and location='store'",
          [product],
        )
      ).quantity
    try {
      // Sólo cambia la base desechable para reproducir un perfume aún sin contar.
      await fixture.db.exec('reset role')
      await fixture.db.query(
        "update public.inventory_balances set quantity=null where product_id=$1 and location='store'",
        [product],
      )
      await fixture.db.exec('set role authenticated')
      await fixture.db.query('select public.open_business_day($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedDay: fixture.today,
          openingNio: 0,
          openingUsd: 0,
        }),
      ])
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
      await page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, `/products/${product}/edit`)
      const editor = page.locator('.product-stock-editor')
      const initial = editor.getByText('Registrar conteo inicial', {
        exact: true,
      })
      await initial.waitFor()
      equal(
        await editor
          .getByLabel('Cómo cambiar las cantidades', { exact: true })
          .count(),
        0,
        'El primer conteo no simula un selector que no abre',
      )
      equal(
        await editor
          .getByText('Indica cuántas unidades hay físicamente en Tienda.', {
            exact: true,
          })
          .isVisible(),
        true,
      )
      equal(
        await quantity(),
        null,
        'Abrir el editor no cuenta ni inventa unidades',
      )
      const location = editor.getByLabel('Ubicación de las cantidades', {
        exact: true,
      })
      await location.selectOption('warehouse')
      const action = editor.getByLabel('Cómo cambiar las cantidades', {
        exact: true,
      })
      await action.waitFor()
      equal(
        await action.isEnabled(),
        true,
        'La ubicación contada mantiene sus operaciones',
      )
      equal(await action.locator('option').count(), 3)
      await action.selectOption('EXIT')
      equal(
        await editor
          .getByLabel('Unidades a mover', { exact: true })
          .isVisible(),
        true,
      )
      await location.selectOption('store')
      await initial.waitFor()
      equal(
        await action.count(),
        0,
        'Volver a una ubicación sin contar requiere el conteo inicial',
      )
      await editor
        .getByLabel('Conteo total del perfume', { exact: true })
        .fill('4')
      await editor
        .getByRole('button', { name: 'Guardar cantidades', exact: true })
        .click()
      equal(await quantity(), null, 'Un conteo sin motivo no llega a la base')
      await editor
        .getByLabel('Motivo del cambio de cantidad', { exact: true })
        .fill('Primer conteo físico de cuatro unidades')
      await editor.scrollIntoViewIfNeeded()
      await page.screenshot({
        path: `${output}/primer-conteo-${width}.png`,
        fullPage: true,
      })
      await editor
        .getByRole('button', { name: 'Guardar cantidades', exact: true })
        .click()
      await editor
        .getByText(
          'Cantidad guardada en Tienda. El movimiento quedó en el historial.',
          { exact: true },
        )
        .waitFor()
      await action.waitFor()
      equal(await quantity(), 4)
      equal(await initial.count(), 0)
      equal(
        await action.isEnabled(),
        true,
        'Después del primer conteo se habilitan las tres operaciones',
      )
      const movement = await one(
        'select type,before_quantity,after_quantity from public.inventory_movements where product_id=$1 order by created_at desc limit 1',
        [product],
      )
      equal(movement, {
        type: 'ADJUSTMENT',
        before_quantity: null,
        after_quantity: 4,
      })
      await action.selectOption('ENTRY')
      await editor
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      const dialog = page.getByRole('dialog')
      await dialog
        .getByRole('heading', { name: 'Registrar compra', exact: true })
        .waitFor()
      equal(
        await dialog.getByLabel('Entra a', { exact: true }).inputValue(),
        'store',
      )
      equal(
        await quantity(),
        4,
        'Elegir agregar abre la compra sin modificar cantidades',
      )
      equal(
        (await one('select count(*)::int n from public.purchase_shipments')).n,
        0,
      )
      await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      await action.selectOption('EXIT')
      await editor.getByLabel('Unidades a mover', { exact: true }).fill('1')
      await editor
        .getByLabel('Motivo del cambio de cantidad', { exact: true })
        .fill('Salida registrada después del primer conteo')
      await editor
        .getByRole('button', { name: 'Guardar cantidades', exact: true })
        .click()
      await page.waitForFunction(
        () =>
          globalThis.document.querySelector(
            '.product-stock-editor .stock-location-cards strong',
          )?.textContent === '3',
      )
      equal(
        await quantity(),
        3,
        'Descontar sigue funcionando después del primer conteo',
      )
      equal(
        (
          await one(
            'select count(*)::int n from public.inventory_movements where product_id=$1',
            [product],
          )
        ).n,
        2,
      )
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
      )
      equal(errors, [])
      equal(fixture.failures, [])
      console.log(
        `PASS controles de inventario ${width}px: primer conteo claro, ubicaciones, motivo, compra y salida`,
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
    JSON.stringify(
      { checks, widths: [1440, 390, 320], productionWrites: false },
      null,
      2,
    ),
  )
  console.log(`Controles de inventario: ${checks} comprobaciones correctas.`)
} finally {
  await browser.close()
  await server?.close()
}

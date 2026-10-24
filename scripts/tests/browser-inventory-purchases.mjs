import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { browserDatabase } from './browser-database.mjs'
import { admin, identity } from './database-fixture.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname))
const output = 'output/inventory-purchases-review'
await mkdir(output, { recursive: true })
const id = (number) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${String(number).padStart(12, '0')}`
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      timezoneId: 'America/Managua',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const fixture = await browserDatabase(page)
    const one = async (sql, values = []) =>
      (await fixture.db.query(sql, values)).rows[0]
    const totals = async (productId) => {
      await fixture.db.exec('reset role')
      const result = await one(
        `select
        (select quantity from public.inventory_balances where product_id=$1 and location='store') store,
        (select quantity from public.inventory_balances where product_id=$1 and location='warehouse') warehouse,
        (select average_cost_nio::text from public.product_costs where product_id=$1) cost,
        (select count(*)::int from public.purchase_shipment_lines where product_id=$1) purchases`,
        [productId],
      )
      await identity(fixture.db, admin)
      return result
    }
    const navigate = async (path) => {
      await page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      await page.locator('.catalog-product').first().waitFor()
    }
    const select = async (dialog, product) => {
      await dialog
        .getByRole('button', { name: /Producto del movimiento/ })
        .click()
      await dialog.getByPlaceholder('Nombre, marca o código…').fill(product)
      await dialog.getByRole('option').first().click()
    }
    const entry = async (sku, quantity, location, note) => {
      await page.getByRole('button', { name: 'Entrada', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await select(dialog, sku)
      await dialog
        .getByLabel('Ubicación', { exact: true })
        .selectOption(location)
      await dialog
        .getByLabel('Cantidad', { exact: true })
        .fill(String(quantity))
      await dialog.getByLabel('Motivo', { exact: true }).fill(note)
      await dialog
        .getByRole('button', { name: 'Continuar con la compra', exact: true })
        .click()
    }
    const healthy = async (label) => {
      equal(errors, [], label + ': errores de navegador')
      equal(fixture.failures, [], label + ': API')
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        label + ': página sin desbordamiento',
      )
      for (const dialog of await page.getByRole('dialog').all())
        equal(
          await dialog.evaluate(
            (element) => element.scrollWidth > element.clientWidth + 1,
          ),
          false,
          label + ': diálogo sin desbordamiento',
        )
    }
    try {
      await fixture.db.exec('reset role')
      await fixture.db.query(
        "update public.inventory_balances set quantity=case when location='store' then 5 else 0 end where product_id=$1",
        [id(1)],
      )
      await fixture.db.query(
        'update public.product_costs set average_cost_nio=1100 where product_id=$1',
        [id(1)],
      )
      await fixture.db.query(
        "update public.inventory_balances set quantity=case when location='store' then 4 else 2 end where product_id=$1",
        [id(3)],
      )
      await fixture.db.query(
        'delete from public.product_costs where product_id=$1',
        [id(3)],
      )
      await fixture.db.query(
        'delete from public.product_costs where product_id=$1',
        [id(5)],
      )
      await fixture.db.query(
        'update public.inventory_balances set quantity=0 where product_id=$1',
        [id(5)],
      )
      await fixture.db.query(
        "update public.inventory_balances set quantity=case when location='store' then 0 else null end where product_id=$1",
        [id(4)],
      )
      await identity(fixture.db, admin)
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

      // La entrada fallida de la captura debe conducir a la compra sin
      // descartar lo escrito ni tocar existencias antes de confirmarla.
      await entry('QA-0001', 10, 'store', 'Compra recibida para mostrador')
      let dialog = page.getByRole('dialog')
      await dialog
        .getByRole('heading', { name: 'Registrar compra', exact: true })
        .waitFor()
      equal(
        await dialog.getByLabel('Unidades', { exact: true }).inputValue(),
        '10',
      )
      equal(
        await dialog.getByLabel('Entra a', { exact: true }).inputValue(),
        'store',
      )
      equal(
        await dialog.getByLabel('Nota', { exact: true }).inputValue(),
        'Compra recibida para mostrador',
      )
      equal(await totals(id(1)), {
        store: 5,
        warehouse: 0,
        cost: '1100.000000',
        purchases: 0,
      })
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      equal(
        await dialog.getByLabel('Cantidad', { exact: true }).inputValue(),
        '10',
        'cancelar conserva cantidad',
      )
      equal(
        await dialog.getByLabel('Motivo', { exact: true }).inputValue(),
        'Compra recibida para mostrador',
        'cancelar conserva motivo',
      )
      await dialog
        .getByRole('button', { name: 'Continuar con la compra', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      await dialog
        .getByLabel('Costo por unidad (C$)', { exact: true })
        .fill('1000')
      await dialog.getByLabel('Pago', { exact: true }).selectOption('credito')
      await dialog
        .getByLabel('Factura o referencia', { exact: true })
        .fill(`COMPRA-TIENDA-${width}`)
      await dialog
        .locator('.pricing-outcome strong')
        .filter({ hasText: '1033.333333' })
        .waitFor()
      await healthy('compra tienda ' + width)
      await dialog
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      equal(
        await totals(id(1)),
        { store: 15, warehouse: 0, cost: '1033.333333', purchases: 1 },
        'promedio ponderado de las notas',
      )
      equal(
        await one(
          'select goods_amount::text goods,note from public.purchase_shipments where reference=$1',
          [`COMPRA-TIENDA-${width}`],
        ),
        { goods: '10000.00', note: 'Compra recibida para mostrador' },
      )
      await fixture.db.exec('reset role')
      equal(
        Number(
          (
            await one(
              "select sum(debit) amount from private.operational_postings where source='purchase' and account='1130'",
              [],
            )
          ).amount,
        ),
        10000,
        'la compra se refleja en contabilidad',
      )
      await identity(fixture.db, admin)

      await entry('QA-0001', 3, 'warehouse', 'Compra para bodega')
      dialog = page.getByRole('dialog')
      await dialog
        .getByRole('heading', { name: 'Registrar compra', exact: true })
        .waitFor()
      equal(
        await dialog.getByLabel('Entra a', { exact: true }).inputValue(),
        'warehouse',
      )
      equal(
        await dialog.getByLabel('Unidades', { exact: true }).inputValue(),
        '3',
      )
      await dialog
        .getByLabel('Costo por unidad (C$)', { exact: true })
        .fill('1200')
      await dialog.getByLabel('Pago', { exact: true }).selectOption('credito')
      await dialog
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      equal(
        await totals(id(1)),
        { store: 15, warehouse: 3, cost: '1061.111111', purchases: 2 },
        'pondera tienda y bodega juntas',
      )

      // No convierte el stock sin costo en una entrada gratis. Registra el
      // costo inicial de lo existente y luego recibe sólo las unidades nuevas.
      await entry('QA-0003', 2, 'store', 'Compra después del costo inicial')
      dialog = page.getByRole('dialog')
      await dialog.getByRole('heading', { name: /Costo inicial/ }).waitFor()
      equal(await totals(id(3)), {
        store: 4,
        warehouse: 2,
        cost: null,
        purchases: 0,
      })
      await dialog
        .getByLabel('Costo por unidad (C$)', { exact: true })
        .fill('900')
      await dialog
        .getByLabel('Origen del costo / comprobante', { exact: true })
        .fill('Factura anterior confirmada')
      await dialog
        .getByRole('button', { name: 'Guardar costo inicial', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Registrar compra', exact: true })
        .waitFor()
      dialog = page.getByRole('dialog')
      equal(
        await totals(id(3)),
        { store: 4, warehouse: 2, cost: '900.000000', purchases: 0 },
        'costo inicial no suma unidades',
      )
      equal(
        await dialog.getByLabel('Unidades', { exact: true }).inputValue(),
        '2',
      )
      equal(
        await dialog.getByLabel('Nota', { exact: true }).inputValue(),
        'Compra después del costo inicial',
      )
      await dialog
        .getByLabel('Costo por unidad (C$)', { exact: true })
        .fill('1000')
      await dialog.getByLabel('Pago', { exact: true }).selectOption('credito')
      await dialog
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      equal(await totals(id(3)), {
        store: 6,
        warehouse: 2,
        cost: '925.000000',
        purchases: 1,
      })

      await entry('QA-0004', 7, 'store', 'Conteo pendiente de bodega')
      dialog = page.getByRole('dialog')
      await dialog
        .getByText('Falta el conteo de Tienda o Bodega.', { exact: true })
        .waitFor()
      equal(
        await totals(id(4)),
        { store: 0, warehouse: null, cost: '100.000000', purchases: 0 },
        'no inventa el conteo faltante',
      )
      await healthy('conteo pendiente ' + width)
      await dialog
        .getByRole('link', { name: 'Registrar conteo', exact: true })
        .click()
      await page.locator('.product-stock-editor').waitFor()
      equal(new URL(page.url()).pathname, `/products/${id(4)}/edit`)

      // También la edición de un perfume sin costo inicia una compra.
      await page.evaluate(
        (path) => {
          globalThis.history.pushState({}, '', path)
          globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
        },
        `/products/${id(5)}/edit`,
      )
      await page
        .locator('.product-stock-editor')
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .waitFor()
      await page
        .locator('.product-stock-editor')
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('heading', { name: 'Registrar compra', exact: true })
        .waitFor()
      await healthy('edición ' + width)
      await page.screenshot({
        path: `${output}/compra-${width}.png`,
        fullPage: true,
      })
      if (width === 1440) {
        await fixture.db.exec('reset role')
        await fixture.db.query(
          "update public.staff_members set role='warehouse' where user_id=$1",
          [admin],
        )
        await identity(fixture.db, admin)
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
        await page
          .getByRole('heading', { name: 'Inicio', exact: true })
          .waitFor()
        await navigate('/inventory')
        await page.getByRole('button', { name: 'Entrada', exact: true }).click()
        dialog = page.getByRole('dialog')
        await select(dialog, 'QA-0001')
        await dialog.getByLabel('Cantidad', { exact: true }).fill('1')
        await dialog
          .getByLabel('Motivo', { exact: true })
          .fill('Compra que requiere administración')
        await dialog
          .getByRole('button', { name: 'Confirmar movimiento', exact: true })
          .click()
        await dialog
          .getByText(
            'Solicita a un administrador que registre la compra con su costo.',
            { exact: true },
          )
          .waitFor()
        equal(
          await totals(id(1)),
          { store: 15, warehouse: 3, cost: '1061.111111', purchases: 2 },
          'Inventario no recibe sin el costo autorizado',
        )
        await healthy('entrada con rol Inventario')
      }
    } catch (error) {
      await page.screenshot({
        path: `${output}/fallo-${width}.png`,
        fullPage: true,
      })
      await writeFile(
        `${output}/fallo-${width}.txt`,
        JSON.stringify(
          {
            errors,
            failures: fixture.failures,
            text: await page.locator('body').innerText(),
          },
          null,
          2,
        ),
      )
      throw error
    } finally {
      await context.close()
      await fixture.db.close()
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, checks, output }) + '\n')
} finally {
  await browser.close()
}

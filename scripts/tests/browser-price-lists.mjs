import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5174'
const output = 'output/price-lists-audit'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
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
    const one = async (sql, params = []) =>
      (await fixture.db.query(sql, params)).rows[0]
    const navigate = async (path) => {
      await page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      const heading =
        path === '/inventory'
          ? 'Inventario'
          : path === '/sales'
            ? 'Facturación'
            : path === '/proformas'
              ? 'Proformas'
              : path === '/reports'
                ? 'Reportes'
                : 'Editar perfume'
      await page.getByRole('heading', { name: heading, exact: true }).waitFor()
    }
    const healthy = async (name) => {
      equal(errors, [], name + ': sin errores JavaScript')
      equal(fixture.failures, [], name + ': sin errores RPC')
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        name + ': sin desbordamiento de página',
      )
      for (const dialog of await page.getByRole('dialog').all())
        equal(
          await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
          false,
          name + ': sin desbordamiento de diálogo',
        )
    }
    try {
      await fixture.db.query('select public.open_business_day($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          openingNio: 1000,
          openingUsd: 0,
          expectedDay: fixture.today,
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
      await navigate('/inventory')
      await page
        .getByRole('button', { name: 'Listas de precios', exact: true })
        .click()
      let dialog = page.getByRole('dialog', {
        name: 'Listas de precios',
        exact: true,
      })
      await dialog.getByLabel('Buscar perfume', { exact: true }).fill('QA-0001')
      await dialog.getByLabel('Precio QA-0001 USD', { exact: true }).waitFor()
      async function create(name) {
        await dialog
          .getByRole('button', { name: 'Nueva lista', exact: true })
          .click()
        await dialog
          .getByLabel('Nombre de la nueva lista', { exact: true })
          .fill(name)
        await dialog
          .getByRole('button', { name: 'Crear lista', exact: true })
          .click()
        await dialog
          .getByText('Lista creada. Agrega los precios de los perfumes.', {
            exact: true,
          })
          .waitFor()
        const row = await one(
          'select code from public.price_tiers where name=$1',
          [name],
        )
        equal(
          (
            await one(
              'select count(*)::int n from public.product_prices where tier_code=$1',
              [row.code],
            )
          ).n,
          0,
          'crear lista no inventa precios',
        )
        return row.code
      }
      const name = `Lista personalizada ${width}`
      const code = await create(name)
      await dialog.getByLabel('Buscar perfume', { exact: true }).fill('QA-0001')
      equal(
        await dialog
          .getByLabel('Precio QA-0001 USD', { exact: true })
          .inputValue(),
        '',
        'lista nueva sin precio',
      )
      await dialog
        .getByLabel('Precio QA-0001 USD', { exact: true })
        .fill('27.03')
      await dialog
        .getByLabel('Lista de precios', { exact: true })
        .selectOption('vip')
      await page
        .getByRole('dialog', {
          name: 'Descartar cambios de precios',
          exact: true,
        })
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      equal(
        await dialog
          .getByLabel('Lista de precios', { exact: true })
          .inputValue(),
        code,
        'cancelar cambio de lista mantiene edición',
      )
      equal(
        await dialog
          .getByLabel('Precio QA-0001 USD', { exact: true })
          .inputValue(),
        '27.03',
        'importe conservado',
      )
      let lost = false
      const requests = []
      const intercept = async (route) => {
        const body = route.request().postDataJSON()
        requests.push(body.p_input.requestId)
        if (lost) return route.fallback()
        lost = true
        await fixture.db.query('select public.save_price_list($1::jsonb)', [
          JSON.stringify(body.p_input),
        ])
        await route.abort('failed')
      }
      await page.route('**/rest/v1/rpc/save_price_list', intercept)
      await dialog
        .getByRole('button', { name: 'Guardar precios', exact: true })
        .click()
      await dialog.getByRole('alert').waitFor()
      const revision = (
        await one('select revision from public.products where id=$1', [
          productId,
        ])
      ).revision
      await dialog
        .getByRole('button', { name: 'Guardar precios', exact: true })
        .click()
      await dialog.getByText('1 precio guardado.', { exact: true }).waitFor()
      equal(requests.length, 2, 'dos intentos del lote')
      equal(requests[0], requests[1], 'respuesta perdida reintenta mismo UUID')
      equal(
        (
          await one('select revision from public.products where id=$1', [
            productId,
          ])
        ).revision,
        revision,
        'recuperación no modifica revisión nuevamente',
      )
      equal(
        Number(
          (
            await one(
              "select amount from public.product_prices where product_id=$1 and tier_code=$2 and currency='USD'",
              [productId, code],
            )
          ).amount,
        ),
        27.03,
        'precio guardado realmente',
      )
      await page.unroute('**/rest/v1/rpc/save_price_list', intercept)
      const fifth = await create(`Lista sin importes ${width}`)
      await dialog
        .getByLabel('Lista de precios', { exact: true })
        .selectOption(code)
      await dialog.getByLabel('Moneda', { exact: true }).selectOption('NIO')
      await dialog
        .getByLabel('Precio QA-0001 NIO', { exact: true })
        .fill('1000')
      const usd = 27.32
      const nio = 999.91
      await dialog.getByText(/27\.32/).waitFor()
      await healthy('edición de lista ' + width)
      await page.screenshot({
        path: `${output}/lista-${width}.png`,
        fullPage: true,
      })
      await dialog
        .getByRole('button', { name: 'Guardar precios', exact: true })
        .click()
      await dialog.getByText('1 precio guardado.', { exact: true }).waitFor()
      equal(
        Number(
          (
            await one(
              "select amount from public.product_prices where product_id=$1 and tier_code=$2 and currency='NIO'",
              [productId, code],
            )
          ).amount,
        ),
        nio,
        'córdoba final anunciado antes de guardar',
      )
      equal(
        Number(
          (
            await one(
              "select amount from public.product_prices where product_id=$1 and tier_code=$2 and currency='USD'",
              [productId, code],
            )
          ).amount,
        ),
        usd,
        'USD canónico correcto',
      )
      await dialog
        .getByRole('button', { name: 'Cerrar', exact: true })
        .last()
        .click()

      await navigate(`/products/${productId}/edit`)
      await page.getByLabel(`${name} USD`, { exact: true }).waitFor()
      equal(
        await page
          .getByLabel(`Lista sin importes ${width} USD`, { exact: true })
          .inputValue(),
        '',
        'quinta lista opcional al editar perfume',
      )
      await page
        .getByLabel('Nombre del perfume', { exact: true })
        .fill('Perfume con lista personalizada')
      await page
        .getByRole('button', { name: 'Guardar perfume', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      equal(
        Number(
          (
            await one(
              "select amount from public.product_prices where product_id=$1 and tier_code=$2 and currency='USD'",
              [productId, code],
            )
          ).amount,
        ),
        usd,
        'editar datos conserva precio de lista personalizada',
      )
      equal(
        (
          await one(
            'select count(*)::int n from public.product_prices where product_id=$1 and tier_code=$2',
            [productId, fifth],
          )
        ).n,
        0,
        'guardar ficha no inventa precio quinta lista',
      )
      await healthy('ficha con cinco listas ' + width)

      await navigate('/sales')
      await page
        .getByLabel('Lista de precios', { exact: true })
        .selectOption(fifth)
      await page
        .getByLabel('Buscar en catálogo', { exact: true })
        .fill('QA-0001')
      await page.getByText('Sin precio', { exact: true }).first().waitFor()
      equal(
        await page
          .getByRole('button', { name: /^Agregar Lattafa/ })
          .first()
          .isDisabled(),
        true,
        'no agrega producto sin precio',
      )
      await page
        .getByLabel('Lista de precios', { exact: true })
        .selectOption(code)
      await page
        .getByRole('button', { name: /^Agregar Lattafa/ })
        .first()
        .click()
      await page
        .getByLabel('Lista de precios', { exact: true })
        .selectOption(fifth)
      equal(
        await page
          .getByRole('button', { name: 'Emitir factura', exact: true })
          .isDisabled(),
        true,
        'cambio de lista no permite factura sin precio',
      )
      await page
        .getByText('Sin precio en esta lista', { exact: true })
        .waitFor()
      await healthy('factura con precio faltante ' + width)
      await page
        .getByLabel('Lista de precios', { exact: true })
        .selectOption(code)
      await page
        .getByLabel('Cliente', { exact: true })
        .fill('Cliente lista personalizada')
      await page
        .getByLabel('Forma de pago', { exact: true })
        .selectOption('cash')
      await page
        .getByRole('button', { name: 'Emitir factura', exact: true })
        .click()
      await page
        .getByText(/FAC-000001/)
        .first()
        .waitFor()
      equal(
        (
          await one(
            "select tier_code from public.documents where kind='invoice'",
          )
        ).tier_code,
        code,
        'factura persiste lista real',
      )
      equal(
        Number(
          (await one("select total from public.documents where kind='invoice'"))
            .total,
        ),
        nio,
        'factura cobra importe exacto de la lista',
      )
      equal(
        (
          await one(
            "select quantity from public.inventory_balances where product_id=$1 and location='store'",
            [productId],
          )
        ).quantity,
        19,
        'factura descuenta una unidad',
      )
      await healthy('factura emitida ' + width)
      await navigate('/proformas')
      await page
        .getByLabel('Lista de precios', { exact: true })
        .selectOption(code)
      await page
        .getByLabel('Buscar en catálogo', { exact: true })
        .fill('QA-0001')
      await page
        .getByRole('button', { name: /^Agregar Lattafa/ })
        .first()
        .click()
      await page
        .getByLabel('Cliente', { exact: true })
        .fill('Cliente cotización lista')
      await page
        .getByRole('button', { name: 'Emitir proforma', exact: true })
        .click()
      await page
        .getByText(/PRO-000001/)
        .first()
        .waitFor()
      equal(
        (
          await one(
            "select quantity from public.inventory_balances where product_id=$1 and location='store'",
            [productId],
          )
        ).quantity,
        19,
        'proforma conserva existencias',
      )
      await healthy('proforma emitida ' + width)
      await navigate('/reports')
      await page
        .getByLabel('Lista para valorar inventario', { exact: true })
        .selectOption(fifth)
      await page.getByText('Valor pendiente', { exact: true }).waitFor()
      equal(
        (await page.getByText('Sin precio', { exact: true }).count()) > 0,
        true,
        'capital detenido sin precio no se muestra como cero',
      )
      for (const [button, extension] of [
        ['Descargar Excel', '.xlsx'],
        ['Descargar PDF', '.pdf'],
      ]) {
        const downloading = page.waitForEvent('download')
        await page.getByRole('button', { name: button, exact: true }).click()
        const downloaded = await downloading
        equal(
          downloaded.suggestedFilename().endsWith(extension),
          true,
          'exportación de lista parcial ' + extension,
        )
        equal(
          await downloaded.failure(),
          null,
          'descarga completa ' + extension,
        )
        await downloaded.saveAs(`${output}/reporte-${width}${extension}`)
      }
      await healthy('reportes con lista parcial ' + width)
    } catch (error) {
      await page.screenshot({
        path: `${output}/error-${width}.png`,
        fullPage: true,
      })
      console.error(await page.locator('.main-content').innerText())
      console.error({ errors, failures: fixture.failures })
      throw error
    } finally {
      await fixture.close()
      await context.close()
    }
  }
  console.log(
    JSON.stringify({ checks, viewports: [1440, 390, 320], result: 'ok' }),
  )
} finally {
  await browser.close()
}

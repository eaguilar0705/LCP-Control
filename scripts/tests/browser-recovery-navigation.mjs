import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
import { identity, admin } from './database-fixture.mjs'
import { seedJournalPages } from './recovery-pagination-fixture.mjs'
const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
// En el HTML publicado también se intercepta toda la API a nivel de contexto:
// recargas y pestañas nuevas siguen usando exclusivamente PostgreSQL desechable.
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) ||
    new URL(base).origin === 'https://lcp-control.pages.dev',
)
const output =
  process.env.LCP_TEST_OUTPUT ?? 'output/functional-recovery-browser'
await mkdir(output, { recursive: true })
let checks = 0
const equal = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
}
const results = []
const browser = await chromium.launch({ channel: 'chrome', headless: true })
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
    let page = await context.newPage()
    page.setDefaultTimeout(20000)
    const errors = []
    context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)))
    page.on('pageerror', (e) => errors.push(e.message))
    const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
    const call = async (name, input) =>
      (
        await db.query(`select public.${name}($1::jsonb) r`, [
          JSON.stringify(input),
        ])
      ).rows[0].r
    const login = async () => {
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
    }
    const inventory = async () => {
      await page
        .getByRole('link', { name: 'Inventario', exact: true })
        .first()
        .click()
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      await page.locator('.catalog-product').first().waitFor()
    }
    const stock = async () =>
      (
        await db.query(
          "select quantity from public.inventory_balances where product_id=$1 and location='store'",
          [product],
        )
      ).rows[0].quantity
    const persisted = () =>
      page.evaluate(() =>
        JSON.parse(
          localStorage.getItem('lcp:pending-operation-ids:v1') ?? '[]',
        ),
      )
    const healthy = async (label) => {
      equal(errors, [], label + ': sin errores de navegador')
      equal(fixture.failures, [], label + ': sin errores API inesperados')
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        label + ': sin desbordamiento',
      )
    }
    const fillExit = async (note) => {
      await page.getByRole('button', { name: 'Salida', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Salida de inventario' })
      await dialog
        .getByRole('button', { name: /Producto del movimiento/ })
        .click()
      await dialog.getByPlaceholder('Nombre, marca o código…').fill('QA-0001')
      await dialog.getByRole('option').first().click()
      await dialog.getByLabel('Cantidad', { exact: true }).fill('2')
      await dialog.getByLabel('Motivo', { exact: true }).fill(note)
      return dialog
    }
    try {
      await call('open_business_day', {
        requestId: crypto.randomUUID(),
        openingNio: 1000,
        openingUsd: 0,
        expectedDay: today,
      })
      await login()
      await inventory()
      await page.getByLabel('Buscar producto', { exact: true }).fill('QA-0001')
      await page.locator(`a[href='/products/${product}/edit']`).first().click()
      const name = page.getByLabel('Nombre del perfume', { exact: true })
      const original = await name.inputValue()
      await name.fill('Edición conservada al pulsar Atrás')
      await page.goBack()
      await page.getByRole('dialog', { name: 'Cambios sin guardar' }).waitFor()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      await page
        .getByRole('dialog', { name: 'Cambios sin guardar' })
        .waitFor({ state: 'hidden' })
      await page.waitForURL(`**/products/${product}/edit`)
      equal(await name.inputValue(), 'Edición conservada al pulsar Atrás')
      equal(new URL(page.url()).pathname, `/products/${product}/edit`)
      await page.goBack()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Salir sin guardar', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      await page.goForward()
      await page.getByLabel('Nombre del perfume', { exact: true }).waitFor()
      equal(
        await name.inputValue(),
        original,
        'Adelante abre el dato guardado tras descartar',
      )
      await page
        .getByRole('link', { name: 'Volver al inventario', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      await page.goBack()
      await name.waitFor()
      await name.fill('Edición conservada al pulsar Adelante')
      await page.goForward()
      await page.getByRole('dialog', { name: 'Cambios sin guardar' }).waitFor()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      await page
        .getByRole('dialog', { name: 'Cambios sin guardar' })
        .waitFor({ state: 'hidden' })
      await page.waitForURL(`**/products/${product}/edit`)
      equal(await name.inputValue(), 'Edición conservada al pulsar Adelante')
      await name.fill(original)
      // React debe haber reconocido la restauración antes de navegar. El
      // botón de costo sólo se habilita cuando ya no quedan cambios pendientes.
      await page
        .getByRole('button', { name: 'Costo de inventario', exact: true })
        .click({ trial: true })
      equal(await name.inputValue(), original)
      await page
        .getByRole('link', { name: 'Volver al inventario', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      await healthy('Atrás y Adelante ' + width)

      let sentPayload
      const lost = async (route) => {
        const payload = route.request().postDataJSON().p_payload
        if (!sentPayload) {
          sentPayload = payload
          await call('record_inventory_movement', payload)
        } else assert.deepEqual(payload, sentPayload)
        await route.abort('failed')
      }
      await context.route('**/rest/v1/rpc/record_inventory_movement', lost)
      let dialog = await fillExit('Motivo sensible que no debe persistirse')
      await dialog
        .getByRole('button', { name: 'Confirmar movimiento', exact: true })
        .click()
      await dialog.getByRole('alert').waitFor()
      equal(await stock(), 18)
      let references = await persisted()
      equal(references.length, 1)
      equal(Object.keys(references[0]).sort(), ['kind', 'requestId', 'scope'])
      equal(references[0].requestId, sentPayload.requestId)
      equal(JSON.stringify(references).includes('sensible'), false)
      equal(JSON.stringify(references).includes(product), false)
      page.once('dialog', (d) => d.accept())
      await page.reload()
      await login()
      const recovery = page.getByRole('status', {
        name: 'Solicitudes por recuperar',
        exact: true,
      })
      await recovery.waitFor()
      equal(
        await page.getByRole('dialog').count(),
        0,
        'no se reconstruye un formulario sensible en disco',
      )
      await healthy('Recuperación después de recargar ' + width)
      await page.screenshot({
        path: `${output}/recarga-${width}.png`,
        fullPage: true,
      })
      await recovery
        .getByRole('button', { name: 'Consultar guardado', exact: true })
        .click()
      await recovery.waitFor({ state: 'hidden' })
      equal(await persisted(), [])
      equal(await stock(), 18)
      equal(
        (
          await db.query(
            'select count(*)::int n from public.inventory_movements where request_id=$1',
            [sentPayload.requestId],
          )
        ).rows[0].n,
        1,
      )
      await context.unroute('**/rest/v1/rpc/record_inventory_movement', lost)

      let notSent
      const neverCommitted = async (route) => {
        notSent = route.request().postDataJSON().p_payload
        await route.abort('failed')
      }
      await context.route(
        '**/rest/v1/rpc/record_inventory_movement',
        neverCommitted,
      )
      await inventory()
      dialog = await fillExit('Solicitud que no llegó a PostgreSQL')
      await dialog
        .getByRole('button', { name: 'Confirmar movimiento', exact: true })
        .click()
      await dialog.getByRole('alert').waitFor()
      equal(await stock(), 18)
      page.once('dialog', (d) => d.accept())
      await page.close({ runBeforeUnload: true })
      page = await context.newPage()
      page.setDefaultTimeout(20000)
      await login()
      await page
        .getByRole('status', { name: 'Solicitudes por recuperar', exact: true })
        .waitFor()
      await page
        .getByRole('button', { name: 'Consultar guardado', exact: true })
        .click()
      await page
        .getByText(
          'No se encontró un guardado con este identificador. Revisa el historial antes de registrar la operación de nuevo.',
          { exact: true },
        )
        .waitFor()
      await page
        .getByRole('button', { name: 'Descartar solicitud', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      equal(
        (await persisted()).length,
        1,
        'cancelar retirada conserva el identificador',
      )
      await page
        .getByRole('button', { name: 'Descartar solicitud', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Descartar solicitud', exact: true })
        .click()
      await page
        .getByText(
          'Solicitud descartada. Puedes registrar la operación de nuevo.',
          { exact: true },
        )
        .waitFor()
      equal(await persisted(), [])
      await assert.rejects(
        call('record_inventory_movement', notSent),
        /solicitud fue descartada/,
      )
      checks++
      equal(await stock(), 18, 'envío tardío no modifica inventario')
      await context.unroute(
        '**/rest/v1/rpc/record_inventory_movement',
        neverCommitted,
      )
      await inventory()
      dialog = await fillExit(
        'Salida legítima tras retirar el identificador anterior',
      )
      await dialog
        .getByRole('button', { name: 'Confirmar movimiento', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      equal(await stock(), 16)
      equal(await persisted(), [])

      // El lote de importes tiene un UUID propio, separado del alta de lista.
      await page
        .getByRole('button', { name: 'Listas de precios', exact: true })
        .click()
      dialog = page.getByRole('dialog', {
        name: 'Listas de precios',
        exact: true,
      })
      await dialog.getByLabel('Buscar perfume', { exact: true }).fill('QA-0001')
      await dialog
        .getByLabel('Precio QA-0001 USD', { exact: true })
        .fill('12.34')
      let priceRequest
      const losePrices = async (route) => {
        const input = route.request().postDataJSON().p_input
        if (!priceRequest) {
          priceRequest = input
          await call('save_price_list', input)
        } else assert.deepEqual(input, priceRequest)
        await route.abort('failed')
      }
      await context.route('**/rest/v1/rpc/save_price_list', losePrices)
      await dialog
        .getByRole('button', { name: 'Guardar precios', exact: true })
        .click()
      await dialog.getByRole('alert').waitFor()
      const priceRevision = (
        await db.query('select revision from public.products where id=$1', [
          product,
        ])
      ).rows[0].revision
      references = await persisted()
      equal(references.length, 1)
      equal(references[0].kind, 'price-list-prices')
      equal(references[0].requestId, priceRequest.requestId)
      equal(Object.keys(references[0]).sort(), ['kind', 'requestId', 'scope'])
      equal(
        JSON.stringify(references).includes('12.34'),
        false,
        'el importe no se persiste',
      )
      page.once('dialog', (d) => d.accept())
      await page.close({ runBeforeUnload: true })
      page = await context.newPage()
      page.setDefaultTimeout(20000)
      await login()
      await page
        .getByRole('status', { name: 'Solicitudes por recuperar', exact: true })
        .getByRole('button', { name: 'Consultar guardado', exact: true })
        .click()
      await page
        .getByRole('status', { name: 'Solicitudes por recuperar', exact: true })
        .waitFor({ state: 'hidden' })
      equal(await persisted(), [])
      equal(
        Number(
          (
            await db.query(
              "select amount from public.product_prices where product_id=$1 and tier_code='emprendedor' and currency='USD'",
              [product],
            )
          ).rows[0].amount,
        ),
        12.34,
      )
      equal(
        (
          await db.query('select revision from public.products where id=$1', [
            product,
          ])
        ).rows[0].revision,
        priceRevision,
        'verificar el lote no escribe precios otra vez',
      )
      await context.unroute('**/rest/v1/rpc/save_price_list', losePrices)

      await db.exec('reset role')
      await db.query(
        "update public.staff_members set role='warehouse' where user_id=$1",
        [admin],
      )
      await identity(db, admin)
      await login()
      await inventory()
      await page.getByRole('button', { name: 'Entrada', exact: true }).click()
      dialog = page.getByRole('dialog', { name: 'Entrada de inventario' })
      await dialog
        .getByText('Esta entrada necesita Administración.', { exact: true })
        .waitFor()
      equal(
        await dialog.getByLabel('Cantidad', { exact: true }).count(),
        0,
        'se avisa antes de llenar datos innecesarios',
      )
      await dialog
        .getByRole('button', { name: 'Cerrar', exact: true })
        .last()
        .click()
      dialog = await fillExit('El rol Inventario conserva sus salidas normales')
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      equal(await stock(), 16)
      await db.exec('reset role')
      await db.query(
        "update public.staff_members set role='superadmin' where user_id=$1",
        [admin],
      )
      await identity(db, admin)
      await call('record_expense', {
        requestId: crypto.randomUUID(),
        incurredOn: today,
        category: 'renta',
        description: 'Pago registrado superior a los fondos de caja',
        amount: 2000,
        currency: 'NIO',
        exchangeRate: 1,
        reference: 'NEGATIVE',
        account: 'caja',
      })
      await login()
      await page
        .getByText('El efectivo esperado es negativo.', { exact: true })
        .waitFor()
      await page
        .getByRole('button', { name: 'Cerrar tienda', exact: true })
        .click()
      dialog = page.getByRole('dialog', { name: 'Cerrar tienda' })
      await dialog
        .getByText('Revisa el efectivo esperado antes de cerrar.', {
          exact: true,
        })
        .waitFor()
      equal(
        await dialog
          .getByLabel('Córdobas C$', { exact: true })
          .getAttribute('min'),
        '0',
      )
      await dialog
        .getByRole('link', { name: 'Revisar cobros y pagos', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Contabilidad', exact: true })
        .waitFor()
      equal(
        await page
          .getByRole('button', { name: 'Cobros y pagos', exact: true })
          .getAttribute('aria-pressed'),
        'true',
      )

      const range = await seedJournalPages(fixture)
      await page
        .getByRole('button', { name: 'Comprobantes', exact: true })
        .click()
      await page.getByLabel('Desde', { exact: true }).fill(range.from)
      const pages = page.getByRole('navigation', {
        name: 'Páginas de comprobantes',
        exact: true,
      })
      await pages.waitFor()
      await pages
        .getByText(`1–50 de ${range.total} comprobantes`, { exact: true })
        .waitFor()
      equal(await page.locator('.accounting-card tbody tr').count(), 50)
      await pages
        .getByRole('button', { name: 'Siguiente', exact: true })
        .click()
      await pages
        .getByText(`51–100 de ${range.total} comprobantes`, { exact: true })
        .waitFor()
      await pages.getByRole('button', { name: 'Última', exact: true }).click()
      const lastOffset = Math.floor((range.total - 1) / 50) * 50
      await pages
        .getByText(
          `${lastOffset + 1}–${range.total} de ${range.total} comprobantes`,
          { exact: true },
        )
        .waitFor()
      const automatic = page.getByRole('button', { name: /^(VE|CV)-/ }).first()
      await automatic.click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Descargar PDF', exact: true })
        .waitFor()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cerrar', exact: true })
        .click()
      await healthy('Historial sin truncar ' + width)
      await page.screenshot({
        path: `${output}/ultima-pagina-${width}.png`,
        fullPage: true,
      })
      results.push({
        width,
        status: 'PASS',
        stock: await stock(),
        journalTotal: range.total,
      })
    } catch (error) {
      await page.screenshot({
        path: `${output}/fallo-${width}.png`,
        fullPage: true,
      })
      await writeFile(
        `${output}/fallo-${width}.json`,
        JSON.stringify(
          {
            message: error.message,
            errors,
            failures: fixture.failures,
            url: page.url(),
          },
          null,
          2,
        ),
      )
      throw error
    } finally {
      await context.close()
      await fixture.close()
    }
  }
} finally {
  await browser.close()
  await writeFile(
    `${output}/resultados.json`,
    JSON.stringify({ checks, results }, null, 2),
  )
}
console.log(`PASS UX/recuperación: ${checks} comprobaciones, 1440/390/320.`)

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) ||
    new URL(base).origin === 'https://lcp-control.pages.dev',
)
// La API del navegador se intercepta y todas las escrituras se ejecutan en
// PostgreSQL local desechable. No se envía información a producción.
const output = process.env.LCP_TEST_OUTPUT ?? 'output/movement-confirmation'
await mkdir(output, { recursive: true })
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const results = []
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390, 320]) {
    const startChecks = checks
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      isMobile: width < 500,
      hasTouch: width < 500,
      timezoneId: 'America/Managua',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const fixture = await browserDatabase(page)
    const one = async (sql, parameters = []) =>
      (await fixture.db.query(sql, parameters)).rows[0]
    const navigate = async (path) => {
      await page.evaluate((target) => {
        globalThis.history.pushState({}, '', target)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
    }
    const stock = async (product) =>
      (
        await one(
          "select quantity from public.inventory_balances where product_id=$1 and location='store'",
          [product],
        )
      ).quantity
    const movements = async (product) =>
      (
        await fixture.db.query(
          'select request_id,product_id,location,type,quantity,before_quantity,after_quantity,note from public.inventory_movements where product_id=$1 order by created_at,id',
          [product],
        )
      ).rows
    const healthy = async (name) => {
      equal(errors, [], name + ': navegador sin errores')
      equal(fixture.failures, [], name + ': API sin errores')
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        name + ': página dentro de pantalla',
      )
      for (const dialog of await page.getByRole('dialog').all())
        equal(
          await dialog.evaluate(
            (element) => element.scrollWidth > element.clientWidth + 1,
          ),
          false,
          name + ': diálogo dentro de pantalla',
        )
    }
    const captureLostResponse = async () => {
      const payloads = []
      let lost = false
      const handler = async (route) => {
        const input = route.request().postDataJSON().p_payload
        payloads.push(input)
        if (lost) return route.fallback()
        lost = true
        await fixture.db.query(
          'select public.record_inventory_movement($1::jsonb)',
          [JSON.stringify(input)],
        )
        await route.abort('failed')
      }
      await page.route('**/rest/v1/rpc/record_inventory_movement', handler)
      return {
        payloads,
        remove: () =>
          page.unroute('**/rest/v1/rpc/record_inventory_movement', handler),
      }
    }
    const pendingFields = async (scope, quantityLabel, reasonLabel) => {
      await scope
        .getByRole('alert')
        .filter({ hasText: 'No pudimos confirmar el guardado.' })
        .waitFor()
      equal(
        await scope.getByLabel(quantityLabel, { exact: true }).inputValue(),
        '2',
        'Se conserva la cantidad original',
      )
      equal(
        await scope.getByLabel(quantityLabel, { exact: true }).isDisabled(),
        true,
        'No permite cambiar unidades antes de confirmar',
      )
      equal(
        await scope.getByLabel(reasonLabel, { exact: true }).isDisabled(),
        true,
        'No permite cambiar motivo antes de confirmar',
      )
      equal(
        await scope
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .isEnabled(),
        true,
        'El usuario puede verificar el guardado original',
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
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()

      for (const scenario of [
        {
          index: 1,
          action: 'Salida',
          title: 'Salida de inventario',
          type: 'EXIT',
        },
        {
          index: 2,
          action: 'Dañado',
          title: 'Producto dañado',
          type: 'DAMAGED',
        },
      ]) {
        const product =
          'aaaaaaaa-aaaa-4aaa-8aaa-' + String(scenario.index).padStart(12, '0')
        const sku = 'QA-' + String(scenario.index).padStart(4, '0')
        const note = `${scenario.action} con respuesta perdida ${width}`
        const lost = await captureLostResponse()
        const fill = async (quantity, reason) => {
          await page
            .getByRole('button', { name: scenario.action, exact: true })
            .click()
          const dialog = page.getByRole('dialog', { name: scenario.title })
          await dialog
            .getByRole('button', { name: /Producto del movimiento/ })
            .click()
          await dialog.getByPlaceholder('Nombre, marca o código…').fill(sku)
          await dialog.getByRole('option').first().click()
          await dialog.getByLabel('Cantidad', { exact: true }).fill(quantity)
          await dialog.getByLabel('Motivo', { exact: true }).fill(reason)
          return dialog
        }
        equal(await stock(product), 20)
        const dialog = await fill('2', note)
        await dialog
          .getByRole('button', { name: 'Confirmar movimiento', exact: true })
          .click()
        await pendingFields(dialog, 'Cantidad', 'Motivo')
        equal(await stock(product), 18, 'La escritura sí se completó')
        equal((await movements(product)).length, 1)
        equal(
          await dialog.getByLabel('Motivo', { exact: true }).inputValue(),
          note,
        )
        equal(
          await dialog
            .getByRole('button', { name: /Producto del movimiento/ })
            .isDisabled(),
          true,
        )
        equal(
          await dialog.getByLabel('Ubicación', { exact: true }).isDisabled(),
          true,
        )
        equal(
          await dialog
            .getByRole('button', { name: 'Cancelar', exact: true })
            .isDisabled(),
          true,
        )
        equal(
          await dialog
            .getByRole('button', { name: 'Cerrar', exact: true })
            .isDisabled(),
          true,
        )
        await dialog
          .getByRole('button', { name: 'Cancelar', exact: true })
          .evaluate((button) => button.click())
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')
        equal(
          await dialog.isVisible(),
          true,
          'Cancelar/Escape no evade la confirmación',
        )
        equal(lost.payloads.length, 1)
        await healthy(`${scenario.type} pendiente ${width}`)
        await page.screenshot({
          path: `${output}/${scenario.type.toLowerCase()}-pendiente-${width}.png`,
          fullPage: false,
        })
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .click()
        await dialog.waitFor({ state: 'hidden' })
        equal(lost.payloads.length, 2)
        equal(
          lost.payloads[1],
          lost.payloads[0],
          'Reintento con DTO y UUID idénticos',
        )
        equal(await stock(product), 18)
        equal(await movements(product), [
          {
            request_id: lost.payloads[0].requestId,
            product_id: product,
            location: 'store',
            type: scenario.type,
            quantity: 2,
            before_quantity: 20,
            after_quantity: 18,
            note,
          },
        ])

        // Confirmado el intento anterior, una operación nueva sí debe poder
        // guardar otra cantidad y motivo con una solicitud distinta.
        const next = await fill('1', 'Otra operación legítima')
        await next
          .getByRole('button', { name: 'Confirmar movimiento', exact: true })
          .click()
        await next.waitFor({ state: 'hidden' })
        equal(lost.payloads.length, 3)
        equal(lost.payloads[2].requestId !== lost.payloads[0].requestId, true)
        equal(await stock(product), 17)
        equal((await movements(product)).length, 2)
        equal((await movements(product))[1].note, 'Otra operación legítima')
        await lost.remove()
        await healthy(`${scenario.type} confirmado ${width}`)
      }

      const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003'
      await navigate(`/products/${product}/edit`)
      await page
        .getByRole('heading', { name: 'Editar perfume', exact: true })
        .waitFor()
      const editor = page.locator('.product-stock-editor')
      await editor
        .getByLabel('Cómo cambiar las cantidades', { exact: true })
        .selectOption('EXIT')
      await editor.getByLabel('Unidades a mover', { exact: true }).fill('2')
      const note = `Salida desde edición con respuesta perdida ${width}`
      await editor
        .getByLabel('Motivo del cambio de cantidad', { exact: true })
        .fill(note)
      const lost = await captureLostResponse()
      await editor
        .getByRole('button', { name: 'Guardar cantidades', exact: true })
        .click()
      await pendingFields(
        editor,
        'Unidades a mover',
        'Motivo del cambio de cantidad',
      )
      equal(
        await editor
          .getByLabel('Motivo del cambio de cantidad', { exact: true })
          .inputValue(),
        note,
      )
      equal(
        await editor
          .getByLabel('Cómo cambiar las cantidades', { exact: true })
          .isDisabled(),
        true,
      )
      equal(
        await editor
          .getByLabel('Ubicación de las cantidades', { exact: true })
          .isDisabled(),
        true,
      )
      equal(
        await editor
          .getByRole('button', {
            name: 'Aumentar cantidad en una unidad',
            exact: true,
          })
          .isDisabled(),
        true,
      )
      equal(await stock(product), 18)
      equal((await movements(product)).length, 1)
      await healthy(`Edición pendiente ${width}`)
      await page.screenshot({
        path: `${output}/edicion-pendiente-${width}.png`,
        fullPage: false,
      })
      await editor
        .getByRole('button', { name: 'Verificar guardado', exact: true })
        .click()
      await editor
        .getByRole('status')
        .filter({ hasText: 'Cantidad guardada en Tienda.' })
        .waitFor()
      equal(lost.payloads.length, 2)
      equal(lost.payloads[1], lost.payloads[0])
      equal(await stock(product), 18)
      equal((await movements(product)).length, 1)
      equal(
        await editor
          .getByLabel('Unidades a mover', { exact: true })
          .inputValue(),
        '',
      )
      equal(
        await editor
          .getByLabel('Motivo del cambio de cantidad', { exact: true })
          .inputValue(),
        '',
      )
      equal(
        await editor
          .getByLabel('Unidades a mover', { exact: true })
          .isEnabled(),
        true,
      )
      await editor.getByLabel('Unidades a mover', { exact: true }).fill('1')
      await editor
        .getByLabel('Motivo del cambio de cantidad', { exact: true })
        .fill('Nueva salida desde edición')
      await editor
        .getByRole('button', { name: 'Guardar cantidades', exact: true })
        .click()
      await editor
        .getByRole('status')
        .filter({ hasText: 'Cantidad guardada en Tienda.' })
        .waitFor()
      equal(lost.payloads.length, 3)
      equal(lost.payloads[2].requestId !== lost.payloads[0].requestId, true)
      equal(await stock(product), 17)
      equal((await movements(product)).length, 2)
      equal((await movements(product))[1].note, 'Nueva salida desde edición')
      await lost.remove()
      await healthy(`Edición confirmada ${width}`)

      // Atrás del navegador desmonta el formulario. El aviso global conserva
      // su solicitud y una instancia nueva no puede reemplazarla por otra.
      await navigate('/')
      await page.getByRole('heading', { name: 'Inicio', exact: true }).waitFor()
      await navigate('/inventory')
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      const backProduct = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004'
      const backLost = await captureLostResponse()
      const fillBackMovement = async (quantity, reason) => {
        await page.getByRole('button', { name: 'Salida', exact: true }).click()
        const dialog = page.getByRole('dialog', {
          name: 'Salida de inventario',
        })
        await dialog
          .getByRole('button', { name: /Producto del movimiento/ })
          .click()
        await dialog.getByPlaceholder('Nombre, marca o código…').fill('QA-0004')
        await dialog.getByRole('option').first().click()
        await dialog.getByLabel('Cantidad', { exact: true }).fill(quantity)
        await dialog.getByLabel('Motivo', { exact: true }).fill(reason)
        return dialog
      }
      let backDialog = await fillBackMovement(
        '2',
        'Salida original antes de Atrás',
      )
      await backDialog
        .getByRole('button', { name: 'Confirmar movimiento', exact: true })
        .click()
      await pendingFields(backDialog, 'Cantidad', 'Motivo')
      await page.goBack()
      await page.getByRole('heading', { name: 'Inicio', exact: true }).waitFor()
      equal(await page.getByRole('dialog').count(), 0)
      const banner = page.getByRole('status', {
        name: 'Operaciones por confirmar',
      })
      await banner.waitFor()
      equal(
        (await banner.innerText()).includes(
          'Movimiento de inventario pendiente de confirmar.',
        ),
        true,
      )
      equal(await stock(backProduct), 18)
      equal((await movements(backProduct)).length, 1)
      await healthy(`Atrás conserva operación ${width}`)
      await page.screenshot({
        path: `${output}/aviso-global-${width}.png`,
        fullPage: false,
      })

      await navigate('/inventory')
      backDialog = await fillBackMovement(
        '5',
        'Otra salida que debe bloquearse',
      )
      await backDialog
        .getByRole('button', { name: 'Confirmar movimiento', exact: true })
        .click()
      await backDialog
        .getByRole('alert')
        .filter({ hasText: 'Hay un guardado pendiente de confirmar.' })
        .waitFor()
      equal(
        backLost.payloads.length,
        1,
        'Reabrir inventario no envía una segunda salida',
      )
      equal(
        await backDialog.getByLabel('Cantidad', { exact: true }).inputValue(),
        '5',
      )
      equal(
        await backDialog.getByLabel('Cantidad', { exact: true }).isEnabled(),
        true,
        'Una instancia nueva no finge conservar el DTO antiguo',
      )
      await backDialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()

      // Editar las cantidades usa la misma clave de inventario, por lo que
      // tampoco puede sortear el bloqueo desde otra pantalla.
      await navigate(`/products/${backProduct}/edit`)
      const recreatedStock = page.locator('.product-stock-editor')
      await recreatedStock
        .getByLabel('Cómo cambiar las cantidades', { exact: true })
        .selectOption('EXIT')
      await recreatedStock
        .getByLabel('Unidades a mover', { exact: true })
        .fill('5')
      await recreatedStock
        .getByLabel('Motivo del cambio de cantidad', { exact: true })
        .fill('Salida alternativa bloqueada')
      await recreatedStock
        .getByRole('button', { name: 'Guardar cantidades', exact: true })
        .click()
      await recreatedStock
        .getByRole('alert')
        .filter({ hasText: 'Hay un guardado pendiente de confirmar.' })
        .waitFor()
      equal(
        backLost.payloads.length,
        1,
        'Editar tampoco envía otro movimiento mientras queda uno sin confirmar',
      )
      equal(await stock(backProduct), 18)
      await banner
        .getByRole('button', { name: 'Verificar operación', exact: true })
        .click()
      await banner.waitFor({ state: 'hidden' })
      await page
        .getByRole('status')
        .filter({ hasText: 'Operación confirmada. Consulta el historial.' })
        .waitFor()
      equal(backLost.payloads.length, 2)
      equal(backLost.payloads[1], backLost.payloads[0])
      equal(await stock(backProduct), 18)
      equal((await movements(backProduct)).length, 1)

      await navigate('/inventory')
      backDialog = await fillBackMovement(
        '1',
        'Nueva salida después de confirmar en aviso',
      )
      await backDialog
        .getByRole('button', { name: 'Confirmar movimiento', exact: true })
        .click()
      await backDialog.waitFor({ state: 'hidden' })
      equal(backLost.payloads.length, 3)
      equal(
        backLost.payloads[2].requestId !== backLost.payloads[0].requestId,
        true,
      )
      equal(await stock(backProduct), 17)
      equal((await movements(backProduct)).length, 2)
      await backLost.remove()
      await healthy(`Operación recuperada desde aviso ${width}`)
      equal(
        (await one('select count(*)::int n from public.inventory_movements')).n,
        8,
        'Cuatro reintentos recuperados más cuatro operaciones nuevas, sin duplicados',
      )
      equal(
        (
          await one(
            'select count(*)::int n from public.inventory_movement_costs',
          )
        ).n,
        8,
        'Cada salida o merma contabiliza una sola pérdida de costo',
      )
      equal(
        Number(
          (
            await one(
              'select sum(quantity*unit_cost_nio) total from public.inventory_movement_costs',
            )
          ).total,
        ),
        1200,
        'Costo de doce unidades, sin duplicar costo por reintento',
      )
      results.push({ width, status: 'passed', checks: checks - startChecks })
      console.log(
        `PASS movimientos ${width}px: salida, dañado y edición recuperan respuesta perdida sin duplicar; permiten después operaciones nuevas`,
      )
    } catch (error) {
      await page.screenshot({
        path: `${output}/fallo-${width}.png`,
        fullPage: true,
      })
      console.error(
        'URL',
        page.url(),
        'API',
        fixture.failures,
        'UI',
        (await page.locator('body').innerText()).slice(-4500),
      )
      throw error
    } finally {
      await context.close()
      await fixture.close()
    }
  }
} finally {
  await browser.close()
}
await writeFile(
  `${output}/resultados.json`,
  JSON.stringify(
    { checks, results, frontend: base, productionWrites: false },
    null,
    2,
  ),
)
console.log(`OK: ${checks} comprobaciones de confirmación de movimientos`)

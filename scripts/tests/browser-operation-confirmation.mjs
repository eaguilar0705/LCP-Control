import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) ||
    new URL(base).origin === 'https://lcp-control.pages.dev',
)
const output =
  process.env.LCP_TEST_OUTPUT ?? 'output/enterprise-operation-confirmation'
await mkdir(output, { recursive: true })
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
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
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const fixture = await browserDatabase(page)
    const errors = []
    const snapshots = []
    page.on('pageerror', (error) => errors.push(error.message))
    const one = async (sql, parameters = []) =>
      (await fixture.db.query(sql, parameters)).rows[0]
    const navigate = async (path) => {
      await page.evaluate((target) => {
        globalThis.history.pushState({}, '', target)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      await page.locator('.main-content h1').first().waitFor()
    }
    const warnReload = () =>
      page.evaluate(() => {
        const event = new globalThis.Event('beforeunload', { cancelable: true })
        globalThis.dispatchEvent(event)
        return event.defaultPrevented
      })
    const healthy = async (label) => {
      equal(errors, [], label + ': errores de navegador')
      equal(fixture.failures, [], label + ': errores SQL/API')
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        label + ': página dentro de pantalla',
      )
      for (const dialog of await page.getByRole('dialog').all())
        equal(
          await dialog.evaluate(
            (element) => element.scrollWidth > element.clientWidth + 1,
          ),
          false,
          label + ': diálogo dentro de pantalla',
        )
    }
    const locked = async (dialog, labels) => {
      for (const label of labels)
        equal(
          await dialog.getByLabel(label, { exact: true }).isDisabled(),
          true,
          label + ' bloqueado',
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
      await page.keyboard.press('Escape')
      equal(
        await dialog.isVisible(),
        true,
        'Escape no descarta una confirmación pendiente',
      )
      equal(
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .isEnabled(),
        true,
      )
    }
    const pending = () =>
      page.getByRole('status', {
        name: 'Operaciones por confirmar',
        exact: true,
      })
    const logoutBlocked = async () => {
      if (width < 900)
        await page
          .getByRole('button', { name: 'Abrir menú', exact: true })
          .click()
      await page
        .getByRole('button', { name: 'Cerrar sesión', exact: true })
        .click()
      await page
        .getByText(
          'Confirma primero las operaciones pendientes antes de cerrar sesión.',
          { exact: true },
        )
        .waitFor()
      equal(new URL(page.url()).pathname, '/', 'la sesión sigue activa')
      if (width < 900)
        await page
          .getByRole('button', { name: 'Cerrar menú', exact: true })
          .click()
    }
    const verifyGlobal = async () => {
      await pending()
        .getByRole('button', { name: 'Verificar operación', exact: true })
        .click()
      await page
        .getByText('Operación confirmada. Consulta el historial.', {
          exact: true,
        })
        .waitFor()
      await pending().waitFor({ state: 'hidden' })
      equal(
        await page
          .getByText(
            'Confirma primero las operaciones pendientes antes de cerrar sesión.',
            { exact: true },
          )
          .count(),
        0,
        'la confirmación elimina el aviso anterior de cierre de sesión bloqueado',
      )
      equal(
        await warnReload(),
        false,
        'confirmación recuperada deja de bloquear la salida',
      )
    }
    const purchaseState = async () =>
      one(
        `select
      (select quantity from public.inventory_balances where product_id=$1 and location='store') stock,
      (select count(*)::int from public.purchase_shipments) purchases,
      (select coalesce(sum(quantity),0)::int from public.purchase_shipment_lines where product_id=$1) units`,
        [product],
      )
    const openPurchase = async (units) => {
      await navigate('/products/' + product + '/edit')
      await page
        .locator('.product-stock-editor')
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Entra a', { exact: true }).selectOption('store')
      await dialog.getByLabel('Unidades', { exact: true }).fill(String(units))
      await dialog
        .getByLabel('Costo por unidad (C$)', { exact: true })
        .fill('100')
      await dialog.getByLabel('Pago', { exact: true }).selectOption('credito')
      await dialog
        .getByLabel('Proveedor', { exact: true })
        .fill('Proveedor Auditoría')
      return dialog
    }
    let invoiceId
    const creditState = async () =>
      one(
        `select
      (select count(*)::int from public.finance_entries where document_id=$1 and voided_at is null) payments,
      (select coalesce(sum(amount*exchange_rate),0)::text from public.finance_entries where document_id=$1 and voided_at is null) paid,
      ((select total from public.documents where id=$1)-(select coalesce(sum(amount*exchange_rate),0) from public.finance_entries where document_id=$1 and voided_at is null))::text pending`,
        [invoiceId],
      )
    const openCredit = async (description) => {
      await navigate('/accounting')
      await page
        .getByRole('button', { name: 'Cobros y pagos', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Cobrar', exact: true })
        .first()
        .click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Importe (NIO)', { exact: true }).fill('100')
      await dialog.getByLabel('Descripción', { exact: true }).fill(description)
      return dialog
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

      let dialog = await openPurchase(2)
      const purchaseInputs = []
      let purchaseLost = false
      const losePurchase = async (route) => {
        const input = route.request().postDataJSON().p_input
        purchaseInputs.push(input)
        if (purchaseLost) return route.fallback()
        purchaseLost = true
        await fixture.db.query('select public.record_shipment($1::jsonb)', [
          JSON.stringify(input),
        ])
        await route.abort('failed')
      }
      await page.route('**/rest/v1/rpc/record_shipment', losePurchase)
      await dialog
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'No pudimos confirmar el guardado' })
        .waitFor()
      await locked(dialog, ['Unidades', 'Costo por unidad (C$)', 'Nota'])
      equal(await purchaseState(), { stock: 22, purchases: 1, units: 2 })
      snapshots.push({
        case: 'purchase-response-lost',
        ...(await purchaseState()),
      })

      // Atrás desmonta el diálogo. El registro en memoria conserva la solicitud
      // original y deja disponible su verificación desde cualquier pantalla.
      await page.goBack()
      await page.getByRole('heading', { name: 'Inicio', exact: true }).waitFor()
      await pending()
        .getByText('Compra pendiente de confirmar.', { exact: true })
        .waitFor()
      equal(await page.getByRole('dialog').count(), 0)
      equal(await warnReload(), true)
      await logoutBlocked()
      await healthy('compra pendiente en Inicio ' + width)
      await page.screenshot({
        path: `${output}/compra-pendiente-${width}.png`,
        fullPage: false,
      })

      // Abrir otro formulario no permite disfrazar la misma compra como nueva.
      dialog = await openPurchase(3)
      await dialog
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'Hay un guardado pendiente de confirmar.' })
        .waitFor()
      equal(await purchaseState(), { stock: 22, purchases: 1, units: 2 })
      equal(purchaseInputs.length, 1, 'el formulario nuevo no llega a escribir')
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      await navigate('/')
      await verifyGlobal()
      equal(await purchaseState(), { stock: 22, purchases: 1, units: 2 })
      equal(purchaseInputs.length, 2)
      equal(purchaseInputs[0].requestId, purchaseInputs[1].requestId)
      snapshots.push({
        case: 'purchase-recovered-after-back',
        ...(await purchaseState()),
        ids: purchaseInputs.map((input) => input.requestId),
      })

      dialog = await openPurchase(1)
      await dialog
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      equal(
        await purchaseState(),
        { stock: 23, purchases: 2, units: 3 },
        'una compra legítima posterior sí se registra',
      )
      equal(purchaseInputs.length, 3)
      assert.notEqual(purchaseInputs[1].requestId, purchaseInputs[2].requestId)
      checks++
      await page.unroute('**/rest/v1/rpc/record_shipment', losePurchase)

      const invoice = await one(
        'select public.create_document($1::jsonb) result',
        [
          JSON.stringify({
            requestId: crypto.randomUUID(),
            kind: 'invoice',
            customerName: 'Cliente con confirmación pendiente',
            tier: 'emprendedor',
            currency: 'NIO',
            exchangeRate: 1,
            location: 'store',
            paymentMethod: 'pending',
            notes: '',
            items: [{ productId: product, quantity: 2 }],
          }),
        ],
      )
      invoiceId = invoice.result.id
      await navigate('/')
      dialog = await openCredit('Primer abono confirmado por el cliente')
      const creditInputs = []
      let creditLost = false
      const loseCredit = async (route) => {
        const input = route.request().postDataJSON().p_input
        creditInputs.push(input)
        if (creditLost) return route.fallback()
        creditLost = true
        await fixture.db.query(
          'select public.record_finance_entry($1::jsonb)',
          [JSON.stringify(input)],
        )
        await route.abort('failed')
      }
      await page.route('**/rest/v1/rpc/record_finance_entry', loseCredit)
      await dialog.getByRole('button', { name: 'Guardar', exact: true }).click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'No pudimos confirmar el guardado' })
        .waitFor()
      await locked(dialog, ['Importe (NIO)', 'Descripción', 'Referencia'])
      equal(Number((await creditState()).pending), 632)
      equal((await creditState()).payments, 1)
      snapshots.push({ case: 'credit-response-lost', ...(await creditState()) })

      // La navegación SPA también conserva la confirmación del abono.
      await navigate('/')
      await pending()
        .getByText('Cobro o pago pendiente de confirmar.', { exact: true })
        .waitFor()
      equal(
        await page
          .getByText('Operación confirmada. Consulta el historial.', {
            exact: true,
          })
          .count(),
        0,
        'el nuevo abono pendiente no muestra la confirmación de una operación anterior',
      )
      equal(await warnReload(), true)
      await logoutBlocked()
      await healthy('abono pendiente en Inicio ' + width)
      await page.screenshot({
        path: `${output}/abono-pendiente-${width}.png`,
        fullPage: false,
      })

      dialog = await openCredit(
        'Descripción nueva que no debe duplicar el abono',
      )
      await dialog.getByRole('button', { name: 'Guardar', exact: true }).click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'Hay un guardado pendiente de confirmar.' })
        .waitFor()
      equal((await creditState()).payments, 1)
      equal(Number((await creditState()).pending), 632)
      equal(creditInputs.length, 1)
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      await navigate('/')
      await verifyGlobal()
      equal((await creditState()).payments, 1)
      equal(Number((await creditState()).pending), 632)
      equal(creditInputs.length, 2)
      equal(creditInputs[0].requestId, creditInputs[1].requestId)
      snapshots.push({
        case: 'credit-recovered-after-spa-navigation',
        ...(await creditState()),
        ids: creditInputs.map((input) => input.requestId),
      })

      dialog = await openCredit(
        'Segundo abono legítimo posterior a la confirmación',
      )
      await dialog.getByRole('button', { name: 'Guardar', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      equal((await creditState()).payments, 2)
      equal(Number((await creditState()).pending), 532)
      equal(creditInputs.length, 3)
      assert.notEqual(creditInputs[1].requestId, creditInputs[2].requestId)
      checks++
      await page.unroute('**/rest/v1/rpc/record_finance_entry', loseCredit)

      // Un rechazo definitivo de validación permanece editable: no representa
      // una escritura desconocida y no debe obligar a verificar otro registro.
      dialog = await openCredit(
        'Validación rechazada, conservando datos editables',
      )
      const reject = (route) =>
        route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'P0001',
            message: 'Revisa la referencia de este abono.',
          }),
        })
      await page.route('**/rest/v1/rpc/record_finance_entry', reject)
      await dialog.getByRole('button', { name: 'Guardar', exact: true }).click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'Revisa la referencia' })
        .waitFor()
      equal(
        await page
          .getByText('Operación confirmada. Consulta el historial.', {
            exact: true,
          })
          .count(),
        0,
        'un rechazo definitivo tampoco hace reaparecer una confirmación antigua',
      )
      equal(
        await dialog.getByLabel('Importe (NIO)', { exact: true }).isEnabled(),
        true,
      )
      equal(
        await dialog
          .getByRole('button', { name: 'Cancelar', exact: true })
          .isEnabled(),
        true,
      )
      equal(
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .count(),
        0,
      )
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      equal((await creditState()).payments, 2)
      await healthy('flujos recuperados ' + width)
      results.push({ width, checks, snapshots })
      console.log(
        `PASS confirmación ${width}px: compra y abono guardados una sola vez, campos/cierre protegidos, Atrás/Inicio con aviso global, cierre de sesión bloqueado, segunda instancia rechazada, confirmación original recuperada y nuevas operaciones legítimas permitidas`,
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
  JSON.stringify({ checks, results }, null, 2),
)
console.log(
  `OK: ${checks} comprobaciones de confirmaciones operativas y factor humano`,
)

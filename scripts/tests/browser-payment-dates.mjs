import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { browserDatabase } from './browser-database.mjs'

const baseUrl = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
const output = 'output/system-review'
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
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
    const calls = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('request', (request) => {
      if (
        /\/rest\/v1\/rpc\/(record_shipment|record_finance_entry)$/.test(
          request.url(),
        )
      )
        calls.push(request.url().split('/').at(-1))
    })
    const fixture = await browserDatabase(page)
    const { today } = fixture
    const yesterday = new Date(
      new Date(today + 'T12:00:00Z').getTime() - 86400000,
    )
      .toISOString()
      .slice(0, 10)
    const get = async (sql, args = []) =>
      (await fixture.db.query(sql, args)).rows[0]
    const day = async () =>
      (await get('select public.get_business_day(null) r')).r
    const navigate = async (path) => {
      await page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      await page.locator('.main-content h1').first().waitFor()
    }
    const healthy = async (label) => {
      equal(errors, [], label + ': errores del navegador')
      equal(fixture.failures, [], label + ': errores de API')
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        label + ': desbordamiento de página',
      )
      const dialog = page.getByRole('dialog')
      if (await dialog.count()) {
        equal(
          await dialog.evaluate(
            (element) => element.scrollWidth > element.clientWidth + 1,
          ),
          false,
          label + ': desbordamiento de diálogo',
        )
        equal(
          await dialog
            .locator('.payment-date-confirmation')
            .evaluateAll((elements) =>
              elements.some((element) => {
                const own = element.getBoundingClientRect()
                const parent = element
                  .closest('dialog,[role="dialog"]')
                  .getBoundingClientRect()
                return (
                  own.left < parent.left - 1 || own.right > parent.right + 1
                )
              }),
            ),
          false,
          label + ': confirmación de pago fuera del diálogo',
        )
      }
    }
    const purchaseDialog = async () => {
      await navigate(`/products/${productId}/edit`)
      await page
        .getByRole('button', { name: 'Costo de inventario', exact: true })
        .click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Unidades', { exact: true }).fill('2')
      await dialog
        .getByLabel('Costo por unidad (C$)', { exact: true })
        .fill('100')
      await dialog
        .getByLabel('Factura o referencia', { exact: true })
        .fill(`PAGO-UI-${width}`)
      return dialog
    }
    try {
      await fixture.db.query('select public.open_business_day($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedDay: today,
          openingNio: 1000,
          openingUsd: 0,
        }),
      ])
      await page.goto(baseUrl + '/login')
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

      // Una compra a crédito conserva la fecha del documento y no declara
      // movimiento físico de dinero. No necesita confirmar un pago anterior.
      let dialog = await purchaseDialog()
      await dialog
        .getByLabel('Fecha de la compra', { exact: true })
        .fill(yesterday)
      await dialog.getByLabel('Pago', { exact: true }).selectOption('credito')
      equal(await dialog.locator('.payment-date-confirmation').count(), 0)
      await healthy(`compra a crédito ${width}`)
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      equal(
        (await get('select count(*)::int n from public.purchase_shipments')).n,
        0,
      )

      dialog = await purchaseDialog()
      await dialog
        .getByLabel('Fecha de la compra', { exact: true })
        .fill(yesterday)
      await dialog.locator('.payment-date-confirmation').waitFor()
      await healthy(`aviso de compra anterior ${width}`)
      await dialog
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'Confirma la fecha real del pago de esta compra.' })
        .waitFor()
      equal(
        (await get('select count(*)::int n from public.purchase_shipments')).n,
        0,
      )
      equal(
        (
          await get(
            'select quantity from public.inventory_balances where product_id=$1 and location=$2',
            [productId, 'warehouse'],
          )
        ).quantity,
        10,
      )
      equal((await day()).report.expectedNio, 1000)
      equal(calls.filter((name) => name === 'record_shipment').length, 0)
      if (width === 320)
        await page.screenshot({
          path: `${output}/payment-purchase-confirmation-320.png`,
          fullPage: true,
        })
      await dialog
        .getByRole('button', { name: 'El pago se hizo hoy', exact: true })
        .click()
      equal(
        await dialog
          .getByLabel('Fecha de la compra', { exact: true })
          .inputValue(),
        today,
      )
      equal(await dialog.locator('.payment-date-confirmation').count(), 0)
      // Formulario completo antes de medianoche: adelantar sólo Date no
      // provoca renders ni altera los temporizadores de la aplicación.
      const purchaseTime = await page.evaluate(() => globalThis.Date.now())
      await page.clock.setFixedTime(new Date(purchaseTime + 86400000))
      await dialog
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'Confirma la fecha real del pago de esta compra.' })
        .waitFor()
      await dialog.locator('.payment-date-confirmation').waitFor()
      equal(
        (await get('select count(*)::int n from public.purchase_shipments')).n,
        0,
        'Cruzar medianoche no escribe una compra con la validación anterior',
      )
      equal(calls.filter((name) => name === 'record_shipment').length, 0)
      equal((await day()).report.expectedNio, 1000)
      await healthy(`compra abierta antes de medianoche ${width}`)
      await page.clock.setFixedTime(new Date(purchaseTime))
      await dialog
        .getByRole('button', { name: 'El pago se hizo hoy', exact: true })
        .click()
      equal(
        await dialog
          .getByLabel('Fecha de la compra', { exact: true })
          .inputValue(),
        today,
        'El botón de hoy consulta el reloj al pulsarlo',
      )
      await dialog
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      const saved = await get(
        'select count(*)::int n,min(incurred_on)::text as recorded_on,sum(goods_amount)::numeric amount from public.purchase_shipments',
      )
      equal(saved.n, 1, 'La confirmación no duplica la compra')
      equal(saved.recorded_on, today)
      equal(Number(saved.amount), 200)
      equal(calls.filter((name) => name === 'record_shipment').length, 1)
      equal(
        (
          await get(
            'select quantity from public.inventory_balances where product_id=$1 and location=$2',
            [productId, 'warehouse'],
          )
        ).quantity,
        12,
      )
      equal(
        (await day()).report.expectedNio,
        800,
        'La compra pagada hoy participa del arqueo de hoy',
      )
      await healthy(`compra registrada ${width}`)

      // La deuda se crea por su propia RPC real; su abono en pantalla debe
      // usar la fecha real del pago, independientemente de la compra original.
      await fixture.db.query('select public.record_shipment($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          incurredOn: today,
          supplier: 'Proveedor Auditoría',
          agency: '',
          reference: `DEUDA-PAGO-${width}`,
          note: '',
          currency: 'NIO',
          exchangeRate: 1,
          shippingAmount: 0,
          account: 'credito',
          lines: [
            { productId, location: 'warehouse', quantity: 1, unitPrice: 120 },
          ],
        }),
      ])
      await navigate('/accounting')
      await page
        .getByRole('button', { name: 'Cobros y pagos', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Pagar', exact: true })
        .first()
        .click()
      dialog = page.getByRole('dialog')
      await dialog.getByLabel('Fecha', { exact: true }).fill(yesterday)
      await dialog.getByLabel('Importe (NIO)', { exact: true }).fill('50')
      await dialog
        .getByLabel('Descripción', { exact: true })
        .fill('Pago real de hoy')
      await dialog.locator('.payment-date-confirmation').waitFor()
      equal(
        await dialog
          .getByRole('button', { name: 'Guardar', exact: true })
          .isDisabled(),
        true,
        'No se puede abonar una deuda en una fecha anterior a su existencia',
      )
      equal(
        (await get('select count(*)::int n from public.finance_entries')).n,
        0,
      )
      equal((await day()).report.expectedNio, 800)
      equal(calls.filter((name) => name === 'record_finance_entry').length, 0)
      await healthy(`abono con fecha anterior ${width}`)
      if (width === 320)
        await page.screenshot({
          path: `${output}/payment-credit-confirmation-320.png`,
          fullPage: true,
        })
      await dialog
        .getByRole('button', { name: 'El pago se hizo hoy', exact: true })
        .click()
      equal(
        await dialog.getByLabel('Fecha', { exact: true }).inputValue(),
        today,
      )
      await dialog
        .locator('.accounting-callout')
        .filter({ hasText: 'Saldo al' })
        .waitFor()
      const paymentTime = await page.evaluate(() => globalThis.Date.now())
      await page.clock.setFixedTime(new Date(paymentTime + 86400000))
      await dialog.getByRole('button', { name: 'Guardar', exact: true }).click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'Confirma la fecha real del movimiento de dinero.' })
        .waitFor()
      await dialog.locator('.payment-date-confirmation').waitFor()
      equal(
        (await get('select count(*)::int n from public.finance_entries')).n,
        0,
        'El abono abierto antes de medianoche exige revisar la fecha al guardar',
      )
      equal(calls.filter((name) => name === 'record_finance_entry').length, 0)
      equal((await day()).report.expectedNio, 800)
      await healthy(`abono abierto antes de medianoche ${width}`)
      await page.clock.setFixedTime(new Date(paymentTime))
      await dialog
        .getByRole('button', { name: 'El pago se hizo hoy', exact: true })
        .click()
      equal(
        await dialog.getByLabel('Fecha', { exact: true }).inputValue(),
        today,
      )
      await dialog.getByRole('button', { name: 'Guardar', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      const payment = await get(
        'select count(*)::int n,min(occurred_on)::text as recorded_on,sum(amount)::numeric amount from public.finance_entries',
      )
      equal(payment.n, 1)
      equal(payment.recorded_on, today)
      equal(Number(payment.amount), 50)
      equal(calls.filter((name) => name === 'record_finance_entry').length, 1)
      equal((await day()).report.expectedNio, 750)
      await healthy(`abono registrado ${width}`)
      console.log(`Fechas de pago en navegador: ${width}px correcto.`)
    } finally {
      await fixture.close()
      await context.close()
    }
  }
  console.log(`Fechas de pago: ${checks} verificaciones correctas.`)
} finally {
  await browser.close()
}

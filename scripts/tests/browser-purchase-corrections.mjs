import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5191'
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) ||
    new URL(base).origin === 'https://lcp-control.pages.dev',
)
const output =
  process.env.LCP_TEST_OUTPUT ?? 'output/purchase-corrections/browser'
await mkdir(output, { recursive: true })
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
let checks = 0
const equal = (actual, expected, label) => {
  assert.deepEqual(actual, expected, label)
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
    page.setDefaultTimeout(20000)
    const fixture = await browserDatabase(page)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const one = async (sql, values = []) =>
      (await fixture.db.query(sql, values)).rows[0]
    const navigate = async (path) => {
      await page.evaluate((target) => {
        globalThis.history.pushState({}, '', target)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      await page.locator('.main-content h1').first().waitFor()
    }
    const healthy = async (label) => {
      equal(errors, [], label + ': navegador')
      equal(fixture.failures, [], label + ': API')
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        label + ': página',
      )
      for (const dialog of await page.getByRole('dialog').all())
        equal(
          await dialog.evaluate(
            (element) => element.scrollWidth > element.clientWidth + 1,
          ),
          false,
          label + ': diálogo',
        )
    }
    const stock = async () =>
      (
        await one(
          'select sum(quantity)::int n from public.inventory_balances where product_id=$1',
          [product],
        )
      ).n
    const openHistory = async () => {
      await navigate('/inventory')
      await page.getByRole('button', { name: 'Compras', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog
        .getByRole('heading', { name: 'Historial de compras', exact: true })
        .waitFor()
      await dialog
        .getByRole('button', { name: 'Ver compra', exact: true })
        .first()
        .waitFor()
      return dialog
    }
    const locked = async (dialog, field) => {
      equal(await dialog.getByLabel(field, { exact: true }).isDisabled(), true)
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
      equal(await dialog.isVisible(), true)
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
      await navigate('/products/' + product + '/edit')
      await page
        .locator('.product-stock-editor')
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      let dialog = page.getByRole('dialog')
      await dialog.getByLabel('Unidades', { exact: true }).fill('2')
      await dialog.getByLabel('Entra a', { exact: true }).selectOption('store')
      await dialog.getByLabel('Pago', { exact: true }).selectOption('banco')
      await dialog
        .getByLabel('Moneda de la compra', { exact: true })
        .selectOption('USD')
      await dialog
        .getByLabel('Costo por unidad (US$)', { exact: true })
        .fill('10')
      await dialog
        .getByLabel('Factura o referencia', { exact: true })
        .fill('QA-BANCO-' + width)
      await dialog
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'Selecciona el banco pagador' })
        .waitFor()
      equal(
        (await one('select count(*)::int n from public.purchase_shipments')).n,
        0,
      )
      await dialog
        .getByLabel('Banco pagador', { exact: true })
        .selectOption('1120-004')
      equal(
        await dialog
          .getByLabel('Banco pagador', { exact: true })
          .locator('option')
          .count(),
        4,
        'Sólo bancos USD',
      )
      await dialog
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      equal(await stock(), 32)
      equal(
        (await one('select bank_ledger_account from public.purchase_shipments'))
          .bank_ledger_account,
        '1120-004',
      )

      dialog = await openHistory()
      await dialog
        .getByRole('button', { name: 'Ver compra', exact: true })
        .first()
        .click()
      await dialog
        .getByRole('button', { name: 'Corregir compra', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      await dialog
        .getByLabel('Motivo de la corrección', { exact: true })
        .fill('Cantidad y banco corregidos')
      await dialog.getByRole('checkbox').check()
      await dialog.getByLabel('Unidades', { exact: true }).fill('3')
      await dialog
        .getByLabel('Banco pagador', { exact: true })
        .selectOption('1120-002')
      const requests = []
      let lost = false
      const lose = async (route) => {
        const input = route.request().postDataJSON().p_input
        requests.push(input)
        if (lost) return route.fallback()
        lost = true
        await fixture.db.query('select public.correct_purchase($1::jsonb)', [
          JSON.stringify(input),
        ])
        await route.abort('failed')
      }
      await page.route('**/rest/v1/rpc/correct_purchase', lose)
      await dialog
        .getByRole('button', { name: 'Guardar corrección', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'No pudimos confirmar el guardado' })
        .waitFor()
      await locked(dialog, 'Motivo de la corrección')
      equal(await stock(), 33)
      equal(
        (await one('select count(*)::int n from public.purchase_corrections'))
          .n,
        1,
      )
      await healthy('corrección pendiente ' + width)
      await page.screenshot({
        path: `${output}/correccion-${width}.png`,
        fullPage: false,
      })
      await dialog
        .getByRole('button', { name: 'Verificar guardado', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Historial de compras', exact: true })
        .waitFor()
      equal(requests.length, 2)
      equal(requests[0], requests[1], 'Mismo payload y UUID')
      equal(
        (await one('select count(*)::int n from public.purchase_shipments')).n,
        2,
      )
      equal(await stock(), 33)
      await page.unroute('**/rest/v1/rpc/correct_purchase', lose)
      const replacement = (
        await one('select replacement_id from public.purchase_corrections')
      ).replacement_id
      const rows = page.locator('.purchase-history-row')
      for (const row of await rows.all()) {
        await row
          .getByRole('button', { name: 'Ver compra', exact: true })
          .click()
        if (
          await row
            .getByRole('button', { name: 'Anular compra', exact: true })
            .count()
        ) {
          await row
            .getByRole('button', { name: 'Anular compra', exact: true })
            .click()
          break
        }
      }
      dialog = page.getByRole('dialog')
      await dialog
        .getByRole('heading', { name: 'Anular compra', exact: true })
        .waitFor()
      await dialog
        .getByLabel('Motivo de la anulación', { exact: true })
        .fill('Pedido ingresado dos veces')
      await dialog.getByRole('checkbox').check()
      let cancelLost = false
      const cancellationRequests = []
      const loseCancel = async (route) => {
        const input = route.request().postDataJSON().p_input
        cancellationRequests.push(input)
        if (cancelLost) return route.fallback()
        cancelLost = true
        await fixture.db.query('select public.correct_purchase($1::jsonb)', [
          JSON.stringify(input),
        ])
        await route.abort('failed')
      }
      await page.route('**/rest/v1/rpc/correct_purchase', loseCancel)
      await dialog
        .getByRole('button', { name: 'Confirmar anulación', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'No pudimos confirmar el guardado' })
        .waitFor()
      await locked(dialog, 'Motivo de la anulación')
      equal(await stock(), 30)
      equal(cancellationRequests[0].shipmentId, replacement)
      await navigate('/')
      const pending = page.getByRole('status', {
        name: 'Operaciones por confirmar',
        exact: true,
      })
      await pending
        .getByRole('button', { name: 'Verificar operación', exact: true })
        .click()
      await pending.waitFor({ state: 'hidden' })
      equal(cancellationRequests.length, 2)
      equal(cancellationRequests[0], cancellationRequests[1])
      equal(
        (await one('select count(*)::int n from public.purchase_corrections'))
          .n,
        2,
      )
      equal(await stock(), 30)
      await page.unroute('**/rest/v1/rpc/correct_purchase', loseCancel)
      dialog = await openHistory()
      await healthy('historial final ' + width)
      await page.screenshot({
        path: `${output}/historial-${width}.png`,
        fullPage: false,
      })
      await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click()
      const creditProduct = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'
      const creditPurchase = (
        await one('select public.record_shipment($1::jsonb) id', [
          JSON.stringify({
            requestId: crypto.randomUUID(),
            incurredOn: fixture.today,
            supplier: 'Proveedor Auditoría',
            agency: '',
            reference: 'QA-ABONO-' + width,
            note: '',
            currency: 'NIO',
            exchangeRate: 1,
            account: 'credito',
            shippingAmount: 0,
            lines: [
              {
                productId: creditProduct,
                location: 'store',
                quantity: 2,
                unitPrice: 100,
              },
            ],
          }),
        ])
      ).id
      await fixture.db.query('select public.record_finance_entry($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          occurredOn: fixture.today,
          kind: 'supplier_payment',
          account: 'caja',
          toAccount: null,
          amount: 100,
          currency: 'NIO',
          exchangeRate: 1,
          counterparty: '',
          description: 'Abono real',
          reference: '',
          shipmentId: creditPurchase,
        }),
      ])
      dialog = await openHistory()
      const creditRow = page
        .locator('.purchase-history-row')
        .filter({ hasText: 'QA-ABONO-' + width })
      await creditRow
        .getByRole('button', { name: 'Ver compra', exact: true })
        .click()
      await creditRow
        .getByRole('button', { name: 'Corregir compra', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      equal(
        await dialog
          .getByLabel('Tratamiento de los pagos', { exact: true })
          .inputValue(),
        'keep_payments',
        'La corrección conserva abonos reales por defecto',
      )
      await dialog
        .getByLabel('Motivo de la corrección', { exact: true })
        .fill('Corregir unidades conservando el abono real')
      await dialog.getByLabel('Unidades', { exact: true }).fill('3')
      await dialog.getByRole('checkbox').check()
      await dialog
        .getByRole('button', { name: 'Guardar corrección', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Historial de compras', exact: true })
        .waitFor()
      const debts = (
        await one('select public.credit_accounts($1) r', [fixture.today])
      ).r
      equal(
        debts.rows.find((row) => row.reference === 'QA-ABONO-' + width)
          .balanceNio,
        200,
      )
      equal(
        (await one('select count(*)::int n from public.finance_entries')).n,
        1,
      )
      equal(
        (await one('select public.get_business_day(null) r')).r.report
          .expectedNio,
        900,
        'El abono real no regresa ficticiamente a caja',
      )
      await healthy('abono real conservado ' + width)
      equal((await one('select count(*)::int n from public.purchase_corrections')).n, 3)
      equal((await one('select count(*)::int n from public.purchase_shipments')).n, 4)
      results.push({ width, stock: await stock(), corrections: 3, purchases: 4, creditBalance: 200 })
    } finally {
      await fixture.close()
      await context.close()
    }
  }
  await writeFile(
    `${output}/results.json`,
    JSON.stringify({ checks, results, productionWrites: 0 }, null, 2),
  )
  console.log(
    JSON.stringify({ checks, widths: results.length, productionWrites: 0 }),
  )
} finally {
  await browser.close()
}

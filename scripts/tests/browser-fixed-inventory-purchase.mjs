import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5207'
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname))
process.env.VITE_SUPABASE_URL ??= 'https://local-test.supabase.co'
process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??= 'sb_publishable_local_test'
process.env.VITE_DATA_MODE = 'supabase'
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5207, strictPort: true, hmr: false },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const output = 'output/fixed-inventory-purchase-review'
await mkdir(output, { recursive: true })
let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
try {
  for (const width of [1440, 320]) {
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
    page.on('pageerror', (e) => errors.push(e.message))
    // Every database request is fulfilled against the disposable PostgreSQL
    // fixture. Other remote requests are rejected, including external media.
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url())
      return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.hostname.endsWith('.supabase.co')
        ? route.fallback()
        : route.abort('blockedbyclient')
    })
    const one = async (sql, args = []) =>
      (await fixture.db.query(sql, args)).rows[0]
    const rpc = async (name, input) =>
      (await one(`select public.${name}($1::jsonb) r`, [JSON.stringify(input)]))
        .r
    const navigate = (path) =>
      page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
    const healthy = async (label) => {
      eq(errors, [], label + ': React sin errores')
      eq(fixture.failures, [], label + ': SQL/API sin errores')
      eq(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        label + ': página sin desbordamiento',
      )
      for (const dialog of await page.getByRole('dialog').all())
        eq(
          await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
          false,
          label + ': diálogo sin desbordamiento',
        )
    }
    const fixedCharge = async (dialog, total) => {
      const account = dialog.getByLabel('Cuenta 1', { exact: true })
      await account.waitFor()
      eq(await account.inputValue(), '1130', 'Inventario es la cuenta 1')
      eq(await account.isDisabled(), true, 'la cuenta del cargo es fija')
      eq(
        await dialog.getByLabel('Moneda 1', { exact: true }).isDisabled(),
        true,
        'la moneda del cargo es fija',
      )
      eq(
        await dialog.getByLabel('Debe 1', { exact: true }).inputValue(),
        String(total),
        'el cargo toma el costo y envío originales en córdobas',
      )
      for (const label of ['Debe 1', 'Haber 1'])
        eq(
          await dialog.getByLabel(label, { exact: true }).isEditable(),
          false,
          label + ' del cargo no se puede editar',
        )
      eq(
        await dialog
          .getByRole('button', { name: 'Quitar renglón 1', exact: true })
          .isDisabled(),
        true,
        'no se puede quitar el cargo a Inventario',
      )
      const options = await dialog
        .getByLabel('Cuenta 2', { exact: true })
        .locator('option')
        .evaluateAll((options) => options.map((o) => o.value))
      eq(options.includes('2190'), false, 'no ofrece la cuenta temporal')
      eq(options.includes('1130'), false, 'no permite otro cargo a Inventario')
      eq(
        await dialog.getByLabel('Cuenta 2', { exact: true }).isEditable(),
        true,
        'la contrapartida sí se puede elegir',
      )
    }
    const confirm = async (dialog) => {
      await dialog
        .getByRole('button', { name: 'Revisar y guardar', exact: true })
        .click()
      await dialog
        .getByRole('button', { name: 'Confirmar comprobante', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
    }
    try {
      await rpc('open_business_day', {
        requestId: crypto.randomUUID(),
        expectedDay: fixture.today,
        openingNio: 1000,
        openingUsd: 0,
      })
      const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
      const usd = width === 320
      const total = usd ? 407 : 215
      const inventoryLedger = async () =>
        Number(
          (
            await one('select public.ledger_report($1::date,$1::date) r', [
              fixture.today,
            ])
          ).r.accounts.find((a) => a.code === '1130').closing,
        )
      const initialInventory = await inventoryLedger()
      const receipt = await rpc('record_shipment', {
        requestId: crypto.randomUUID(),
        incurredOn: fixture.today,
        supplier: 'Proveedor Auditoría',
        agency: 'Agencia de auditoría',
        reference: 'COMPRA-CARGO-FIJO',
        note: '',
        currency: usd ? 'USD' : 'NIO',
        exchangeRate: usd ? 37 : 1,
        account: 'pending',
        shippingAmount: usd ? 1 : 15,
        lines: [
          {
            productId: product,
            location: 'store',
            quantity: 2,
            unitPrice: usd ? 5 : 100,
          },
        ],
      })
      const stockAndCost = async () =>
        (
          await one(
            `select jsonb_build_object(
              'stock',(select sum(quantity) from public.inventory_balances where product_id=$1),
              'cost',(select to_jsonb(c) from public.product_costs c where product_id=$1)
            ) snapshot`,
            [product],
          )
        ).snapshot
      const before = await stockAndCost()
      eq(
        Number(before.stock),
        32,
        'la compra ingresa las unidades una sola vez',
      )
      const priceHash = (
        await one(
          'select md5(jsonb_agg(to_jsonb(p) order by product_id,tier_code,currency)::text) h from public.product_prices p',
        )
      ).h
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
      await navigate('/accounting')
      await page
        .getByRole('button', { name: 'Clasificar compra', exact: true })
        .click()
      let dialog = page.getByRole('dialog', {
        name: 'Clasificar compra',
        exact: true,
      })
      await fixedCharge(dialog, total)
      await dialog
        .getByLabel('Cuenta 2', { exact: true })
        .selectOption(usd ? '1120-002' : '1110-001')
      if (usd) {
        await dialog.getByLabel('Tipo de cambio 2', { exact: true }).fill('37')
        await dialog.getByLabel('Haber 2', { exact: true }).fill('11')
      }
      // Saving and resuming the purchase draft must retain the locked first
      // line; ordinary journal drafts still use the shared editable component.
      await dialog
        .getByRole('button', { name: 'Guardar borrador', exact: true })
        .click()
      await dialog.getByText('Borrador guardado.', { exact: true }).waitFor()
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      await page
        .getByRole('button', { name: 'Borradores contables', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Continuar borrador', exact: true })
        .click()
      dialog = page.getByRole('dialog', {
        name: 'Continuar borrador contable',
        exact: true,
      })
      await fixedCharge(dialog, total)
      await healthy('borrador de compra ' + width)
      await page.screenshot({
        path: `${output}/cargo-fijo-${width}.png`,
        fullPage: true,
      })
      if (width === 1440) {
        let dropped = false
        await page.route('**/rest/v1/rpc/classify_purchase', async (route) => {
          if (dropped) return route.fallback()
          dropped = true
          await rpc('classify_purchase', route.request().postDataJSON().p_input)
          return route.abort('connectionreset')
        })
        await dialog
          .getByRole('button', { name: 'Revisar y guardar', exact: true })
          .click()
        await dialog
          .getByRole('button', { name: 'Confirmar comprobante', exact: true })
          .click()
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .click()
        await dialog.waitFor({ state: 'hidden' })
        await page.unroute('**/rest/v1/rpc/classify_purchase')
      } else await confirm(dialog)
      eq((await one('select public.accounting_drafts(0) r')).r.length, 0)
      eq(
        await stockAndCost(),
        before,
        'clasificar y reintentar no toca stock ni costo',
      )
      await page
        .getByRole('dialog', { name: 'Borradores contables', exact: true })
        .getByRole('button', { name: 'Cerrar', exact: true })
        .click()
      await page
        .getByLabel('Mostrar recepciones', { exact: true })
        .selectOption('all')
      await page
        .getByRole('button', { name: 'Editar clasificación', exact: true })
        .click()
      dialog = page.getByRole('dialog', {
        name: 'Editar clasificación de compra',
        exact: true,
      })
      await fixedCharge(dialog, total)
      await dialog.getByLabel('Cuenta 2', { exact: true }).selectOption('2111')
      await dialog
        .getByLabel('Referencia', { exact: true })
        .fill('COMPRA-A-CREDITO')
      await confirm(dialog)
      eq(
        await stockAndCost(),
        before,
        'editar contrapartida conserva inventario',
      )
      eq(
        await inventoryLedger(),
        initialInventory + total,
        'el mayor incluye el cargo a Inventario exactamente una vez',
      )
      const classified = (
        await one('select public.purchase_accounting_rows() r')
      ).r.find((r) => r.id === receipt)
      const detail = (
        await one('select public.get_journal_entry($1) r', [
          classified.entry_id,
        ])
      ).r
      eq(detail.lines[0].account, '1130', 'el comprobante carga Inventario')
      eq(
        Number(detail.lines[0].debit_nio),
        total,
        'cargo exacto del comprobante',
      )
      eq(
        detail.lines.some((line) => line.account === '2190'),
        false,
        'el comprobante no conserva una cuenta temporal',
      )
      const credit = (
        await one('select public.credit_accounts($1) r', [fixture.today])
      ).r.rows.find((row) => row.shipmentId === receipt)
      eq(
        credit.balanceNio,
        total,
        'la contrapartida elegida crea su deuda real',
      )
      await page
        .locator('.accounting-table tbody tr')
        .filter({ hasText: 'COMPRA-A-CREDITO' })
        .getByRole('button', { name: /CP-/ })
        .click()
      await page
        .getByRole('dialog', { name: /^Comprobante CP-/ })
        .getByRole('button', { name: 'Editar comprobante', exact: true })
        .click()
      dialog = page.getByRole('dialog', { name: /^Editar comprobante CP-/ })
      await fixedCharge(dialog, total)
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      await page
        .getByRole('dialog', { name: /^Comprobante CP-/ })
        .getByRole('button', { name: 'Cerrar', exact: true })
        .click()
      await navigate('/accounting?section=catalog')
      await page.locator('.accounting-catalog').waitFor()
      eq(
        await page
          .locator('.accounting-catalog')
          .getByText('Compras por clasificar', { exact: true })
          .count(),
        0,
        'la cuenta temporal ya no aparece en catálogo',
      )
      // Regression requested in the audio: the same product remains saleable
      // with its existing prices and emits an ordinary invoice from the UI.
      await navigate('/sales')
      const customer = page.locator('.document-customer-panel details')
      await customer.waitFor()
      if ((await customer.getAttribute('open')) === null)
        await customer.locator(':scope > summary').click()
      await page
        .getByLabel('Cliente', { exact: true })
        .fill('Cliente cargo fijo')
      await page
        .getByLabel('Buscar en catálogo', { exact: true })
        .fill('Oriental')
      await page
        .getByRole('button', { name: /^Agregar Lattafa/ })
        .first()
        .click()
      await page
        .getByRole('button', { name: 'Emitir factura', exact: true })
        .click()
      await page.getByText(/Factura FAC-.*emitida/).waitFor()
      eq(
        (
          await one(
            "select count(*)::int n from public.documents where kind='invoice'",
          )
        ).n,
        1,
        'facturación sigue emitiendo una única factura',
      )
      eq(
        Number((await stockAndCost()).stock),
        31,
        'facturar descuenta solo una unidad',
      )
      eq(
        (
          await one(
            'select md5(jsonb_agg(to_jsonb(p) order by product_id,tier_code,currency)::text) h from public.product_prices p',
          )
        ).h,
        priceHash,
        'clasificar compras no cambia precios de venta',
      )
      await healthy('compra y facturación ' + width)
      console.log(
        `PASS cargo fijo, borrador, edición y facturación a ${width} px`,
      )
    } catch (e) {
      await page.screenshot({
        path: `${output}/fallo-${width}.png`,
        fullPage: true,
      })
      await writeFile(
        `${output}/fallo-${width}.txt`,
        await page.locator('body').innerText(),
      )
      throw e
    } finally {
      await fixture.close()
      await context.close()
    }
  }
  console.log(`PASS ${checks} comprobaciones del cargo fijo a Inventario`)
} finally {
  await browser.close()
  await server?.close()
}

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
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
const out = 'output/purchase-classification-review'
await mkdir(out, { recursive: true })
let checks = 0
const eq = (a, b, m) => {
  assert.deepEqual(a, b, m)
  checks++
}
try {
  for (const width of [1440, 768, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      isMobile: width < 500,
      hasTouch: width < 500,
      timezoneId: 'America/Managua',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const f = await browserDatabase(page),
      errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const one = async (s, args = []) => (await f.db.query(s, args)).rows[0]
    const rpc = async (name, p) =>
      (
        await one('select public.' + name + '($1::jsonb) r', [
          JSON.stringify(p),
        ])
      ).r
    const navigate = (path) =>
      page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
    const healthy = async (label) => {
      eq(errors, [], label + ' sin errores de React')
      eq(f.failures, [], label + ' sin errores de API')
      eq(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        label + ' sin desbordar página',
      )
      for (const d of await page.getByRole('dialog').all())
        eq(
          await d.evaluate((e) => e.scrollWidth > e.clientWidth + 1),
          false,
          label + ' diálogo contenido',
        )
    }
    try {
      await rpc('open_business_day', {
        requestId: crypto.randomUUID(),
        expectedDay: f.today,
        openingNio: 1000,
        openingUsd: 0,
      })
      const id = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
      const receipt = await rpc('record_shipment', {
        requestId: crypto.randomUUID(),
        incurredOn: f.today,
        supplier: 'Proveedor Auditoría',
        agency: '',
        reference: 'REC-REVISION',
        note: 'Recepción de revisión',
        currency: 'NIO',
        exchangeRate: 1,
        account: 'pending',
        shippingAmount: 0,
        lines: [
          { productId: id, location: 'store', quantity: 2, unitPrice: 100 },
        ],
      })
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
        .getByRole('heading', {
          name: 'Recepciones de inventario',
          exact: true,
        })
        .waitFor()
      await page
        .getByRole('button', { name: 'Clasificar compra', exact: true })
        .click()
      let dialog = page.getByRole('dialog', {
        name: 'Clasificar compra',
        exact: true,
      })
      const fixedInventory = async (total, label) => {
        eq(
          await dialog.getByLabel('Cuenta 1', { exact: true }).inputValue(),
          '1130',
          label + ' carga Inventario',
        )
        eq(
          await dialog.getByLabel('Cuenta 1', { exact: true }).isDisabled(),
          true,
          label + ' cuenta de inventario fija',
        )
        eq(
          await dialog.getByLabel('Moneda 1', { exact: true }).isDisabled(),
          true,
          label + ' moneda de inventario fija',
        )
        eq(
          await dialog.getByLabel('Debe 1', { exact: true }).inputValue(),
          String(total),
          label + ' total recibido',
        )
        eq(
          await dialog.getByLabel('Debe 1', { exact: true }).isEditable(),
          false,
          label + ' importe de inventario fijo',
        )
        eq(
          await dialog.getByLabel('Haber 1', { exact: true }).isEditable(),
          false,
          label + ' Haber de inventario fijo',
        )
        eq(
          await dialog
            .getByRole('button', { name: 'Quitar renglón 1', exact: true })
            .isDisabled(),
          true,
          label + ' inventario no eliminable',
        )
        eq(
          await dialog.getByLabel('Cuenta 2', { exact: true }).isEnabled(),
          true,
          label + ' contrapartida editable',
        )
        eq(
          await dialog.locator('option[value="2190"]').count(),
          0,
          label + ' sin cuenta retirada',
        )
      }
      await fixedInventory(200, 'clasificación inicial')
      await dialog
        .getByLabel('Cuenta 2', { exact: true })
        .selectOption('1110-001')
      await healthy('clasificar ' + width)
      await dialog
        .getByRole('button', { name: 'Revisar y guardar', exact: true })
        .click()
      if (width === 1440) {
        let dropped = false
        await page.route('**/rest/v1/rpc/classify_purchase', async (route) => {
          if (!dropped) {
            dropped = true
            await rpc(
              'classify_purchase',
              route.request().postDataJSON().p_input,
            )
            await route.abort('connectionreset')
          } else await route.fallback()
        })
        await dialog
          .getByRole('button', { name: 'Confirmar comprobante', exact: true })
          .click()
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .waitFor()
        eq(
          await dialog.getByLabel('Referencia', { exact: true }).isDisabled(),
          true,
        )
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .click()
        await page.unroute('**/rest/v1/rpc/classify_purchase')
      } else
        await dialog
          .getByRole('button', { name: 'Confirmar comprobante', exact: true })
          .click()
      await dialog.waitFor({ state: 'hidden' })
      eq(
        (
          await one(
            'select sum(quantity)::int n from public.inventory_balances where product_id=$1',
            [id],
          )
        ).n,
        32,
      )
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
      await fixedInventory(200, 'edición de clasificación')
      await dialog.getByLabel('Referencia', { exact: true }).fill('REC-EDITADA')
      await dialog
        .getByRole('button', { name: 'Revisar y guardar', exact: true })
        .click()
      await dialog
        .getByRole('button', { name: 'Confirmar comprobante', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      await page
        .getByLabel('Mostrar recepciones', { exact: true })
        .selectOption('all')
      await page
        .getByRole('button', { name: 'Editar recepción', exact: true })
        .click()
      dialog = page.getByRole('dialog', {
        name: 'Editar recepción de mercancía',
        exact: true,
      })
      await dialog.getByLabel('Unidades 1', { exact: true }).fill('3')
      await dialog
        .getByLabel('Valor final del inventario · QA-0001 (C$)', {
          exact: true,
        })
        .fill('3300')
      await dialog
        .getByRole('button', { name: 'Revisar corrección', exact: true })
        .click()
      await healthy('corregir recepción ' + width)
      await page.screenshot({
        path: `${out}/recepcion-${width}.png`,
        fullPage: true,
      })
      await dialog
        .getByRole('button', { name: 'Confirmar corrección', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      eq(
        (
          await one(
            'select sum(quantity)::int n from public.inventory_balances where product_id=$1',
            [id],
          )
        ).n,
        33,
      )
      const effective = (
        await one('select public.receipt_edit_context($1) r', [receipt])
      ).r
      eq(effective.receipt.units, 3)
      eq(effective.history.length, 1)
      await page
        .getByLabel('Mostrar recepciones', { exact: true })
        .selectOption('pending')
      await page
        .getByRole('button', { name: 'Clasificar compra', exact: true })
        .click()
      dialog = page.getByRole('dialog', {
        name: 'Clasificar compra',
        exact: true,
      })
      await fixedInventory(300, 'clasificación tras corregir recepción')
      await dialog.getByLabel('Haber 2', { exact: true }).fill('300')
      await dialog
        .getByRole('button', { name: 'Revisar y guardar', exact: true })
        .click()
      await dialog
        .getByRole('button', { name: 'Confirmar comprobante', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      await page
        .getByRole('button', { name: 'Transferencia bancaria', exact: true })
        .click()
      dialog = page.getByRole('dialog', {
        name: 'Transferencia bancaria',
        exact: true,
      })
      await dialog
        .getByRole('button', {
          name: 'Usar córdobas y dólares en el comprobante',
          exact: true,
        })
        .click()
      await dialog
        .getByLabel('Cuenta 1', { exact: true })
        .selectOption('1120-002')
      await dialog.getByLabel('Tipo de cambio 1', { exact: true }).fill('35.85')
      await dialog.getByLabel('Debe 1', { exact: true }).fill('100')
      await dialog
        .getByLabel('Concepto', { exact: true })
        .fill('Compra de dólares')
      await dialog
        .getByLabel('Referencia', { exact: true })
        .fill('CAMBIO-REVISION')
      await dialog
        .getByRole('button', { name: 'Guardar borrador', exact: true })
        .click()
      await dialog.getByText('Borrador guardado.', { exact: true }).waitFor()
      eq((await one('select public.accounting_drafts(0) r')).r.length, 1)
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
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
      eq(await dialog.getByLabel('Debe 1', { exact: true }).inputValue(), '100')
      await dialog
        .getByLabel('Cuenta 2', { exact: true })
        .selectOption('1120-001')
      await dialog.getByLabel('Haber 2', { exact: true }).fill('3585')
      await healthy('comprobante mixto ' + width)
      await page.screenshot({
        path: `${out}/monedas-${width}.png`,
        fullPage: true,
      })
      await dialog
        .getByRole('button', { name: 'Revisar y guardar', exact: true })
        .click()
      await dialog
        .getByRole('button', { name: 'Confirmar comprobante', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      eq((await one('select public.accounting_drafts(0) r')).r.length, 0)
      const mixed = (
        await one(
          "select id from public.journal_entries where reference='CAMBIO-REVISION'",
        )
      ).id
      const detail = (
        await one('select public.get_journal_entry($1) r', [mixed])
      ).r
      eq(
        detail.lines.map((l) => [
          l.currency,
          l.exchange_rate,
          l.debit_nio,
          l.credit_nio,
        ]),
        [
          ['USD', 35.85, 3585, 0],
          ['NIO', 1, 0, 3585],
        ],
      )
      eq(
        (
          await one(
            'select md5(jsonb_agg(to_jsonb(p) order by product_id,tier_code,currency)::text) h from public.product_prices p',
          )
        ).h,
        priceHash,
        'corregir recepción no cambia precios de venta',
      )
      if (width === 1440) {
        await page
          .getByRole('dialog', { name: 'Borradores contables', exact: true })
          .getByRole('button', { name: 'Cerrar', exact: true })
          .click()
        const voucher = page
          .locator('.accounting-table tbody tr')
          .filter({ hasText: 'CAMBIO-REVISION' })
        await voucher.getByRole('button', { name: /CP-/ }).click()
        const pdfDialog = page.getByRole('dialog').last()
        const downloadPromise = page.waitForEvent('download')
        await pdfDialog
          .getByRole('button', { name: 'Descargar PDF', exact: true })
          .click()
        const download = await downloadPromise
        await download.saveAs(`${out}/comprobante-monedas.pdf`)
        await pdfDialog
          .getByRole('button', { name: 'Cerrar', exact: true })
          .click()
      }
      await navigate('/accounting?section=credits')
      const receipt2 = await rpc('record_shipment', {
        requestId: crypto.randomUUID(),
        incurredOn: f.today,
        supplier: 'Proveedor Auditoría',
        agency: '',
        reference: 'REC-CREDITO',
        note: '',
        currency: 'NIO',
        exchangeRate: 1,
        account: 'pending',
        shippingAmount: 0,
        lines: [
          {
            productId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
            location: 'store',
            quantity: 1,
            unitPrice: 100,
          },
        ],
      })
      await rpc('classify_purchase', {
        requestId: crypto.randomUUID(),
        shipmentId: receipt2,
        occurredOn: f.today,
        description: 'Compra a crédito',
        reference: 'REC-CREDITO',
        currency: 'NIO',
        exchangeRate: 1,
        linkedPayments: [],
        lines: [
          {
            account: '1130',
            currency: 'NIO',
            exchangeRate: 1,
            debit: 100,
            credit: 0,
          },
          {
            account: '2111',
            currency: 'NIO',
            exchangeRate: 1,
            debit: 0,
            credit: 100,
          },
        ],
      })
      const payment = await rpc('record_finance_entry', {
        requestId: crypto.randomUUID(),
        occurredOn: f.today,
        kind: 'supplier_payment',
        account: 'caja',
        toAccount: null,
        amount: 25,
        currency: 'NIO',
        exchangeRate: 1,
        counterparty: 'Proveedor Auditoría',
        description: 'Abono de revisión',
        reference: 'ABONO-REVISION',
        shipmentId: receipt2,
      })
      await navigate('/accounting?section=journal')
      await navigate('/accounting?section=credits')
      await page
        .getByRole('button', { name: 'Editar abono', exact: true })
        .click()
      dialog = page.getByRole('dialog', {
        name: 'Editar cobro o pago',
        exact: true,
      })
      await dialog.getByLabel('Importe del abono', { exact: true }).fill('40')
      await dialog
        .getByRole('button', { name: 'Revisar edición', exact: true })
        .click()
      await healthy('editar abono ' + width)
      await dialog
        .getByRole('button', { name: 'Confirmar edición', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      eq(
        (
          await one(
            'select amount::numeric a from public.finance_entries where id=$1',
            [payment],
          )
        ).a,
        '40.00',
      )
      eq(
        (
          await one('select public.credit_accounts($1) r', [f.today])
        ).r.rows.find((r) => r.shipmentId === receipt2).balanceNio,
        60,
      )
      await healthy('final ' + width)
      console.log('PASS navegador ' + width + ' px')
    } catch (e) {
      await page.screenshot({
        path: `${out}/fallo-${width}.png`,
        fullPage: true,
      })
      await writeFile(
        `${out}/fallo-${width}.txt`,
        await page.locator('body').innerText(),
      )
      throw e
    } finally {
      await f.close()
      await context.close()
    }
  }
  console.log(`PASS ${checks} comprobaciones de interfaz`)
} finally {
  await browser.close()
  await server?.close()
}

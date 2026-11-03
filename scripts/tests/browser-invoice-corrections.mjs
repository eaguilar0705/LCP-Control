import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
import { identity, admin } from './database-fixture.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5196'
assert.ok(
  ['127.0.0.1', 'lcp-control.pages.dev'].includes(new URL(base).hostname),
)
const out = 'output/invoice-correction-review'
await mkdir(out, { recursive: true })
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5196, strictPort: true },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let checks = 0
const eq = (a, b, msg) => {
  assert.deepEqual(a, b, msg)
  checks++
}
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
    page.on('pageerror', (e) => errors.push(e.message))
    const get = async (sql, args = []) =>
      (await fixture.db.query(sql, args)).rows[0]
    const rpc = async (name, payload) =>
      (
        await get(`select public.${name}($1::jsonb) r`, [
          JSON.stringify(payload),
        ])
      ).r
    const navigate = async () => {
      await page.evaluate(() => {
        globalThis.history.pushState({}, '', '/sales/history')
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      })
      await page
        .getByRole('heading', { name: 'Facturas emitidas', exact: true })
        .waitFor()
    }
    await page.route('**/rest/v1/storefront_drafts*', (r) =>
      r.request().method() === 'HEAD'
        ? r.fulfill({
            status: 200,
            headers: { 'content-range': '*/0' },
            body: '',
          })
        : r.fallback(),
    )
    try {
      await rpc('open_business_day', {
        requestId: crypto.randomUUID(),
        openingNio: 1000,
        openingUsd: 0,
      })
      const invoice = await rpc('create_document', {
        requestId: crypto.randomUUID(),
        kind: 'invoice',
        customerName: 'Cliente original',
        customerPhone: '77770000',
        tier: 'emprendedor',
        currency: 'NIO',
        exchangeRate: 1,
        location: 'store',
        paymentMethod: 'pending',
        notes: 'Original',
        items: [
          { productId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', quantity: 2 },
        ],
      })
      await rpc('record_finance_entry', {
        requestId: crypto.randomUUID(),
        kind: 'collection',
        documentId: invoice.id,
        occurredOn: fixture.today,
        amount: 732,
        currency: 'NIO',
        exchangeRate: 1,
        account: 'banco',
        bankLedgerAccount: '1120-001',
        counterparty: 'Cliente',
        description: 'Pago recibido',
        reference: invoice.number,
      })
      const login = async () => {
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
      }
      await page.goto(base + '/login')
      await login()
      await navigate()
      const editButton = page.getByRole('button', {
        name: `Editar factura ${invoice.number}`,
        exact: true,
      })
      await editButton.waitFor()
      await editButton.click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Forma de pago', { exact: true }).waitFor()
      eq(
        await dialog.getByLabel('Cantidad 1', { exact: true }).inputValue(),
        '2',
      )
      eq(
        await dialog.getByLabel('Forma de pago', { exact: true }).inputValue(),
        'pending',
      )
      await dialog
        .getByLabel('Forma de pago', { exact: true })
        .selectOption('bac_nio')
      if (width === 1440) {
        let dropped = false
        await page.route('**/rest/v1/rpc/correct_invoice', async (route) => {
          if (!dropped) {
            dropped = true
            await rpc('correct_invoice', route.request().postDataJSON().p_input)
            return route.abort('connectionreset')
          }
          return route.fallback()
        })
        await dialog
          .getByRole('button', { name: 'Guardar cambios', exact: true })
          .click()
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .waitFor()
        eq(
          await dialog.getByLabel('Cantidad 1', { exact: true }).isDisabled(),
          true,
          'el formulario conserva la solicitud pendiente',
        )
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .click()
        await page.unroute('**/rest/v1/rpc/correct_invoice')
      } else
        await dialog
          .getByRole('button', { name: 'Guardar cambios', exact: true })
          .click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      const corrected = await get(
        'select * from public.documents where id=$1',
        [invoice.id],
      )
      eq(corrected.number, invoice.number)
      eq(corrected.revision, 1)
      eq(corrected.payment_method, 'bac_nio')
      eq(
        (
          await get(
            'select count(*) n from public.finance_entries where document_id=$1 and voided_at is null',
            [invoice.id],
          )
        ).n,
        0,
      )
      eq(
        (
          await get(
            "select quantity from public.inventory_balances where product_id=$1 and location='store'",
            ['aaaaaaaa-aaaa-4aaa-8aaa-000000000001'],
          )
        ).quantity,
        18,
      )
      const report = (
        await get('select public.ledger_report($1,$1) r', [fixture.today])
      ).r
      eq(
        report.accounts.find((a) => a.code === '1120-001').closing,
        732,
        'el banco recibe una sola vez',
      )
      await page
        .getByRole('button', { name: 'Cerrar documento', exact: true })
        .click()
      await editButton.click()
      await dialog.getByLabel('Forma de pago', { exact: true }).waitFor()
      await dialog
        .getByLabel('Cliente', { exact: true })
        .fill('Cliente corregido ' + width)
      await dialog
        .getByLabel('RUC / Identificación del cliente', { exact: true })
        .fill('RUC-CORREGIDO')
      await dialog.getByLabel('Cantidad 1', { exact: true }).fill('3')
      await dialog.getByLabel('Precio unitario 1', { exact: true }).fill('400')
      await dialog
        .getByLabel('Descuento por unidad 1', { exact: true })
        .fill('10')
      await dialog
        .getByRole('button', { name: 'Agregar perfume', exact: true })
        .click()
      await dialog.getByRole('button', { name: /^Perfume 2/ }).click()
      await dialog
        .getByRole('combobox', {
          name: 'Buscar perfume: Perfume 2',
          exact: true,
        })
        .fill('QA-0002')
      await dialog.getByRole('option').filter({ hasText: 'QA-0002' }).click()
      await dialog
        .getByLabel('Descuento total (NIO)', { exact: true })
        .fill('20')
      await dialog
        .getByLabel('Tipo de envío', { exact: true })
        .selectOption('moto')
      await dialog
        .getByLabel('Cobro por envío (NIO)', { exact: true })
        .fill('80')
      await dialog
        .getByLabel('Notas de la factura', { exact: true })
        .fill('Entrega corregida')
      eq(
        (
          await dialog.locator('.invoice-edit-total strong').innerText()
        ).replace(/\s/g, ' '),
        'NIO 1,596.00',
      )
      const bounds = await dialog.evaluate((el) => ({
        scroll: el.scrollWidth,
        client: el.clientWidth,
      }))
      eq(
        bounds.scroll <= bounds.client + 1,
        true,
        'sin desbordamiento horizontal del formulario',
      )
      await dialog.screenshot({ path: `${out}/edicion-${width}.png` })
      await dialog
        .getByRole('button', { name: 'Guardar cambios', exact: true })
        .click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      const full = await get('select * from public.documents where id=$1', [
        invoice.id,
      ])
      eq(Number(full.total), 1596)
      eq(full.revision, 2)
      eq(full.customer_name, 'Cliente corregido ' + width)
      eq(full.customer_tax_id, 'RUC-CORREGIDO')
      eq(full.shipping_method, 'moto')
      eq(
        (
          await get(
            "select quantity from public.inventory_balances where product_id=$1 and location='store'",
            ['aaaaaaaa-aaaa-4aaa-8aaa-000000000001'],
          )
        ).quantity,
        17,
      )
      await page
        .getByRole('button', { name: 'Cerrar documento', exact: true })
        .click()
      await editButton.click()
      await dialog.getByLabel('Forma de pago', { exact: true }).waitFor()
      await dialog
        .getByText('Historial de ediciones (2)', { exact: true })
        .click()
      await dialog
        .getByRole('button', {
          name: 'Ver versión anterior · revisión 0',
          exact: true,
        })
        .click()
      await dialog
        .getByText('Versión del historial · revisión 0', { exact: true })
        .waitFor()
      await dialog
        .locator('.invoice-edit-paper .letter-client-name strong')
        .waitFor()
      eq(
        await dialog
          .locator('.invoice-edit-paper .letter-client-name strong')
          .textContent(),
        'Cliente original',
        'se conserva la versión original imprimible',
      )
      await dialog
        .getByRole('button', { name: 'Volver a editar', exact: true })
        .click()
      if (width === 1440) {
        await dialog
          .getByRole('button', { name: 'Dividir pago', exact: true })
          .click()
        const amounts = dialog.getByLabel('Importe recibido', { exact: true })
        await amounts.nth(0).fill('798')
        await amounts.nth(1).fill('798')
        await dialog
          .getByRole('button', { name: 'Guardar cambios', exact: true })
          .click()
        await page.getByRole('dialog').waitFor({ state: 'hidden' })
        await page.reload()
        await login()
        await navigate()
        await page
          .getByRole('button', { name: 'Ver documento', exact: false })
          .first()
          .click()
        eq(
          (await page.locator('.example-paper').innerText()).includes(
            'Pago dividido',
          ),
          true,
          'el documento reabierto conserva pagos corregidos',
        )
        await page
          .getByRole('button', { name: 'Cerrar documento', exact: true })
          .click()
        await editButton.click()
        await dialog.getByLabel('Pago 1', { exact: true }).waitFor()
        eq(
          await dialog
            .getByLabel('Importe recibido', { exact: true })
            .nth(0)
            .inputValue(),
          '798',
        )
        eq(
          await dialog
            .getByLabel('Importe recibido', { exact: true })
            .nth(1)
            .inputValue(),
          '798',
        )
        await dialog
          .getByRole('button', { name: 'Usar un solo pago', exact: true })
          .click()
        await dialog
          .getByLabel('Forma de pago', { exact: true })
          .selectOption('bac_nio')
        await dialog
          .getByRole('button', { name: 'Guardar cambios', exact: true })
          .click()
        await page.getByRole('dialog').waitFor({ state: 'hidden' })
        await page
          .getByRole('button', { name: 'Cerrar documento', exact: true })
          .click()
        await editButton.click()
        await dialog.getByLabel('Forma de pago', { exact: true }).waitFor()
        const current = (
          await get('select public.invoice_edit_detail($1) r', [invoice.id])
        ).r.document
        await rpc('correct_invoice', {
          requestId: crypto.randomUUID(),
          documentId: invoice.id,
          expectedRevision: current.revision,
          customerId: current.customer_id,
          customerName: current.customer_name,
          customerPhone: current.customer_phone,
          customerTaxId: current.customer_tax_id,
          tier: current.tier_code,
          currency: current.currency,
          exchangeRate: 1,
          location: current.location,
          paymentMethod: 'bac_nio',
          notes: 'Otra ventana',
          invoiceDiscount: 20,
          shippingMethod: 'moto',
          shippingAmount: 80,
          items: current.items.map((i) => ({
            productId: i.product_id,
            quantity: i.quantity,
            unitPrice: i.original_unit_price,
            finalUnitPrice: i.unit_price,
          })),
        })
        await dialog
          .getByLabel('Notas de la factura', { exact: true })
          .fill('Intento con versión vieja')
        await dialog
          .getByRole('button', { name: 'Guardar cambios', exact: true })
          .click()
        await dialog
          .getByRole('button', { name: 'Cargar última versión', exact: true })
          .waitFor()
        eq(
          await dialog
            .getByRole('button', { name: 'Guardar cambios', exact: true })
            .isDisabled(),
          true,
          'no pisa cambios de otro usuario',
        )
        await dialog
          .getByRole('button', { name: 'Cargar última versión', exact: true })
          .click()
        await page.waitForFunction(
          () =>
            globalThis.document.querySelector('input[maxlength="2000"]')
              ?.value === 'Otra ventana',
        )
        fixture.failures.splice(
          fixture.failures.findIndex((e) => e.includes('La factura cambió')),
          1,
        )
      }
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      if (width === 1440) {
        await fixture.db.exec('reset role')
        await fixture.db.query("update public.staff_members set role='admin'")
        await identity(fixture.db, admin)
        await page.reload()
        await login()
        await navigate()
        await page
          .getByRole('button', { name: 'Ver documento', exact: false })
          .first()
          .waitFor()
        eq(
          await page.getByRole('button', { name: /^Editar factura/ }).count(),
          0,
          'admin no tiene permiso para editar facturas',
        )
      }
      eq(errors, [], 'sin errores de React')
      eq(fixture.failures, [], 'sin fallos de API inesperados')
    } finally {
      await context.close()
      await fixture.close()
    }
  }
} finally {
  await browser.close()
  await server?.close()
}
await writeFile(
  `${out}/resultado.json`,
  JSON.stringify(
    { checks, widths: [1440, 390, 320], productionDataModified: false },
    null,
    2,
  ),
)
console.log(
  `PASS ${checks} comprobaciones de edición de factura en escritorio y móvil; API aislada, sin modificar producción.`,
)

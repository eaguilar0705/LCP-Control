import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { browserDatabase } from './browser-database.mjs'

const output = 'output/system-review'
const baseUrl = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
    })
    const page = await context.newPage()
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'canShare', {
        value: () => false,
        configurable: true,
      })
    })
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    const fixture = await browserDatabase(page)
    const navigate = async (path) => {
      await page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      await page.locator('.main-content h1').first().waitFor()
      await page.waitForTimeout(200)
    }
    const openDocumentData = async () => {
      const details = page.locator('.document-customer-panel details')
      if (!(await details.evaluate((element) => element.open)))
        await details.locator('summary').click()
    }
    const healthy = async (label) => {
      assert.deepEqual(errors, [], label + ' runtime errors')
      assert.deepEqual(fixture.failures, [], label + ' API failures')
      const overflow = await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth >
          globalThis.innerWidth + 1,
      )
      assert.equal(overflow, false, `${label} ${width}px page overflow`)
      const clipped = await page
        .locator('.report-filters input, .report-filters button')
        .evaluateAll((elements) =>
          elements
            .filter((el) => {
              const box = el.getBoundingClientRect(),
                card = el.closest('.report-filters')?.getBoundingClientRect()
              return (
                card && (box.left < card.left - 1 || box.right > card.right + 1)
              )
            })
            .map(
              (el) =>
                el.getAttribute('aria-label') || el.textContent || el.tagName,
            ),
        )
      assert.deepEqual(clipped, [], label + ' clipped filter controls')
      assert.equal(
        await page.locator('.state.error').count(),
        0,
        label + ' error panel',
      )
    }
    try {
      await page.goto(`${baseUrl}/login`)
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
      await page
        .getByRole('button', { name: 'Abrir tienda', exact: true })
        .click()
      let dialog = page.getByRole('dialog')
      await dialog.getByLabel('Córdobas C$', { exact: true }).fill('1000')
      await dialog.getByLabel('Dólares US$', { exact: true }).fill('0')
      await dialog
        .getByRole('button', { name: 'Confirmar apertura', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      await page
        .getByRole('heading', { name: 'Tienda abierta', exact: true })
        .waitFor()
      for (const path of [
        '/',
        '/inventory',
        '/inventory/history',
        '/sales',
        '/proformas',
        '/sales/history',
        '/proformas/history',
        '/customers',
        '/suppliers',
        '/staff',
        '/settings',
        '/account',
        '/products/new',
        '/products/aaaaaaaa-aaaa-4aaa-8aaa-000000000001/edit',
        '/reports',
        '/accounting',
        '/alerts',
      ]) {
        await navigate(path)
        await healthy(path)
        await page.screenshot({
          path: `${output}/${path.replaceAll('/', '-') || 'home'}-${width}.png`,
          fullPage: true,
        })
      }
      await navigate('/sales')
      await openDocumentData()
      await page
        .getByLabel('Cliente', { exact: true })
        .fill('Cliente Venta Auditoría')
      await page
        .getByLabel('Buscar en catálogo', { exact: true })
        .fill('Oriental')
      await page
        .getByLabel('Forma de pago', { exact: true })
        .selectOption('cash')
      await page
        .getByRole('button', { name: /^Agregar Lattafa/ })
        .first()
        .click()
      await page
        .getByRole('button', { name: 'Emitir factura', exact: true })
        .click()
      await page.getByText(/FAC-/, { exact: false }).first().waitFor()
      await healthy('issued invoice')
      assert.equal(
        (
          await fixture.db.query(
            "select count(*)::int n from public.documents where kind='invoice'",
          )
        ).rows[0].n,
        1,
      )
      assert.equal(
        (
          await fixture.db.query(
            "select quantity from public.inventory_balances where product_id='aaaaaaaa-aaaa-4aaa-8aaa-000000000001' and location='store'",
          )
        ).rows[0].quantity,
        19,
      )
      await page.screenshot({
        path: `${output}/invoice-${width}.png`,
        fullPage: true,
      })
      const pdf = page.waitForEvent('download')
      await page
        .getByRole('button', { name: 'Compartir PDF', exact: true })
        .click()
      const invoicePdf = await pdf
      assert.ok(invoicePdf.suggestedFilename().endsWith('.pdf'))
      await invoicePdf.saveAs(`${output}/invoice-${width}.pdf`)
      // Contact CRUD through the actual form and SQL RPC, including RUC.
      for (const [path, noun] of [
        ['/customers', 'cliente'],
        ['/suppliers', 'proveedor'],
      ]) {
        await navigate(path)
        await page
          .getByRole('button', { name: 'Nuevo ' + noun, exact: true })
          .click()
        dialog = page.getByRole('dialog')
        await dialog
          .getByLabel('Nombre', { exact: true })
          .fill('Registro temporal ' + noun)
        await dialog.getByLabel('RUC', { exact: true }).fill('QA-123')
        await dialog
          .getByRole('button', { name: 'Guardar', exact: true })
          .click()
        await dialog.waitFor({ state: 'hidden' })
        await page
          .getByRole('button', {
            name: 'Editar Registro temporal ' + noun,
            exact: true,
          })
          .click()
        await dialog
          .getByLabel('Nombre', { exact: true })
          .fill('Registro editado ' + noun)
        await dialog
          .getByRole('button', { name: 'Guardar', exact: true })
          .click()
        await dialog.waitFor({ state: 'hidden' })
        await page
          .getByRole('button', {
            name: 'Eliminar Registro editado ' + noun,
            exact: true,
          })
          .click()
        await dialog
          .getByRole('button', { name: 'Eliminar', exact: true })
          .click()
        await dialog.waitFor({ state: 'hidden' })
        await healthy('contact CRUD ' + noun)
      }
      // Purchase from the product editor, followed by the linked supplier payment.
      await navigate('/products/aaaaaaaa-aaaa-4aaa-8aaa-000000000001/edit')
      await page
        .getByLabel('Código del fabricante (EAN / UPC)', { exact: true })
        .fill('1234567890128')
      await page
        .getByRole('button', { name: 'Guardar perfume', exact: true })
        .click()
      await page.waitForTimeout(250)
      assert.equal(
        (
          await fixture.db.query(
            "select barcode from public.products where id='aaaaaaaa-aaaa-4aaa-8aaa-000000000001'",
          )
        ).rows[0].barcode,
        '1234567890128',
      )
      await navigate('/products/aaaaaaaa-aaaa-4aaa-8aaa-000000000001/edit')
      await page
        .getByRole('button', { name: 'Costo de inventario', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      await dialog
        .getByLabel('Proveedor', { exact: true })
        .fill('Proveedor Auditoría')
      await dialog
        .getByLabel('Factura o referencia', { exact: true })
        .fill('COMPRA-UI')
      await dialog.getByLabel('Pago', { exact: true }).selectOption('credito')
      await dialog
        .getByLabel('Moneda de la compra', { exact: true })
        .selectOption('NIO')
      await dialog.getByLabel('Unidades', { exact: true }).fill('2')
      await dialog
        .getByLabel('Costo por unidad (C$)', { exact: true })
        .fill('100')
      await dialog
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      await healthy('purchase')
      // Credit sale and proforma, whose items must not change stock.
      for (const [path, kind] of [
        ['/sales', 'factura'],
        ['/proformas', 'proforma'],
      ]) {
        await navigate(path)
        if (kind === 'factura')
          await page
            .getByRole('button', { name: 'Nueva factura', exact: true })
            .click()
        await openDocumentData()
        await page
          .getByLabel('Cliente', { exact: true })
          .fill('Cliente Crédito')
        await page
          .getByLabel('Buscar en catálogo', { exact: true })
          .fill('Oriental')
        await page
          .getByRole('button', { name: /^Agregar Lattafa/ })
          .first()
          .click()
        await page
          .getByRole('button', { name: 'Emitir ' + kind, exact: true })
          .click()
        await page
          .getByText(kind === 'factura' ? /FAC-000002/ : /PRO-000001/)
          .first()
          .waitFor()
        await healthy(kind)
      }
      assert.equal(
        (
          await fixture.db.query(
            "select quantity from public.inventory_balances where product_id='aaaaaaaa-aaaa-4aaa-8aaa-000000000001' and location='store'",
          )
        ).rows[0].quantity,
        18,
        'proforma no descuenta inventario',
      )
      await navigate('/accounting')
      await page
        .getByRole('button', { name: 'Cobros y pagos', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Cobrar', exact: true })
        .first()
        .click()
      dialog = page.getByRole('dialog')
      await dialog.getByLabel('Entra a', { exact: true }).selectOption('banco')
      await dialog
        .getByLabel('Cuenta bancaria', { exact: true })
        .selectOption('1120-003')
      await dialog.getByLabel('Importe (NIO)', { exact: true }).fill('100')
      await dialog
        .getByLabel('Descripción', { exact: true })
        .fill('Abono desde navegador')
      await dialog.getByRole('button', { name: 'Guardar', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      await page
        .getByRole('region', { name: 'Abonos del período', exact: true })
        .getByText('LAFISE C$', { exact: true })
        .waitFor()
      await page
        .getByRole('button', { name: 'Pagar', exact: true })
        .first()
        .click()
      await dialog.getByLabel('Importe (NIO)', { exact: true }).fill('50')
      await dialog
        .getByLabel('Descripción', { exact: true })
        .fill('Abono de compra')
      await dialog.getByRole('button', { name: 'Guardar', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      await healthy('linked payments')
      await page.screenshot({
        path: `${output}/credits-${width}.png`,
        fullPage: true,
      })
      // Every accounting view must also render with actual operations.
      for (const name of [
        'Catálogo de cuentas',
        'Balanza de comprobación',
        'Estado de resultado',
        'Estado de situación financiera',
        'Comprobantes',
      ]) {
        await page
          .getByRole('navigation', { name: 'Secciones de contabilidad' })
          .getByRole('button', { name, exact: true })
          .click()
        await healthy(name)
      }
      await page
        .getByRole('button', { name: 'Liquidación de tarjetas', exact: true })
        .click()
      await fixture.db.query('select public.create_document($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          kind: 'invoice',
          customerName: 'Venta POS',
          tier: 'emprendedor',
          currency: 'NIO',
          exchangeRate: 1,
          location: 'store',
          paymentMethod: 'card_pos',
          notes: '',
          items: [
            { productId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', quantity: 1 },
          ],
        }),
      ])
      dialog = page.getByRole('dialog')
      await dialog
        .getByLabel('Concepto', { exact: true })
        .fill('Liquidación de auditoría')
      await dialog
        .getByLabel('Banco que acredita', { exact: true })
        .selectOption('1120-001')
      await dialog
        .getByLabel('Venta bruta liquidada', { exact: true })
        .fill('366')
      await dialog
        .getByLabel('Comisión bancaria (%)', { exact: true })
        .fill('4.5')
      await dialog.getByLabel('Retención IR (%)', { exact: true }).fill('1.5')
      await page.screenshot({
        path: `${output}/card-${width}.png`,
        fullPage: true,
      })
      assert.ok(
        await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        'card dialog fits',
      )
      await dialog
        .getByRole('button', { name: 'Guardar comprobante', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      const xlsx = page.waitForEvent('download')
      await page
        .getByRole('button', { name: 'Descargar Excel', exact: true })
        .click()
      assert.ok((await xlsx).suggestedFilename().endsWith('.xlsx'))
      if (width === 1440) {
        for (const kind of ['invoice', 'proforma']) {
          const bigDownload = page.waitForEvent('download')
          await page.evaluate(
            async ({ kind, today }) => {
              const { supabaseAdapter } =
                await import('/src/services/adapters/supabase.ts')
              const { downloadDocumentPdf } =
                await import('/src/features/sales/pdf.ts')
              const doc = await supabaseAdapter.createDocument({
                requestId: crypto.randomUUID(),
                kind,
                customerName: 'Cliente documento de cien productos',
                tier: 'emprendedor',
                currency: 'NIO',
                exchangeRate: 1,
                location: 'store',
                paymentMethod: 'pending',
                validUntil: today,
                notes: 'Revisión de paginación',
                items: Array.from({ length: 100 }, (_, i) => ({
                  productId:
                    'aaaaaaaa-aaaa-4aaa-8aaa-' +
                    String(i + 1).padStart(12, '0'),
                  quantity: 1,
                })),
              })
              await downloadDocumentPdf(doc)
            },
            { kind, today: fixture.today },
          )
          await (await bigDownload).saveAs(`${output}/${kind}-100.pdf`)
        }
      }
      await navigate('/')
      await page
        .getByRole('button', { name: 'Cerrar tienda', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      const day = (
        await fixture.db.query('select public.get_business_day(null) r')
      ).rows[0].r
      await dialog
        .getByLabel('Córdobas C$', { exact: true })
        .fill(String(day.report.expectedNio))
      await dialog
        .getByLabel('Dólares US$', { exact: true })
        .fill(String(day.report.expectedUsd))
      await dialog
        .getByRole('button', { name: 'Confirmar cierre', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      const daily = page.waitForEvent('download')
      await page
        .getByRole('button', { name: 'Reporte diario', exact: true })
        .click()
      assert.ok((await daily).suggestedFilename().endsWith('.pdf'))
      await healthy('closed day')
      // Image processing runs in the same browser code used by the editor.
      const image = await page.evaluate(async () => {
        const { optimizeProductImage } =
          await import('/src/features/products/product.ts')
        const canvas = globalThis.document.createElement('canvas')
        canvas.width = 2400
        canvas.height = 1600
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#641d28'
        ctx.fillRect(0, 0, 2400, 1600)
        const source = await new Promise((resolve) =>
          canvas.toBlob(resolve, 'image/png'),
        )
        const result = await optimizeProductImage(
          new File([source], 'foto.png', { type: 'image/png' }),
        )
        const bitmap = await globalThis.createImageBitmap(result)
        const info = {
          type: result.type,
          bytes: result.size,
          width: bitmap.width,
          height: bitmap.height,
        }
        bitmap.close()
        return info
      })
      assert.equal(image.type, 'image/webp')
      assert.equal(image.width, 1200)
      assert.equal(image.height, 800)
      assert.ok(image.bytes < 100000)
      await navigate('/forgot-password')
      await page
        .getByLabel('Correo electrónico', { exact: true })
        .fill('auditoria@example.test')
      await page
        .getByRole('button', { name: 'Enviar enlace', exact: true })
        .click()
      await page
        .getByRole('status')
        .filter({ hasText: 'recibirás un enlace' })
        .waitFor()
      await healthy('password recovery request')
      await page.goto(`${baseUrl}/reset-password`)
      await page
        .getByRole('link', { name: 'Solicitar otro enlace', exact: true })
        .waitFor()
      console.log(
        `PASS system ${width}px: 17 routes, contact CRUD, product editing, purchases, invoices, proformas, credits, journal, daily closing, PDFs/Excel, 260 products, WebP; no runtime/API errors or page overflow`,
      )
    } catch (e) {
      await page.screenshot({
        path: `${output}/failure-${width}.png`,
        fullPage: true,
      })
      console.error(
        'Page:',
        page.url(),
        'API:',
        fixture.failures,
        'Errors:',
        errors,
        'UI:',
        (await page.locator('body').innerText()).slice(-5000),
      )
      throw e
    } finally {
      await context.close()
      await fixture.close()
    }
  }
} finally {
  await browser.close()
}

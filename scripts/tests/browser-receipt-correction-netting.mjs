import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

const migration = '20261107220000_consolidar_correcciones_de_recepcion.sql'
const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5219'
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname))
process.env.VITE_SUPABASE_URL ??= 'https://local-test.supabase.co'
process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??= 'sb_publishable_local_test'
process.env.VITE_DATA_MODE = 'supabase'
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5219, strictPort: true, hmr: false },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const output = 'output/receipt-correction-netting-review'
await mkdir(output, { recursive: true })
let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const money = (value) =>
  new Intl.NumberFormat('es-NI', {
    style: 'currency',
    currency: 'NIO',
    currencyDisplay: 'code',
  }).format(value)

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
    const fixture = await browserDatabase(page, { beforeMigration: migration })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    // Supabase calls are handled by browserDatabase's isolated PostgreSQL.
    // Everything else must stay on loopback, including media and auth traffic.
    await page.route('**/*', (route) => {
      const host = new URL(route.request().url()).hostname
      return ['127.0.0.1', 'localhost', '[::1]'].includes(host) ||
        host.endsWith('.supabase.co')
        ? route.fallback()
        : route.abort('blockedbyclient')
    })
    const one = async (sql, args = []) =>
      (await fixture.db.query(sql, args)).rows[0]
    const rpc = async (name, input) =>
      (
        await one(`select public.${name}($1::jsonb) r`, [
          JSON.stringify({ requestId: crypto.randomUUID(), ...input }),
        ])
      ).r
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
          await dialog.evaluate(
            (element) => element.scrollWidth > element.clientWidth + 1,
          ),
          false,
          label + ': diálogo sin desbordamiento',
        )
    }
    const book = async () =>
      (await one('select public.ledger_report($1,$1) r', [fixture.today])).r
    const inventoryRow = (report) =>
      report.accounts.find((account) => account.code === '1130')
    const inventoryCells = async () =>
      page
        .locator('.accounting-trial tbody tr')
        .filter({ hasText: 'Inventario de perfumes' })
        .locator('td.num')
        .allTextContents()
    try {
      await rpc('open_business_day', {
        expectedDay: fixture.today,
        openingNio: 1000,
        openingUsd: 0,
      })
      const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000900001'
      await fixture.db.exec('reset role')
      await fixture.db.query(
        `insert into public.products(id,sku,name,brand_id)
       values($1,'RECEIPT-NET','Perfume de la corrección del video',(select id from public.brands limit 1))`,
        [product],
      )
      await fixture.db.query(
        `insert into public.inventory_balances(product_id,location,quantity)
       values($1,'store',0),($1,'warehouse',0)`,
        [product],
      )
      await fixture.db.query(
        'insert into public.product_costs(product_id,average_cost_nio) values($1,0)',
        [product],
      )
      await fixture.db.exec('set role authenticated')
      const receipt = await rpc('record_shipment', {
        incurredOn: fixture.today,
        supplier: 'Proveedor Auditoría',
        agency: '',
        reference: 'VIDEO-NET-2129',
        note: '',
        currency: 'NIO',
        exchangeRate: 1,
        account: 'pending',
        shippingAmount: 0,
        lines: [
          {
            productId: product,
            location: 'store',
            quantity: 1,
            unitPrice: 100,
          },
        ],
      })
      const revised = await rpc('revise_purchase_receipt', {
        shipmentId: receipt,
        expectedRevision: 0,
        incurredOn: fixture.today,
        supplier: 'Proveedor Auditoría',
        reference: 'VIDEO-NET-2129',
        note: 'Corrección de costo del video',
        currency: 'NIO',
        exchangeRate: 1,
        shippingAmount: 0,
        counterpart: '1120-003',
        costAccount: '5150',
        lines: [
          {
            productId: product,
            location: 'store',
            quantity: 1,
            unitPrice: 2229.15,
          },
        ],
        impacts: [
          {
            productId: product,
            expectedStore: 1,
            expectedWarehouse: 0,
            expectedValueNio: 100,
            targetValueNio: 2229.15,
          },
        ],
      })
      const originalDetail = (
        await one('select public.get_journal_entry($1) r', [
          revised.journalEntryId,
        ])
      ).r
      eq(
        originalDetail.lines.map((line) => [
          line.account,
          line.debit_nio,
          line.credit_nio,
        ]),
        [
          ['1130', 2129.15, 0],
          ['1130', 0, 2129.15],
        ],
        'Reproduce las dos patas históricas del video',
      )
      eq(inventoryRow(await book()).debit, 2129.15)
      eq(inventoryRow(await book()).credit, 2129.15)
      await fixture.db.exec('reset role')
      await fixture.db.exec(
        await readFile(`backend/supabase/migrations/${migration}`, 'utf8'),
      )
      await fixture.db.exec('set role authenticated')
      const after = inventoryRow(await book())
      eq(
        [after.opening, after.debit, after.credit, after.closing],
        [780000, 0, 0, 780000],
        'La corrección no añade movimientos brutos a la balanza',
      )

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
      await navigate('/accounting?section=trial')
      await page.locator('.accounting-trial').waitFor()
      eq(
        await inventoryCells(),
        ['Pendiente', 'Pendiente', 'Pendiente', 'Pendiente'],
        'La balanza conserva la advertencia de compra pendiente hasta completar la contrapartida',
      )
      await healthy('balanza sin doble movimiento ' + width)
      await page.screenshot({
        path: `${output}/balanza-${width}.png`,
        fullPage: true,
      })

      await navigate('/accounting')
      const history = page
        .locator('.accounting-table tbody tr')
        .filter({ hasText: 'VIDEO-NET-2129' })
      await history.getByText('Sin efecto contable', { exact: true }).waitFor()
      eq(
        await history
          .getByRole('button', { name: 'Anular', exact: true })
          .count(),
        0,
      )
      await history.getByRole('button', { name: /^CP-/ }).click()
      const detail = page.getByRole('dialog', { name: /^Comprobante CP-/ })
      await detail
        .getByText('Sin movimiento contable neto.', { exact: true })
        .waitFor()
      eq(
        await detail
          .getByRole('status')
          .filter({
            hasText: 'Esta corrección no modifica los saldos contables.',
          })
          .count(),
        1,
      )
      const netTable = detail.locator('table').first()
      eq(await netTable.locator('tbody tr').count(), 1)
      eq(await netTable.locator('tfoot td').allTextContents(), [
        money(0),
        money(0),
      ])
      eq(
        await detail
          .getByRole('button', { name: 'Editar comprobante', exact: true })
          .count(),
        0,
      )
      await healthy('comprobante neto ' + width)
      await page.screenshot({
        path: `${output}/comprobante-neto-${width}.png`,
        fullPage: true,
      })
      await detail
        .getByText('Ver registro original de la corrección', { exact: true })
        .click()
      const originalTable = detail.getByRole('table', {
        name: 'Registro original conservado para consulta',
        exact: true,
      })
      eq(await originalTable.locator('tbody tr').count(), 2)
      eq(
        await originalTable
          .locator('tbody tr')
          .nth(0)
          .locator('td')
          .allTextContents(),
        [money(2129.15), money(0)],
      )
      eq(
        await originalTable
          .locator('tbody tr')
          .nth(1)
          .locator('td')
          .allTextContents(),
        [money(0), money(2129.15)],
      )
      await healthy('registro histórico expandido ' + width)
      await page.screenshot({
        path: `${output}/registro-original-${width}.png`,
        fullPage: true,
      })
      const download = page.waitForEvent('download')
      await detail
        .getByRole('button', { name: 'Descargar PDF', exact: true })
        .click()
      const pdf = await download
      eq(pdf.suggestedFilename().endsWith('.pdf'), true)
      const pdfPath = `${output}/correccion-sin-efecto-${width}.pdf`
      await pdf.saveAs(pdfPath)
      const bytes = await readFile(pdfPath)
      eq(bytes.subarray(0, 4).toString(), '%PDF')
      eq(
        bytes.toString('latin1').includes('no modifica los saldos contables'),
        true,
        'El PDF explica el resultado contable neutro',
      )
      await detail.getByRole('button', { name: 'Cerrar', exact: true }).click()

      await page
        .getByRole('button', { name: 'Clasificar compra', exact: true })
        .click()
      const classify = page.getByRole('dialog', {
        name: 'Clasificar compra',
        exact: true,
      })
      const first = classify.getByLabel('Cuenta 1', { exact: true })
      await first.waitFor()
      eq(
        await first.inputValue(),
        '1130',
        'Inventario de perfumes es el cargo fijo',
      )
      eq(await first.isDisabled(), true)
      eq(
        await classify.getByLabel('Debe 1', { exact: true }).inputValue(),
        '2229.15',
      )
      await classify
        .getByLabel('Cuenta 2', { exact: true })
        .selectOption('1120-003')
      eq(
        await classify.getByLabel('Cuenta 2', { exact: true }).inputValue(),
        '1120-003',
        'Puede elegir LAFISE C$',
      )
      eq(
        await classify.getByLabel('Haber 2', { exact: true }).inputValue(),
        '2229.15',
      )
      await healthy('Inventario contra LAFISE ' + width)
      await page.screenshot({
        path: `${output}/clasificacion-lafise-${width}.png`,
        fullPage: true,
      })
      await classify
        .getByRole('button', { name: 'Revisar y guardar', exact: true })
        .click()
      await classify
        .getByRole('button', { name: 'Confirmar comprobante', exact: true })
        .click()
      await classify.waitFor({ state: 'hidden' })
      const finalBook = await book()
      eq(
        inventoryRow(finalBook).debit,
        2229.15,
        'Clasificar reconoce una sola compra',
      )
      eq(inventoryRow(finalBook).credit, 0)
      eq(inventoryRow(finalBook).closing, 782229.15)
      eq(
        finalBook.accounts.find((account) => account.code === '1120-003')
          .credit,
        2229.15,
      )
      eq(finalBook.accounts.find((account) => account.code === '5150').debit, 0)
      eq(
        finalBook.accounts.find((account) => account.code === '4190').credit,
        0,
      )
      const originalAfter = (
        await one('select public.get_journal_entry($1) r', [
          revised.journalEntryId,
        ])
      ).r
      eq(originalAfter.receiptNoAccountingEffect, true)
      eq(originalAfter.lines, [])
      eq(
        originalAfter.receiptOriginalLines,
        originalDetail.lines,
        'Clasificar conserva los renglones originales',
      )
      await navigate('/accounting?section=trial')
      await page.locator('.accounting-trial').waitFor()
      eq(await inventoryCells(), [
        money(780000),
        money(2229.15),
        money(0),
        money(782229.15),
      ])
      await healthy('compra clasificada y balanza ' + width)
      console.log(
        `PASS corrección neta, registro original, PDF y clasificación LAFISE a ${width} px`,
      )
    } catch (error) {
      await page.screenshot({
        path: `${output}/fallo-${width}.png`,
        fullPage: true,
      })
      await writeFile(
        `${output}/fallo-${width}.txt`,
        await page.locator('body').innerText(),
      )
      throw error
    } finally {
      await fixture.close()
      await context.close()
    }
  }
  console.log(
    `PASS ${checks} comprobaciones visuales de correcciones de recepción sin doble movimiento`,
  )
} finally {
  await browser.close()
  await server?.close()
}

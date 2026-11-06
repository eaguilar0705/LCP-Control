import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { browserDatabase } from './browser-database.mjs'
import { admin, identity } from './database-fixture.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5201'
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname))
process.env.VITE_SUPABASE_URL ??= 'https://local-test.supabase.co'
process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??= 'sb_publishable_local_test'
process.env.VITE_DATA_MODE = 'supabase'
const output = 'output/inventory-receipts-review'
await mkdir(output, { recursive: true })
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5201, strictPort: true, hmr: false },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
const widths = [1440, 390, 320]
const results = []
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
try {
  for (const width of widths) {
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
    // Supabase transport is intercepted by browserDatabase; unexpected external
    // requests are blocked so this test can never write to a remote service.
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url())
      if (
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.hostname.endsWith('.supabase.co')
      )
        return route.fallback()
      errors.push('Unexpected external request: ' + url.origin)
      return route.abort('blockedbyclient')
    })
    await page.route('**/rest/v1/storefront_drafts*', (route) =>
      route.request().method() === 'HEAD'
        ? route.fulfill({
            status: 200,
            headers: { 'content-range': '*/0' },
            body: '',
          })
        : route.fallback(),
    )
    const one = async (sql, values = []) =>
      (await fixture.db.query(sql, values)).rows[0]
    const rpc = async (name, input) =>
      (
        await one(`select public.${name}($1::jsonb) result`, [
          JSON.stringify(input),
        ])
      ).result
    const navigate = async (path) =>
      page.evaluate((target) => {
        globalThis.history.pushState({}, '', target)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
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
    const role = async (value) => {
      await fixture.db.exec('reset role')
      await fixture.db.query(
        'update public.staff_members set role=$1 where user_id=$2',
        [value, admin],
      )
      await identity(fixture.db, admin)
    }
    const stockAndLedger = async () => {
      await fixture.db.exec('reset role')
      const result = await one(
        `select
          (select quantity::int from public.inventory_balances where product_id=$1 and location='store') store,
          (select quantity::int from public.inventory_balances where product_id=$1 and location='warehouse') warehouse,
          (select average_cost_nio::float8 from public.product_costs where product_id=$1) cost,
          (select count(*)::int from public.purchase_shipments) purchases,
          (select count(*)::int from public.inventory_movements) movements,
          (select coalesce(sum(debit),0)::float8 from private.operational_postings where source='purchase' and account='1130') "inventoryDebit",
          (select coalesce(sum(credit),0)::float8 from private.operational_postings where source='purchase' and account='2111') "supplierCredit"`,
        [product],
      )
      await identity(fixture.db, admin)
      return result
    }
    const receipt = async (reference) =>
      (await rpc('inventory_receipts', { status: 'all' })).receipts.find(
        (row) => row.reference === reference,
      )
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
        label + ': página sin desbordamiento',
      )
      for (const dialog of await page.getByRole('dialog').all())
        equal(
          await dialog.evaluate(
            (element) => element.scrollWidth > element.clientWidth + 1,
          ),
          false,
          label + ': diálogo sin desbordamiento',
        )
    }
    const locked = async (dialog, label) => {
      equal(await dialog.getByLabel(label, { exact: true }).isDisabled(), true)
      await page.keyboard.press('Escape')
      equal(
        await dialog.isVisible(),
        true,
        'el guardado incierto no se descarta',
      )
    }
    const references = {
      posted: 'QA-RECEPCION-POST-' + width,
      cancelled: 'QA-RECEPCION-CANCEL-' + width,
    }
    const create = async (reference, loseResponse = false) => {
      await page
        .getByRole('button', { name: 'Recibir mercadería', exact: true })
        .click()
      const dialog = page.getByRole('dialog', {
        name: 'Recibir mercadería',
        exact: true,
      })
      await dialog.getByRole('button', { name: /^Perfume 1 / }).click()
      await dialog.getByPlaceholder('Nombre, marca o código…').fill('QA-0001')
      await dialog
        .getByRole('listbox', { name: 'Perfume 1', exact: true })
        .getByRole('option')
        .first()
        .click()
      await dialog.getByLabel('Unidades', { exact: true }).fill('4')
      await dialog
        .getByLabel('Entra a', { exact: true })
        .selectOption('warehouse')
      await dialog
        .getByLabel('Costo por unidad (C$)', { exact: true })
        .fill('200')
      await dialog
        .getByLabel('Envío de todo el pedido (C$)', { exact: true })
        .fill('40')
      await dialog
        .getByLabel('Factura o referencia', { exact: true })
        .fill(reference)
      equal(await dialog.getByLabel('Pago', { exact: true }).count(), 0)
      await healthy('captura bodega ' + width)
      const requests = []
      const lose = async (route) => {
        const input = route.request().postDataJSON().p_input
        requests.push(input)
        if (requests.length > 1) return route.fallback()
        await rpc('record_inventory_receipt', input)
        return route.abort('connectionreset')
      }
      if (loseResponse)
        await page.route('**/rest/v1/rpc/record_inventory_receipt', lose)
      await dialog
        .getByRole('button', { name: 'Guardar recepción', exact: true })
        .click()
      if (loseResponse) {
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .waitFor()
        await locked(dialog, 'Unidades')
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .click()
      }
      await dialog.waitFor({ state: 'hidden' })
      await page.getByLabel('Recepción ' + reference, { exact: true }).waitFor()
      if (loseResponse) {
        equal(requests.length, 2)
        equal(requests[0], requests[1], 'reintenta la misma recepción')
        await page.unroute('**/rest/v1/rpc/record_inventory_receipt', lose)
      }
      return receipt(reference)
    }
    try {
      await fixture.db.exec('reset role')
      await fixture.db.query(
        'update public.inventory_balances set quantity=0 where product_id=$1',
        [product],
      )
      await identity(fixture.db, admin)
      await rpc('open_business_day', {
        requestId: crypto.randomUUID(),
        openingNio: 1000,
        openingUsd: 0,
        expectedDay: fixture.today,
      })
      const before = await stockAndLedger()
      await role('warehouse')
      await login()
      await navigate('/inventory')
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      const pending = await create(references.posted, width === 1440)
      equal(pending.status, 'pending')
      equal(pending.units, 4)
      equal(
        await stockAndLedger(),
        before,
        'recibir no cambia inventario, costo ni mayor',
      )
      const pendingRow = page.getByLabel('Recepción ' + references.posted, {
        exact: true,
      })
      equal(
        await pendingRow
          .getByRole('button', { name: 'Revisar recepción', exact: true })
          .count(),
        0,
        'bodega no contabiliza',
      )
      await create(references.cancelled)
      equal(
        await stockAndLedger(),
        before,
        'ambas recepciones siguen fuera del stock vendible',
      )
      await page.screenshot({
        path: `${output}/pendientes-${width}.png`,
        fullPage: true,
      })

      await role('admin')
      await login()
      await navigate('/accounting?section=receipts')
      await page
        .getByRole('button', { name: 'Recepciones pendientes', exact: true })
        .click()
      await page
        .getByLabel('Recepción ' + references.posted, { exact: true })
        .getByRole('button', { name: 'Revisar recepción', exact: true })
        .click()
      let dialog = page.getByRole('dialog', {
        name: 'Revisar recepción',
        exact: true,
      })
      equal(
        await dialog.getByLabel('Unidades', { exact: true }).isDisabled(),
        true,
        'la revisión conserva el conteo físico',
      )
      equal(
        await dialog.getByLabel('Entra a', { exact: true }).isDisabled(),
        true,
        'la revisión conserva la ubicación recibida',
      )
      equal(
        await dialog.getByLabel('Pago', { exact: true }).inputValue(),
        '',
        'contabilidad elige el pago explícitamente',
      )
      await dialog
        .getByRole('button', { name: 'Contabilizar recepción', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: /Selecciona cómo se pagó/i })
        .waitFor()
      equal(await stockAndLedger(), before, 'no registra sin forma de pago')
      await dialog.getByLabel('Pago', { exact: true }).selectOption('credito')
      await dialog
        .getByLabel('Costo por unidad (C$)', { exact: true })
        .fill('220')
      await dialog
        .getByLabel('Envío de todo el pedido (C$)', { exact: true })
        .fill('80')
      await healthy('revisión contable ' + width)
      await page.screenshot({
        path: `${output}/revision-${width}.png`,
        fullPage: true,
      })
      const postingRequests = []
      const losePost = async (route) => {
        const input = route.request().postDataJSON().p_input
        postingRequests.push(input)
        if (postingRequests.length > 1) return route.fallback()
        await rpc('post_inventory_receipt', input)
        return route.abort('connectionreset')
      }
      if (width === 1440)
        await page.route('**/rest/v1/rpc/post_inventory_receipt', losePost)
      await dialog
        .getByRole('button', { name: 'Contabilizar recepción', exact: true })
        .click()
      if (width === 1440) {
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .waitFor()
        await locked(dialog, 'Costo por unidad (C$)')
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .click()
      }
      await dialog.waitFor({ state: 'hidden' })
      if (width === 1440) {
        equal(postingRequests.length, 2)
        equal(
          postingRequests[0],
          postingRequests[1],
          'confirmar reintenta el mismo pago y costo',
        )
        await page.unroute('**/rest/v1/rpc/post_inventory_receipt', losePost)
      }
      const posted = await receipt(references.posted)
      equal(posted.status, 'posted')
      equal(typeof posted.shipmentId, 'string')
      const after = await stockAndLedger()
      equal(
        after,
        {
          ...before,
          warehouse: 4,
          cost: 240,
          purchases: 1,
          movements: before.movements + 1,
          inventoryDebit: 960,
          supplierCredit: 960,
        },
        'la revisión crea una sola compra con el costo y el envío revisados',
      )

      await page
        .getByLabel('Recepción ' + references.cancelled, { exact: true })
        .getByRole('button', { name: 'Cancelar recepción', exact: true })
        .click()
      dialog = page.getByRole('dialog', {
        name: 'Cancelar recepción',
        exact: true,
      })
      await dialog
        .getByRole('button', { name: 'Confirmar cancelación', exact: true })
        .click()
      equal(await dialog.isVisible(), true, 'cancelar exige motivo')
      equal((await receipt(references.cancelled)).status, 'pending')
      await dialog
        .getByLabel('Motivo de cancelación', { exact: true })
        .fill('Mercadería duplicada en la recepción')
      await healthy('cancelación ' + width)
      await dialog
        .getByRole('button', { name: 'Confirmar cancelación', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      const cancelled = await receipt(references.cancelled)
      equal(cancelled.status, 'cancelled')
      equal(cancelled.cancelReason, 'Mercadería duplicada en la recepción')
      equal(
        await stockAndLedger(),
        after,
        'cancelar la pendiente no revierte la compra contabilizada',
      )
      await page
        .getByLabel('Estado de recepciones', { exact: true })
        .selectOption('all')
      await page
        .getByLabel('Recepción ' + references.posted, { exact: true })
        .getByText('Contabilizada', { exact: true })
        .waitFor()
      await page
        .getByLabel('Recepción ' + references.cancelled, { exact: true })
        .getByText('Cancelada', { exact: true })
        .waitFor()
      await healthy('cola final ' + width)
      await page.screenshot({
        path: `${output}/final-${width}.png`,
        fullPage: true,
      })
      if (width === 1440) {
        const requestId = crypto.randomUUID()
        const reference = 'QA-RECEPCION-RECUPERADA-' + width
        const recovery = {
          scope: 'user:' + admin,
          kind: 'inventory-receipt',
          requestId,
        }
        await page.evaluate((saved) => {
          localStorage.setItem(
            'lcp:pending-operation-ids:v1',
            JSON.stringify([saved]),
          )
        }, recovery)
        await login()
        await navigate('/inventory')
        await page
          .getByLabel('Estado de recepciones', { exact: true })
          .waitFor()
        await page
          .getByText('No hay recepciones en este estado.', { exact: true })
          .waitFor()
        const banner = page.getByRole('status', {
          name: 'Solicitudes por recuperar',
          exact: true,
        })
        await banner.waitFor()
        equal(
          await page.evaluate(() =>
            JSON.parse(localStorage.getItem('lcp:pending-operation-ids:v1')),
          ),
          [recovery],
          'solo conserva el identificador de recuperación',
        )
        // The original request finishes after this newly loaded inventory has
        // already fetched its queue. Confirming it must refresh that queue.
        await rpc('record_inventory_receipt', {
          requestId,
          incurredOn: fixture.today,
          supplier: 'Proveedor Auditoría',
          agency: '',
          reference,
          note: 'Solicitud original confirmada después de recargar',
          currency: 'NIO',
          exchangeRate: 1,
          shippingAmount: 0,
          lines: [
            {
              productId: product,
              location: 'warehouse',
              quantity: 1,
              unitPrice: 200,
            },
          ],
        })
        equal(
          await page
            .getByLabel('Recepción ' + reference, { exact: true })
            .count(),
          0,
          'el fetch inicial todavía no conocía la solicitud tardía',
        )
        await banner
          .getByRole('button', { name: 'Consultar guardado', exact: true })
          .click()
        await banner.waitFor({ state: 'hidden' })
        await page
          .getByLabel('Recepción ' + reference, { exact: true })
          .waitFor()
        equal(
          await stockAndLedger(),
          after,
          'recuperar la recepción pendiente conserva el stock y el mayor',
        )
        await healthy('confirmación tardía después de recargar')
        await page.screenshot({
          path: `${output}/recuperada-${width}.png`,
          fullPage: true,
        })
      }
      results.push({
        width,
        receiptId: pending.id,
        shipmentId: posted.shipmentId,
        ...after,
      })
    } catch (error) {
      await page.screenshot({
        path: `${output}/error-${width}.png`,
        fullPage: true,
      })
      throw error
    } finally {
      await context.close()
      await fixture.close()
    }
  }
  await writeFile(
    `${output}/resultado.json`,
    JSON.stringify({ checks, widths, results, productionWrites: 0 }, null, 2),
  )
  console.log(
    `PASS navegador recepciones: ${checks} verificaciones, escritorio y móvil, API y datos aislados.`,
  )
} finally {
  await browser.close()
  await server?.close()
}

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
import { admin, identity } from './database-fixture.mjs'

const output = 'output/product-sales-history'
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
const other = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'
const empty = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003'
const productNames = {
  [product]: 'Perfume Oriental de nombre largo para revisar presentación',
  [other]: 'Perfume 2',
  [empty]: 'Perfume 3',
}
const historyName = 'Historial de ventas del perfume'
const emptyText = 'Este perfume todavía no tiene ventas registradas.'
const endpoint = '**/rest/v1/rpc/product_sales_history'
let checks = 0
const results = []
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const matches = (actual, expected, message) => {
  assert.match(actual, expected, message)
  checks++
}
const normalized = (text) => text.replace(/\s+/g, ' ').trim()
const deferred = () => {
  let resolve
  const promise = new Promise((done) => (resolve = done))
  return { promise, resolve }
}

await mkdir(output, { recursive: true })
const server = await createServer({
  configFile: 'frontend/vite.config.ts',
  server: { host: '127.0.0.1', port: 5214, strictPort: false },
})
let browser
try {
  await server.listen()
  const base = server.resolvedUrls.local[0].replace(/\/$/, '')
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  for (const width of [1440, 390, 320]) {
    const startChecks = checks
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      timezoneId: 'America/Managua',
      isMobile: width < 500,
      hasTouch: width < 500,
    })
    const page = await context.newPage()
    page.setDefaultTimeout(20000)
    const errors = []
    const requests = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      if (request.url().endsWith('/rpc/product_sales_history'))
        requests.push(request.postDataJSON())
    })
    const fixture = await browserDatabase(page)
    const { db } = fixture
    const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]
    const rpc = async (name, input) =>
      (
        await one(`select public.${name}($1::jsonb) result`, [
          JSON.stringify(input),
        ])
      ).result
    const clock = (time) =>
      db.query("select set_config('lcp.history_browser_now',$1,false)", [
        new Date(time).toISOString(),
      ])
    const readHistory = async (params) =>
      (
        await one(
          'select public.product_sales_history($1,$2,$3,$4,$5) result',
          [
            params.p_product,
            params.p_offset ?? 0,
            params.p_limit ?? 20,
            params.p_as_of ?? null,
            params.p_expected_total ?? null,
          ],
        )
      ).result
    const fingerprint = async () =>
      (
        await one(`select jsonb_build_object(
          'documents',(select count(*) from public.documents),
          'movements',(select count(*) from public.inventory_movements),
          'journals',(select count(*) from public.journal_entries),
          'stock',(select jsonb_agg(to_jsonb(b) order by product_id,location)
            from public.inventory_balances b where product_id in ('${product}','${other}','${empty}'))
        ) result`)
      ).result
    const navigate = async (path) => {
      await page.evaluate((target) => {
        globalThis.history.pushState({}, '', target)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
    }
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
    const inventory = async () => {
      await navigate('/inventory')
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
    }
    const openProduct = async (id) => {
      await page
        .getByLabel('Buscar producto', { exact: true })
        .fill('QA-' + id.slice(-4))
      await page
        .locator('.catalog-product')
        .filter({
          has: page.getByRole('button', {
            name: productNames[id],
            exact: true,
          }),
        })
        .locator('.product-photo-button')
        .click()
      const dialog = page.getByRole('dialog', {
        name: productNames[id],
        exact: true,
      })
      await dialog.waitFor()
      return dialog
    }
    const closeProduct = async () => {
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
    }
    const records = (scope) => scope.locator('.product-sales-history-record')
    const waitPage = (scope, from, to, total) =>
      scope
        .getByRole('status')
        .filter({ hasText: `${from}–${to} de ${total} facturas` })
        .waitFor()
    const field = async (row, label) =>
      normalized(
        await row
          .getByText(label, { exact: true })
          .locator('..')
          .locator('dd')
          .innerText(),
      )
    const healthy = async (label) => {
      equal(errors, [], label + ': navegador sin errores')
      equal(fixture.failures, [], label + ': RPCs reales sin errores')
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        label + ': página dentro de pantalla',
      )
      for (const scope of [
        ...(await page.getByRole('dialog').all()),
        ...(await page.getByRole('region', { name: historyName }).all()),
      ])
        equal(
          await scope.evaluate(
            (element) => element.scrollWidth > element.clientWidth + 1,
          ),
          false,
          label + ': ficha e historial sin desbordamiento',
        )
    }
    const holdResponse = async (predicate) => {
      const entered = deferred()
      const release = deferred()
      const completed = deferred()
      let intercepted = false
      const handler = async (route) => {
        const params = route.request().postDataJSON()
        if (intercepted || !predicate(params)) return route.fallback()
        intercepted = true
        const responseReady = page.waitForResponse(
          (response) => response.request() === route.request(),
        )
        const data = await readHistory(params)
        entered.resolve({ params, data })
        await release.promise
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(data),
        })
        await (await responseReady).finished()
        await page.evaluate(
          () =>
            new Promise((done) =>
              globalThis.requestAnimationFrame(() =>
                globalThis.requestAnimationFrame(done),
              ),
            ),
        )
        completed.resolve()
      }
      await page.route(endpoint, handler)
      return {
        entered: entered.promise,
        async finish() {
          release.resolve()
          await completed.promise
          await page.unroute(endpoint, handler)
        },
      }
    }
    try {
      // El reloj cruza la medianoche UTC, pero las ventas pertenecen al día de Managua.
      const start = Date.parse(fixture.today + 'T00:00:00Z') + 26.25 * 3600000
      await db.exec('reset role')
      await db.exec(`create or replace function pg_catalog.now() returns timestamptz
        language sql stable as $$select current_setting('lcp.history_browser_now')::timestamptz$$`)
      await clock(start)
      await identity(db, admin)
      await rpc('open_business_day', {
        requestId: crypto.randomUUID(),
        expectedDay: fixture.today,
        openingNio: 1000,
        openingUsd: 1000,
      })
      await rpc('record_inventory_movement', {
        requestId: crypto.randomUUID(),
        productId: product,
        location: 'store',
        type: 'ADJUSTMENT',
        quantity: 100,
        expectedQuantity: 20,
        adjustmentKind: 'correction',
        counterAccount: '3110-001',
        note: 'Existencias aisladas para paginar el histórico de ventas',
      })
      const customer = await one('select id,name from public.customers limit 1')
      const sale = (extra = {}) =>
        rpc('create_document', {
          requestId: crypto.randomUUID(),
          kind: 'invoice',
          customerId: customer.id,
          tier: 'emprendedor',
          currency: 'NIO',
          exchangeRate: 1,
          location: 'store',
          paymentMethod: 'cash',
          notes: '',
          items: [{ productId: product, quantity: 1 }],
          ...extra,
        })
      const invoices = []
      for (let index = 0; index < 22; index++) {
        await clock(start + index * 60000)
        invoices.push(
          await sale(
            index === 21
              ? {
                  invoiceDiscount: 20,
                  items: [
                    { productId: product, quantity: 2, finalUnitPrice: 340 },
                  ],
                }
              : index === 20
                ? {
                    currency: 'USD',
                    exchangeRate: 36.6,
                    invoiceDiscount: 1,
                    items: [
                      { productId: product, quantity: 2, finalUnitPrice: 9 },
                    ],
                  }
                : index === 19
                  ? { items: [{ productId: product, quantity: 2 }] }
                  : {},
          ),
        )
      }
      await clock(start + 30 * 60000)
      for (const [index, quantity] of [
        [19, 1],
        [18, 1],
      ]) {
        const detail = (
          await one('select public.invoice_return_detail($1) result', [
            invoices[index].id,
          ])
        ).result
        await rpc('record_sales_return', {
          requestId: crypto.randomUUID(),
          documentId: invoices[index].id,
          reason: 'Devolución real para el histórico por perfume',
          refundMethod: 'cash',
          items: [{ itemId: detail.items[0].id, quantity, restock: true }],
        })
      }
      await db.query('select public.delete_invoice($1,$2)', [
        invoices[17].id,
        'Factura anulada para comprobar el histórico del perfume',
      ])
      const original = (
        await one('select public.invoice_edit_detail($1) result', [
          invoices[16].id,
        ])
      ).result.document
      await rpc('correct_invoice', {
        requestId: crypto.randomUUID(),
        documentId: original.id,
        expectedRevision: original.revision,
        customerId: original.customer_id,
        customerName: original.customer_name,
        customerPhone: original.customer_phone,
        customerTaxId: original.customer_tax_id ?? '',
        tier: original.tier_code,
        currency: original.currency,
        exchangeRate: 1,
        location: original.location,
        paymentMethod: original.payment_method,
        notes: 'El perfume original se retiró al corregir esta factura',
        invoiceDiscount: 0,
        shippingMethod: null,
        shippingAmount: 0,
        items: [
          {
            productId: other,
            quantity: 1,
            unitPrice: 366,
            finalUnitPrice: 366,
          },
        ],
      })
      const otherInvoice = await sale({
        customerId: undefined,
        customerName: 'Cliente exclusivo de otro perfume',
        items: [{ productId: other, quantity: 1 }],
      })
      const proforma = await sale({
        kind: 'proforma',
        customerId: undefined,
        customerName: 'Cliente de proforma que no es venta',
        location: null,
        paymentMethod: null,
        validUntil: fixture.today,
      })
      await db.exec('reset role')
      await db.query('update public.customers set name=$2 where id=$1', [
        customer.id,
        'Cliente actual renombrado después de facturar',
      ])
      await db.query(
        "update public.product_prices set amount=case when currency='NIO' then 999 else 99 end where product_id=$1",
        [product],
      )
      await identity(db, admin)
      await clock(start + 40 * 60000)
      const beforeReads = await fingerprint()
      await login()
      await inventory()
      let dialog = await openProduct(product)
      let history = dialog.getByRole('region', { name: historyName })
      await waitPage(history, 1, 20, 22)
      equal(await records(history).count(), 20)
      const discounted = history.getByRole('article', {
        name: `Factura ${invoices[21].number}`,
        exact: true,
      })
      const dollars = history.getByRole('article', {
        name: `Factura ${invoices[20].number}`,
        exact: true,
      })
      equal(
        await discounted
          .locator('.product-sales-history-customer strong')
          .innerText(),
        customer.name,
      )
      equal(await field(discounted, 'Cantidad facturada'), '2 unidades')
      equal(await field(discounted, 'Precio unitario neto'), 'NIO 330.00')
      equal(await field(discounted, 'Total facturado'), 'NIO 660.00')
      equal(
        await field(discounted, 'Precio original del renglón'),
        'NIO 366.00',
      )
      equal(await field(discounted, 'Descuento general asignado'), 'NIO 20.00')
      equal(await field(dollars, 'Precio unitario neto'), 'USD 8.50')
      equal(await field(dollars, 'Total facturado'), 'USD 17.00')
      equal(
        await discounted
          .getByRole('link', { name: 'Ver facturas del día' })
          .getAttribute('href'),
        `/sales/history?day=${fixture.today}`,
        'La fecha de la venta usa el día de Managua, aunque UTC sea el día siguiente',
      )
      matches(
        await discounted.locator('time').innerText(),
        /08:36|20:36/,
        'Hora de Managua',
      )
      equal(
        await history
          .getByText('Cliente actual renombrado después de facturar', {
            exact: true,
          })
          .count(),
        0,
      )
      equal(
        await history
          .getByRole('article', {
            name: `Factura ${otherInvoice.number}`,
            exact: true,
          })
          .count(),
        0,
      )
      equal(
        await history
          .getByRole('article', {
            name: `Factura ${proforma.number}`,
            exact: true,
          })
          .count(),
        0,
      )
      for (const [index, status] of [
        [19, 'Devolución parcial'],
        [18, 'Devuelta'],
        [17, 'Anulada'],
        [16, 'Retirado de la factura'],
      ]) {
        const row = history.getByRole('article', {
          name: `Factura ${invoices[index].number}`,
          exact: true,
        })
        equal(await row.getByText(status, { exact: true }).isVisible(), true)
      }
      equal(
        await history
          .getByText('Registro histórico; no cuenta como venta vigente.', {
            exact: true,
          })
          .count(),
        2,
      )
      await healthy('Histórico desde la ficha ' + width)
      await discounted.screenshot({ path: `${output}/factura-${width}.png` })
      await history.screenshot({ path: `${output}/historial-${width}.png` })

      const firstNumbers = await records(history)
        .locator('h3')
        .allTextContents()
      await history
        .getByRole('button', { name: 'Página siguiente de ventas' })
        .click()
      await waitPage(history, 21, 22, 22)
      equal(await records(history).count(), 2)
      const lastNumbers = await records(history).locator('h3').allTextContents()
      equal(
        new Set([...firstNumbers, ...lastNumbers]).size,
        22,
        'Páginas sin duplicados',
      )
      equal(
        await history
          .getByRole('button', { name: 'Página siguiente de ventas' })
          .isDisabled(),
        true,
      )
      equal(requests.at(-1).p_offset, 20)
      equal(
        requests.at(-1).p_expected_total,
        22,
        'Paginar verifica el total de la primera página',
      )
      equal(
        typeof requests.at(-1).p_as_of,
        'string',
        'Paginar conserva el corte temporal',
      )
      await history
        .getByRole('button', { name: 'Página anterior de ventas' })
        .click()
      await waitPage(history, 1, 20, 22)
      equal(
        await records(history).locator('h3').allTextContents(),
        firstNumbers,
      )

      let failed = false
      const failNextPage = async (route) => {
        if (failed) return route.fallback()
        failed = true
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Fallo temporal de prueba' }),
        })
      }
      await page.route(endpoint, failNextPage)
      await history
        .getByRole('button', { name: 'Página siguiente de ventas' })
        .click()
      await history.getByRole('alert').waitFor()
      equal(
        await history.getByText(emptyText, { exact: true }).count(),
        0,
        'Un fallo no se presenta como cero ventas',
      )
      equal(
        await records(history).count(),
        0,
        'Un fallo no deja ventas de la página anterior',
      )
      await history
        .getByRole('button', { name: 'Reintentar', exact: true })
        .click()
      await waitPage(history, 21, 22, 22)
      await page.unroute(endpoint, failNextPage)
      await history
        .getByRole('button', { name: 'Página anterior de ventas' })
        .click()
      await waitPage(history, 1, 20, 22)
      const changedMessage =
        'El historial cambió mientras lo consultabas. Pulsa Actualizar ventas para volver al inicio.'
      let changedParams
      const rejectChangedPage = async (route) => {
        const params = route.request().postDataJSON()
        if (changedParams || params.p_offset !== 20) return route.fallback()
        changedParams = params
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'P0001', message: changedMessage }),
        })
      }
      await page.route(endpoint, rejectChangedPage)
      await history
        .getByRole('button', { name: 'Página siguiente de ventas' })
        .click()
      await history
        .getByRole('alert')
        .getByText(changedMessage, { exact: true })
        .waitFor()
      equal(changedParams.p_expected_total, 22)
      equal(await history.getByText(emptyText, { exact: true }).count(), 0)
      equal(
        await records(history).count(),
        0,
        'Un historial cambiado no muestra una página mezclada',
      )
      await page.unroute(endpoint, rejectChangedPage)
      await history
        .getByRole('button', { name: 'Actualizar ventas', exact: true })
        .click()
      await waitPage(history, 1, 20, 22)
      equal(
        requests.at(-1).p_offset,
        0,
        'Actualizar recupera desde la primera página',
      )
      equal(requests.at(-1).p_as_of, null)
      equal(requests.at(-1).p_expected_total, null)
      equal(
        await fingerprint(),
        beforeReads,
        'Consultar y reintentar no cambia ventas, stock ni comprobantes',
      )

      const lateProduct = await holdResponse(
        (params) => params.p_product === product && params.p_offset === 0,
      )
      await history
        .getByRole('button', { name: 'Actualizar ventas', exact: true })
        .click()
      await lateProduct.entered
      await history
        .getByRole('status')
        .filter({ hasText: 'Cargando ventas…' })
        .waitFor()
      equal(await history.getByText(emptyText, { exact: true }).count(), 0)
      equal(await records(history).count(), 0)
      await closeProduct()
      dialog = await openProduct(empty)
      history = dialog.getByRole('region', { name: historyName })
      await history.getByText(emptyText, { exact: true }).waitFor()
      await lateProduct.finish()
      equal(
        await records(history).count(),
        0,
        'La respuesta atrasada de otro perfume no contamina la ficha vacía',
      )
      equal(
        await history.getByText(emptyText, { exact: true }).isVisible(),
        true,
      )
      await healthy('Producto sin ventas ' + width)
      await closeProduct()

      dialog = await openProduct(product)
      history = dialog.getByRole('region', { name: historyName })
      await waitPage(history, 1, 20, 22)
      const latePage = await holdResponse(
        (params) => params.p_product === product && params.p_offset === 20,
      )
      await history
        .getByRole('button', { name: 'Página siguiente de ventas' })
        .click()
      const oldPage = await latePage.entered
      equal(oldPage.data.total, 22)
      await closeProduct()
      await clock(start + 50 * 60000)
      const fresh = await sale({
        customerId: undefined,
        customerName: 'Venta posterior a la consulta',
      })
      const afterConcurrentSale = await fingerprint()
      dialog = await openProduct(product)
      history = dialog.getByRole('region', { name: historyName })
      await waitPage(history, 1, 20, 23)
      await latePage.finish()
      equal(
        await records(history).count(),
        20,
        'La página atrasada no reemplaza la página actual',
      )
      equal(
        await records(history).first().locator('h3').innerText(),
        fresh.number,
      )
      await waitPage(history, 1, 20, 23)
      equal(
        requests.at(-1).p_as_of,
        null,
        'Reabrir inicia una consulta actualizada',
      )
      await healthy('Respuesta atrasada y nueva venta ' + width)
      await closeProduct()

      await navigate(`/products/${product}/edit`)
      await page
        .getByRole('heading', { name: 'Editar perfume', exact: true })
        .waitFor()
      history = page.getByRole('region', { name: historyName })
      await waitPage(history, 1, 20, 23)
      equal(
        await records(history).first().locator('h3').innerText(),
        fresh.number,
      )
      equal(
        await page
          .getByRole('heading', { name: 'Historial de precios', exact: true })
          .isVisible(),
        true,
      )
      await healthy('Histórico en el editor ' + width)
      await history.screenshot({ path: `${output}/editor-${width}.png` })
      equal(await fingerprint(), afterConcurrentSale)

      for (const role of ['admin', 'warehouse', 'viewer']) {
        await page.goto(base + '/login')
        await page.waitForLoadState('networkidle')
        await db.exec('reset role')
        await db.query(
          'update public.staff_members set role=$2 where user_id=$1',
          [admin, role],
        )
        await identity(db, admin)
        await login()
        await inventory()
        const previousRequests = requests.length
        dialog = await openProduct(product)
        history = dialog.getByRole('region', { name: historyName })
        if (role === 'admin') {
          await waitPage(history, 1, 20, 23)
          equal(
            requests.length > previousRequests,
            true,
            'Administración puede consultar ventas',
          )
        } else {
          await page.waitForLoadState('networkidle')
          equal(
            await history.count(),
            0,
            `${role} no recibe el histórico financiero`,
          )
          equal(
            requests.length,
            previousRequests,
            `${role} no solicita el RPC de ventas`,
          )
        }
        await healthy(`Permisos ${role} ${width}`)
        await closeProduct()
      }
      results.push({ width, checks: checks - startChecks, status: 'passed' })
      console.log(
        `PASS histórico de ventas ${width}px: producto, fecha Managua, cliente y precios conservados, devoluciones/anulación/retiro, páginas, errores/reintentos, respuestas atrasadas y permisos`,
      )
    } catch (error) {
      await writeFile(
        `${output}/fallo-${width}.json`,
        JSON.stringify(
          {
            error: String(error),
            errors,
            failures: fixture.failures,
            requests,
            body: await page
              .locator('body')
              .innerText()
              .catch(() => ''),
          },
          null,
          2,
        ),
      )
      await page
        .screenshot({ path: `${output}/fallo-${width}.png`, fullPage: true })
        .catch(() => {})
      throw error
    } finally {
      await context.close()
      await fixture.close()
    }
  }
  await writeFile(
    `${output}/resultados.json`,
    JSON.stringify({ checks, results, productionWrites: false }, null, 2),
  )
  console.log(
    `OK: ${checks} comprobaciones del histórico de ventas por producto`,
  )
} finally {
  await browser?.close()
  await server.close()
}

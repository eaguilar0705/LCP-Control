import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5193'
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) ||
    new URL(base).origin === 'https://lcp-control.pages.dev',
)
const output = process.env.LCP_TEST_OUTPUT ?? 'output/customer-autocomplete'
await mkdir(output, { recursive: true })
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5193, strictPort: true },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let checks = 0
const results = []
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      isMobile: width < 500,
      hasTouch: width < 500,
      timezoneId: 'America/Managua',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    // Todos los endpoints de Supabase se interceptan antes del primer acceso.
    // Incluso al probar el frontend publicado, no se escriben datos reales.
    const fixture = await browserDatabase(page)
    const get = async (sql, values = []) =>
      (await fixture.db.query(sql, values)).rows[0]
    const reveal = async (target) => {
      for (const summary of await target
        .locator('xpath=ancestor::details[not(@open)]/summary')
        .all())
        await summary.click()
    }
    const navigate = async (path, heading) => {
      await page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      await page.getByRole('heading', { name: heading, exact: true }).waitFor()
      await page.getByLabel('Buscar en catálogo', { exact: true }).waitFor()
    }
    try {
      await fixture.db.exec('reset role')
      const registered = await get(
        "insert into public.customers(name,phone,tax_id,price_tier,active) values('José Núñez','88881234','J0310000000012','vip',true) returning id,name,phone,tax_id",
      )
      await fixture.db.exec(
        "insert into public.customers(name,phone,tax_id,price_tier,active) values('María López','77775555','F000000009','premium',true),('José Archivado','66664444','INACTIVO-01','vip',false)",
      )
      await fixture.db.exec('set role authenticated')
      const originalCustomers = (
        await get('select count(*)::int n from public.customers')
      ).n
      await fixture.db.query('select public.open_business_day($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedDay: fixture.today,
          openingNio: 1000,
          openingUsd: 0,
        }),
      ])
      await page.goto(`${base}/login`)
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
      for (const kind of ['invoice', 'proforma']) {
        const noun = kind === 'invoice' ? 'factura' : 'proforma'
        await navigate(
          kind === 'invoice' ? '/sales' : '/proformas',
          kind === 'invoice' ? 'Facturación' : 'Proformas',
        )
        const customer = page.getByLabel('Cliente', { exact: true })
        const phone = page.getByLabel('WhatsApp del cliente', { exact: true })
        const taxId = page.getByLabel('RUC / Identificación del cliente', {
          exact: true,
        })
        const options = page.getByRole('listbox', {
          name: 'Clientes registrados',
          exact: true,
        })
        const customerOption = () =>
          options.getByRole('option', { name: /José Núñez/ })
        await reveal(customer)
        equal(await customer.getAttribute('role'), 'combobox')
        equal(
          await page.getByLabel('Cliente registrado', { exact: true }).count(),
          0,
          'Un único campo evita elegir dos veces el cliente',
        )
        await customer.focus()
        await options.waitFor()
        equal(
          await options.getByRole('option').count(),
          3,
          'Al empezar se ofrecen únicamente los tres clientes activos',
        )
        const firstOption = options.getByRole('option').first()
        await firstOption.scrollIntoViewIfNeeded()
        equal(
          await firstOption.evaluate((option) => {
            const bounds = option.getBoundingClientRect()
            const topElement = globalThis.document.elementFromPoint(
              bounds.x + bounds.width / 2,
              bounds.y + bounds.height / 2,
            )
            return topElement !== null && option.contains(topElement)
          }),
          true,
          'El desplegable queda visible sobre la tarjeta y permite seleccionar',
        )
        await customer.fill('jOsE nUnEz')
        await customerOption().waitFor()
        equal(
          await options.getByRole('option').count(),
          1,
          'Búsqueda sin tildes ni diferencias de mayúsculas',
        )
        await page.screenshot({
          path: `${output}/busqueda-${kind}-${width}.png`,
          fullPage: true,
        })
        await customerOption().click()
        equal(await customer.inputValue(), registered.name)
        equal(await phone.inputValue(), registered.phone)
        equal(await taxId.inputValue(), registered.tax_id)
        equal(
          await page
            .getByLabel('Lista de precios', { exact: true })
            .inputValue(),
          'vip',
        )
        equal(await customer.isDisabled(), true)
        equal(await phone.isDisabled(), true)
        await page
          .getByRole('button', { name: 'Cambiar cliente', exact: true })
          .click()
        equal(await customer.inputValue(), '')
        equal(await phone.inputValue(), '')
        equal(await taxId.inputValue(), '')
        equal(await customer.isDisabled(), false)
        equal(await phone.isDisabled(), false)
        await customer.fill('88881234')
        await customerOption().waitFor()
        equal(
          await options.getByRole('option').count(),
          1,
          'Búsqueda por teléfono',
        )
        await customerOption().click()
        equal(await customer.inputValue(), registered.name)
        await page
          .getByRole('button', { name: 'Cambiar cliente', exact: true })
          .click()
        await customer.fill('José Archivado')
        await page
          .getByText('Sin coincidencias. Puedes usar el nombre escrito.', {
            exact: true,
          })
          .waitFor()
        equal(
          await options.getByRole('option').count(),
          0,
          'Los clientes archivados no se ofrecen para una venta nueva',
        )
        await customer.fill(`Cliente nuevo libre ${kind}`)
        await page
          .getByText('Sin coincidencias. Puedes usar el nombre escrito.', {
            exact: true,
          })
          .waitFor()
        await customer.press('Enter')
        equal(
          await customer.inputValue(),
          `Cliente nuevo libre ${kind}`,
          'Un nombre libre no se reemplaza por otra persona',
        )
        equal(
          (await get('select count(*)::int n from public.customers')).n,
          originalCustomers,
          'Escribir y buscar no registra personas automáticamente',
        )

        await page
          .getByLabel('Buscar en catálogo', { exact: true })
          .fill('QA-0001')
        await page
          .getByRole('button', { name: /^Agregar Lattafa/ })
          .first()
          .click()
        const quantity = page.getByLabel(/^Cantidad de /).first()
        await quantity.fill('2')
        await reveal(customer)
        await customer.fill('j0310000000012')
        await customerOption().waitFor()
        equal(
          await options.getByRole('option').count(),
          1,
          'Búsqueda por RUC sin distinguir mayúsculas',
        )
        const documentsBeforeEnter = (
          await get('select count(*)::int n from public.documents')
        ).n
        await customer.press('Enter')
        equal(
          (await get('select count(*)::int n from public.documents')).n,
          documentsBeforeEnter,
          'Enter no debe emitir una factura ni proforma mientras se busca',
        )
        await customer.focus()
        await customer.press('ArrowDown')
        await customer.press('Enter')
        equal(
          await customer.inputValue(),
          registered.name,
          'Selección accesible con flecha y Enter',
        )
        equal(
          (await get('select count(*)::int n from public.documents')).n,
          documentsBeforeEnter,
        )
        if (kind === 'invoice') {
          await page
            .getByRole('button', { name: 'Dividir pago', exact: true })
            .click()
          equal(await page.locator('.split-payment-row').count(), 2)
          const single = page.getByRole('button', {
            name: 'Usar un solo pago',
            exact: true,
          })
          await single.focus()
          await page.keyboard.press('Shift')
          const style = await single.evaluate((button) => {
            const css = globalThis.getComputedStyle(button)
            return {
              background: css.backgroundColor,
              color: css.color,
              outline: css.outlineStyle,
              outlineWidth: Number.parseFloat(css.outlineWidth),
              height: button.getBoundingClientRect().height,
              right: button.getBoundingClientRect().right,
            }
          })
          const rgb = style.background.match(/\d+/g).map(Number)
          equal(
            rgb[0] > rgb[1] * 1.5 && rgb[0] > rgb[2] * 1.3,
            true,
            'Botón de un solo pago usa el rojo de la tienda',
          )
          equal(
            style.outline !== 'none' && style.outlineWidth >= 2,
            true,
            'Foco de teclado visible',
          )
          equal(style.height >= 44, true, 'Área táctil adecuada')
          equal(style.right <= width + 1, true)
          await page.screenshot({
            path: `${output}/pago-dividido-${width}.png`,
            fullPage: true,
          })
          await single.click()
          equal(await page.locator('.split-payment-row').count(), 0)
          await page.getByLabel('Forma de pago', { exact: true }).waitFor()
          equal(
            await customer.inputValue(),
            registered.name,
            'Cambiar la forma de pago conserva cliente',
          )
          equal(await phone.inputValue(), registered.phone)
          equal(
            await quantity.inputValue(),
            '2',
            'Cambiar pagos conserva los productos',
          )
        }
        await page
          .getByRole('button', { name: 'Guardar borrador', exact: true })
          .click()
        await page
          .getByText('Borrador guardado en tu cuenta.', { exact: true })
          .waitFor()
        const drafts = (
          await get('select items from public.user_drafts where namespace=$1', [
            `lcp.drafts.${kind}.v2`,
          ])
        ).items
        equal(drafts.length, 1)
        equal(
          drafts[0].customerId,
          registered.id,
          'El borrador conserva el identificador real del cliente',
        )
        equal(drafts[0].customer, registered.name)
        equal(drafts[0].phone, registered.phone)
        equal(drafts[0].taxId, registered.tax_id)
        equal(drafts[0].tier, 'vip')
        await page
          .getByRole('button', { name: `Emitir ${noun}`, exact: true })
          .click()
        await page
          .getByText(
            kind === 'invoice'
              ? /Factura FAC-.*emitida/
              : /Proforma PRO-.*emitida/,
          )
          .waitFor()
        const document = await get(
          'select customer_id,customer_name,customer_phone,customer_tax_id,tier_code from public.documents where kind=$1 order by created_at desc,id desc limit 1',
          [kind],
        )
        equal(
          document.customer_id,
          registered.id,
          'La emisión conserva el cliente seleccionado',
        )
        equal(document.customer_name, registered.name)
        equal(document.customer_phone?.replace(/^505/, ''), registered.phone)
        equal(document.customer_tax_id, registered.tax_id)
        equal(document.tier_code, 'vip')
        equal(
          (await get('select count(*)::int n from public.customers')).n,
          originalCustomers,
          'Emitir a un cliente registrado no lo duplica',
        )
        equal(
          await page.evaluate(
            () =>
              globalThis.document.documentElement.scrollWidth >
              globalThis.innerWidth + 1,
          ),
          false,
        )
        equal(fixture.failures, [])
        equal(errors, [])
        results.push({ width, kind, status: 'correcto', checks })
      }
      equal((await get('select count(*)::int n from public.documents')).n, 2)
      console.log(
        `PASS clientes ${width}px: búsqueda nombre/teléfono/RUC, teclado, cambiar cliente, borrador y factura/proforma sin duplicar; botón rojo de un solo pago`,
      )
    } catch (error) {
      await page.screenshot({
        path: `${output}/fallo-${width}.png`,
        fullPage: true,
      })
      await writeFile(
        `${output}/fallo-${width}.json`,
        JSON.stringify(
          {
            errors,
            failures: fixture.failures,
            body: await page.locator('body').innerText(),
          },
          null,
          2,
        ),
      )
      throw error
    } finally {
      await fixture.close()
      await context.close()
    }
  }
  await writeFile(
    `${output}/resultados.json`,
    JSON.stringify({ checks, results }, null, 2),
  )
  console.log(`Autocompletado de clientes: ${checks} comprobaciones correctas.`)
} finally {
  await browser.close()
  await server?.close()
}

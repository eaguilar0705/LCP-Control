import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { browserDatabase } from './browser-database.mjs'
import { admin, identity } from './database-fixture.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname))
const output = 'output/supplier-autocomplete-review'
await mkdir(output, { recursive: true })
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      timezoneId: 'America/Managua',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const fixture = await browserDatabase(page)
    const suggestions = () =>
      page.getByRole('listbox', { name: 'Proveedores registrados' })
    const one = async (sql, values = []) =>
      (await fixture.db.query(sql, values)).rows[0]
    const purchases = async () =>
      Number(
        (await one('select count(*)::int n from public.purchase_shipments')).n,
      )
    const openPurchase = async () => {
      await page.getByRole('button', { name: 'Entrada', exact: true }).click()
      let dialog = page.getByRole('dialog')
      await dialog
        .getByRole('button', { name: /Producto del movimiento/ })
        .click()
      await dialog.getByPlaceholder('Nombre, marca o código…').fill('QA-0001')
      await dialog.getByRole('option').first().click()
      await dialog
        .getByLabel('Ubicación', { exact: true })
        .selectOption('store')
      await dialog.getByLabel('Cantidad', { exact: true }).fill('2')
      await dialog
        .getByLabel('Motivo', { exact: true })
        .fill('Compra de auditoría de proveedor')
      await dialog
        .getByRole('button', { name: 'Continuar con la compra', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      await dialog
        .getByRole('heading', { name: 'Registrar compra', exact: true })
        .waitFor()
      await dialog.getByLabel('Pago', { exact: true }).selectOption('credito')
      await dialog
        .getByLabel('Costo por unidad (C$)', { exact: true })
        .fill('200')
      return dialog
    }
    const savePurchase = async (dialog, supplierName, reference) => {
      await dialog
        .getByLabel('Factura o referencia', { exact: true })
        .fill(reference)
      await dialog
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      equal(
        (
          await one(
            'select supplier from public.purchase_shipments where reference=$1',
            [reference],
          )
        ).supplier,
        supplierName,
        'la compra guarda el proveedor como texto sin cambiar el contacto',
      )
    }
    const healthy = async (label) => {
      equal(errors, [], label + ': navegador sin errores')
      equal(fixture.failures, [], label + ': API sin errores')
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        label + ': página sin desbordamiento horizontal',
      )
      for (const dialog of await page.getByRole('dialog').all()) {
        equal(
          await dialog.evaluate(
            (element) => element.scrollWidth > element.clientWidth + 1,
          ),
          false,
          label + ': diálogo sin desbordamiento horizontal',
        )
      }
    }
    try {
      await fixture.db.exec('reset role')
      await fixture.db
        .exec(`insert into public.suppliers(name,phone,tax_id,active) values
        ('Distribuidora Ámbar','88881234','J0310000001234',true),
        ('Perfumes Pacífico','77775678','J0310000005678',true),
        ('Distribuidora Ambar Inactiva','88889999','J0310000009999',false)`)
      const contactsBefore = (
        await one('select count(*)::int n from public.suppliers')
      ).n
      await identity(fixture.db, admin)
      await fixture.db.query('select public.open_business_day($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedDay: fixture.today,
          openingNio: 1000,
          openingUsd: 0,
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
      await page.evaluate(() => {
        globalThis.history.pushState({}, '', '/inventory')
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      })
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      await page.locator('.catalog-product').first().waitFor()

      let dialog = await openPurchase()
      let supplier = dialog.getByRole('combobox', {
        name: 'Proveedor',
        exact: true,
      })
      await supplier.fill('ambar')
      await suggestions()
        .getByRole('option', { name: /Distribuidora Ámbar/ })
        .waitFor()
      equal(
        await suggestions().getByRole('option').count(),
        1,
        'ignora acentos y excluye proveedores inactivos',
      )
      equal(
        await supplier.getAttribute('aria-expanded'),
        'true',
        'combobox anuncia sugerencias',
      )
      await healthy('sugerencias ' + width)
      await page.screenshot({
        path: `${output}/sugerencias-${width}.png`,
        fullPage: false,
      })

      // Enter sin seleccionar ni confirmar una compra; Escape no cierra el diálogo.
      await supplier.press('Enter')
      equal(
        await purchases(),
        0,
        'Enter sin opción activa no registra la compra',
      )
      equal(await supplier.inputValue(), 'ambar', 'Enter no cambia texto libre')
      await supplier.fill('Ámbar')
      await suggestions()
        .getByRole('option', { name: /Distribuidora Ámbar/ })
        .waitFor()
      await supplier.press('Escape')
      equal(
        await dialog.isVisible(),
        true,
        'Escape conserva el formulario de compra',
      )
      equal(await supplier.inputValue(), 'Ámbar', 'Escape conserva el texto')
      equal(
        await supplier.getAttribute('aria-expanded'),
        'false',
        'Escape cierra las sugerencias',
      )

      await supplier.fill('88881234')
      await suggestions()
        .getByRole('option', { name: /Distribuidora Ámbar/ })
        .waitFor()
      equal(
        await suggestions().getByRole('option').count(),
        1,
        'busca por teléfono',
      )
      await supplier.fill('J0310000005678')
      await suggestions()
        .getByRole('option', { name: /Perfumes Pacífico/ })
        .waitFor()
      equal(await suggestions().getByRole('option').count(), 1, 'busca por RUC')
      await supplier.fill('')
      await suggestions()
        .getByRole('option', { name: /Proveedor Auditoría/ })
        .waitFor()
      equal(
        await suggestions().getByRole('option').count(),
        3,
        'solo ofrece proveedores activos',
      )
      await supplier.press('ArrowUp')
      await supplier.press('Enter')
      equal(
        await supplier.inputValue(),
        'Proveedor Auditoría',
        'flecha arriba desde ninguna opción selecciona la última',
      )
      equal(
        await purchases(),
        0,
        'flecha arriba y Enter tampoco registran la compra',
      )
      await supplier.fill('ambar')
      await suggestions()
        .getByRole('option', { name: /Distribuidora Ámbar/ })
        .waitFor()
      await supplier.press('ArrowDown')
      await supplier.press('Enter')
      equal(
        await supplier.inputValue(),
        'Distribuidora Ámbar',
        'selección por teclado completa nombre',
      )
      equal(
        await purchases(),
        0,
        'seleccionar proveedor no envía el formulario',
      )
      await savePurchase(
        dialog,
        'Distribuidora Ámbar',
        `PROVEEDOR-REGISTRADO-${width}`,
      )
      equal(await purchases(), 1, 'una sola compra registrada')
      await fixture.db.exec('reset role')
      equal(
        await one(
          `select
          (select quantity from public.inventory_balances where product_id=$1 and location='store') quantity,
          (select average_cost_nio::text from public.product_costs where product_id=$1) cost`,
          [productId],
        ),
        { quantity: 22, cost: '106.250000' },
        'proveedor seleccionado conserva actualización de inventario y costo promedio',
      )
      await identity(fixture.db, admin)

      dialog = await openPurchase()
      supplier = dialog.getByRole('combobox', {
        name: 'Proveedor',
        exact: true,
      })
      await supplier.fill('Proveedor particular nuevo')
      await supplier.press('Tab')
      await savePurchase(
        dialog,
        'Proveedor particular nuevo',
        `PROVEEDOR-LIBRE-${width}`,
      )
      equal(
        await purchases(),
        2,
        'permite compra con proveedor escrito libremente',
      )

      // Un fallo de la lectura auxiliar no debe bloquear una compra válida.
      const blockRead = async (route) => route.abort('failed')
      await page.route('**/rest/v1/suppliers?*', blockRead)
      dialog = await openPurchase()
      supplier = dialog.getByRole('combobox', {
        name: 'Proveedor',
        exact: true,
      })
      await supplier.focus()
      await dialog
        .getByRole('button', { name: 'Reintentar', exact: true })
        .waitFor()
      await supplier.fill('Proveedor durante corte de consulta')
      await supplier.press('Tab')
      await savePurchase(
        dialog,
        'Proveedor durante corte de consulta',
        `PROVEEDOR-SIN-CONSULTA-${width}`,
      )
      equal(
        await purchases(),
        3,
        'fallo al consultar proveedores no impide registrar la compra',
      )
      await page.unroute('**/rest/v1/suppliers?*', blockRead)

      // Verifica recuperación de sugerencias al reintentar sin borrar lo escrito.
      await page.route('**/rest/v1/suppliers?*', blockRead)
      dialog = await openPurchase()
      supplier = dialog.getByRole('combobox', {
        name: 'Proveedor',
        exact: true,
      })
      await supplier.focus()
      await dialog
        .getByRole('button', { name: 'Reintentar', exact: true })
        .waitFor()
      await supplier.fill('pacifico')
      await page.unroute('**/rest/v1/suppliers?*', blockRead)
      await dialog
        .getByRole('button', { name: 'Reintentar', exact: true })
        .click()
      await supplier.focus()
      await suggestions()
        .getByRole('option', { name: /Perfumes Pacífico/ })
        .waitFor()
      equal(
        await supplier.inputValue(),
        'pacifico',
        'reintentar conserva texto escrito',
      )
      await suggestions()
        .getByRole('option', { name: /Perfumes Pacífico/ })
        .click()
      equal(
        await supplier.inputValue(),
        'Perfumes Pacífico',
        'selección con ratón o toque',
      )
      await healthy('recuperación ' + width)
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      equal(
        await purchases(),
        3,
        'cancelar después de seleccionar no registra compra',
      )
      await fixture.db.exec('reset role')
      equal(
        (await one('select count(*)::int n from public.suppliers')).n,
        contactsBefore,
        'autocompletar y escribir libremente no crean proveedores',
      )
      await identity(fixture.db, admin)
      await healthy('final ' + width)
    } finally {
      await fixture.close()
      await context.close()
    }
  }
  await writeFile(
    `${output}/resultado.json`,
    JSON.stringify(
      { checks, widths: [1440, 320], productionWrites: false },
      null,
      2,
    ),
  )
  console.log(
    `${checks} verificaciones de autocompletar proveedores correctas, sin escrituras en producción.`,
  )
} finally {
  await browser.close()
}

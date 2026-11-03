import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
import { admin, identity } from './database-fixture.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5207'
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]', 'lcp-control.pages.dev'].includes(
    new URL(base).hostname,
  ),
)
const output = process.env.LCP_TEST_OUTPUT ?? 'output/inventory-adjustments'
await mkdir(output, { recursive: true })
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5207, strictPort: true },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}

try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      timezoneId: 'America/Managua',
      isMobile: width < 500,
      hasTouch: width < 500,
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const fixture = await browserDatabase(page)
    const one = async (sql, values = []) =>
      (await fixture.db.query(sql, values)).rows[0]
    const stock = async () =>
      (
        await fixture.db.query(
          'select location,quantity from public.inventory_balances where product_id=$1 order by location',
          [product],
        )
      ).rows
    const movement = async (note) =>
      one(
        'select type,location,before_quantity,after_quantity,actor_id,note from public.inventory_movements where product_id=$1 and note=$2',
        [product, note],
      )
    const navigate = async (path) => {
      await page.evaluate((target) => {
        globalThis.history.pushState({}, '', target)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
    }
    const editor = page.locator('.product-stock-editor')
    const action = editor.getByLabel('Cómo cambiar las cantidades', {
      exact: true,
    })
    const count = editor.getByLabel('Conteo total del perfume', { exact: true })
    const noteField = editor.getByLabel('Motivo del cambio de cantidad', {
      exact: true,
    })
    const location = editor.getByLabel('Ubicación de las cantidades', {
      exact: true,
    })
    const save = editor.getByRole('button', {
      name: 'Guardar ajuste',
      exact: true,
    })
    const adjust = async (place, total, note) => {
      await location.selectOption(place)
      await action.selectOption('ADJUSTMENT')
      await count.fill(String(total))
      await noteField.fill(note)
      await save.click()
      await page.waitForFunction(
        ({ place, total }) => {
          const cards = [
            ...globalThis.document.querySelectorAll(
              '.product-stock-editor .stock-location-cards > div',
            ),
          ]
          return (
            cards
              .find((card) => card.querySelector('span')?.textContent === place)
              ?.querySelector('strong')?.textContent === String(total)
          )
        },
        { place: place === 'store' ? 'Tienda' : 'Bodega', total },
      )
      equal(await count.inputValue(), '', 'Se limpia el conteo guardado')
    }
    const setRole = async (role) => {
      await fixture.db.exec('reset role')
      await fixture.db.query(
        'update public.staff_members set role=$1 where user_id=$2',
        [role, admin],
      )
      await identity(fixture.db, admin)
      await page.reload()
      await login()
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
    try {
      await fixture.db.query('select public.open_business_day($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedDay: fixture.today,
          openingNio: 0,
          openingUsd: 0,
        }),
      ])
      await login()
      await navigate('/inventory')
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      await page
        .locator('.inventory-movement-area')
        .getByRole('button', {
          name: 'Ajustar existencias',
          exact: true,
        })
        .click()
      const dialog = page.getByRole('dialog')
      await dialog
        .getByRole('heading', { name: 'Ajuste de inventario', exact: true })
        .waitFor()
      await dialog
        .getByRole('button', { name: /Producto del movimiento/ })
        .click()
      await dialog.getByPlaceholder('Nombre, marca o código…').fill('QA-0001')
      await dialog.getByRole('option').first().click()
      await dialog
        .getByLabel('Ubicación', { exact: true })
        .selectOption('store')
      await dialog.getByLabel('Conteo total', { exact: true }).fill('25')
      equal(
        await dialog.getByLabel('Motivo', { exact: true }).inputValue(),
        'Conteo físico',
        'el ajuste ya trae un motivo editable',
      )
      const generalNote = `Conteo físico general ${width}`
      await dialog.getByLabel('Motivo', { exact: true }).fill(generalNote)
      await page.screenshot({
        path: `${output}/modal-${width}.png`,
        fullPage: true,
      })
      await dialog
        .getByRole('button', { name: 'Guardar ajuste', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      equal(await stock(), [
        { location: 'store', quantity: 25 },
        { location: 'warehouse', quantity: 10 },
      ])
      equal(
        await movement(generalNote),
        {
          type: 'ADJUSTMENT',
          location: 'store',
          before_quantity: 20,
          after_quantity: 25,
          actor_id: admin,
          note: generalNote,
        },
        'El ajuste general conserva el conteo, la ubicación y el responsable',
      )

      await page.getByLabel('Buscar producto', { exact: true }).fill('QA-0001')
      const card = page.locator('.catalog-product').first()
      await card.waitFor()
      await page.waitForFunction(
        () =>
          globalThis.document.querySelector(
            '.catalog-product .stock-tile-total dd',
          )?.textContent === '35',
      )
      equal(
        await card.locator('.stock-tile-total dd').innerText(),
        '35',
        'Total actualizado en el inventario',
      )
      await card
        .getByRole('link', { name: 'Ajustar existencias', exact: true })
        .click()
      await action.waitFor()
      equal(
        await noteField.inputValue(),
        'Conteo físico',
        'el editor evita volver a escribir el motivo del conteo',
      )
      equal(
        await action.inputValue(),
        'ADJUSTMENT',
        'Editar propone corregir el conteo físico',
      )
      equal(
        await editor
          .getByRole('button', { name: 'Registrar compra', exact: true })
          .count(),
        0,
      )

      const lowerNote = `Conteo menor en tienda ${width}`
      await adjust('store', 18, lowerNote)
      equal(await movement(lowerNote), {
        type: 'ADJUSTMENT',
        location: 'store',
        before_quantity: 25,
        after_quantity: 18,
        actor_id: admin,
        note: lowerNote,
      })
      const zeroNote = `Conteo de cero en bodega ${width}`
      await adjust('warehouse', 0, zeroNote)
      equal(
        await stock(),
        [
          { location: 'store', quantity: 18 },
          { location: 'warehouse', quantity: 0 },
        ],
        'El cero es válido y la otra ubicación conserva sus unidades',
      )

      // El servidor guarda, pero la respuesta se pierde: verificar conserva el
      // mismo identificador y no vuelve a sumar ni duplicar el ajuste.
      const payloads = []
      let lost = false
      const handler = async (route) => {
        const payload = route.request().postDataJSON().p_payload
        payloads.push(payload)
        if (lost) return route.fallback()
        lost = true
        await fixture.db.query(
          'select public.record_inventory_movement($1::jsonb)',
          [JSON.stringify(payload)],
        )
        await route.abort('failed')
      }
      await page.route('**/rest/v1/rpc/record_inventory_movement', handler)
      await location.selectOption('store')
      await count.fill('21')
      const retryNote = `Conteo con respuesta perdida ${width}`
      await noteField.fill(retryNote)
      await save.click()
      await editor
        .getByRole('alert')
        .filter({ hasText: 'No pudimos confirmar el guardado.' })
        .waitFor()
      equal(await count.isDisabled(), true)
      equal(await noteField.isDisabled(), true)
      await editor
        .getByRole('button', { name: 'Verificar guardado', exact: true })
        .click()
      await save.waitFor()
      await page.unroute('**/rest/v1/rpc/record_inventory_movement', handler)
      equal(payloads.length, 2)
      equal(
        payloads[1],
        payloads[0],
        'El reintento conserva los datos y requestId',
      )
      equal(
        payloads[0].expectedQuantity,
        18,
        'El conteo incluye las existencias que se revisaron',
      )
      equal(
        (
          await one(
            'select count(*)::int n from public.inventory_movements where note=$1',
            [retryNote],
          )
        ).n,
        1,
      )

      // Otro movimiento cambia la ubicación tras abrir el editor. El conteo
      // anterior se rechaza y no sobrescribe las existencias nuevas.
      await location.selectOption('warehouse')
      await count.fill('5')
      const staleNote = `Conteo desactualizado ${width}`
      await noteField.fill(staleNote)
      await fixture.db.query(
        'select public.record_inventory_movement($1::jsonb)',
        [
          JSON.stringify({
            requestId: crypto.randomUUID(),
            productId: product,
            location: 'warehouse',
            type: 'ADJUSTMENT',
            quantity: 2,
            expectedQuantity: 0,
            note: `Conteo registrado desde otra sesión ${width}`,
          }),
        ],
      )
      await save.click()
      await editor
        .getByRole('alert')
        .filter({ hasText: 'Las existencias cambiaron.' })
        .waitFor()
      equal(
        (
          await one(
            'select count(*)::int n from public.inventory_movements where note=$1',
            [staleNote],
          )
        ).n,
        0,
      )
      equal(await stock(), [
        { location: 'store', quantity: 21 },
        { location: 'warehouse', quantity: 2 },
      ])
      equal(
        fixture.failures.splice(0).length,
        1,
        'Se esperaba únicamente el rechazo del conteo desactualizado',
      )
      await editor
        .getByRole('button', { name: 'Actualizar existencias', exact: true })
        .click()
      await action.waitFor()
      await page.waitForFunction(
        () =>
          globalThis.document.querySelectorAll(
            '.product-stock-editor .stock-location-cards strong',
          )[1]?.textContent === '2',
      )
      await adjust('warehouse', 5, `Conteo actualizado ${width}`)
      equal(
        (await one('select count(*)::int n from public.purchase_shipments')).n,
        0,
        'Ningún conteo registra una compra',
      )
      equal(
        (
          await one(
            'select count(*)::int n from public.inventory_movements where product_id=$1',
            [product],
          )
        ).n,
        6,
      )
      await page.screenshot({
        path: `${output}/ajustes-${width}.png`,
        fullPage: true,
      })
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
      )

      await setRole('admin')
      await navigate(`/products/${product}/edit`)
      await action.waitFor()
      equal(
        await action.inputValue(),
        'ENTRY',
        'Administración conserva las compras',
      )
      equal(
        await action.locator('option[value="ADJUSTMENT"]').count(),
        0,
        'Administración no corrige conteos',
      )
      await editor
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('heading', { name: 'Registrar compra', exact: true })
        .waitFor()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cerrar', exact: true })
        .click()
      await fixture.db.exec('reset role')
      await fixture.db.query(
        "update public.inventory_balances set quantity=null where product_id=$1 and location='warehouse'",
        [product],
      )
      await identity(fixture.db, admin)
      await navigate('/inventory')
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      await navigate(`/products/${product}/edit`)
      await location.waitFor()
      await location.selectOption('warehouse')
      await editor
        .getByText(
          'Solicita a un SuperAdmin que registre el conteo inicial de esta ubicación.',
          { exact: true },
        )
        .waitFor()
      equal(
        await count.count(),
        0,
        'Administración no inicializa una ubicación pendiente',
      )
      equal(await save.count(), 0)
      await page
        .getByRole('button', { name: 'Costo de inventario', exact: true })
        .click()
      const pendingDialog = page.getByRole('dialog')
      await pendingDialog
        .getByText(
          'Solicita al Superadmin que registre el conteo de Tienda y Bodega antes de continuar, aunque sea 0.',
          { exact: true },
        )
        .waitFor()
      equal(
        await pendingDialog
          .getByRole('button', { name: /Registrar .* en 0|Registrar conteo/ })
          .count(),
        0,
        'Registrar costo tampoco permite inicializar unidades a Administración',
      )
      await pendingDialog
        .getByRole('button', { name: 'Cerrar', exact: true })
        .click()
      await navigate('/inventory')
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      equal(
        await page
          .getByRole('button', { name: 'Ajustar existencias', exact: true })
          .count(),
        0,
      )
      await setRole('warehouse')
      await navigate('/inventory')
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      equal(
        await page
          .getByRole('button', { name: 'Ajustar existencias', exact: true })
          .count(),
        0,
        'Inventario tampoco puede ajustar',
      )
      await page.getByRole('button', { name: 'Entrada', exact: true }).click()
      await page
        .getByRole('dialog')
        .getByText('Esta entrada necesita Administración.', { exact: true })
        .waitFor()
      equal(errors, [])
      equal(fixture.failures, [])
      console.log(
        `PASS ajustes ${width}px: conteos mayores, menores y cero; historial, permisos, concurrencia y recuperación sin compras`,
      )
    } catch (failure) {
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
      throw failure
    } finally {
      await fixture.close()
      await context.close()
    }
  }
  await writeFile(
    `${output}/resultados.json`,
    JSON.stringify(
      { checks, widths: [1440, 390, 320], productionWrites: false },
      null,
      2,
    ),
  )
  console.log(`Ajustes de inventario: ${checks} comprobaciones correctas.`)
} finally {
  await browser.close()
  await server?.close()
}

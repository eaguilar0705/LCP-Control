import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5197'
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) ||
    new URL(base).origin === 'https://lcp-control.pages.dev',
)
const output = process.env.LCP_TEST_OUTPUT ?? 'output/cost-location-counts'
await mkdir(output, { recursive: true })
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5197, strictPort: true },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let checks = 0
const results = []
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const productId = (index) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`
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
    // Toda la API está interceptada antes del primer acceso. Incluso en el
    // frontend publicado, las cantidades y costos sólo existen en PGlite.
    const fixture = await browserDatabase(page)
    const expectedFailures = []
    const one = async (sql, values = []) =>
      (await fixture.db.query(sql, values)).rows[0]
    const counts = async (index) => {
      const id = productId(index)
      const row = await one(
        `select
        (select quantity from public.inventory_balances where product_id=$1 and location='store') store,
        (select quantity from public.inventory_balances where product_id=$1 and location='warehouse') warehouse,
        (select average_cost_nio from public.product_costs where product_id=$1) cost,
        (select count(*)::int from public.opening_cost_records where product_id=$1) openings,
        (select count(*)::int from public.inventory_movements where product_id=$1) movements`,
        [id],
      )
      return { ...row, cost: row.cost === null ? null : Number(row.cost) }
    }
    const rpc = async (name, payload) =>
      (
        await fixture.db.query(`select public.${name}($1::jsonb) result`, [
          JSON.stringify(payload),
        ])
      ).rows[0].result
    const edit = async (index) => {
      const back = page.getByRole('link', {
        name: 'Volver al inventario',
        exact: true,
      })
      if (await back.count()) await back.click()
      else
        await page
          .getByRole('link', { name: 'Inventario', exact: true })
          .filter({ visible: true })
          .first()
          .click()
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      await page
        .getByLabel('Buscar producto', { exact: true })
        .fill(`QA-${String(index).padStart(4, '0')}`)
      const editLink = page
        .getByRole('link', { name: 'Editar', exact: true })
        .filter({ visible: true })
        .first()
      await editLink.click()
      await page
        .getByRole('heading', { name: 'Editar perfume', exact: true })
        .waitFor()
    }
    const openCost = async () => {
      await page
        .getByRole('button', { name: 'Costo de inventario', exact: true })
        .click()
      await page.getByRole('dialog').waitFor()
    }
    const missingDialog = () =>
      page.getByRole('dialog', { name: 'Agregar costo', exact: true })
    const openingDialog = () =>
      page.getByRole('dialog').filter({
        has: page.getByRole('button', {
          name: 'Guardar costo inicial',
          exact: true,
        }),
      })
    const confirmEmpty = async (location) => {
      await missingDialog()
        .getByRole('button', {
          name: `Registrar ${location} en 0`,
          exact: true,
        })
        .click()
      const confirm = page.getByRole('dialog', {
        name: 'Confirmar ubicación vacía',
        exact: true,
      })
      await confirm
        .getByRole('button', { name: 'Registrar en 0', exact: true })
        .click()
    }
    const saveOpening = async (index) => {
      const dialog = openingDialog()
      await dialog
        .getByText('5 unidades contadas en tienda y bodega.', { exact: true })
        .waitFor()
      await dialog
        .getByLabel('Costo por unidad (C$)', { exact: true })
        .fill('100')
      await dialog
        .getByLabel('Origen del costo / comprobante', { exact: true })
        .fill('Factura de costo inicial verificada')
      await dialog
        .getByRole('button', { name: 'Guardar costo inicial', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      const saved = await counts(index)
      equal(
        Number(saved.cost),
        100,
        'Se guarda el costo de las cinco unidades reales',
      )
      equal(saved.openings, 1)
      const record = await one(
        'select quantity,unit_cost_nio from public.opening_cost_records where product_id=$1',
        [productId(index)],
      )
      equal(record.quantity, 5)
      equal(Number(record.unit_cost_nio), 100)
    }
    const healthy = async (message) => {
      equal(errors, [], message + ': navegador sin errores')
      equal(
        fixture.failures,
        expectedFailures,
        message + ': sólo el conflicto de inventario provocado',
      )
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        message + ': sin desborde de página',
      )
      for (const dialog of await page.getByRole('dialog').all())
        equal(
          await dialog.evaluate(
            (element) => element.scrollWidth > element.clientWidth + 1,
          ),
          false,
          message + ': sin desborde del cuadro',
        )
    }
    try {
      await fixture.db.exec('reset role')
      for (const [index, store, warehouse] of [
        [1, 5, 0],
        [2, 0, 5],
        [3, 5, null],
        [4, null, 5],
        [5, null, null],
        [6, 5, null],
        [7, 5, null],
      ]) {
        if (index !== 7)
          await fixture.db.query(
            'delete from public.product_costs where product_id=$1',
            [productId(index)],
          )
        await fixture.db.query(
          "update public.inventory_balances set quantity=case when location='store' then $2::integer else $3::integer end where product_id=$1",
          [productId(index), store, warehouse],
        )
      }
      await fixture.db.exec('set role authenticated')
      await rpc('open_business_day', {
        requestId: crypto.randomUUID(),
        expectedDay: fixture.today,
        openingNio: 1000,
        openingUsd: 0,
      })
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

      // Un cero ya contado no requiere crear movimientos adicionales.
      for (const index of [1, 2]) {
        await edit(index)
        await openCost()
        await saveOpening(index)
        equal((await counts(index)).movements, 0)
      }

      // Abrir, cancelar y cerrar la confirmación nunca cambian un NULL a cero.
      await edit(3)
      await openCost()
      const initial = await counts(3)
      await missingDialog()
        .getByRole('button', { name: 'Registrar Bodega en 0', exact: true })
        .waitFor()
      equal(await counts(3), initial)
      await missingDialog()
        .getByRole('button', { name: 'Registrar Bodega en 0', exact: true })
        .click()
      let confirm = page.getByRole('dialog', {
        name: 'Confirmar ubicación vacía',
        exact: true,
      })
      await confirm
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      equal(await counts(3), initial)
      await missingDialog()
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      equal(await counts(3), initial)
      await openCost()
      const payloads = []
      let lost = false
      const loseResponse = async (route) => {
        const payload = route.request().postDataJSON().p_payload
        payloads.push(payload)
        if (lost) return route.fallback()
        lost = true
        await rpc('record_inventory_movement', payload)
        return route.abort('failed')
      }
      await page.route('**/rest/v1/rpc/record_inventory_movement', loseResponse)
      await confirmEmpty('Bodega')
      await missingDialog()
        .getByRole('button', { name: 'Verificar guardado', exact: true })
        .waitFor()
      equal((await counts(3)).warehouse, 0)
      equal((await counts(3)).movements, 1)
      equal((await counts(3)).openings, 0)
      equal(
        await missingDialog()
          .getByRole('button', { name: 'Cancelar', exact: true })
          .isDisabled(),
        true,
      )
      await page.screenshot({
        path: `${output}/conteo-por-confirmar-${width}.png`,
        fullPage: true,
      })
      await missingDialog()
        .getByRole('button', { name: 'Verificar guardado', exact: true })
        .click()
      await openingDialog()
        .getByRole('button', { name: 'Guardar costo inicial', exact: true })
        .waitFor()
      equal(payloads.length, 2)
      equal(
        payloads[0],
        payloads[1],
        'El reintento conserva el identificador y todos los datos del conteo',
      )
      equal(Object.hasOwn(payloads[0], 'expectedQuantity'), true)
      equal(payloads[0].expectedQuantity, null)
      equal(
        (await counts(3)).movements,
        1,
        'La respuesta perdida no duplica el conteo',
      )
      await page.unroute(
        '**/rest/v1/rpc/record_inventory_movement',
        loseResponse,
      )
      const audit = await one(
        'select before_quantity,after_quantity,quantity,type,note from public.inventory_movements where product_id=$1',
        [productId(3)],
      )
      equal(audit.before_quantity, null)
      equal(audit.after_quantity, 0)
      equal(audit.quantity, 0)
      equal(audit.type, 'ADJUSTMENT')
      equal(audit.note.includes('Bodega'), true)

      // El conteo es una operación real independiente; cancelar el costo no lo
      // deshace, pero tampoco afirma haber registrado un costo que no existe.
      await openingDialog()
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      const countedOnly = await counts(3)
      equal(countedOnly.warehouse, 0)
      equal(countedOnly.cost, null)
      equal(countedOnly.openings, 0)
      await page
        .getByText('Existencias actualizadas.', { exact: true })
        .waitFor()
      await openCost()
      await saveOpening(3)

      // La misma acción funciona a la inversa, sin inventar existencias.
      await edit(4)
      await openCost()
      await confirmEmpty('Tienda')
      await saveOpening(4)
      equal((await counts(4)).store, 0)
      equal((await counts(4)).warehouse, 5)
      equal((await counts(4)).movements, 1)

      // Con ambas ubicaciones pendientes, confirmar una no cuenta la otra.
      await edit(5)
      await openCost()
      await missingDialog()
        .getByRole('button', { name: 'Registrar Tienda en 0', exact: true })
        .waitFor()
      equal((await counts(5)).store, null)
      equal((await counts(5)).warehouse, null)
      await confirmEmpty('Bodega')
      await missingDialog()
        .getByRole('button', { name: 'Registrar Tienda en 0', exact: true })
        .waitFor()
      equal((await counts(5)).warehouse, 0)
      equal((await counts(5)).store, null)
      equal((await counts(5)).cost, null)
      await page.screenshot({
        path: `${output}/ubicacion-pendiente-${width}.png`,
        fullPage: true,
      })
      await missingDialog()
        .getByRole('button', { name: 'Registrar conteo', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Editar perfume', exact: true })
        .waitFor()
      equal(new URL(page.url()).pathname, `/products/${productId(5)}/edit`)
      await page.locator('#cantidades-perfume').waitFor()
      equal(await page.getByRole('dialog').count(), 0)
      equal(new URL(page.url()).searchParams.get('countLocation'), 'store')
      equal(new URL(page.url()).hash, '#cantidades-perfume')
      equal(
        await page
          .getByLabel('Ubicación de las cantidades', { exact: true })
          .inputValue(),
        'store',
      )

      // Desde una entrada de inventario no existe la sección del editor:
      // «Registrar conteo» debe abrir el perfume en lugar de quedarse detenido.
      await page
        .getByRole('link', { name: 'Volver al inventario', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      await page.getByRole('button', { name: 'Entrada', exact: true }).click()
      const entry = page.getByRole('dialog', {
        name: 'Entrada de inventario',
        exact: true,
      })
      await entry
        .getByRole('button', { name: /Producto del movimiento/ })
        .click()
      await page
        .getByRole('combobox', {
          name: 'Buscar perfume: Producto del movimiento',
          exact: true,
        })
        .fill('QA-0005')
      await page.getByRole('option').first().click()
      await entry.getByLabel('Cantidad', { exact: true }).fill('2')
      await entry
        .getByLabel('Motivo', { exact: true })
        .fill('Compra pendiente de conteo físico')
      await entry
        .getByRole('button', { name: 'Continuar con la compra', exact: true })
        .click()
      await missingDialog()
        .getByRole('button', { name: 'Registrar conteo', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Editar perfume', exact: true })
        .waitFor()
      equal(
        new URL(page.url()).pathname,
        `/products/${productId(5)}/edit`,
        'La entrada permite ir al editor para contar unidades reales',
      )
      equal(await page.getByRole('dialog').count(), 0)
      equal(
        (await counts(5)).movements,
        1,
        'Navegar al conteo no registra una entrada ni vuelve a guardar el cero',
      )
      equal(new URL(page.url()).searchParams.get('countLocation'), 'store')
      equal(
        await page
          .getByLabel('Ubicación de las cantidades', { exact: true })
          .inputValue(),
        'store',
      )

      // Otro administrador cuenta siete mientras este cuadro aún ofrece cero.
      await edit(6)
      await openCost()
      await missingDialog()
        .getByRole('button', { name: 'Registrar conteo', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Editar perfume', exact: true })
        .waitFor()
      equal(new URL(page.url()).searchParams.get('countLocation'), 'warehouse')
      equal(new URL(page.url()).hash, '#cantidades-perfume')
      const countLocation = page.getByLabel('Ubicación de las cantidades', {
        exact: true,
      })
      equal(
        await countLocation.inputValue(),
        'warehouse',
        'Dirige el conteo a Bodega, la ubicación pendiente',
      )
      await countLocation.selectOption('store')
      equal(
        await countLocation.inputValue(),
        'store',
        'La ubicación sugerida se puede cambiar manualmente',
      )
      await countLocation.selectOption('warehouse')
      equal(await countLocation.inputValue(), 'warehouse')
      equal(
        (await counts(6)).warehouse,
        null,
        'Ir al formulario no cuenta unidades automáticamente',
      )
      await openCost()
      await missingDialog()
        .getByRole('button', { name: 'Registrar Bodega en 0', exact: true })
        .click()
      confirm = page.getByRole('dialog', {
        name: 'Confirmar ubicación vacía',
        exact: true,
      })
      await rpc('record_inventory_movement', {
        requestId: crypto.randomUUID(),
        productId: productId(6),
        location: 'warehouse',
        type: 'ADJUSTMENT',
        quantity: 7,
        expectedQuantity: null,
        note: 'Conteo concurrente confirmado por otra persona',
      })
      await confirm
        .getByRole('button', { name: 'Registrar en 0', exact: true })
        .click()
      await missingDialog()
        .getByRole('button', { name: 'Actualizar existencias', exact: true })
        .waitFor()
      const conflict = fixture.failures.at(-1)
      equal(
        /record_inventory_movement.*Las existencias cambiaron/.test(conflict),
        true,
      )
      expectedFailures.push(conflict)
      equal(
        (await counts(6)).warehouse,
        7,
        'Nunca sustituye por cero el conteo nuevo de otra persona',
      )
      equal((await counts(6)).movements, 1)
      equal((await counts(6)).openings, 0)
      await missingDialog()
        .getByRole('button', { name: 'Actualizar existencias', exact: true })
        .click()
      await openingDialog()
        .getByText('12 unidades contadas en tienda y bodega.', { exact: true })
        .waitFor()
      await openingDialog()
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()

      // Si ya existía un costo, confirmar el cero abre la compra; el promedio
      // considera sólo las cinco unidades existentes y las cinco compradas.
      await edit(7)
      await openCost()
      await confirmEmpty('Bodega')
      const purchase = page.getByRole('dialog', {
        name: 'Registrar compra',
        exact: true,
      })
      await purchase
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .waitFor()
      equal((await counts(7)).cost, 100)
      equal((await counts(7)).openings, 0)
      await purchase
        .getByLabel('Proveedor', { exact: true })
        .fill('Proveedor de costos verificado')
      await purchase
        .getByLabel('Factura o referencia', { exact: true })
        .fill('COSTO-PROM-02')
      await purchase.getByLabel('Pago', { exact: true }).selectOption('credito')
      await purchase.getByLabel('Unidades', { exact: true }).fill('5')
      await purchase
        .getByLabel('Costo por unidad (C$)', { exact: true })
        .fill('200')
      await purchase
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      await purchase.waitFor({ state: 'hidden' })
      equal((await counts(7)).cost, 150, '(5×100 + 5×200) / 10 = 150')
      equal((await counts(7)).store, 5)
      equal((await counts(7)).warehouse, 5)
      await healthy('Costo con una ubicación vacía')
      await page.screenshot({
        path: `${output}/costo-promedio-${width}.png`,
        fullPage: true,
      })
      results.push({ width, status: 'correcto', checks })
      console.log(
        `PASS costos ${width}px: cero conocido, confirmación explícita, cancelaciones, idempotencia, conteo concurrente y promedio real`,
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
  console.log(`Costo por ubicación: ${checks} comprobaciones correctas.`)
} finally {
  await browser.close()
  await server?.close()
}

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
import { identity, admin } from './database-fixture.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) ||
    new URL(base).origin === 'https://lcp-control.pages.dev',
)
// Incluso con el frontend publicado, browserDatabase intercepta la API y
// ejecuta cada escritura exclusivamente en PostgreSQL local desechable.
const output = process.env.LCP_TEST_OUTPUT ?? 'output/first-use-audit'
await mkdir(output, { recursive: true })
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
const results = []
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      isMobile: width < 500,
      hasTouch: width < 500,
      timezoneId: 'America/Managua',
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.setDefaultTimeout(15000)
    const fixture = await browserDatabase(page)
    const one = async (sql, parameters = []) =>
      (await fixture.db.query(sql, parameters)).rows[0]
    const navigate = async (path) => {
      await page.evaluate((target) => {
        globalThis.history.pushState({}, '', target)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      await page
        .locator('.main-content h1,.main-content .state')
        .first()
        .waitFor()
    }
    const healthy = async (label) => {
      equal(errors, [], label + ': errores de ejecución')
      equal(fixture.failures, [], label + ': API')
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        label + ': sin desbordamiento',
      )
      for (const dialog of await page.getByRole('dialog').all())
        equal(
          await dialog.evaluate(
            (element) => element.scrollWidth > element.clientWidth + 1,
          ),
          false,
          label + ': diálogo dentro de pantalla',
        )
    }
    const warnsReload = () =>
      page.evaluate(() => {
        const event = new globalThis.Event('beforeunload', { cancelable: true })
        globalThis.dispatchEvent(event)
        return event.defaultPrevented
      })
    const openProduct = async (id = productId) => {
      await navigate('/products/' + id + '/edit')
      await page.getByLabel('Nombre del perfume', { exact: true }).waitFor()
    }
    try {
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

      // Editar y abrir/cancelar costo no deben dejar falsos cambios pendientes.
      await openProduct()
      equal(await warnsReload(), false, 'perfume sin cambios')
      await page
        .getByRole('button', { name: 'Costo de inventario', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      equal(await warnsReload(), false, 'cancelar costo no modifica perfume')
      const nameInput = page.getByLabel('Nombre del perfume', { exact: true })
      const original = await nameInput.inputValue()
      const changed = `Perfume corregido ${width}`
      await nameInput.fill(changed)
      equal(
        await warnsReload(),
        true,
        'avisa antes de recargar edición pendiente',
      )
      equal(
        await page
          .getByRole('button', { name: 'Costo de inventario', exact: true })
          .isDisabled(),
        true,
        'costo espera guardar los datos del perfume',
      )
      await page
        .getByRole('link', { name: 'Volver al inventario', exact: true })
        .click()
      let dialog = page.getByRole('dialog')
      await dialog
        .getByRole('heading', { name: 'Cambios sin guardar', exact: true })
        .waitFor()
      await healthy('confirmación de salida ' + width)
      await page.screenshot({
        path: `${output}/salida-edicion-${width}.png`,
        fullPage: false,
      })
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      equal(
        await nameInput.inputValue(),
        changed,
        'cancelar salida conserva texto',
      )
      equal(
        new URL(page.url()).pathname,
        '/products/' + productId + '/edit',
        'cancelar conserva ruta',
      )
      await nameInput.fill(original)
      equal(await warnsReload(), false, 'deshacer modificación elimina aviso')
      await nameInput.fill(changed)
      await page
        .getByRole('link', { name: 'Volver al inventario', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Salir sin guardar', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      equal(
        (await one('select name from public.products where id=$1', [productId]))
          .name,
        original,
        'descartar no escribe datos parciales',
      )

      // Primera alta: avisos al lado del dato y la información escrita se conserva.
      await navigate('/products/new')
      await page
        .getByRole('button', { name: 'Guardar perfume', exact: true })
        .click()
      await page
        .getByRole('alert')
        .filter({ hasText: 'Revisa los campos marcados' })
        .waitFor()
      equal(
        await page
          .getByLabel('Nombre del perfume', { exact: true })
          .getAttribute('aria-invalid'),
        'true',
      )
      const newName = `Perfume nuevo con conexión interrumpida ${width}`
      await page.getByLabel('Nombre del perfume', { exact: true }).fill(newName)
      await page.getByLabel('Marca', { exact: true }).fill('Marca nueva')
      for (const label of ['Emprendedor USD', 'VIP USD', 'Premium USD'])
        await page.getByLabel(label, { exact: true }).fill('10')
      await page
        .getByLabel('Código del fabricante (EAN / UPC)', { exact: true })
        .fill('123')
      await page
        .getByRole('button', { name: 'Guardar perfume', exact: true })
        .click()
      equal(
        await page
          .getByLabel('Código del fabricante (EAN / UPC)', { exact: true })
          .getAttribute('aria-invalid'),
        'true',
      )
      equal(
        await page
          .getByLabel('Nombre del perfume', { exact: true })
          .inputValue(),
        newName,
      )
      await page
        .getByLabel('Código del fabricante (EAN / UPC)', { exact: true })
        .fill('1234567890128')
      equal(
        await page.locator('[aria-invalid="true"]').count(),
        0,
        'corregir datos retira avisos',
      )

      // El servidor guarda y la conexión cae también durante la comprobación.
      // Un segundo Guardar recupera el mismo UUID, sin duplicar ni quedar atrapado.
      let lost = false
      let offline = false
      const payloads = []
      const lostSave = async (route) => {
        const payload = route.request().postDataJSON().p_payload
        payloads.push(payload)
        if (lost) return route.fallback()
        lost = true
        offline = true
        await fixture.db.query(
          'select public.save_catalog_product($1::jsonb)',
          [JSON.stringify(payload)],
        )
        await route.abort('failed')
      }
      const offlineRead = async (route) =>
        offline ? route.abort('failed') : route.fallback()
      await page.route('**/rest/v1/products?*', offlineRead)
      await page.route('**/rest/v1/rpc/save_catalog_product', lostSave)
      await page
        .getByRole('button', { name: 'Guardar perfume', exact: true })
        .click()
      await page.getByRole('alert').last().waitFor()
      equal(
        (
          await one(
            'select count(*)::int n from public.products where name=$1',
            [newName],
          )
        ).n,
        1,
      )
      equal(
        await page
          .getByLabel('Nombre del perfume', { exact: true })
          .inputValue(),
        newName,
      )
      offline = false
      await page
        .getByRole('button', { name: 'Guardar perfume', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Editar perfume', exact: true })
        .waitFor()
      equal(
        new URL(page.url()).pathname,
        '/products/' + payloads[0].id + '/edit',
        'recupera perfume guardado tras reintento',
      )
      equal(payloads.length, 2, 'dos intentos explícitos')
      equal(payloads[0].id, payloads[1].id, 'conserva UUID')
      equal(
        (
          await one(
            'select count(*)::int n from public.products where name=$1',
            [newName],
          )
        ).n,
        1,
        'sin perfume duplicado',
      )
      equal(
        fixture.failures.splice(0),
        [
          '/rest/v1/rpc/save_catalog_product: Otro usuario cambió este perfume. Vuelve a abrirlo antes de guardar.',
        ],
        'conflicto recuperado comprobando datos, no reescribiendo',
      )
      await page.unroute('**/rest/v1/rpc/save_catalog_product', lostSave)
      await page.unroute('**/rest/v1/products?*', offlineRead)
      equal(await warnsReload(), false, 'el alta confirmada queda limpia')
      await healthy('alta recuperada ' + width)

      // En edición normal la respuesta perdida se reconcilia sin un segundo clic.
      await page
        .getByLabel('Nombre del perfume', { exact: true })
        .fill(newName + ' revisado')
      let edited = false
      const lostEdit = async (route) => {
        if (edited) return route.fallback()
        edited = true
        await fixture.db.query(
          'select public.save_catalog_product($1::jsonb)',
          [JSON.stringify(route.request().postDataJSON().p_payload)],
        )
        await route.abort('failed')
      }
      await page.route('**/rest/v1/rpc/save_catalog_product', lostEdit)
      await page
        .getByRole('button', { name: 'Guardar perfume', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      equal(
        (
          await one('select name from public.products where id=$1', [
            payloads[0].id,
          ])
        ).name,
        newName + ' revisado',
      )
      await page.unroute('**/rest/v1/rpc/save_catalog_product', lostEdit)
      await healthy('edición recuperada ' + width)

      // Otra persona cambia realmente el registro: no se oculta el conflicto ni
      // se confunde con nuestra respuesta perdida, y no se pierden datos locales.
      await openProduct()
      await page
        .getByLabel('Nombre del perfume', { exact: true })
        .fill('Edición local que debe conservarse')
      const current = (
        await fixture.db.query(
          'select name,revision from public.products where id=$1',
          [productId],
        )
      ).rows[0]
      await fixture.db.exec('reset role')
      await fixture.db.query(
        'update public.products set name=$2,revision=revision+1 where id=$1',
        [productId, original + ' concurrente'],
      )
      await identity(fixture.db, admin)
      await page
        .getByRole('button', { name: 'Guardar perfume', exact: true })
        .click()
      await page
        .getByRole('alert')
        .filter({ hasText: 'Otro usuario cambió este perfume' })
        .waitFor()
      equal(
        await page
          .getByLabel('Nombre del perfume', { exact: true })
          .inputValue(),
        'Edición local que debe conservarse',
      )
      equal(
        (await one('select name from public.products where id=$1', [productId]))
          .name,
        current.name + ' concurrente',
        'no sobrescribe edición ajena',
      )
      equal(fixture.failures.splice(0), [
        '/rest/v1/rpc/save_catalog_product: Otro usuario cambió este perfume. Vuelve a abrirlo antes de guardar.',
      ])
      await page.screenshot({
        path: `${output}/conflicto-edicion-${width}.png`,
        fullPage: false,
      })
      await page
        .getByRole('link', { name: 'Volver al inventario', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Salir sin guardar', exact: true })
        .click()

      // Cantidades equivocadas no llegan al servidor y se corrigen en el mismo formulario.
      await page.getByRole('button', { name: 'Salida', exact: true }).click()
      dialog = page.getByRole('dialog')
      await dialog
        .getByRole('button', { name: /Producto del movimiento/ })
        .click()
      await dialog.getByPlaceholder('Nombre, marca o código…').fill('QA-0001')
      await dialog.getByRole('option').first().click()
      await dialog.getByLabel('Cantidad', { exact: true }).fill('21')
      await dialog
        .getByLabel('Motivo', { exact: true })
        .fill('Cantidad escrita por error')
      await dialog
        .getByRole('button', { name: 'Confirmar movimiento', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'Solo hay 20 unidades en Tienda' })
        .waitFor()
      equal(
        await dialog.getByLabel('Cantidad', { exact: true }).inputValue(),
        '21',
      )
      equal(
        (await one('select count(*)::int n from public.inventory_movements')).n,
        0,
      )
      await dialog.getByLabel('Cantidad', { exact: true }).fill('1')
      await dialog
        .getByRole('button', { name: 'Confirmar movimiento', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      equal(
        (
          await one(
            "select quantity from public.inventory_balances where product_id=$1 and location='store'",
            [productId],
          )
        ).quantity,
        19,
      )
      equal(
        (await one('select count(*)::int n from public.inventory_movements')).n,
        1,
      )
      await healthy('cantidad corregida ' + width)

      // Un perfume contado y con precio, pero sin costo, no debe producir una
      // factura con contabilidad pendiente. El rechazo permite corregir el
      // costo por otro administrador sin volver a armar la venta.
      await fixture.db.exec('reset role')
      await fixture.db.query(
        'delete from public.product_costs where product_id=$1',
        [productId],
      )
      await identity(fixture.db, admin)
      await fixture.db.query('select public.open_business_day($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          openingNio: 1000,
          openingUsd: 0,
          expectedDay: fixture.today,
        }),
      ])
      await navigate('/sales')
      const details = page.locator('.document-customer-panel details')
      await details.waitFor()
      if (!(await details.evaluate((element) => element.open)))
        await details.locator('summary').click()
      await page
        .getByLabel('Cliente', { exact: true })
        .fill('Cliente con costo por completar')
      await page
        .getByLabel('Forma de pago', { exact: true })
        .selectOption('cash')
      await page
        .getByLabel('Buscar en catálogo', { exact: true })
        .fill('QA-0001')
      await page
        .getByRole('button', { name: /^Agregar Lattafa/ })
        .first()
        .click()
      await page
        .getByRole('button', { name: 'Emitir factura', exact: true })
        .click()
      await page
        .getByRole('alert')
        .filter({ hasText: 'Falta registrar el costo' })
        .waitFor()
      equal(
        await page.locator('.invoice-line').count(),
        1,
        'el rechazo conserva productos',
      )
      equal(
        await page.getByLabel('Cliente', { exact: true }).inputValue(),
        'Cliente con costo por completar',
      )
      equal(
        await page
          .getByRole('button', { name: 'Reintentar emisión', exact: true })
          .count(),
        0,
        'costo faltante es corregible y no emisión incierta',
      )
      equal(
        (
          await one(
            "select count(*)::int n from public.documents where kind='invoice'",
          )
        ).n,
        0,
      )
      equal(
        (
          await one(
            "select count(*)::int n from public.inventory_movements where type='SALE'",
          )
        ).n,
        0,
      )
      equal(
        (
          await one(
            "select quantity from public.inventory_balances where product_id=$1 and location='store'",
            [productId],
          )
        ).quantity,
        19,
      )
      equal(
        fixture.failures.length,
        1,
        'un rechazo explícito de costo faltante',
      )
      assert.match(
        fixture.failures.splice(0)[0],
        /Falta registrar el costo.*Inventario → Editar → Costo de inventario/,
      )
      checks++
      await page.screenshot({
        path: `${output}/costo-pendiente-${width}.png`,
        fullPage: false,
      })
      await fixture.db.exec('reset role')
      await fixture.db.query(
        'insert into public.product_costs(product_id,average_cost_nio) values($1,100)',
        [productId],
      )
      await identity(fixture.db, admin)
      await page
        .getByRole('button', { name: 'Emitir factura', exact: true })
        .click()
      await page
        .getByRole('status')
        .filter({ hasText: 'Factura FAC-' })
        .waitFor()
      equal(
        (
          await one(
            "select count(*)::int n from public.documents where kind='invoice'",
          )
        ).n,
        1,
      )
      equal(
        (
          await one(
            "select count(*)::int n from public.inventory_movements where type='SALE'",
          )
        ).n,
        1,
      )
      equal(
        (
          await one(
            "select quantity from public.inventory_balances where product_id=$1 and location='store'",
            [productId],
          )
        ).quantity,
        18,
      )
      equal(
        Number(
          (
            await one(
              'select sum(quantity*unit_cost_nio) n from public.document_item_costs',
            )
          ).n,
        ),
        100,
        'la venta recuperada guarda su costo contable',
      )
      await healthy('corregir costo y reemitir ' + width)

      // La misma persona con otro rol sólo puede entrar en las áreas de su
      // trabajo. Cambiar de ruta a mano tampoco debe abrir una pantalla ajena.
      const routes = [
        [
          '/inventory',
          'Inventario',
          ['superadmin', 'admin', 'warehouse', 'viewer'],
        ],
        ['/sales', 'Facturación', ['superadmin', 'admin', 'operator']],
        ['/products/new', 'Nuevo perfume', ['superadmin', 'admin']],
        ['/suppliers', 'Proveedores', ['superadmin', 'admin', 'warehouse']],
        ['/accounting', 'Contabilidad', ['superadmin', 'admin']],
      ]
      for (const role of [
        'admin',
        'warehouse',
        'viewer',
        'operator',
        'superadmin',
      ]) {
        await fixture.db.exec('reset role')
        await fixture.db.query(
          'update public.staff_members set role=$2 where user_id=$1',
          [admin, role],
        )
        await identity(fixture.db, admin)
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
        await page
          .getByRole('heading', { name: 'Inicio', exact: true })
          .waitFor()
        for (const [path, title, allowed] of routes) {
          await navigate(path)
          if (allowed.includes(role)) {
            await page
              .getByRole('heading', { name: title, exact: true })
              .waitFor()
            equal(
              await page
                .getByText('No tienes permiso para esta pantalla.', {
                  exact: true,
                })
                .count(),
              0,
              `${role} puede entrar a ${path}`,
            )
            if (role === 'operator' && path === '/sales') {
              const otherProduct = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'
              await fixture.db.exec('reset role')
              await fixture.db.query(
                'delete from public.product_costs where product_id=$1',
                [otherProduct],
              )
              await identity(fixture.db, admin)
              const customerDetails = page.locator(
                '.document-customer-panel details',
              )
              if (!(await customerDetails.evaluate((element) => element.open)))
                await customerDetails.locator('summary').click()
              const costReads = []
              const inspectRead = (request) => {
                if (/product_costs|product_pricing/.test(request.url()))
                  costReads.push(request.url())
              }
              page.on('request', inspectRead)
              await page
                .getByLabel('Cliente', { exact: true })
                .fill('Venta de caja sin costo')
              await page
                .getByLabel('Buscar en catálogo', { exact: true })
                .fill('QA-0002')
              await page
                .getByRole('button', { name: /^Agregar Lattafa/ })
                .first()
                .click()
              await page
                .getByRole('button', { name: 'Emitir factura', exact: true })
                .click()
              await page
                .getByRole('alert')
                .filter({ hasText: 'Falta registrar el costo' })
                .waitFor()
              equal(
                await page.locator('.invoice-line').count(),
                1,
                'Caja conserva venta rechazada',
              )
              equal(
                await page.getByLabel('Cliente', { exact: true }).inputValue(),
                'Venta de caja sin costo',
              )
              equal(
                costReads,
                [],
                'Caja no consulta costos ni porcentajes para explicar el rechazo',
              )
              equal(
                await page
                  .locator('.product-stock-editor,.product-prices')
                  .count(),
                0,
                'Caja no recibe edición de costo',
              )
              equal(fixture.failures.length, 1)
              assert.match(
                fixture.failures.splice(0)[0],
                /Falta registrar el costo/,
              )
              checks++
              page.off('request', inspectRead)
              await page.screenshot({
                path: `${output}/caja-costo-pendiente-${width}.png`,
                fullPage: false,
              })
              await page
                .getByRole('button', { name: 'Nueva factura', exact: true })
                .click()
              await page
                .getByRole('dialog')
                .getByRole('button', { name: 'Descartar cambios', exact: true })
                .click()
            }
          } else {
            await page
              .getByText(/No tienes permiso|Tu cuenta no tiene/)
              .first()
              .waitFor()
            equal(
              await page
                .locator(
                  '.picker-product,.catalog-product,.product-editor,.accounting-tabs',
                )
                .count(),
              0,
              `${role} no recibe controles de ${path}`,
            )
          }
          await healthy(`rol ${role} ${path} ${width}`)
        }
      }
      results.push({ width, status: 'passed', checks })
      console.log(
        `PASS primer uso ${width}px: validaciones con corrección, salida protegida, costo sin falsos avisos, altas/ediciones con respuesta perdida sin duplicar, conflicto real conservado, cantidades corregidas en el formulario`,
      )
    } catch (error) {
      await page.screenshot({
        path: `${output}/fallo-${width}.png`,
        fullPage: true,
      })
      console.error(
        'URL',
        page.url(),
        'API',
        fixture.failures,
        'UI',
        (await page.locator('body').innerText()).slice(-3500),
      )
      throw error
    } finally {
      await context.close()
      await fixture.close()
    }
  }
} finally {
  await browser.close()
}
await writeFile(
  `${output}/resultados.json`,
  JSON.stringify(
    { checks, results, frontend: base, productionWrites: false },
    null,
    2,
  ),
)
console.log(`OK: ${checks} comprobaciones de primer uso y errores humanos`)

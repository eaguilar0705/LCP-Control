import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { browserDatabase } from './browser-database.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
const output = 'output/revision-entrega-final'
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let checks = 0
const equal = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
}
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      timezoneId: 'America/Managua',
    })
    const page = await context.newPage()
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'canShare', {
        value: () => false,
        configurable: true,
      })
    })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.setDefaultTimeout(15000)
    const fixture = await browserDatabase(page)
    const one = async (sql, params = []) =>
      (await fixture.db.query(sql, params)).rows[0]
    const navigate = async (path) => {
      await page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      await page.locator('.main-content h1').first().waitFor()
    }
    const healthy = async (name) => {
      equal(errors, [], name + ': ejecución del navegador')
      equal(fixture.failures, [], name + ': API')
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        name + ': sin desbordamiento horizontal',
      )
      for (const dialog of await page.getByRole('dialog').all())
        equal(
          await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
          false,
          name + ': diálogo sin desbordamiento',
        )
    }
    try {
      await fixture.db.query('select public.open_business_day($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          openingNio: 1000,
          openingUsd: 0,
          expectedDay: fixture.today,
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

      // Atrás/Adelante y el cambio entre directorios no deben convertir un
      // formulario de cliente abierto en un formulario de proveedor.
      await navigate('/customers')
      await page
        .getByRole('button', { name: 'Nuevo cliente', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByLabel('Nombre', { exact: true })
        .fill('Cliente sin guardar')
      await navigate('/suppliers')
      await page
        .getByRole('heading', { name: 'Proveedores', exact: true })
        .waitFor()
      equal(
        await page.getByRole('dialog').count(),
        0,
        'no conserva el formulario del otro directorio',
      )
      await page
        .getByRole('button', { name: 'Nuevo proveedor', exact: true })
        .click()
      equal(
        await page
          .getByRole('dialog')
          .getByLabel('Nombre', { exact: true })
          .inputValue(),
        '',
        'proveedor nuevo sin datos del cliente',
      )
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      await page.goBack()
      await page
        .getByRole('heading', { name: 'Clientes', exact: true })
        .waitFor()
      equal(
        await page.getByRole('dialog').count(),
        0,
        'volver atrás no cambia el tipo de contacto',
      )

      // Simula un guardado confirmado por PostgreSQL cuya respuesta se pierde.
      // El reintento del mismo formulario no debe crear otro contacto.
      for (const [kind, noun, rpc] of [
        ['customers', 'cliente', 'save_customer'],
        ['suppliers', 'proveedor', 'save_supplier'],
      ]) {
        await navigate('/' + kind)
        await page
          .getByRole('button', { name: 'Nuevo ' + noun, exact: true })
          .click()
        let dialog = page.getByRole('dialog')
        const name = `Registro con respuesta perdida ${noun} ${width}`
        await dialog.getByLabel('Nombre', { exact: true }).fill(name)
        await dialog
          .getByLabel('RUC', { exact: true })
          .fill('AUDITORIA-' + width)
        let lost = false
        let recovering = false
        const submitted = []
        const intercept = async (route) => {
          if (lost) return route.fallback()
          lost = true
          recovering = true
          const body = route.request().postDataJSON()
          submitted.push(body.p_payload)
          await fixture.db.query(`select public.${rpc}($1::jsonb)`, [
            JSON.stringify(body.p_payload),
          ])
          await route.abort('failed')
        }
        // Además del primer fallo, el primer intento de comprobar los datos no
        // tiene conexión. Hay que poder pulsar Guardar de nuevo de forma segura.
        const blockRead = async (route) => {
          if (recovering) return route.abort('failed')
          return route.fallback()
        }
        await page.route(`**/rest/v1/${kind}?*`, blockRead)
        await page.route(`**/rest/v1/rpc/${rpc}`, intercept)
        await dialog
          .getByRole('button', { name: 'Guardar', exact: true })
          .click()
        await dialog.getByRole('alert').waitFor()
        equal(
          (
            await one(
              `select count(*)::int n from public.${kind} where name=$1`,
              [name],
            )
          ).n,
          1,
          'primer guardado real',
        )
        recovering = false
        await page.unroute(`**/rest/v1/${kind}?*`, blockRead)
        await page.unroute(`**/rest/v1/rpc/${rpc}`, intercept)
        await dialog
          .getByRole('button', { name: 'Guardar', exact: true })
          .click()
        await dialog.waitFor({ state: 'hidden' })
        equal(
          fixture.failures.splice(0),
          [
            `/rest/v1/rpc/${rpc}: Otro usuario modificó este ${noun}. Vuelve a abrirlo.`,
          ],
          'la revisión anterior no vuelve a escribir el registro confirmado',
        )
        equal(
          (
            await one(
              `select count(*)::int n from public.${kind} where name=$1`,
              [name],
            )
          ).n,
          1,
          'reintento sin contacto duplicado',
        )
        await page
          .getByRole('button', { name: 'Editar ' + name, exact: true })
          .click()
        dialog = page.getByRole('dialog')
        await dialog
          .getByLabel('Notas', { exact: true })
          .fill('Datos confirmados después del reintento')
        await dialog
          .getByRole('button', { name: 'Guardar', exact: true })
          .click()
        await dialog.waitFor({ state: 'hidden' })
        equal(
          (await one(`select notes from public.${kind} where name=$1`, [name]))
            .notes,
          'Datos confirmados después del reintento',
        )
        await page
          .getByRole('button', { name: 'Editar ' + name, exact: true })
          .click()
        await dialog
          .getByLabel('Notas', { exact: true })
          .fill('Edición local pendiente')
        const revision = (
          await one(`select revision from public.${kind} where name=$1`, [name])
        ).revision
        await fixture.db.query(`select public.${rpc}($1::jsonb)`, [
          JSON.stringify({
            ...submitted[0],
            revision,
            notes: 'Edición concurrente que se debe conservar',
          }),
        ])
        await dialog
          .getByRole('button', { name: 'Guardar', exact: true })
          .click()
        await dialog
          .getByRole('alert')
          .filter({ hasText: 'Otro usuario modificó' })
          .waitFor()
        equal(
          (await one(`select notes from public.${kind} where name=$1`, [name]))
            .notes,
          'Edición concurrente que se debe conservar',
          'no oculta ni sobrescribe un cambio concurrente',
        )
        equal(
          fixture.failures.splice(0),
          [
            `/rest/v1/rpc/${rpc}: Otro usuario modificó este ${noun}. Vuelve a abrirlo.`,
          ],
          'conflicto esperado de la edición concurrente',
        )
        await dialog
          .getByRole('button', { name: 'Cancelar', exact: true })
          .click()
        await dialog.waitFor({ state: 'hidden' })
        await healthy(`contacto ${noun} ${width}`)
      }

      // El lector manual integrado conserva la pantalla y filtra el inventario.
      await navigate('/inventory')
      await page.getByRole('button', { name: 'Escanear', exact: true }).click()
      let dialog = page.getByRole('dialog')
      await dialog
        .getByLabel('Código de barras o etiqueta', { exact: true })
        .fill('QA-0001')
      await dialog
        .getByRole('button', { name: 'Buscar código', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      equal(
        await page.getByLabel('Buscar producto', { exact: true }).inputValue(),
        'QA-0001',
      )
      await healthy('buscar con lector manual')

      // Datos, lista de precios y existencias se editan sin confundir costo con precio.
      await navigate(`/products/${productId}/edit`)
      await page
        .getByLabel('Nombre del perfume', { exact: true })
        .fill('Oriental edición revisada para entrega')
      await page.getByLabel('Precio de compra', { exact: true }).fill('8')
      await page
        .getByLabel('% de ganancia · Emprendedor', { exact: true })
        .fill('50')
      await page.getByLabel('VIP USD', { exact: true }).fill('11')
      await page.getByLabel('Premium USD', { exact: true }).fill('10')
      await page
        .getByRole('button', { name: 'Guardar perfume', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Inventario', exact: true })
        .waitFor()
      equal(
        (await one('select name from public.products where id=$1', [productId]))
          .name,
        'Oriental edición revisada para entrega',
      )
      equal(
        Number(
          (
            await one(
              "select amount from public.product_prices where product_id=$1 and tier_code='emprendedor' and currency='USD'",
              [productId],
            )
          ).amount,
        ),
        12,
      )
      equal(
        Number(
          (
            await one(
              'select average_cost_nio from public.product_costs where product_id=$1',
              [productId],
            )
          ).average_cost_nio,
        ),
        100,
        'precio de compra no cambia costo contable',
      )
      await navigate(`/products/${productId}/edit`)
      const stock = page.locator('.product-stock-editor')
      await stock
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      equal(
        await dialog.getByLabel('Entra a', { exact: true }).inputValue(),
        'store',
        'la compra conserva la ubicación seleccionada',
      )
      await dialog.getByLabel('Unidades', { exact: true }).fill('3')
      await dialog
        .getByLabel('Costo por unidad (C$)', { exact: true })
        .fill('100')
      await dialog
        .getByLabel('Factura o referencia', { exact: true })
        .fill(`INGRESO-${width}`)
      await dialog
        .getByRole('button', { name: 'Registrar compra', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      await page
        .getByRole('button', { name: 'Costo de inventario', exact: true })
        .waitFor()
      await stock
        .getByLabel('Ubicación de las cantidades', { exact: true })
        .waitFor()
      equal(
        (
          await one(
            "select quantity from public.inventory_balances where product_id=$1 and location='store'",
            [productId],
          )
        ).quantity,
        23,
      )
      await stock
        .getByLabel('Cómo cambiar las cantidades', { exact: true })
        .selectOption('EXIT')
      await stock.getByLabel('Unidades a mover', { exact: true }).fill('2')
      await stock
        .getByLabel('Motivo del cambio de cantidad', { exact: true })
        .fill('Salida auditada de dos unidades')
      await stock
        .getByRole('button', { name: 'Guardar cantidades', exact: true })
        .click()
      await stock.locator('p[role="status"]').waitFor()
      equal(
        (
          await one(
            "select quantity from public.inventory_balances where product_id=$1 and location='store'",
            [productId],
          )
        ).quantity,
        21,
      )
      await stock
        .getByLabel('Cómo cambiar las cantidades', { exact: true })
        .selectOption('ADJUSTMENT')
      await stock
        .getByLabel('Conteo total del perfume', { exact: true })
        .fill('20')
      await stock
        .getByLabel('Motivo del cambio de cantidad', { exact: true })
        .fill('Conteo físico auditado de veinte unidades')
      await stock
        .getByRole('button', { name: 'Guardar cantidades', exact: true })
        .click()
      await stock.locator('p[role="status"]').waitFor()
      equal(
        (
          await one(
            "select quantity from public.inventory_balances where product_id=$1 and location='store'",
            [productId],
          )
        ).quantity,
        20,
      )
      await healthy('edición de precios y conteos')
      equal(
        await stock
          .locator('input,select,button,.stock-preview')
          .evaluateAll((elements) =>
            elements
              .filter((element) => {
                const own = element.getBoundingClientRect()
                const card = element
                  .closest('.product-stock-editor')
                  .getBoundingClientRect()
                return own.left < card.left || own.right > card.right
              })
              .map(
                (element) =>
                  element.getAttribute('aria-label') ||
                  element.getAttribute('type') ||
                  element.tagName,
              ),
          ),
        [],
        'todos los controles de cantidades caben dentro de la tarjeta',
      )
      await stock.screenshot({
        path: `${output}/edicion-diaria-${width}.png`,
      })

      // Selector de movimientos con teclado: Escape cierra sólo la lista,
      // Enter elige el producto y conserva el diálogo de movimiento.
      await navigate('/inventory')
      await page.getByRole('button', { name: 'Dañado', exact: true }).click()
      dialog = page.getByRole('dialog')
      await dialog
        .getByRole('button', { name: /Producto del movimiento/ })
        .click()
      const search = dialog.locator('.product-select input[role="combobox"]')
      await search.fill('QA-0001')
      await search.press('Escape')
      equal(await dialog.count(), 1, 'Escape no cierra el diálogo padre')
      await dialog
        .getByRole('button', { name: /Producto del movimiento/ })
        .click()
      await search.fill('QA-0001')
      await search.press('Enter')
      await dialog.getByLabel('Cantidad', { exact: true }).fill('1')
      await dialog
        .getByLabel('Motivo', { exact: true })
        .fill('Frasco dañado en revisión diaria')
      await healthy('movimiento con teclado')
      await page.screenshot({
        path: `${output}/movimiento-diario-${width}.png`,
        fullPage: false,
      })
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
        (
          await one(
            'select count(*)::int n from public.inventory_movements where product_id=$1',
            [productId],
          )
        ).n,
        4,
      )
      await navigate('/accounting')
      for (const name of [
        'Balanza de comprobación',
        'Estado de resultado',
        'Estado de situación financiera',
        'Comprobantes',
      ]) {
        await page
          .getByRole('navigation', { name: 'Secciones de contabilidad' })
          .getByRole('button', { name, exact: true })
          .click()
        await healthy(`contabilidad después de ediciones: ${name}`)
      }
      await page.screenshot({
        path: `${output}/contabilidad-diaria-${width}.png`,
        fullPage: false,
      })
      // El precio confirmado en pantalla debe coincidir con la factura, incluso
      // si un administrador cambia la lista mientras se atiende al cliente.
      await navigate('/sales')
      await page
        .getByLabel('Cliente', { exact: true })
        .fill('Cliente revisión de precio')
      await page
        .getByLabel('Buscar en catálogo', { exact: true })
        .fill('QA-0001')
      await page
        .getByRole('button', { name: /^Agregar Lattafa/ })
        .first()
        .click()
      equal(await page.locator('.invoice-line').count(), 1)
      const shownTotal = await page.locator('.invoice-paper').innerText()
      assert.ok(
        shownTotal.includes('439.20'),
        'precio visible antes del cambio concurrente',
      )
      checks++
      await fixture.db.exec(`reset role;
        update public.product_prices set amount=400 where product_id='${productId}' and tier_code='emprendedor' and currency='NIO';
        set role authenticated;`)
      await page
        .getByRole('button', { name: 'Emitir factura', exact: true })
        .click()
      await page
        .getByRole('alert')
        .filter({ hasText: 'Los precios cambiaron' })
        .waitFor()
      equal(
        (
          await one(
            "select count(*)::int n from public.documents where kind='invoice'",
          )
        ).n,
        0,
        'no se emite por un total sorpresivo',
      )
      equal(
        (
          await one(
            "select quantity from public.inventory_balances where product_id=$1 and location='store'",
            [productId],
          )
        ).quantity,
        19,
        'rechazo de precio no descuenta',
      )
      equal(fixture.failures.splice(0), [
        '/rest/v1/rpc/create_document: Los precios cambiaron. Actualiza los precios de los productos y revisa el total antes de emitir.',
      ])
      await page
        .getByRole('button', { name: 'Actualizar precios', exact: true })
        .click()
      await page
        .getByRole('status')
        .filter({
          hasText: 'Precios actualizados. Revisa el total antes de emitir.',
        })
        .waitFor()
      assert.ok(
        (await page.locator('.invoice-paper').innerText()).includes('400.00'),
      )
      checks++
      await page
        .getByRole('button', { name: 'Emitir factura', exact: true })
        .click()
      await page.getByText('FAC-000001', { exact: true }).first().waitFor()
      equal(
        Number(
          (await one("select total from public.documents where kind='invoice'"))
            .total,
        ),
        400,
        'la factura coincide con el total actualizado',
      )
      equal(
        (
          await one(
            "select quantity from public.inventory_balances where product_id=$1 and location='store'",
            [productId],
          )
        ).quantity,
        18,
        'la venta correcta descuenta una sola vez',
      )
      await healthy('precio cambiado durante la venta')
      await page.screenshot({
        path: `${output}/factura-precio-revisado-${width}.png`,
        fullPage: false,
      })

      if (width === 1440) {
        await navigate('/proformas')
        await page
          .getByLabel('Cliente', { exact: true })
          .fill('Cliente proforma de cien perfumes')
        for (let index = 1; index <= 101; index++) {
          await page
            .getByLabel('Buscar en catálogo', { exact: true })
            .fill('QA-' + String(index).padStart(4, '0'))
          await page
            .getByRole('button', { name: /^Agregar Lattafa/ })
            .first()
            .click()
        }
        equal(
          await page.locator('.invoice-line').count(),
          100,
          'el carrito conserva cien renglones al intentar agregar el 101',
        )
        await page
          .getByRole('status')
          .filter({ hasText: 'Cada documento admite hasta 100 productos.' })
          .waitFor()
        await page
          .getByRole('button', { name: 'Emitir proforma', exact: true })
          .click()
        await page.getByText('PRO-000001', { exact: true }).first().waitFor()
        equal(
          (
            await one(
              "select count(*)::int n from public.document_items where document_id=(select id from public.documents where kind='proforma')",
            )
          ).n,
          100,
        )
        equal(
          Number(
            (
              await one(
                "select total from public.documents where kind='proforma'",
              )
            ).total,
          ),
          36634,
        )
        equal(
          (
            await one(
              "select quantity from public.inventory_balances where product_id=$1 and location='store'",
              [productId],
            )
          ).quantity,
          18,
          'cien productos cotizados no alteran existencias',
        )
        const download = page.waitForEvent('download')
        await page
          .getByRole('button', { name: 'Compartir PDF', exact: true })
          .click()
        await (await download).saveAs(`${output}/proforma-cien-productos.pdf`)
        await healthy('proforma grande con límite explícito')
      }
      console.log(
        `PASS entrega diaria ${width}px: contactos sin duplicados tras respuesta perdida, lector manual, precios/costos separados, entrada/salida/conteo/dañado, teclado y reportes contables`,
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
        'Navegador',
        errors,
        'UI',
        (await page.locator('body').innerText()).slice(-5000),
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
console.log(`OK: ${checks} comprobaciones de revisión diaria de entrega`)

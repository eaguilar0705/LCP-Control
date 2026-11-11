import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
import { identity, admin } from './database-fixture.mjs'

const base = 'http://127.0.0.1:5215'
const output = 'output/add-inventory-units'
await mkdir(output, { recursive: true })
const server = await createServer({
  configFile: 'frontend/vite.config.ts',
  server: { host: '127.0.0.1', port: 5215, strictPort: true },
})
await server.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000005001'
const code = '7000-501'
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
    const one = async (sql, args = []) =>
      (await fixture.db.query(sql, args)).rows[0]
    const rpc = async (name, input) =>
      (
        await one(`select public.${name}($1::jsonb) result`, [
          JSON.stringify(input),
        ])
      ).result
    const quantity = async () =>
      (
        await one(
          "select quantity from public.inventory_balances where product_id=$1 and location='store'",
          [product],
        )
      ).quantity
    const ledger = async () =>
      (await one('select public.ledger_report($1,$1) result', [fixture.today]))
        .result
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
    try {
      await rpc('open_business_day', {
        requestId: crypto.randomUUID(),
        expectedDay: fixture.today,
        openingNio: 0,
        openingUsd: 0,
      })
      await fixture.db.exec('reset role')
      await fixture.db.query(
        "insert into public.products(id,sku,name,brand_id,size,unit,category,gender) values($1,'QA-ADD-500','Perfume para agregar unidades',(select id from public.brands limit 1),100,'ml','arabian','unisex')",
        [product],
      )
      await fixture.db.query(
        "insert into public.inventory_balances(product_id,location,quantity) values($1,'store',2),($1,'warehouse',0)",
        [product],
      )
      await fixture.db.query(
        'insert into public.product_costs(product_id,average_cost_nio) values($1,500)',
        [product],
      )
      await fixture.db.query(
        "insert into public.product_prices(product_id,tier_code,currency,amount) select $1,t,c,case when c='NIO' then 900 else 25 end from unnest(array['emprendedor','vip','premium'])t cross join unnest(array['NIO','USD'])c",
        [product],
      )
      await identity(fixture.db, admin)
      await rpc('change_ledger_account', {
        requestId: crypto.randomUUID(),
        action: 'create',
        code,
        name: 'Cuenta de orden de prueba',
        parent: '7000',
      })
      await rpc('record_journal_entry', {
        requestId: crypto.randomUUID(),
        kind: 'adjustment',
        occurredOn: fixture.today,
        description: 'Inventario inicial del perfume de prueba',
        currency: 'NIO',
        exchangeRate: 1,
        lines: [
          { account: '1130', debit: 1000, credit: 0 },
          { account: '3110-001', debit: 0, credit: 1000 },
        ],
      })
      const initialBook = await ledger()
      const initialInventory = initialBook.accounts.find(
        (a) => a.code === '1130',
      ).debit
      const initialLoss = initialBook.accounts.find(
        (a) => a.code === '5150',
      ).debit
      await login()
      await navigate(`/products/${product}/edit`)
      const editor = page.locator('.product-stock-editor')
      const action = editor.getByLabel('Cómo cambiar las cantidades', {
        exact: true,
      })
      const amount = editor.getByLabel('Unidades a agregar', { exact: true })
      const counter = editor.getByLabel('Cuenta de contrapartida', {
        exact: true,
      })
      const note = editor.getByLabel('Motivo del cambio de cantidad', {
        exact: true,
      })
      const save = editor.getByRole('button', {
        name: 'Guardar cantidades',
        exact: true,
      })
      await action.waitFor()
      equal(
        await action.inputValue(),
        'ADD',
        'La edición habitual propone escribir las unidades adicionales',
      )
      await amount.fill('1')
      await counter.selectOption(code)
      await note.fill('Agregar una unidad de quinientos')
      const inventoryAccount = editor.getByLabel(
        'Cuenta de inventario (automática)',
        { exact: true },
      )
      equal(
        await inventoryAccount.inputValue(),
        '1130 · Inventario de perfumes',
      )
      equal(await inventoryAccount.getAttribute('readonly'), '')
      equal(
        await counter.locator('option[value="1130"]').count(),
        0,
        'Inventario participa automáticamente y no se compensa contra sí mismo',
      )
      await editor.locator('.inventory-adjustment-value').waitFor()
      equal(
        await editor
          .locator('.inventory-adjustment-value')
          .innerText()
          .then(
            (text) =>
              text.includes('Se agregan 1 unidad') &&
              text.includes('2 → 3') &&
              text.includes('500.00') &&
              !text.includes('1,500'),
          ),
        true,
      )
      await editor
        .locator('.inventory-adjustment-preview')
        .screenshot({ path: `${output}/agregar-una-${width}.png` })
      await save.click()
      await page.waitForFunction(
        () =>
          globalThis.document.querySelector(
            '.product-stock-editor .stock-location-cards strong',
          )?.textContent === '3',
      )
      equal(await quantity(), 3)
      const move = await one(
        'select type,quantity,before_quantity,after_quantity,adjustment_kind,counter_account from public.inventory_movements where product_id=$1 and note=$2',
        [product, 'Agregar una unidad de quinientos'],
      )
      equal(move, {
        type: 'ADJUSTMENT',
        quantity: 3,
        before_quantity: 2,
        after_quantity: 3,
        adjustment_kind: 'correction',
        counter_account: code,
      })
      await fixture.db.exec('reset role')
      const gain = await one(
        'select quantity,unit_cost_nio from private.inventory_count_gains where movement_id=(select id from public.inventory_movements where product_id=$1 and note=$2)',
        [product, 'Agregar una unidad de quinientos'],
      )
      equal(
        { quantity: gain.quantity, cost: Number(gain.unit_cost_nio) },
        { quantity: 1, cost: 500 },
      )
      equal(
        Number(
          (
            await one(
              'select value_nio from private.inventory_value_balances where product_id=$1',
              [product],
            )
          ).value_nio,
        ),
        1500,
      )
      await identity(fixture.db, admin)
      let book = await ledger()
      equal(
        book.accounts.find((a) => a.code === '1130').debit - initialInventory,
        500,
        'El mayor aumenta C$500, no C$1500',
      )
      equal(book.accounts.find((a) => a.code === code).credit, 500)
      equal(book.accounts.find((a) => a.code === '5150').debit, initialLoss)

      // Cambiar entre diferencia y conteo borra la cifra para no reinterpretarla.
      await amount.fill('1')
      await action.selectOption('ADJUSTMENT')
      const count = editor.getByLabel('Conteo total del perfume', {
        exact: true,
      })
      equal(await count.inputValue(), '')
      await count.fill('4')
      await action.selectOption('ADD')
      equal(await amount.inputValue(), '')
      await amount.fill('999999')
      await counter.selectOption(code)
      await save.click()
      await editor.getByRole('alert').waitFor()
      equal(await quantity(), 3, 'No acepta un total superior al máximo')

      // La respuesta se pierde después de guardar: verificar no agrega otra unidad.
      await amount.fill('1')
      await counter.selectOption(code)
      await note.fill('Una unidad con respuesta perdida')
      const requests = []
      let dropped = false
      const handler = async (route) => {
        const payload = route.request().postDataJSON().p_payload
        requests.push(payload)
        if (dropped) return route.fallback()
        dropped = true
        await rpc('record_inventory_movement', payload)
        return route.abort('failed')
      }
      await page.route('**/rest/v1/rpc/record_inventory_movement', handler)
      await save.click()
      const verify = editor.getByRole('button', {
        name: 'Verificar guardado',
        exact: true,
      })
      await verify.waitFor()
      equal(await amount.isDisabled(), true)
      await verify.click()
      await page.waitForFunction(
        () =>
          globalThis.document.querySelector(
            '.product-stock-editor .stock-location-cards strong',
          )?.textContent === '4',
      )
      await page.unroute('**/rest/v1/rpc/record_inventory_movement', handler)
      equal(await quantity(), 4)
      equal(requests.length, 2)
      equal(requests[1], requests[0])
      equal(
        {
          type: requests[0].type,
          quantity: requests[0].quantity,
          expectedQuantity: requests[0].expectedQuantity,
        },
        { type: 'ADJUSTMENT', quantity: 4, expectedQuantity: 3 },
      )
      equal(
        (
          await one(
            'select count(*)::int n from public.inventory_movements where product_id=$1 and note=$2',
            [product, 'Una unidad con respuesta perdida'],
          )
        ).n,
        1,
      )

      // El conteo total sigue disponible y también valora únicamente su diferencia.
      await action.selectOption('ADJUSTMENT')
      await count.fill('5')
      await counter.selectOption(code)
      await note.fill('Conteo de cinco unidades')
      await editor
        .getByRole('button', { name: 'Guardar ajuste', exact: true })
        .click()
      await page.waitForFunction(
        () =>
          globalThis.document.querySelector(
            '.product-stock-editor .stock-location-cards strong',
          )?.textContent === '5',
      )
      equal(await quantity(), 5)
      book = await ledger()
      equal(
        book.accounts.find((a) => a.code === '1130').debit - initialInventory,
        1500,
      )

      // La misma adición puede iniciarse desde el panel general de Inventario.
      await page
        .getByRole('link', { name: 'Volver al inventario', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Agregar unidades', exact: true })
        .click()
      const dialog = page.getByRole('dialog')
      await dialog
        .getByRole('button', { name: /Producto del movimiento/ })
        .click()
      await dialog
        .getByPlaceholder('Nombre, marca o código…')
        .fill('QA-ADD-500')
      await dialog.getByRole('option').first().click()
      await dialog.getByLabel('Unidades a agregar', { exact: true }).fill('1')
      await dialog
        .getByLabel('Cuenta de contrapartida', { exact: true })
        .selectOption(code)
      await dialog
        .getByLabel('Motivo', { exact: true })
        .fill('Una unidad desde Inventario')
      await dialog
        .getByRole('button', { name: 'Confirmar movimiento', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      equal(await quantity(), 6)
      book = await ledger()
      equal(
        book.accounts.find((a) => a.code === '1130').debit - initialInventory,
        2000,
      )
      equal(book.accounts.find((a) => a.code === code).credit, 2000)
      equal(book.accounts.find((a) => a.code === '5150').debit, initialLoss)

      // Otros roles conservan sus permisos y no reciben la adición de corrección.
      await page.goto(base + '/login')
      await page.waitForLoadState('networkidle')
      await fixture.db.exec('reset role')
      await fixture.db.query(
        "update public.staff_members set role='admin' where user_id=$1",
        [admin],
      )
      await identity(fixture.db, admin)
      await login()
      await navigate(`/products/${product}/edit`)
      await action.waitFor()
      equal(await action.locator('option[value="ADD"]').count(), 0)
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
      )
      equal(errors, [])
      equal(fixture.failures, [])
      console.log(`PASS agregar unidades por diferencia ${width}px`)
    } catch (error) {
      await writeFile(
        `${output}/fallo-${width}.json`,
        JSON.stringify(
          {
            error: String(error),
            errors,
            failures: fixture.failures,
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
  console.log(`Agregar unidades: ${checks} comprobaciones correctas.`)
} finally {
  await browser.close()
  await server.close()
}

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
import { admin, identity } from './database-fixture.mjs'

const base = 'http://127.0.0.1:5213'
const output = 'output/inventory-order-accounts'
await mkdir(output, { recursive: true })
const server = await createServer({
  configFile: 'frontend/vite.config.ts',
  server: { host: '127.0.0.1', port: 5213, strictPort: true },
})
await server.listen()
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
    const one = async (sql, args = []) =>
      (await fixture.db.query(sql, args)).rows[0]
    const rpc = async (name, input) =>
      (
        await one(`select public.${name}($1::jsonb) result`, [
          JSON.stringify(input),
        ])
      ).result
    const navigate = async (path) => {
      await page.evaluate((target) => {
        globalThis.history.pushState({}, '', target)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
    }
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
      await login()
      // El dueño puede crear otra cuenta de orden para sus deducciones.
      await navigate('/accounting?section=catalog')
      await page
        .getByRole('button', { name: 'Administrar cuentas', exact: true })
        .click()
      const accountsDialog = page.getByRole('dialog')
      await accountsDialog
        .getByRole('button', { name: 'Agregar cuenta', exact: true })
        .click()
      await accountsDialog
        .getByLabel('Código', { exact: true })
        .fill('7000-501')
      await accountsDialog
        .getByLabel('Nombre de la cuenta', { exact: true })
        .fill('Cuenta de orden del dueño')
      await accountsDialog
        .getByLabel('Cuenta mayor', { exact: true })
        .selectOption('7000')
      await accountsDialog
        .getByRole('button', { name: 'Guardar cuenta', exact: true })
        .click()
      await accountsDialog
        .getByRole('article', { name: 'Cuenta 7000-501', exact: true })
        .waitFor()
      equal(
        (
          await one(
            "select bucket from public.ledger_accounts where code='7000-501'",
          )
        ).bucket,
        'memorandum',
      )

      await navigate(`/products/${product}/edit`)
      const editor = page.locator('.product-stock-editor')
      const action = editor.getByLabel('Cómo cambiar las cantidades', {
        exact: true,
      })
      const treatment = editor.getByLabel('Tratamiento del ajuste', {
        exact: true,
      })
      const counter = editor.getByLabel('Cuenta de contrapartida', {
        exact: true,
      })
      const units = editor.getByLabel('Unidades a mover', { exact: true })
      const note = editor.getByLabel('Motivo del cambio de cantidad', {
        exact: true,
      })
      await action.selectOption('EXIT')
      await units.fill('3')
      await note.fill('Corrección sin pérdida contra cuenta de orden')
      equal(await treatment.inputValue(), 'correction')
      equal(await counter.inputValue(), '', 'La cuenta la elige el dueño')
      await editor
        .getByRole('button', { name: 'Guardar cantidades', exact: true })
        .click()
      equal(
        await counter.evaluate((input) => input.validity.valueMissing),
        true,
      )
      equal(await quantity(), 20, 'Sin contrapartida no descuenta unidades')
      await counter.selectOption('7000-501')
      await editor
        .getByRole('button', { name: 'Guardar cantidades', exact: true })
        .click()
      await page.waitForFunction(
        () =>
          globalThis.document.querySelector(
            '.product-stock-editor .stock-location-cards strong',
          )?.textContent === '17',
      )
      equal(await quantity(), 17)
      const movement = await one(
        'select type,before_quantity,after_quantity,adjustment_kind,counter_account from public.inventory_movements where note=$1',
        ['Corrección sin pérdida contra cuenta de orden'],
      )
      equal(movement, {
        type: 'ADJUSTMENT',
        before_quantity: 20,
        after_quantity: 17,
        adjustment_kind: 'correction',
        counter_account: '7000-501',
      })
      let book = await ledger()
      const account = (code) => book.accounts.find((row) => row.code === code)
      equal(
        account('7000-501').debit,
        300,
        'Tres unidades de C$100 van a orden',
      )
      equal(account('5150').debit, 0, 'Corregir no reconoce pérdida')
      equal(account('1130').credit, 300, 'Se reduce el valor del inventario')
      equal(await treatment.inputValue(), 'correction')
      equal(await counter.inputValue(), '', 'No reutiliza cuenta sin elegirla')

      // La misma operación permite reconocer una pérdida, expresamente.
      await units.fill('1')
      await treatment.selectOption('loss')
      await note.fill('Pérdida real elegida por el dueño')
      equal(await counter.inputValue(), '5150')
      await editor
        .getByRole('button', { name: 'Guardar cantidades', exact: true })
        .click()
      await page.waitForFunction(
        () =>
          globalThis.document.querySelector(
            '.product-stock-editor .stock-location-cards strong',
          )?.textContent === '16',
      )
      book = await ledger()
      equal(account('5150').debit, 100)
      equal(account('7000-501').debit, 300)

      // Descontar desde Inventario ofrece la misma separación.
      await navigate('/inventory')
      await page.getByRole('button', { name: 'Salida', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog
        .getByRole('button', { name: /Producto del movimiento/ })
        .click()
      await dialog.getByPlaceholder('Nombre, marca o código…').fill('QA-0001')
      await dialog.getByRole('option').first().click()
      await dialog.getByLabel('Cantidad', { exact: true }).fill('2')
      await dialog
        .getByLabel('Motivo', { exact: true })
        .fill('Salida corregida contra orden')
      equal(
        await dialog
          .getByLabel('Tratamiento del ajuste', { exact: true })
          .inputValue(),
        'correction',
      )
      await dialog
        .getByLabel('Cuenta de contrapartida', { exact: true })
        .selectOption('7000-501')
      await dialog
        .getByRole('button', { name: 'Confirmar movimiento', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      equal(await quantity(), 14)
      book = await ledger()
      equal(account('7000-501').debit, 500)
      equal(
        account('5150').debit,
        100,
        'La salida corregida no suma otra pérdida',
      )

      // Los roles sin permiso de ajustes siguen viendo su salida como pérdida.
      await fixture.db.exec('reset role')
      await fixture.db.query(
        'update public.staff_members set role=$1 where user_id=$2',
        ['admin', admin],
      )
      await identity(fixture.db, admin)
      await page.reload()
      await login()
      await navigate(`/products/${product}/edit`)
      await action.selectOption('EXIT')
      equal(await treatment.count(), 0)
      equal(
        await editor
          .getByText(
            'Esta salida se registra como pérdida real de inventario.',
            { exact: false },
          )
          .isVisible(),
        true,
      )
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
      await page.screenshot({
        path: `${output}/descuento-${width}.png`,
        fullPage: true,
      })
      console.log(`PASS cuentas de orden e inventario ${width}px`)
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
  console.log(
    `Cuentas de orden en navegador: ${checks} comprobaciones correctas.`,
  )
} finally {
  await browser.close()
  await server.close()
}

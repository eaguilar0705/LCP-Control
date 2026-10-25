import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
import { identity, admin } from './database-fixture.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5174'
assert.ok(
  ['127.0.0.1', 'localhost'].includes(new URL(base).hostname) ||
    new URL(base).origin === 'https://lcp-control.pages.dev',
)
const output =
  process.env.LCP_TEST_OUTPUT ?? 'output/browser-inventory-valuation'
await mkdir(output, { recursive: true })
let checks = 0
const results = []
const eq = (actual, expected, why) => {
  assert.deepEqual(actual, expected, why)
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
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const fixture = await browserDatabase(page)
    const one = async (sql, values = []) =>
      (await fixture.db.query(sql, values)).rows[0]
    const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
    try {
      await fixture.db.exec('reset role')
      await fixture.db.exec(
        "update public.inventory_balances set quantity=0; update public.journal_lines set debit=15500,debit_nio=15500 where account='1130'; update public.journal_lines set credit=16500,credit_nio=16500 where account='3110-001';",
      )
      await fixture.db.query(
        "update public.inventory_balances set quantity=15 where product_id=$1 and location='store'",
        [product],
      )
      await fixture.db.query(
        'update public.product_costs set average_cost_nio=1033.333333 where product_id=$1',
        [product],
      )
      await fixture.db.query(
        "update public.product_prices set amount=2000 where product_id=$1 and currency='NIO'",
        [product],
      )
      await identity(fixture.db, admin)
      await fixture.db.query('select public.open_business_day($1)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedDay: fixture.today,
          openingNio: 1000,
          openingUsd: 0,
        }),
      ])
      for (let i = 0; i < 15; i++)
        await fixture.db.query('select public.create_document($1)', [
          JSON.stringify({
            requestId: crypto.randomUUID(),
            kind: 'invoice',
            customerName: 'Auditoría de centavos',
            tier: 'emprendedor',
            currency: 'NIO',
            exchangeRate: 1,
            location: 'store',
            paymentMethod: 'cash',
            items: [{ productId: product, quantity: 1 }],
          }),
        ])
      await fixture.db.exec(
        'reset role; update public.document_item_costs set total_cost_nio=null;',
      )
      await identity(fixture.db, admin)
      const snapshots = (
        await one(
          'select jsonb_agg(to_jsonb(c) order by document_item_id) data from public.document_item_costs c',
        )
      ).data
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
        globalThis.history.pushState({}, '', '/accounting')
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      })
      await page
        .getByRole('button', {
          name: 'Valorización de inventario',
          exact: true,
        })
        .click()
      const dialog = page.getByRole('dialog')
      await dialog
        .getByLabel('Motivo de la revisión', { exact: true })
        .fill('Revisión de centavos históricos verificada')
      eq(
        (await dialog.locator('.valuation-totals').innerText()).includes(
          '0.05',
        ),
        true,
        'Diferencia histórica visible',
      )
      let lost = false
      const ids = []
      const loseResponse = async (route) => {
        const input = route.request().postDataJSON().p_input
        ids.push(input.requestId)
        if (lost) return route.fallback()
        lost = true
        await fixture.db.query('select public.reconcile_inventory_value($1)', [
          JSON.stringify(input),
        ])
        await route.abort('failed')
      }
      await page.route('**/rest/v1/rpc/reconcile_inventory_value', loseResponse)
      await dialog
        .getByRole('button', { name: 'Confirmar regularización', exact: true })
        .click()
      await dialog
        .getByRole('button', { name: 'Verificar guardado', exact: true })
        .waitFor()
      eq(
        await dialog
          .getByLabel('Motivo de la revisión', { exact: true })
          .isDisabled(),
        true,
      )
      eq(
        await dialog
          .getByRole('button', { name: 'Cerrar', exact: true })
          .last()
          .isDisabled(),
        true,
      )
      await page.keyboard.press('Escape')
      eq(await dialog.isVisible(), true)
      await dialog
        .getByRole('button', { name: 'Verificar guardado', exact: true })
        .click()
      await dialog
        .getByText('Revisión de inventario registrada.', { exact: true })
        .waitFor()
      eq(new Set(ids).size, 1, 'Respuesta perdida conserva UUID original')
      eq(
        (await one('select public.inventory_valuation_preview() data')).data
          .differenceNio,
        0,
      )
      await fixture.db.exec('reset role')
      eq(
        (
          await one(
            'select count(*)::int n from private.inventory_value_reconciliations',
          )
        ).n,
        1,
      )
      eq(
        (
          await one(
            'select jsonb_agg(to_jsonb(c) order by document_item_id) data from public.document_item_costs c',
          )
        ).data,
        snapshots,
        'Costos históricos intactos',
      )
      await identity(fixture.db, admin)
      await dialog.getByText('Historial de revisiones', { exact: true }).click()
      await dialog
        .getByText('Revisión de centavos históricos verificada', {
          exact: true,
        })
        .waitFor()
      await page.screenshot({
        path: `${output}/conciliacion-${width}.png`,
        fullPage: true,
      })
      eq(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        'Sin desborde de página',
      )
      eq(
        await dialog.evaluate((e) => e.scrollWidth > e.clientWidth + 1),
        false,
        'Sin desborde de diálogo',
      )
      await fixture.db.exec('reset role')
      await fixture.db.query(
        "update public.inventory_balances set quantity=null where product_id=$1 and location='warehouse'",
        [product],
      )
      await identity(fixture.db, admin)
      await dialog
        .getByRole('button', { name: 'Actualizar importes', exact: true })
        .click()
      await dialog
        .getByRole('link', { name: 'Completar en Inventario', exact: true })
        .waitFor()
      eq(
        await dialog
          .getByRole('button', { name: 'Registrar revisión', exact: true })
          .count(),
        0,
        'Datos incompletos nunca se regularizan',
      )
      eq(errors, [])
      eq(fixture.failures, [])
      results.push({ width, status: 'passed' })
      console.log(
        `PASS valorización ${width}px: vista previa, centavos, historial, pérdida de respuesta y conteos incompletos`,
      )
    } catch (error) {
      await page.screenshot({
        path: `${output}/fallo-${width}.png`,
        fullPage: true,
      })
      console.error(
        'UI',
        (await page.locator('body').innerText()).slice(-3000),
        'API',
        fixture.failures,
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
  JSON.stringify({ checks, results, productionWrites: false }, null, 2),
)
console.log(`PASS ${checks} comprobaciones Chrome de valorización`)

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) ||
    new URL(base).origin === 'https://lcp-control.pages.dev',
)
const output =
  process.env.LCP_TEST_OUTPUT ?? 'output/inventory-transfers-browser'
await mkdir(output, { recursive: true })
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
let checks = 0
const eq = (a, b, m) => {
  assert.deepEqual(a, b, m)
  checks++
}
const results = []
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390, 320]) {
    const start = checks
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      timezoneId: 'America/Managua',
      isMobile: width < 500,
      hasTouch: width < 500,
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const fixture = await browserDatabase(page)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const one = async (sql, args = []) =>
      (await fixture.db.query(sql, args)).rows[0]
    const state = () =>
      one(
        `select (select quantity from public.inventory_balances where product_id=$1 and location='warehouse') warehouse,
   (select quantity from public.inventory_balances where product_id=$1 and location='store') store,
   (select count(*)::int from public.inventory_transfers) transfers`,
        [product],
      )
    const protectedState = async () =>
      (
        await one(
          `select jsonb_build_object(
   'costs',(select jsonb_agg(to_jsonb(t) order by product_id) from public.product_costs t),
   'prices',(select jsonb_agg(to_jsonb(t) order by product_id,tier_code,currency) from public.product_prices t),
   'movements',(select count(*) from public.inventory_movements),
   'ledger',public.ledger_report($1,$1)) r`,
          [fixture.today],
        )
      ).r
    const navigate = async (path) => {
      await page.evaluate((target) => {
        globalThis.history.pushState({}, '', target)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      await page
        .getByRole('heading', {
          name: path === '/' ? 'Inicio' : 'Inventario',
          exact: true,
        })
        .waitFor()
    }
    const open = async () => {
      await page.getByRole('button', { name: 'Traslados', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: /Perfume del traslado/ }).click()
      await dialog
        .getByRole('option', { name: /Perfume Oriental de nombre largo/ })
        .click()
      return dialog
    }
    const healthy = async () => {
      eq(errors, [], 'sin errores de navegador')
      eq(fixture.failures, [], 'sin errores API/SQL inesperados')
      eq(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        'sin desbordamiento de página',
      )
      for (const d of await page.getByRole('dialog').all())
        eq(
          await d.evaluate((e) => e.scrollWidth > e.clientWidth + 1),
          false,
          'sin desbordamiento de diálogo',
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
      const before = await protectedState()
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
      await navigate('/inventory')
      let dialog = await open()
      await dialog
        .getByLabel('Unidades a trasladar', { exact: true })
        .fill('11')
      await dialog
        .getByLabel('Motivo del traslado', { exact: true })
        .fill('Reposición de Tienda')
      await dialog
        .getByRole('button', { name: 'Confirmar traslado', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'Solo hay 10 unidades en Bodega' })
        .waitFor()
      eq(
        await state(),
        { warehouse: 10, store: 20, transfers: 0 },
        'cantidad insuficiente no altera nada',
      )
      await dialog.getByLabel('Unidades a trasladar', { exact: true }).fill('3')
      const requests = []
      let lost = false
      const lose = async (route) => {
        const input = route.request().postDataJSON().p_input
        requests.push(input)
        if (lost) return route.fallback()
        lost = true
        await fixture.db.query('select public.transfer_inventory($1::jsonb)', [
          JSON.stringify(input),
        ])
        return route.abort('failed')
      }
      await page.route('**/rest/v1/rpc/transfer_inventory', lose)
      await dialog
        .getByRole('button', { name: 'Confirmar traslado', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'No pudimos confirmar el guardado' })
        .waitFor()
      eq(
        await state(),
        { warehouse: 7, store: 23, transfers: 1 },
        'ambas ubicaciones actualizadas una sola vez',
      )
      for (const label of [
        'Unidades a trasladar',
        'Motivo del traslado',
        'Desde',
      ])
        eq(
          await dialog.getByLabel(label, { exact: true }).isDisabled(),
          true,
          label + ' protegido',
        )
      eq(
        await dialog
          .getByRole('button', { name: 'Cerrar', exact: true })
          .first()
          .isDisabled(),
        true,
        'cierre bloqueado',
      )
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      eq(
        await page.getByRole('dialog').count(),
        1,
        'Escape no descarta confirmación',
      )
      await healthy()
      await page.screenshot({ path: `${output}/pendiente-${width}.png` })
      await dialog
        .getByRole('button', { name: 'Verificar traslado', exact: true })
        .click()
      await dialog
        .getByText('Traslado registrado. Inventario actualizado.', {
          exact: true,
        })
        .waitFor()
      eq(requests.length, 2, 'dos peticiones para recuperar una operación')
      eq(requests[0], requests[1], 'mismo DTO y UUID')
      eq(
        await state(),
        { warehouse: 7, store: 23, transfers: 1 },
        'verificación no duplica unidades',
      )
      await page.unroute('**/rest/v1/rpc/transfer_inventory', lose)
      await dialog.getByText('Últimos 100 traslados', { exact: true }).click()
      await dialog
        .locator('.transfer-history')
        .getByText(/QA-0001/)
        .waitFor()
      await healthy()
      await page.screenshot({
        path: `${output}/historial-${width}.png`,
        fullPage: false,
      })
      // Una equivocación de ubicación se corrige con un traslado inverso trazable.
      await dialog.getByLabel('Desde', { exact: true }).selectOption('store')
      await dialog.getByLabel('Unidades a trasladar', { exact: true }).fill('2')
      await dialog
        .getByLabel('Motivo del traslado', { exact: true })
        .fill('Corrección parcial de ubicación')
      lost = false
      requests.length = 0
      await page.route('**/rest/v1/rpc/transfer_inventory', lose)
      await dialog
        .getByRole('button', { name: 'Confirmar traslado', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'No pudimos confirmar el guardado' })
        .waitFor()
      eq(
        await state(),
        { warehouse: 9, store: 21, transfers: 2 },
        'traslado inverso parcial independiente',
      )
      await page.goBack()
      await page.getByRole('heading', { name: 'Inicio', exact: true }).waitFor()
      const pending = page.getByRole('status', {
        name: 'Operaciones por confirmar',
        exact: true,
      })
      await pending
        .getByText('Traslado de inventario pendiente de confirmar.', {
          exact: true,
        })
        .waitFor()
      await pending
        .getByRole('button', { name: 'Verificar operación', exact: true })
        .click()
      await pending.waitFor({ state: 'hidden' })
      eq(requests.length, 2, 'la navegación recupera el original')
      eq(requests[0], requests[1], 'UUID y datos conservados tras Atrás')
      eq(
        await state(),
        { warehouse: 9, store: 21, transfers: 2 },
        'total30 unidades conservado',
      )
      eq(
        await protectedState(),
        before,
        'costos precios mayor y movimientos contables intactos',
      )
      await healthy()
      await navigate('/inventory')
      dialog = await open()
      await dialog.getByText('Últimos 100 traslados', { exact: true }).click()
      eq(
        await dialog.locator('.transfer-history li').count(),
        2,
        'ambos traslados en historial',
      )
      await healthy()
      results.push({ width, checks: checks - start, status: 'passed' })
    } finally {
      await fixture.close()
      await context.close()
    }
  }
  await writeFile(
    output + '/resultados.json',
    JSON.stringify(
      { checks, results, frontend: base, productionWrites: false },
      null,
      2,
    ),
  )
  console.log(`PASS traslados navegador: ${checks} comprobaciones`)
} finally {
  await browser.close()
}

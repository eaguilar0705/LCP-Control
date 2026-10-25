import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) ||
    new URL(base).origin === 'https://lcp-control.pages.dev',
)
// La API usa exclusivamente las migraciones/RPCs de PostgreSQL desechable.
// No se crean listas ni documentos en la tienda publicada.
const output = process.env.LCP_TEST_OUTPUT ?? 'output/price-tier-confirmation'
await mkdir(output, { recursive: true })
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const results = []
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390, 320]) {
    const start = checks
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
    const one = async (sql, parameters = []) =>
      (await fixture.db.query(sql, parameters)).rows[0]
    const protectedSnapshot = async () =>
      (
        await one(`select jsonb_build_object(
          'documents',(select count(*) from public.documents),
          'movements',(select count(*) from public.inventory_movements),
          'stock',(select jsonb_agg(to_jsonb(t) order by product_id,location) from public.inventory_balances t),
          'costs',(select jsonb_agg(to_jsonb(t) order by product_id) from public.product_costs t),
          'prices',(select jsonb_agg(to_jsonb(t) order by product_id,tier_code,currency) from public.product_prices t),
          'journal',(select jsonb_agg(to_jsonb(t) order by id) from public.journal_entries t)) r`)
      ).r
    const navigate = async (path) => {
      await page.evaluate((target) => {
        globalThis.history.pushState({}, '', target)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
    }
    const healthy = async (name) => {
      equal(errors, [], name + ': navegador sin errores')
      equal(fixture.failures, [], name + ': API sin errores')
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        name + ': página sin desbordamiento',
      )
      for (const dialog of await page.getByRole('dialog').all())
        equal(
          await dialog.evaluate(
            (element) => element.scrollWidth > element.clientWidth + 1,
          ),
          false,
          name + ': diálogo sin desbordamiento',
        )
    }
    const captureLostResponse = async () => {
      const payloads = []
      const handler = async (route) => {
        const input = route.request().postDataJSON().p_input
        payloads.push(input)
        if (payloads.length > 1) return route.fallback()
        await fixture.db.query('select public.create_price_tier($1::jsonb)', [
          JSON.stringify(input),
        ])
        await route.abort('failed')
      }
      await page.route('**/rest/v1/rpc/create_price_tier', handler)
      return {
        payloads,
        remove: () => page.unroute('**/rest/v1/rpc/create_price_tier', handler),
      }
    }
    const openLists = async () => {
      await page
        .getByRole('button', { name: 'Listas de precios', exact: true })
        .click()
      const dialog = page.getByRole('dialog', {
        name: 'Listas de precios',
        exact: true,
      })
      await dialog.getByLabel('Buscar perfume', { exact: true }).fill('QA-0001')
      await dialog.getByLabel('Precio QA-0001 USD', { exact: true }).waitFor()
      return dialog
    }
    const beginCreate = async (dialog, name) => {
      await dialog
        .getByRole('button', { name: 'Nueva lista', exact: true })
        .click()
      await dialog
        .getByLabel('Nombre de la nueva lista', { exact: true })
        .fill(name)
      await dialog
        .getByRole('button', { name: 'Crear lista', exact: true })
        .click()
    }
    const createdMessage = async (dialog) => {
      await dialog
        .getByLabel('Nombre de la nueva lista', { exact: true })
        .waitFor({ state: 'hidden' })
      await dialog
        .getByText('Lista creada. Agrega los precios de los perfumes.', {
          exact: true,
        })
        .waitFor()
    }
    const tierNames = async () =>
      (
        await fixture.db.query(
          "select name from public.price_tiers where code not in ('emprendedor','vip','premium') order by name",
        )
      ).rows.map((row) => row.name)
    try {
      const initial = await protectedSnapshot()
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
      let dialog = await openLists()
      const localName = `Lista original ${width}`
      const local = await captureLostResponse()
      await beginCreate(dialog, localName)
      await dialog
        .getByRole('button', { name: 'Verificar guardado', exact: true })
        .waitFor()
      const originalInput = dialog.getByLabel('Nombre de la nueva lista', {
        exact: true,
      })
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'No pudimos confirmar el guardado.' })
        .waitFor()
      equal(await originalInput.inputValue(), localName)
      equal(await originalInput.isDisabled(), true)
      await assert.rejects(
        originalInput.fill('Nombre distinto', { timeout: 500 }),
      )
      checks++
      equal(await originalInput.inputValue(), localName)
      for (const label of ['Lista de precios', 'Moneda', 'Buscar perfume'])
        equal(
          await dialog.getByLabel(label, { exact: true }).isDisabled(),
          true,
        )
      equal(
        await dialog
          .getByLabel('Precio QA-0001 USD', { exact: true })
          .isDisabled(),
        true,
      )
      equal(
        await dialog
          .getByRole('button', { name: 'Cancelar', exact: true })
          .isDisabled(),
        true,
      )
      for (const close of await dialog
        .getByRole('button', { name: 'Cerrar', exact: true })
        .all()) {
        equal(await close.isDisabled(), true)
        await close.evaluate((button) => button.click())
      }
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      equal(
        await dialog.isVisible(),
        true,
        'Cancelar, X y Escape no pierden el alta pendiente',
      )
      equal(await tierNames(), [localName])
      equal(local.payloads.length, 1)
      await healthy(`Alta pendiente ${width}`)
      await dialog
        .getByRole('button', { name: 'Verificar guardado', exact: true })
        .scrollIntoViewIfNeeded()
      await page.screenshot({
        path: `${output}/pendiente-${width}.png`,
        fullPage: false,
      })
      await dialog
        .getByRole('button', { name: 'Verificar guardado', exact: true })
        .click()
      await createdMessage(dialog)
      equal(local.payloads.length, 2)
      equal(
        local.payloads[1],
        local.payloads[0],
        'El reintento conserva nombre y UUID',
      )
      equal(await tierNames(), [localName])
      equal(
        await dialog
          .getByLabel('Nombre de la nueva lista', { exact: true })
          .count(),
        0,
      )
      equal(
        await dialog
          .getByRole('button', { name: 'Nueva lista', exact: true })
          .isEnabled(),
        true,
      )
      const nextName = `Nueva lista legítima ${width}`
      await beginCreate(dialog, nextName)
      await createdMessage(dialog)
      equal(local.payloads.length, 3)
      equal(local.payloads[2].requestId !== local.payloads[0].requestId, true)
      equal(await tierNames(), [localName, nextName].sort())
      await local.remove()
      await healthy(`Alta recuperada ${width}`)

      const backName = `Lista antes de Atrás ${width}`
      const back = await captureLostResponse()
      await beginCreate(dialog, backName)
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'No pudimos confirmar el guardado.' })
        .waitFor()
      await page.goBack()
      await page.getByRole('heading', { name: 'Inicio', exact: true }).waitFor()
      equal(await page.getByRole('dialog').count(), 0)
      const banner = page.getByRole('status', {
        name: 'Operaciones por confirmar',
      })
      await banner.waitFor()
      equal(
        (await banner.innerText()).includes(
          'Lista de precios pendiente de confirmar.',
        ),
        true,
      )
      equal(await tierNames(), [backName, localName, nextName].sort())

      await navigate('/inventory')
      dialog = await openLists()
      const finalName = `Lista posterior ${width}`
      await beginCreate(dialog, finalName)
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'Hay un guardado pendiente de confirmar.' })
        .waitFor()
      equal(back.payloads.length, 1, 'Un formulario nuevo no crea otra lista')
      equal(
        await dialog
          .getByLabel('Nombre de la nueva lista', { exact: true })
          .inputValue(),
        finalName,
      )
      equal(
        await dialog
          .getByLabel('Nombre de la nueva lista', { exact: true })
          .isEnabled(),
        true,
      )
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      await dialog
        .locator('.form-actions')
        .getByRole('button', { name: 'Cerrar', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      await healthy(`Atrás conserva el alta ${width}`)
      await page.screenshot({
        path: `${output}/aviso-global-${width}.png`,
        fullPage: false,
      })
      await banner
        .getByRole('button', { name: 'Verificar operación', exact: true })
        .click()
      await banner.waitFor({ state: 'hidden' })
      await page
        .getByRole('status')
        .filter({ hasText: 'Operación confirmada. Consulta el historial.' })
        .waitFor()
      equal(back.payloads.length, 2)
      equal(back.payloads[1], back.payloads[0])
      equal(await tierNames(), [backName, localName, nextName].sort())

      dialog = await openLists()
      await beginCreate(dialog, finalName)
      await createdMessage(dialog)
      equal(back.payloads.length, 3)
      equal(back.payloads[2].requestId !== back.payloads[0].requestId, true)
      equal(
        await tierNames(),
        [backName, localName, nextName, finalName].sort(),
      )
      await back.remove()
      equal(
        await protectedSnapshot(),
        initial,
        'Crear y confirmar listas no cambia datos económicos ni existencias',
      )
      await healthy(`Alta legítima tras confirmación global ${width}`)
      results.push({ width, status: 'passed', checks: checks - start })
      console.log(
        `PASS listas ${width}px: respuesta perdida, edición bloqueada, reintento idéntico, Atrás y formulario nuevo protegidos, aviso global y alta posterior legítima`,
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
        (await page.locator('body').innerText()).slice(-4000),
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
console.log(
  `OK: ${checks} comprobaciones del alta y confirmación de listas de precios`,
)

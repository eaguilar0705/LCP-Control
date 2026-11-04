import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5197'
assert.ok(
  ['127.0.0.1', 'lcp-control.pages.dev'].includes(new URL(base).hostname),
)
const out = 'output/ledger-account-review'
await mkdir(out, { recursive: true })
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5197, strictPort: true },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let checks = 0
const eq = (a, b, msg) => {
  assert.deepEqual(a, b, msg)
  checks++
}
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      isMobile: width < 500,
      hasTouch: width < 500,
      timezoneId: 'America/Managua',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const fixture = await browserDatabase(page)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const get = async (sql, args = []) =>
      (await fixture.db.query(sql, args)).rows[0]
    const rpc = async (name, input) =>
      (await get(`select public.${name}($1::jsonb) r`, [JSON.stringify(input)]))
        .r
    await page.route('**/rest/v1/storefront_drafts*', (r) =>
      r.request().method() === 'HEAD'
        ? r.fulfill({
            status: 200,
            headers: { 'content-range': '*/0' },
            body: '',
          })
        : r.fallback(),
    )
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
      await page.evaluate(() => {
        globalThis.history.pushState({}, '', '/accounting?section=catalog')
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      })
      await page
        .getByRole('button', { name: 'Administrar cuentas', exact: true })
        .click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Buscar cuenta', { exact: true }).waitFor()
      await dialog
        .getByRole('button', { name: 'Agregar cuenta', exact: true })
        .click()
      await dialog.getByLabel('Código', { exact: true }).fill('5130-900')
      await dialog
        .getByLabel('Nombre de la cuenta', { exact: true })
        .fill('Cuenta de auditoría ' + width)
      await dialog
        .getByLabel('Cuenta mayor', { exact: true })
        .selectOption('5130')
      if (width === 1440) {
        let dropped = false
        await page.route(
          '**/rest/v1/rpc/change_ledger_account',
          async (route) => {
            if (!dropped) {
              dropped = true
              await rpc(
                'change_ledger_account',
                route.request().postDataJSON().p_input,
              )
              return route.abort('connectionreset')
            }
            return route.fallback()
          },
        )
        await dialog
          .getByRole('button', { name: 'Guardar cuenta', exact: true })
          .click()
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .waitFor()
        eq(
          await dialog
            .getByLabel('Nombre de la cuenta', { exact: true })
            .isDisabled(),
          true,
        )
        await page.keyboard.press('Escape')
        eq(
          await dialog.isVisible(),
          true,
          'el guardado pendiente no se descarta',
        )
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .click()
        await page.unroute('**/rest/v1/rpc/change_ledger_account')
      } else
        await dialog
          .getByRole('button', { name: 'Guardar cuenta', exact: true })
          .click()
      const row = dialog.getByRole('article', {
        name: 'Cuenta 5130-900',
        exact: true,
      })
      await row.waitFor()
      eq(
        (
          await get(
            "select count(*) n from public.ledger_accounts where code='5130-900'",
          )
        ).n,
        1,
        'alta única',
      )
      await row
        .getByRole('button', { name: 'Renombrar cuenta 5130-900', exact: true })
        .click()
      eq(
        await dialog
          .getByLabel('Código', { exact: true })
          .getAttribute('readonly'),
        '',
      )
      await dialog
        .getByLabel('Nombre de la cuenta', { exact: true })
        .fill('Cuenta corregida ' + width)
      await dialog
        .getByRole('button', { name: 'Guardar cuenta', exact: true })
        .click()
      await row
        .getByText('5130-900 · Cuenta corregida ' + width, { exact: true })
        .waitFor()
      if (width === 1440) {
        await rpc('open_business_day', {
          requestId: crypto.randomUUID(),
          openingNio: 1000,
          openingUsd: 0,
        })
        await rpc('record_journal_entry', {
          requestId: crypto.randomUUID(),
          kind: 'expense',
          occurredOn: fixture.today,
          description: 'Movimiento que debe conservarse',
          currency: 'NIO',
          exchangeRate: 1,
          lines: [
            { account: '5130-900', debit: 50, credit: 0 },
            { account: '1110-001', debit: 0, credit: 50 },
          ],
        })
      }
      await row
        .getByRole('button', {
          name: 'Desactivar cuenta 5130-900',
          exact: true,
        })
        .click()
      await dialog
        .getByText(
          'Dejará de estar disponible para nuevos comprobantes. Sus saldos y movimientos se conservan.',
          { exact: true },
        )
        .waitFor()
      await dialog
        .getByRole('button', { name: 'Desactivar cuenta', exact: true })
        .click()
      await row
        .getByRole('button', { name: 'Reactivar cuenta 5130-900', exact: true })
        .waitFor()
      eq(
        await dialog
          .getByLabel('Estado de las cuentas', { exact: true })
          .inputValue(),
        'inactive',
      )
      eq(
        (
          await get(
            "select active from public.ledger_accounts where code='5130-900'",
          )
        ).active,
        false,
      )
      await dialog.screenshot({ path: `${out}/inactiva-${width}.png` })
      eq(
        await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        true,
        'modal sin desbordamiento',
      )
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      await page
        .getByRole('button', { name: 'Comprobantes', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Comprobante de egreso', exact: true })
        .click()
      await dialog.getByLabel('Cuenta 1', { exact: true }).waitFor()
      eq(
        await dialog
          .getByLabel('Cuenta 1', { exact: true })
          .locator('option[value="5130-900"]')
          .count(),
        0,
        'cuenta inactiva no se puede elegir',
      )
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      if (width === 1440) {
        const report = (
          await get('select public.ledger_report($1,$1) r', [fixture.today])
        ).r
        eq(
          report.accounts.find((a) => a.code === '5130-900').closing,
          50,
          'saldo histórico intacto',
        )
      }
      await page
        .getByRole('button', { name: 'Catálogo de cuentas', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Administrar cuentas', exact: true })
        .click()
      await dialog
        .getByLabel('Estado de las cuentas', { exact: true })
        .selectOption('inactive')
      await dialog.getByLabel('Buscar cuenta', { exact: true }).fill('5130-900')
      await row
        .getByRole('button', { name: 'Reactivar cuenta 5130-900', exact: true })
        .click()
      await dialog
        .getByRole('button', { name: 'Reactivar cuenta', exact: true })
        .click()
      await row
        .getByRole('button', {
          name: 'Desactivar cuenta 5130-900',
          exact: true,
        })
        .waitFor()
      eq(
        (
          await get(
            "select active from public.ledger_accounts where code='5130-900'",
          )
        ).active,
        true,
      )
      if (width === 1440) {
        await row
          .getByRole('button', {
            name: 'Renombrar cuenta 5130-900',
            exact: true,
          })
          .click()
        const current = await get(
          "select revision from public.ledger_accounts where code='5130-900'",
        )
        await rpc('change_ledger_account', {
          requestId: crypto.randomUUID(),
          action: 'rename',
          code: '5130-900',
          name: 'Edición de otra ventana',
          expectedRevision: current.revision,
        })
        await dialog
          .getByLabel('Nombre de la cuenta', { exact: true })
          .fill('No pisar otra edición')
        await dialog
          .getByRole('button', { name: 'Guardar cuenta', exact: true })
          .click()
        await dialog
          .getByRole('button', { name: 'Actualizar lista', exact: true })
          .waitFor()
        eq(
          await dialog
            .getByRole('button', { name: 'Guardar cuenta', exact: true })
            .isDisabled(),
          true,
        )
        await dialog
          .getByRole('button', { name: 'Actualizar lista', exact: true })
          .click()
        await row
          .getByText('5130-900 · Edición de otra ventana', { exact: true })
          .waitFor()
        const index = fixture.failures.findIndex((e) =>
          e.includes('La cuenta cambió'),
        )
        assert.ok(index >= 0)
        fixture.failures.splice(index, 1)
      }
      await dialog.getByLabel('Buscar cuenta', { exact: true }).fill('2117')
      eq(
        await dialog
          .getByRole('button', { name: 'Desactivar cuenta 2117', exact: true })
          .isDisabled(),
        true,
        'cuentas automáticas protegidas',
      )
      await dialog
        .getByLabel('Estado de las cuentas', { exact: true })
        .selectOption('inactive')
      await dialog.getByLabel('Buscar cuenta', { exact: true }).fill('4120')
      eq(
        await dialog
          .getByRole('button', { name: 'Reactivar cuenta 4120', exact: true })
          .isDisabled(),
        true,
        'cuenta retirada no se reactiva por error',
      )
      eq(errors, [])
      eq(fixture.failures, [])
    } finally {
      await context.close()
      await fixture.close()
    }
  }
} finally {
  await browser.close()
  await server?.close()
}
await writeFile(
  `${out}/resultado.json`,
  JSON.stringify(
    { checks, widths: [1440, 390, 320], productionDataModified: false },
    null,
    2,
  ),
)
console.log(
  `PASS ${checks} comprobaciones de cuentas en escritorio y móvil, sin alterar producción.`,
)

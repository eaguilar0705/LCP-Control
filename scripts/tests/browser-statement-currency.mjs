import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { browserDatabase } from './browser-database.mjs'
import { identity, admin } from './database-fixture.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5201'
assert.ok(
  ['127.0.0.1', 'lcp-control.pages.dev'].includes(new URL(base).hostname),
)
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5201, strictPort: true },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
await mkdir('output/statement-currency-review', { recursive: true })
let checks = 0
const eq = (a, b, message) => {
  assert.deepEqual(a, b, message)
  checks++
}
const money = (n, currency) =>
  new Intl.NumberFormat('es-NI', {
    style: 'currency',
    currency,
    currencyDisplay: 'code',
  })
    .format(n)
    .replaceAll('\u00a0', ' ')
const text = async (locator) =>
  (await locator.innerText()).replaceAll('\u00a0', ' ')
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      timezoneId: 'America/Managua',
    })
    const page = await context.newPage()
    const fixture = await browserDatabase(page),
      errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.setDefaultTimeout(15000)
    const navigate = (path) =>
      page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
    const login = async () => {
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
    const setRate = async (rate) => {
      await fixture.db.exec('reset role')
      await fixture.db.query(
        'update public.exchange_rates set accounting_usd_to_nio=$1',
        [rate],
      )
      await identity(fixture.db, admin)
    }
    try {
      await setRate(37)
      await fixture.db.query('select public.record_journal_entry($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          kind: 'adjustment',
          occurredOn: fixture.today,
          description: 'Salida valorizada de auditoría',
          reference: 'QA-COSTO-59063',
          currency: 'NIO',
          exchangeRate: 1,
          lines: [
            { account: '5120', debit: 59063.46, credit: 0 },
            { account: '1130', debit: 0, credit: 59063.46 },
          ],
        }),
      ])
      const source = async () =>
        (
          await fixture.db.query(
            'select public.ledger_report($1::date,$1::date) r',
            [fixture.today],
          )
        ).rows[0].r
      const before = await source()
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
      await navigate('/accounting?section=trial')
      const table = page.getByRole('region', {
        name: 'Balanza de comprobación',
        exact: true,
      })
      await table.waitFor()
      const inventory = table.getByRole('row').filter({
        has: page.getByRole('rowheader', {
          name: 'Inventario de perfumes',
          exact: true,
        }),
      })
      eq((await text(inventory)).includes(money(59063.46, 'NIO')), true)
      const selector = page.getByLabel('Moneda del reporte', { exact: true })
      await selector.selectOption('USD')
      eq((await text(inventory)).includes(money(59063.46 / 37, 'USD')), true)
      eq(
        (await text(page.locator('div.statement-heading'))).includes(
          'C$37 por US$1',
        ),
        true,
      )
      eq(
        (await text(page.locator('div.statement-heading'))).includes(
          'USD equivalentes',
        ),
        true,
      )
      const downloading = page.waitForEvent('download')
      await page
        .getByRole('button', { name: 'Descargar Excel', exact: true })
        .click()
      const download = await downloading
      eq(download.suggestedFilename().endsWith('-USD.xlsx'), true)
      const path = `output/statement-currency-review/balanza-${width}.xlsx`
      await download.saveAs(path)
      const bytes = await readFile(path)
      eq(bytes.includes(Buffer.from(`>${59063.46 / 37}<`)), true)
      eq(bytes.includes(Buffer.from('C$37 por US$1')), true)
      await page.screenshot({
        path: `output/statement-currency-review/balanza-${width}.png`,
        fullPage: true,
      })
      for (const section of [
        'Estado de resultado',
        'Estado de situación financiera',
      ]) {
        await page.getByRole('button', { name: section, exact: true }).click()
        await page
          .getByRole('heading', { name: section, exact: true })
          .waitFor()
        eq(
          (await text(page.locator('div.statement-heading'))).includes(
            'USD equivalentes',
          ),
          true,
        )
        eq(await selector.inputValue(), 'USD')
      }
      await page
        .getByRole('button', { name: 'Balanza de comprobación', exact: true })
        .click()
      await selector.selectOption('NIO')
      eq((await text(inventory)).includes(money(59063.46, 'NIO')), true)
      await setRate(38.5)
      await page.reload()
      await login()
      await navigate('/accounting?section=trial')
      await table.waitFor()
      await page
        .getByLabel('Moneda del reporte', { exact: true })
        .selectOption('USD')
      eq((await text(inventory)).includes(money(59063.46 / 38.5, 'USD')), true)
      eq(
        (await text(page.locator('div.statement-heading'))).includes(
          'C$38.5 por US$1',
        ),
        true,
      )
      eq(
        await source(),
        before,
        'consultar o exportar en otra moneda no cambia ningún asiento',
      )
      await fixture.db.exec('reset role')
      await fixture.db.exec('delete from public.exchange_rates')
      await identity(fixture.db, admin)
      await page.reload()
      await login()
      await navigate('/accounting?section=trial')
      await table.waitFor()
      eq(
        await page
          .getByLabel('Moneda del reporte', { exact: true })
          .inputValue(),
        'NIO',
      )
      await page
        .getByRole('status')
        .filter({ hasText: 'Configura el tipo de cambio' })
        .waitFor()
      eq(
        await page
          .locator('option[value="USD"]')
          .evaluate((option) => option.disabled),
        true,
      )
      eq((await text(inventory)).includes(money(59063.46, 'NIO')), true)
      eq(errors, [])
      eq(fixture.failures, [])
      eq(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
      )
      console.log(
        `PASS balanza, resultados, balance y Excel en ambas monedas ${width}px`,
      )
    } catch (e) {
      await page.screenshot({
        path: `output/statement-currency-review/error-${width}.png`,
        fullPage: true,
      })
      console.error(
        await page.locator('body').innerText(),
        errors,
        fixture.failures,
      )
      throw e
    } finally {
      await fixture.close()
      await context.close()
    }
  }
  console.log(
    `PASS ${checks} comprobaciones de estados en ambas monedas; datos aislados`,
  )
} finally {
  await browser.close()
  await server?.close()
}

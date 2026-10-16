import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
import { identity, admin } from './database-fixture.mjs'

const output = 'output/system-review'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
    })
    const page = await context.newPage()
    const fixture = await browserDatabase(page)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    try {
      await fixture.db.query('select public.open_business_day($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          openingNio: 1000,
          openingUsd: 0,
          note: '',
        }),
      ])
      await fixture.db.query('select public.create_document($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          kind: 'invoice',
          customerName: 'Cliente',
          currency: 'NIO',
          exchangeRate: 1,
          tier: 'emprendedor',
          location: 'store',
          paymentMethod: 'bac_nio',
          notes: '',
          items: [
            { productId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', quantity: 2 },
          ],
        }),
      ])
      await page.goto(
        `${process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'}/login`,
      )
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
      const day = fixture.today.replaceAll('-', '')
      await page
        .getByRole('button', { name: `VE-${day}`, exact: true })
        .waitFor()
      assert.equal(
        await page
          .getByRole('button', { name: 'Minuta de depósito', exact: true })
          .count(),
        0,
      )
      for (const prefix of ['VE', 'CV']) {
        await page
          .getByRole('button', { name: `${prefix}-${day}`, exact: true })
          .click()
        const dialog = page.getByRole('dialog')
        await dialog
          .getByRole('heading', {
            name: `Comprobante ${prefix}-${day}`,
            exact: true,
          })
          .waitFor()
        await dialog
          .getByText(
            prefix === 'VE' ? 'Ventas del día' : 'Costo de ventas del día',
            { exact: false },
          )
          .waitFor()
        assert.equal(
          await dialog
            .getByRole('button', { name: 'Anular', exact: true })
            .count(),
          0,
        )
        assert.ok(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
          'Detalle cabe en su cuadro',
        )
        const download = page.waitForEvent('download')
        await dialog
          .getByRole('button', { name: 'Descargar PDF', exact: true })
          .click()
        const pdf = await download
        assert.equal(
          pdf.suggestedFilename(),
          `comprobante-${prefix}-${day}.pdf`,
        )
        await pdf.saveAs(`${output}/comprobante-${prefix}-${width}.pdf`)
        await page.screenshot({
          path: `${output}/comprobante-${prefix}-${width}.png`,
          fullPage: true,
        })
        await dialog
          .getByRole('button', { name: 'Cerrar', exact: true })
          .click()
      }
      const refresh = async () => {
        for (const path of ['/', '/accounting']) {
          await page.evaluate((path) => {
            globalThis.history.pushState({}, '', path)
            globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
          }, path)
          await page
            .getByRole('heading', {
              name: path === '/' ? 'Inicio' : 'Contabilidad',
              exact: true,
            })
            .waitFor()
        }
        await page
          .getByRole('button', { name: `VE-${day}`, exact: true })
          .waitFor()
      }
      await fixture.db.exec('reset role')
      await fixture.db.exec(
        'update public.document_item_costs set unit_cost_nio=null',
      )
      await identity(fixture.db, admin)
      await refresh()
      await page.getByRole('button', { name: `CV-${day}`, exact: true }).click()
      let dialog = page.getByRole('dialog')
      await dialog
        .getByRole('status')
        .filter({ hasText: 'Costo pendiente en 1 factura(s).' })
        .waitFor()
      let download = page.waitForEvent('download')
      await dialog
        .getByRole('button', { name: 'Descargar PDF', exact: true })
        .click()
      await (
        await download
      ).saveAs(`${output}/comprobante-CV-sin-costo-${width}.pdf`)
      await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click()
      await fixture.db.exec('reset role')
      await fixture.db.exec('delete from public.document_item_costs')
      await identity(fixture.db, admin)
      await refresh()
      await page.getByRole('button', { name: `VE-${day}`, exact: true }).click()
      dialog = page.getByRole('dialog')
      await dialog
        .getByRole('status')
        .filter({ hasText: 'Detalle contable pendiente en 1 factura(s).' })
        .waitFor()
      assert.equal(
        await dialog
          .locator('tbody td')
          .filter({ hasText: 'Pendiente' })
          .count(),
        4,
      )
      download = page.waitForEvent('download')
      await dialog
        .getByRole('button', { name: 'Descargar PDF', exact: true })
        .click()
      await (
        await download
      ).saveAs(`${output}/comprobante-VE-sin-detalle-${width}.pdf`)
      await page.screenshot({
        path: `${output}/comprobante-VE-sin-detalle-${width}.png`,
        fullPage: true,
      })
      await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click()
      assert.deepEqual(errors, [])
      assert.deepEqual(fixture.failures, [])
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
      )
      console.log(
        `OK: comprobantes automáticos VE/CV, PDF, sin minuta ni anulación y sin desborde a ${width}px`,
      )
    } finally {
      await fixture.close()
      await context.close()
    }
  }
} finally {
  await browser.close()
}

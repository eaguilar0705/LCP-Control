import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
import { rpc } from './database-fixture.mjs'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage()
  const fixture = await browserDatabase(page)
  try {
    await rpc(fixture.db, 'open_business_day', {
      requestId: crypto.randomUUID(),
      openingNio: 1000,
      openingUsd: 0,
    })
    async function sell(currency, shippingAmount) {
      await rpc(fixture.db, 'create_document', {
        requestId: crypto.randomUUID(),
        kind: 'invoice',
        currency,
        exchangeRate: currency === 'USD' ? 36.6 : 1,
        customerName: 'Cliente',
        tier: 'emprendedor',
        location: 'store',
        paymentMethod: 'cash',
        shippingMethod: 'moto',
        shippingAmount,
        items: [
          { productId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', quantity: 1 },
        ],
      })
    }
    await sell('USD', 2)
    await page.goto(
      (process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173') + '/login',
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
    const card = page.locator('.home-chart-wide', { hasText: 'Ventas del mes' })
    await card.getByText(/^NIO\s*366\.00$/, { exact: true }).waitFor()
    await sell('NIO', 80)
    await page.evaluate(() => globalThis.dispatchEvent(new Event('focus')))
    await card.getByText(/^NIO\s*732\.00$/, { exact: true }).waitFor()
    await card.getByText(/USD\s*20\.00 equivalentes/).waitFor()
    await card.getByText('2 facturas', { exact: false }).waitFor()
    await fixture.db.exec('reset role')
    await fixture.db.exec(
      'update public.exchange_rates set accounting_usd_to_nio=37',
    )
    await fixture.db.exec('set role authenticated')
    await page.evaluate(() => globalThis.dispatchEvent(new Event('focus')))
    await card.getByText(/USD\s*19\.78 equivalentes/).waitFor()
    await card.getByRole('link', { name: 'Estado de resultados' }).click()
    const salesRow = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: '4110', exact: true }) })
    assert.match(await salesRow.innerText(), /732\.00/)
    await page.goBack()
    await card.getByText(/^NIO\s*732\.00$/).waitFor()
    const nextMonth = new Date(fixture.today + 'T12:00:00Z')
    nextMonth.setUTCDate(1)
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1)
    await page.clock.setFixedTime(nextMonth)
    await page.evaluate(() => globalThis.dispatchEvent(new Event('focus')))
    await card.getByText(/^NIO\s*0\.00$/).waitFor()
    await card.getByText('0 facturas', { exact: true }).waitFor()
    console.log(
      'Ventas del mes concilia ambas monedas, excluye envíos y se actualiza al volver a Inicio.',
    )
  } finally {
    await fixture.close()
  }
} finally {
  await browser.close()
}

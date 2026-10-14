import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Managua',
}).format(new Date())
const accounts = [
  ['1000', 'Activo', false, 'asset'],
  ['1110-001', 'Caja córdobas', true, 'asset'],
  ['1110-002', 'Caja dólares', true, 'asset'],
  ['1120-001', 'BAC C$', true, 'asset'],
  ['1120-003', 'LAFISE C$', true, 'asset'],
  ['1130', 'Inventario de perfumes', true, 'asset'],
  ['1340', 'Retenciones de IR acreditables', true, 'asset'],
  ['3110-001', 'Capital — Miguel', true, 'equity'],
  ['4110', 'Ventas', true, 'revenue'],
  ['4190', 'Otros ingresos', true, 'revenue'],
  ['5120', 'Costo de venta', true, 'cost'],
  ['5150', 'Pérdidas de inventario', true, 'expense'],
  ['5130-002', 'Alquiler', true, 'expense'],
  ['5140-001', 'Comisión de tarjetas', true, 'expense'],
  ['1142', 'Tarjetas pendientes de acreditar', true, 'asset'],
].map(([code, name, postable, bucket]) => ({
  code,
  name,
  postable,
  bucket,
  nature: ['revenue', 'equity'].includes(bucket) ? 'credit' : 'debit',
  parent: null,
  opening: 0,
  debit: 0,
  credit: 0,
  closing: 0,
}))
const browser = await chromium.launch({ channel: 'chrome', headless: true })
await mkdir('output/accounting-review', { recursive: true })
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
    })
    const page = await context.newPage()
    const errors = []
    let saved = null
    let dayStatus = 'not_opened'
    let missingCosts = 0
    page.on('pageerror', (e) => errors.push(e.message))
    await page.route('**/*.supabase.co/**', async (route) => {
      const url = new URL(route.request().url())
      const body = route.request().postDataJSON() ?? {}
      const send = (data) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(data),
        })
      if (url.pathname.includes('/auth/v1/token')) {
        const user = {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'visual@example.test',
          aud: 'authenticated',
          role: 'authenticated',
          app_metadata: {},
          user_metadata: {},
          created_at: new Date().toISOString(),
        }
        const token = [
          { alg: 'HS256', typ: 'JWT' },
          { sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 },
          'test',
        ]
          .map((v) =>
            Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString(
              'base64url',
            ),
          )
          .join('.')
        return send({
          access_token: token,
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'test-only',
          user,
        })
      }
      if (url.pathname.includes('staff_members'))
        return send({ role: 'superadmin', active: true })
      if (url.pathname.endsWith('/rpc/ledger_report'))
        return send({
          startOn: today,
          from: body.p_from,
          to: body.p_to,
          missingCosts,
          missingSales: 0,
          accounts: accounts.map((a) => {
            if (missingCosts && a.code === '1110-001')
              return {
                ...a,
                opening: 100,
                debit: 1000,
                credit: 200,
                closing: 900,
              }
            if (missingCosts && a.code === '4110')
              return { ...a, credit: 2000, closing: -2000 }
            return a
          }),
          entries: [],
        })
      if (url.pathname.endsWith('/rpc/record_journal_entry')) {
        saved = body.p_input
        return send('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      }
      if (
        url.pathname.endsWith('/rpc/open_business_day') ||
        url.pathname.endsWith('/rpc/close_business_day')
      ) {
        dayStatus = url.pathname.includes('/open_') ? 'open' : 'closed'
        return send({
          today,
          day: today,
          status: dayStatus,
          openDay: dayStatus === 'open' ? today : null,
          openingNio: 100,
          openingUsd: 0,
          report: {
            invoices: 1,
            units: 2,
            payments: [],
            products: [],
            expectedNio: 330,
            expectedUsd: 0,
            differenceNio: 0,
            differenceUsd: 0,
          },
        })
      }
      if (url.pathname.endsWith('/rpc/get_business_day'))
        return send({
          today,
          day: today,
          status: dayStatus,
          openDay: dayStatus === 'open' ? today : null,
          openingNio: 100,
          openingUsd: 0,
          report:
            dayStatus === 'not_opened'
              ? null
              : {
                  invoices: 1,
                  units: 2,
                  payments: [
                    {
                      method: 'cash',
                      currency: 'NIO',
                      amount: 230,
                      invoices: 1,
                      units: 2,
                    },
                  ],
                  products: [
                    {
                      product_id: 'test',
                      description: 'Perfume de prueba',
                      units: 2,
                    },
                  ],
                  expectedNio: 330,
                  expectedUsd: 0,
                  differenceNio: 0,
                  differenceUsd: 0,
                },
        })
      if (url.pathname.includes('business_settings'))
        return send({
          name: 'La Casa del Perfume',
          address: '',
          phone: '',
          legal_name: '',
          tax_id: '',
        })
      if (url.pathname.includes('exchange_rates'))
        return send({ usd_to_nio: 36.6, updated_at: new Date().toISOString() })
      return send([])
    })
    await page.goto(
      `${process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'}/login`,
    )
    await page
      .getByLabel('Correo electrónico', { exact: true })
      .fill('visual@example.test')
    await page
      .getByLabel('Contraseña', { exact: true })
      .fill('Test-only-Password!')
    await page
      .getByRole('button', { name: 'Iniciar sesión', exact: true })
      .click()
    await page.getByRole('heading', { name: 'Inicio', exact: true }).waitFor()
    await page
      .getByRole('button', { name: 'Abrir tienda', exact: true })
      .waitFor()
    await page.screenshot({
      path: `output/accounting-review/home-${width}.png`,
      fullPage: true,
    })
    await page
      .getByRole('button', { name: 'Abrir tienda', exact: true })
      .click()
    await page
      .getByRole('dialog')
      .getByLabel('Córdobas C$', { exact: true })
      .fill('100')
    await page
      .getByRole('dialog')
      .getByLabel('Dólares US$', { exact: true })
      .fill('0')
    await page
      .getByRole('button', { name: 'Confirmar apertura', exact: true })
      .click()
    await page
      .getByRole('heading', { name: 'Tienda abierta', exact: true })
      .waitFor()
    await page
      .getByRole('button', { name: 'Cerrar tienda', exact: true })
      .click()
    await page
      .getByRole('dialog')
      .getByLabel('Córdobas C$', { exact: true })
      .fill('330')
    await page
      .getByRole('dialog')
      .getByLabel('Dólares US$', { exact: true })
      .fill('0')
    await page
      .getByRole('button', { name: 'Confirmar cierre', exact: true })
      .click()
    await page
      .getByRole('heading', { name: 'Jornada cerrada', exact: true })
      .waitFor()
    const download = page.waitForEvent('download')
    await page
      .getByRole('button', { name: 'Reporte diario', exact: true })
      .click()
    assert.ok((await download).suggestedFilename().endsWith('.pdf'))

    // Client navigation preserves the in-memory session.
    await page.evaluate(() => {
      globalThis.history.pushState({}, '', '/accounting')
      globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
    })
    await page
      .getByRole('heading', { name: 'Comprobantes', exact: true })
      .waitFor()
    assert.ok(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth <=
          globalThis.innerWidth + 1,
      ),
      `page overflow ${width}`,
    )
    await page.screenshot({
      path: `output/accounting-review/accounting-${width}.png`,
      fullPage: true,
    })
    for (const title of [
      'Balanza de comprobación',
      'Estado de resultado',
      'Estado de situación financiera',
    ]) {
      await page.getByRole('button', { name: title, exact: true }).click()
      await page.getByRole('heading', { name: title, exact: true }).waitFor()
      assert.equal(
        await page
          .locator('.statement-table')
          .getByText('Pendiente', { exact: true })
          .count(),
        0,
        `${title} preserves known balances when the month starts before the opening`,
      )
    }

    // Reproduce the reported case: two unknown historical costs, while cash
    // and sales have recorded amounts. All three statements must stay useful.
    missingCosts = 2
    const missingFrom = today.endsWith('-01')
      ? `${Number(today.slice(0, 4)) - 1}-12-31`
      : today
    await page.getByLabel('Desde', { exact: true }).fill(missingFrom)
    await page
      .getByText('2 movimientos sin costo histórico.', { exact: true })
      .waitFor()
    const accountRow = (code) =>
      page.locator('.statement-table tbody tr').filter({
        has: page.getByText(code, { exact: true }),
      })
    for (const title of [
      'Balanza de comprobación',
      'Estado de resultado',
      'Estado de situación financiera',
    ]) {
      await page.getByRole('button', { name: title, exact: true }).click()
      await page.getByRole('heading', { name: title, exact: true }).waitFor()
      const knownCode = title === 'Estado de resultado' ? '4110' : '1110-001'
      const pendingCode = title === 'Estado de resultado' ? '5120' : '1130'
      assert.equal(
        await accountRow(knownCode)
          .getByText('Pendiente', { exact: true })
          .count(),
        0,
      )
      assert.match(
        await accountRow(knownCode).innerText(),
        title === 'Estado de resultado' ? /2,000\.00/ : /900\.00/,
      )
      assert.ok(
        await accountRow(pendingCode)
          .getByText('Pendiente', { exact: true })
          .count(),
      )
      assert.ok(
        await page
          .locator('.statement-total')
          .getByText('Pendiente', { exact: true })
          .count(),
      )
      await page.screenshot({
        path: `output/accounting-review/missing-costs-${knownCode === '4110' ? 'income' : title === 'Balanza de comprobación' ? 'trial' : 'balance'}-${width}.png`,
        fullPage: true,
      })
    }
    missingCosts = 0
    await page
      .getByLabel('Desde', { exact: true })
      .fill(today.slice(0, 7) + '-01')
    await page
      .getByText('2 movimientos sin costo histórico.', { exact: true })
      .waitFor({ state: 'hidden' })
    await page
      .getByRole('button', { name: 'Comprobantes', exact: true })
      .click()
    await page
      .getByRole('button', { name: 'Liquidación de tarjetas', exact: true })
      .click()
    const dialog = page.getByRole('dialog')
    await dialog
      .getByLabel('Concepto', { exact: true })
      .fill('Liquidación BAC del día')
    await dialog
      .getByLabel('Banco que acredita', { exact: true })
      .selectOption('1120-001')
    await dialog
      .getByLabel('Venta bruta liquidada', { exact: true })
      .fill('1000')
    await dialog
      .getByLabel('Comisión bancaria (%)', { exact: true })
      .fill('4.5')
    await dialog.getByLabel('Retención IR (%)', { exact: true }).fill('1.5')
    await page.screenshot({
      path: `output/accounting-review/card-${width}.png`,
      fullPage: true,
    })
    assert.ok(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      `dialog overflow ${width}`,
    )
    await dialog
      .getByRole('button', { name: 'Guardar comprobante', exact: true })
      .click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(saved.lines.find((l) => l.account === '1120-001').debit, 940)
    assert.equal(saved.lines.find((l) => l.account === '1340').debit, 15)
    assert.deepEqual(errors, [])
    console.log(
      `PASS browser ${width}px: login, day panel, known balances with two missing costs, journal navigation, card calculation, save and no horizontal overflow`,
    )
    await context.close()
  }
} finally {
  await browser.close()
}

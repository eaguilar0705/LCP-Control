import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

const output = 'output/day-contingencies'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const fixture = await browserDatabase(page)
    const rpc = async (name, payload) =>
      (
        await fixture.db.query(`select public.${name}($1::jsonb) result`, [
          JSON.stringify(payload),
        ])
      ).rows[0].result
    const state = async () =>
      (await fixture.db.query('select public.get_business_day(null) result'))
        .rows[0].result
    const focus = () =>
      page.evaluate(() =>
        globalThis.dispatchEvent(new globalThis.Event('focus')),
      )
    try {
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
      await page
        .getByRole('button', { name: 'Abrir tienda', exact: true })
        .click()
      let dialog = page.getByRole('dialog')
      await dialog.getByLabel('Córdobas C$', { exact: true }).fill('1000')
      await dialog.getByLabel('Dólares US$', { exact: true }).fill('0')

      // Se adelanta sólo la respuesta de lectura. La fecha del servidor real no
      // se modifica: esta prueba comprueba la fecha congelada y reconfirmación.
      const tomorrow = (
        await fixture.db.query(
          "select ((now() at time zone 'America/Managua')::date+1)::text as day",
        )
      ).rows[0].day
      let shiftDay = true
      const shift = async (route) => {
        if (!shiftDay) return route.fallback()
        const current = await state()
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            ...current,
            today: tomorrow,
            day: tomorrow,
            status: 'not_opened',
            stateToken: 'tomorrow',
          }),
        })
      }
      await page.route('**/rest/v1/rpc/get_business_day', shift)
      const frozenDate = await dialog.locator('.day-dialog-date').innerText()
      await focus()
      await dialog
        .getByText('La fecha o el estado de la tienda cambió.', { exact: true })
        .waitFor()
      assert.equal(
        await dialog.locator('.day-dialog-date').innerText(),
        frozenDate,
      )
      assert.equal(
        await dialog.getByLabel('Córdobas C$', { exact: true }).inputValue(),
        '1000',
      )
      assert.equal(
        await dialog
          .getByRole('button', { name: 'Confirmar apertura', exact: true })
          .isDisabled(),
        true,
      )
      await dialog
        .getByRole('button', { name: 'Actualizar jornada', exact: true })
        .click()
      await assert.doesNotReject(async () => {
        await page.waitForFunction(
          (old) =>
            globalThis.document.querySelector('.day-dialog-date')
              ?.textContent !== old,
          frozenDate,
        )
      })
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      shiftDay = false
      await focus()
      await page
        .getByRole('button', { name: 'Abrir tienda', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      await dialog.getByLabel('Córdobas C$', { exact: true }).fill('1000')
      await dialog.getByLabel('Dólares US$', { exact: true }).fill('0')

      // La base confirma, pero se pierde la respuesta. El segundo envío debe
      // llevar exactamente el mismo identificador y no crear otra jornada.
      const lost = new Map()
      for (const operation of ['open', 'close', 'reopen']) {
        let first = true
        const ids = []
        lost.set(operation, ids)
        await page.route(
          `**/rest/v1/rpc/${operation}_business_day`,
          async (route) => {
            const input = route.request().postDataJSON().p_input
            ids.push(input.requestId)
            if (!first) return route.fallback()
            first = false
            await rpc(`${operation}_business_day`, input)
            return route.abort('failed')
          },
        )
      }
      await dialog
        .getByRole('button', { name: 'Confirmar apertura', exact: true })
        .click()
      await dialog.getByText(/No pudimos confirmar la operación/).waitFor()
      await dialog
        .getByRole('button', { name: 'Confirmar apertura', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(lost.get('open').length, 2)
      assert.equal(lost.get('open')[0], lost.get('open')[1])
      assert.equal((await state()).openingNio, 1000)

      await page
        .getByRole('button', { name: 'Cerrar tienda', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      await dialog.getByLabel('Córdobas C$', { exact: true }).fill('1000')
      await dialog.getByLabel('Dólares US$', { exact: true }).fill('0')
      await rpc('create_document', {
        requestId: crypto.randomUUID(),
        kind: 'invoice',
        customerName: 'Venta mientras se cuenta caja',
        currency: 'NIO',
        exchangeRate: 1,
        tier: 'emprendedor',
        location: 'store',
        paymentMethod: 'cash',
        items: [
          { productId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', quantity: 1 },
        ],
      })
      await focus()
      await dialog
        .getByText('La jornada cambió desde que abriste este formulario.', {
          exact: true,
        })
        .waitFor()
      assert.equal(
        await dialog
          .getByRole('button', { name: 'Confirmar cierre', exact: true })
          .isDisabled(),
        true,
      )
      await dialog
        .getByRole('button', {
          name: 'Actualizar importes del cierre',
          exact: true,
        })
        .click()
      await dialog
        .locator('.day-count-preview')
        .getByText(/1,366.00/)
        .waitFor()
      assert.equal(
        await dialog.getByLabel('Córdobas C$', { exact: true }).inputValue(),
        '1000',
      )
      assert.equal(
        await dialog
          .getByLabel('Observación / motivo de diferencia', { exact: true })
          .getAttribute('required'),
        '',
      )
      await dialog.getByLabel('Córdobas C$', { exact: true }).fill('1366')
      assert.equal(
        await dialog
          .getByLabel('Observación / motivo de diferencia', { exact: true })
          .getAttribute('required'),
        null,
      )
      await dialog.evaluate((el) => {
        el.scrollTop = 0
      })
      await dialog.screenshot({ path: `${output}/resumen-cierre-${width}.png` })
      await dialog
        .getByRole('button', { name: 'Confirmar cierre', exact: true })
        .click()
      await dialog.getByText(/No pudimos confirmar la operación/).waitFor()
      await dialog
        .getByRole('button', { name: 'Confirmar cierre', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(lost.get('close')[0], lost.get('close')[1])
      const firstClosure = structuredClone((await state()).report)
      await page.locator('.day-history summary').click()
      await page
        .getByRole('button', {
          name: 'PDF del cierre · revisión 1',
          exact: true,
        })
        .waitFor()
      const firstPdf = page.waitForEvent('download')
      await page
        .getByRole('button', {
          name: 'PDF del cierre · revisión 1',
          exact: true,
        })
        .click()
      await (await firstPdf).saveAs(`${output}/cierre-original-${width}.pdf`)

      await page
        .getByRole('button', { name: 'Reabrir jornada', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      assert.equal(
        await dialog
          .getByLabel('Motivo de reapertura')
          .getAttribute('minlength'),
        '10',
      )
      await dialog
        .getByLabel('Motivo de reapertura')
        .fill('Cierre accidental antes de terminar las ventas')
      await dialog
        .getByRole('button', { name: 'Confirmar reapertura', exact: true })
        .click()
      await dialog.getByText(/No pudimos confirmar la operación/).waitFor()
      await dialog
        .getByRole('button', { name: 'Confirmar reapertura', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(lost.get('reopen')[0], lost.get('reopen')[1])
      await page
        .getByRole('heading', { name: 'Tienda abierta', exact: true })
        .waitFor()
      assert.equal((await state()).reopenCount, 1)
      assert.equal((await state()).openingNio, 1000)
      const history = (
        await fixture.db.query(
          'select public.get_business_day_history($1) result',
          [fixture.today],
        )
      ).rows[0].result
      assert.equal(history.length, 2)
      const historyReport = history.find((row) => row.event === 'close').report
      for (const [key, value] of Object.entries(firstClosure))
        assert.deepEqual(historyReport[key], value)

      // El primer cierre no desaparece al continuar operando y cerrar otra vez.
      await rpc('create_document', {
        requestId: crypto.randomUUID(),
        kind: 'invoice',
        customerName: 'Venta posterior a reapertura',
        currency: 'NIO',
        exchangeRate: 1,
        tier: 'emprendedor',
        location: 'store',
        paymentMethod: 'cash',
        items: [
          { productId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002', quantity: 1 },
        ],
      })
      await focus()
      await page
        .getByRole('button', { name: 'Cerrar tienda', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      await dialog.getByLabel('Córdobas C$', { exact: true }).fill('1732')
      await dialog.getByLabel('Dólares US$', { exact: true }).fill('0')
      await dialog
        .getByRole('button', { name: 'Confirmar cierre', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      await page
        .getByRole('button', {
          name: 'PDF del cierre · revisión 3',
          exact: true,
        })
        .waitFor()
      assert.equal(
        await page
          .getByRole('button', {
            name: 'PDF del cierre · revisión 1',
            exact: true,
          })
          .count(),
        1,
      )
      const final = await state()
      assert.equal(final.report.invoices, 2)
      assert.equal(final.report.expectedNio, 1732)
      assert.equal(final.report.differenceNio, 0)
      assert.equal(final.day, fixture.today)
      assert.equal(final.revision, 3)
      assert.equal(
        (await fixture.db.query('select count(*)::int n from public.documents'))
          .rows[0].n,
        2,
      )
      assert.deepEqual(fixture.failures, [])
      assert.deepEqual(errors, [])
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
      )
      await page.screenshot({
        path: `${output}/historial-${width}.png`,
        fullPage: true,
      })
      // Una jornada antigua pendiente sigue accesible y vuelve a hoy tras el
      // cierre. La creación directa es sólo preparación de la base desechable.
      const yesterday = (
        await fixture.db.query(
          "select ((now() at time zone 'America/Managua')::date-1)::text as day",
        )
      ).rows[0].day
      await fixture.db.exec(`reset role;
        insert into public.business_days(day,opening_nio,opening_usd,opened_at,opened_by,opening_request,opening_payload)
        values((now() at time zone 'America/Managua')::date-1,500,0,now()-interval '1 day',auth.uid(),gen_random_uuid(),'{}');
        set role authenticated;`)
      await focus()
      await page
        .getByRole('button', { name: /Cerrar jornada pendiente del/ })
        .click()
      await page
        .getByRole('heading', { name: 'Tienda abierta', exact: true })
        .waitFor()
      assert.equal(
        await page
          .getByLabel('Consultar jornada', { exact: true })
          .inputValue(),
        yesterday,
      )
      await page
        .getByRole('button', { name: 'Cerrar tienda', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      await dialog.getByLabel('Córdobas C$', { exact: true }).fill('500')
      await dialog.getByLabel('Dólares US$', { exact: true }).fill('0')
      assert.equal(
        await dialog
          .getByLabel('Observación / motivo de diferencia', { exact: true })
          .getAttribute('minlength'),
        '10',
      )
      await dialog
        .getByLabel('Observación / motivo de diferencia', { exact: true })
        .fill('Cierre pendiente por interrupción eléctrica')
      await dialog
        .getByRole('button', { name: 'Confirmar cierre', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      await page
        .getByRole('button', { name: 'Reabrir jornada', exact: true })
        .waitFor()
      assert.equal(
        await page
          .getByLabel('Consultar jornada', { exact: true })
          .inputValue(),
        fixture.today,
      )
      let releaseHistory
      const waitHistory = new Promise((resolve) => {
        releaseHistory = resolve
      })
      const delayHistory = async (route) => {
        if (route.request().postDataJSON().p_day === yesterday)
          await waitHistory
        return route.fallback()
      }
      await page.route('**/rest/v1/rpc/get_business_day_history', delayHistory)
      await page
        .getByLabel('Consultar jornada', { exact: true })
        .fill(yesterday)
      await page
        .locator('.day-history')
        .getByText('Cargando historial…', { exact: true })
        .waitFor({ state: 'attached' })
      assert.equal(
        await page.locator('.day-history-event').count(),
        0,
        'Nunca mostrar cierres de otra fecha durante la consulta',
      )
      releaseHistory()
      await page
        .locator('.day-history')
        .getByText('Cierre pendiente por interrupción eléctrica', {
          exact: true,
        })
        .waitFor({ state: 'attached' })
      assert.equal(await page.locator('.day-history-event').count(), 1)
      await page.unroute(
        '**/rest/v1/rpc/get_business_day_history',
        delayHistory,
      )
      assert.deepEqual(fixture.failures, [])
      assert.deepEqual(errors, [])
      console.log(
        `PASS jornadas ${width}px: cambio de fecha, cierre tardío y regreso a hoy, ventas concurrentes, comparación de caja, reapertura, historial/PDF y respuesta perdida sin duplicados`,
      )
    } finally {
      await fixture.close()
      await context.close()
    }
  }
} finally {
  await browser.close()
}

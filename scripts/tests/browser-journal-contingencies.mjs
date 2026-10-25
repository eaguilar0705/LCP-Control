import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
import { identity, admin } from './database-fixture.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) ||
    new URL(base).origin === 'https://lcp-control.pages.dev',
)
// Incluso con el frontend publicado, browserDatabase intercepta la API y
// ejecuta cada escritura exclusivamente en PostgreSQL local desechable.
const output = process.env.LCP_TEST_OUTPUT ?? 'output/journal-contingencies'
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
    const one = async (sql, parameters = []) =>
      (await fixture.db.query(sql, parameters)).rows[0]
    const healthy = async (name) => {
      equal(errors, [], name + ': navegador')
      equal(fixture.failures, [], name + ': API')
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        name + ': página dentro de pantalla',
      )
      for (const dialog of await page.getByRole('dialog').all())
        equal(
          await dialog.evaluate(
            (element) => element.scrollWidth > element.clientWidth + 1,
          ),
          false,
          name + ': diálogo dentro de pantalla',
        )
    }
    try {
      const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
      await fixture.db.exec('reset role')
      await fixture.db.query(
        "update public.product_prices set amount=case when currency='USD' then 6 else 219.60 end where product_id=$1",
        [product],
      )
      await identity(fixture.db, admin)
      await fixture.db.query('select public.open_business_day($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          openingNio: 1000,
          openingUsd: 0,
          expectedDay: fixture.today,
        }),
      ])
      await fixture.db.query('select public.create_document($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          kind: 'invoice',
          customerName: 'Pago POS en dólares',
          tier: 'emprendedor',
          currency: 'USD',
          exchangeRate: 36.6,
          location: 'store',
          paymentMethod: 'card_pos',
          notes: '',
          items: [{ productId: product, quantity: 1 }],
        }),
      ])
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
      const homePath = new URL(page.url()).pathname
      await page.evaluate(() => {
        globalThis.history.pushState({}, '', '/accounting')
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      })
      await page
        .getByRole('button', { name: 'Liquidación de tarjetas', exact: true })
        .click()
      let dialog = page.getByRole('dialog')
      await dialog
        .getByLabel('Concepto', { exact: true })
        .fill('Liquidación USD con redondeo y respuesta perdida')
      await dialog
        .getByLabel('Referencia / número de documento', { exact: true })
        .fill('POS-USD-' + width)
      await dialog.getByLabel('Moneda', { exact: true }).selectOption('USD')
      await dialog.getByLabel('Tipo de cambio', { exact: true }).fill('36.6')
      await dialog
        .getByLabel('Banco que acredita', { exact: true })
        .selectOption('1120-002')
      await dialog
        .getByLabel('Venta bruta liquidada', { exact: true })
        .fill('6')
      // Error humano en tasas: el cálculo local debe explicar el problema y
      // conservar los datos, sin enviar un comprobante inválido al servidor.
      await dialog
        .getByLabel('Comisión bancaria (%)', { exact: true })
        .fill('60')
      await dialog.getByLabel('Retención IR (%)', { exact: true }).fill('50')
      await dialog
        .getByRole('button', { name: 'Guardar comprobante', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'Las deducciones superan el importe liquidado.' })
        .waitFor()
      equal(
        await dialog
          .getByLabel('Comisión bancaria (%)', { exact: true })
          .inputValue(),
        '60',
      )
      equal(
        await dialog
          .getByLabel('Retención IR (%)', { exact: true })
          .inputValue(),
        '50',
      )
      equal(
        await dialog
          .getByLabel('Venta bruta liquidada', { exact: true })
          .inputValue(),
        '6',
      )
      equal(
        await dialog.getByLabel('Tipo de cambio', { exact: true }).inputValue(),
        '36.6',
      )
      equal(
        await dialog
          .getByLabel('Banco que acredita', { exact: true })
          .inputValue(),
        '1120-002',
      )
      equal(
        (
          await one(
            "select count(*)::int n from public.journal_entries where kind<>'opening'",
          )
        ).n,
        0,
        'tasas inválidas no guardan comprobantes',
      )
      await healthy('aviso de deducciones ' + width)
      await dialog
        .getByLabel('Comisión bancaria (%)', { exact: true })
        .fill('4.5')
      await dialog.getByLabel('Retención IR (%)', { exact: true }).fill('1.5')
      await dialog
        .getByLabel('Base de retención', { exact: true })
        .selectOption('gross')
      const status = dialog
        .getByRole('status')
        .filter({ hasText: 'Ajuste de redondeo al banco' })
      await status.waitFor()
      assert.match(await status.innerText(), /219\.60.*219\.60.*0\.01/)
      checks++
      equal(
        await dialog
          .getByRole('button', { name: 'Guardar comprobante', exact: true })
          .isEnabled(),
        true,
      )
      await healthy('liquidación preparada ' + width)
      await page.screenshot({
        path: `${output}/liquidacion-usd-${width}.png`,
        fullPage: false,
      })

      // El banco recibe el centavo NIO, manteniendo USD 5.64 de neto. Si la
      // respuesta se pierde, reintentar conserva la misma liquidación.
      let lost = false
      const ids = []
      const lostResponse = async (route) => {
        const input = route.request().postDataJSON().p_input
        ids.push(input.requestId)
        if (ids.length >= 2 && ids.length <= 5)
          return route.fulfill({
            status: [500, 502, 403, 429][ids.length - 2],
            contentType: 'application/json',
            body: JSON.stringify({
              code:
                ids.length === 4
                  ? '42501'
                  : ids.length === 5
                    ? 'LCP429'
                    : 'XX000',
              message:
                ids.length === 5
                  ? 'Espera un momento para verificar la operación.'
                  : 'DETALLE_TECNICO_PRIVADO_QUE_NO_DEBE_APARECER',
            }),
          })
        if (lost) return route.fallback()
        lost = true
        await fixture.db.query(
          'select public.record_journal_entry($1::jsonb)',
          [JSON.stringify(input)],
        )
        await route.abort('failed')
      }
      await page.route('**/rest/v1/rpc/record_journal_entry', lostResponse)
      await dialog
        .getByRole('button', { name: 'Guardar comprobante', exact: true })
        .click()
      await dialog.getByRole('alert').waitFor()
      equal(
        await dialog
          .getByLabel('Venta bruta liquidada', { exact: true })
          .inputValue(),
        '6',
      )
      equal(
        await dialog.getByLabel('Concepto', { exact: true }).inputValue(),
        'Liquidación USD con redondeo y respuesta perdida',
      )
      equal(
        (
          await one(
            "select count(*)::int n from public.journal_entries where kind='card_settlement'",
          )
        ).n,
        1,
      )
      const assertPending = async () => {
        for (const label of [
          'Concepto',
          'Referencia / número de documento',
          'Moneda',
          'Tipo de cambio',
          'Banco que acredita',
          'Venta bruta liquidada',
          'Comisión bancaria (%)',
          'Retención IR (%)',
          'Base de retención',
        ])
          equal(
            await dialog.getByLabel(label, { exact: true }).isDisabled(),
            true,
            `${label} queda bloqueado hasta confirmar`,
          )
        const cancel = dialog.getByRole('button', {
          name: 'Cancelar',
          exact: true,
        })
        if (await cancel.isEnabled()) await cancel.click()
        else await cancel.evaluate((button) => button.click())
        equal(
          await dialog.isVisible(),
          true,
          'Cancelar no oculta una operación pendiente',
        )
        await page.keyboard.press('Escape')
        equal(
          await dialog.isVisible(),
          true,
          'Escape conserva la confirmación pendiente',
        )
        equal(
          (await page.locator('body').innerText()).includes(
            'DETALLE_TECNICO_PRIVADO',
          ),
          false,
        )
        equal(
          (
            await one(
              "select count(*)::int n from public.journal_entries where kind='card_settlement'",
            )
          ).n,
          1,
        )
      }
      await assertPending()
      await page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, homePath)
      await page.getByRole('heading', { name: 'Inicio', exact: true }).waitFor()
      await page
        .getByRole('link', { name: 'Verificar comprobante', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      await dialog
        .getByRole('button', { name: 'Verificar guardado', exact: true })
        .waitFor()
      equal(
        await dialog
          .getByLabel('Venta bruta liquidada', { exact: true })
          .inputValue(),
        '6',
        'Navegar y volver restaura el importe original',
      )
      equal(
        await dialog
          .getByLabel('Referencia / número de documento', { exact: true })
          .inputValue(),
        'POS-USD-' + width,
      )
      await assertPending()
      for (const [expectedAttempts, expectedMessage] of [
        [2, 'No pudimos confirmar si el comprobante se guardó.'],
        [3, 'No pudimos confirmar si el comprobante se guardó.'],
        [4, 'No tienes permiso para esta operación.'],
        [5, 'Espera un momento para verificar la operación.'],
      ]) {
        await dialog
          .getByRole('button', { name: 'Verificar guardado', exact: true })
          .click()
        await dialog
          .getByRole('alert')
          .filter({
            hasText: expectedMessage,
          })
          .waitFor()
        equal(ids.length, expectedAttempts)
        await assertPending()
      }
      await dialog
        .getByRole('button', { name: 'Verificar guardado', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      await page.unroute('**/rest/v1/rpc/record_journal_entry', lostResponse)
      equal(ids.length, 6)
      equal(new Set(ids).size, 1, 'Todos los reintentos conservan idempotencia')
      equal(
        (
          await one(
            "select count(*)::int n from public.journal_entries where kind='card_settlement'",
          )
        ).n,
        1,
      )
      const entry = await one(
        "select id,number from public.journal_entries where kind='card_settlement'",
      )
      const amounts = await one(
        'select sum(debit)::text debit,sum(credit)::text credit,sum(debit_nio)::text debit_nio,sum(credit_nio)::text credit_nio from public.journal_lines where entry_id=$1',
        [entry.id],
      )
      equal(
        Object.fromEntries(
          Object.entries(amounts).map(([key, amount]) => [key, Number(amount)]),
        ),
        { debit: 6, credit: 6, debit_nio: 219.6, credit_nio: 219.6 },
        'liquidación cuadra en ambas monedas',
      )
      const bank = await one(
        "select debit::text original,debit_nio::text nio from public.journal_lines where entry_id=$1 and account='1120-002'",
        [entry.id],
      )
      equal(
        { original: Number(bank.original), nio: Number(bank.nio) },
        { original: 5.64, nio: 206.43 },
        'redondeo exclusivo en banco',
      )
      const remaining = (
        await fixture.db.query(
          "select account,debit::text debit,debit_nio::text debit_nio,credit::text credit,credit_nio::text credit_nio from public.journal_lines where entry_id=$1 and account<>'1120-002' order by account",
          [entry.id],
        )
      ).rows
      equal(
        remaining.map((row) => ({
          account: row.account,
          debit: Number(row.debit),
          debitNio: Number(row.debit_nio),
          credit: Number(row.credit),
          creditNio: Number(row.credit_nio),
        })),
        [
          {
            account: '1142',
            debit: 0,
            debitNio: 0,
            credit: 6,
            creditNio: 219.6,
          },
          {
            account: '1340',
            debit: 0.09,
            debitNio: 3.29,
            credit: 0,
            creditNio: 0,
          },
          {
            account: '5140-001',
            debit: 0.27,
            debitNio: 9.88,
            credit: 0,
            creditNio: 0,
          },
        ],
        'comisión, retención y POS conservan sus importes',
      )
      const reference = `CP-${String(entry.number).padStart(6, '0')}`
      await page.getByRole('button', { name: reference, exact: true }).click()
      dialog = page.getByRole('dialog')
      await dialog
        .getByRole('heading', { name: 'Comprobante ' + reference, exact: true })
        .waitFor()
      await dialog.getByText('1120-002 · BAC US$', { exact: true }).waitFor()
      const download = page.waitForEvent('download')
      await dialog
        .getByRole('button', { name: 'Descargar PDF', exact: true })
        .click()
      const pdf = await download
      equal(pdf.suggestedFilename(), `comprobante-${reference}.pdf`)
      await pdf.saveAs(`${output}/liquidacion-usd-${width}.pdf`)
      await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click()
      await healthy('liquidación guardada ' + width)

      // Medio centavo exacto: 53 × 4.5% debe ser 2.39, como PostgreSQL;
      // la coma flotante no puede bloquear una liquidación calculada.
      await fixture.db.exec('reset role')
      await fixture.db.query(
        "update public.product_prices set amount=53 where product_id=$1 and currency='USD'",
        [product],
      )
      await identity(fixture.db, admin)
      await fixture.db.query('select public.create_document($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          kind: 'invoice',
          customerName: 'POS de medio centavo',
          tier: 'emprendedor',
          currency: 'USD',
          exchangeRate: 36.6,
          paymentMethod: 'card_pos',
          location: 'store',
          items: [{ productId: product, quantity: 1 }],
        }),
      ])
      await page
        .getByRole('button', { name: 'Liquidación de tarjetas', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      await dialog
        .getByLabel('Concepto', { exact: true })
        .fill('Liquidación US$53 con medio centavo exacto')
      await dialog
        .getByLabel('Referencia / número de documento', { exact: true })
        .fill('POS-53-' + width)
      await dialog.getByLabel('Moneda', { exact: true }).selectOption('USD')
      await dialog.getByLabel('Tipo de cambio', { exact: true }).fill('36.6')
      await dialog
        .getByLabel('Banco que acredita', { exact: true })
        .selectOption('1120-002')
      await dialog
        .getByLabel('Venta bruta liquidada', { exact: true })
        .fill('53')
      await dialog
        .getByLabel('Comisión bancaria (%)', { exact: true })
        .fill('4.5')
      await dialog.getByLabel('Retención IR (%)', { exact: true }).fill('1.5')
      assert.match(
        await dialog.locator('.day-closing').innerText(),
        /2\.39[\s\S]*0\.80[\s\S]*49\.81/,
      )
      checks++
      await page.screenshot({
        path: `${output}/liquidacion-53-${width}.png`,
        fullPage: false,
      })
      await dialog
        .getByRole('button', { name: 'Guardar comprobante', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      const exactFee = await one(
        "select l.debit::text fee,l.debit_nio::text fee_nio from public.journal_entries e join public.journal_lines l on l.entry_id=e.id where e.reference=$1 and l.account='5140-001'",
        ['POS-53-' + width],
      )
      equal(
        { fee: Number(exactFee.fee), nio: Number(exactFee.fee_nio) },
        { fee: 2.39, nio: 87.47 },
        'Comisión de medio centavo coincide entre pantalla y base',
      )
      await healthy('medio centavo guardado ' + width)

      // Un comprobante manual desequilibrado da una explicación y permite
      // corregirlo en su lugar, sin enviar partidas incorrectas a la base.
      await page
        .getByRole('button', { name: 'Comprobante de ajuste', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      await dialog
        .getByLabel('Concepto', { exact: true })
        .fill('Ajuste manual con importe equivocado')
      await dialog
        .getByLabel('Cuenta 1', { exact: true })
        .selectOption('1110-001')
      await dialog
        .getByLabel('Cuenta 2', { exact: true })
        .selectOption('3110-001')
      await dialog.getByLabel('Debe', { exact: true }).nth(0).fill('10')
      await dialog.getByLabel('Haber', { exact: true }).nth(1).fill('9')
      await dialog
        .getByRole('button', { name: 'Guardar comprobante', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'El Debe y el Haber deben sumar lo mismo.' })
        .waitFor()
      equal(
        await dialog.getByLabel('Debe', { exact: true }).nth(0).inputValue(),
        '10',
      )
      equal(
        await dialog.getByLabel('Haber', { exact: true }).nth(1).inputValue(),
        '9',
      )
      equal(
        await dialog.getByLabel('Concepto', { exact: true }).inputValue(),
        'Ajuste manual con importe equivocado',
      )
      equal(
        (
          await one(
            "select count(*)::int n from public.journal_entries where kind='adjustment'",
          )
        ).n,
        0,
      )
      await healthy('aviso de descuadre ' + width)
      await page.screenshot({
        path: `${output}/ajuste-desequilibrado-${width}.png`,
        fullPage: false,
      })
      await dialog.getByLabel('Haber', { exact: true }).nth(1).fill('10')
      equal(
        await dialog.getByRole('alert').count(),
        0,
        'se retira el aviso al corregir el importe',
      )
      let rejectedByServer = false
      const serverValidation = async (route) => {
        if (rejectedByServer) return route.fallback()
        rejectedByServer = true
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'P0001',
            message: 'Revisa la cuenta seleccionada antes de guardar.',
          }),
        })
      }
      await page.route('**/rest/v1/rpc/record_journal_entry', serverValidation)
      await dialog
        .getByRole('button', { name: 'Guardar comprobante', exact: true })
        .click()
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'Revisa la cuenta seleccionada antes de guardar.' })
        .waitFor()
      equal(
        await dialog.getByLabel('Concepto', { exact: true }).isEnabled(),
        true,
        'Un rechazo SQL definitivo permite corregir',
      )
      equal(
        await dialog
          .getByRole('button', { name: 'Cancelar', exact: true })
          .isEnabled(),
        true,
      )
      equal(
        (
          await one(
            "select count(*)::int n from public.journal_entries where kind='adjustment'",
          )
        ).n,
        0,
      )
      await page.unroute(
        '**/rest/v1/rpc/record_journal_entry',
        serverValidation,
      )
      await dialog
        .getByRole('button', { name: 'Guardar comprobante', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      equal(
        (
          await one(
            "select count(*)::int n from public.journal_entries where kind='adjustment'",
          )
        ).n,
        1,
      )
      equal(
        (
          await one(
            "select sum(l.debit_nio-l.credit_nio)::text delta from public.journal_lines l join public.journal_entries e on e.id=l.entry_id where e.kind='adjustment'",
          )
        ).delta,
        '0.00',
      )
      await healthy('ajuste corregido ' + width)

      // Los errores técnicos de lectura se ocultan; reconsultar no modifica
      // las partidas y permite recuperar la misma pantalla.
      let rejectRead = true
      const badRead = async (route) => {
        if (!rejectRead) return route.fallback()
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'XX000',
            message: 'DETALLE_SQL_PRIVADO_NO_MOSTRAR',
          }),
        })
      }
      await page.route('**/rest/v1/rpc/ledger_report', badRead)
      await page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, homePath)
      await page.getByRole('heading', { name: 'Inicio', exact: true }).waitFor()
      await page.evaluate(() => {
        globalThis.history.pushState({}, '', '/accounting')
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      })
      await page
        .getByRole('alert')
        .filter({ hasText: 'No pudimos completar la operación contable.' })
        .waitFor()
      equal(
        (await page.locator('body').innerText()).includes(
          'DETALLE_SQL_PRIVADO',
        ),
        false,
        'No se filtra detalle SQL de lectura',
      )
      equal(
        (
          await one(
            "select count(*)::int n from public.journal_entries where kind<>'opening'",
          )
        ).n,
        3,
      )
      rejectRead = false
      await page
        .getByRole('button', { name: 'Reintentar', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Liquidación de tarjetas', exact: true })
        .waitFor()
      await page.unroute('**/rest/v1/rpc/ledger_report', badRead)
      await healthy('lectura recuperada ' + width)
      results.push({ width, status: 'passed', checks })
      console.log(
        `PASS comprobantes ${width}px: POS USD6/36.6/4.5%/1.5%, redondeo C$0.01 atribuido a banco, respuesta perdida recuperada sin duplicar, detalle/PDF y ajuste manual corregible`,
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
  `OK: ${checks} comprobaciones de redondeo y correcciones de comprobantes`,
)

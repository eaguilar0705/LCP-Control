import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5198'
assert(
  ['127.0.0.1', 'localhost', 'lcp-control.pages.dev'].includes(
    new URL(base).hostname,
  ),
)
const output = 'output/opening-journal-correction'
await mkdir(output, { recursive: true })
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5198, strictPort: true },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let checks = 0
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const results = []
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      acceptDownloads: true,
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const fixture = await browserDatabase(page)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const one = async (sql, values = []) =>
      (await fixture.db.query(sql, values)).rows[0]
    const call = async (name, input) =>
      (await one(`select public.${name}($1::jsonb) r`, [JSON.stringify(input)]))
        .r
    const id = (
      await one("select id from public.journal_entries where kind='opening'")
    ).id
    const detail = async () =>
      (await one('select public.get_journal_entry($1) r', [id])).r
    const overflow = async () => {
      eq(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
      )
      eq(
        await page
          .getByRole('dialog')
          .evaluate((d) => d.scrollWidth > d.clientWidth + 1),
        false,
      )
    }
    try {
      let lostResponse = true,
        writes = 0
      await page.route(
        '**/rest/v1/rpc/correct_opening_journal',
        async (route) => {
          writes++
          if (!lostResponse) return route.fallback()
          lostResponse = false
          await call(
            'correct_opening_journal',
            route.request().postDataJSON().p_input,
          )
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 'NETWORK_TEST',
              message: 'Prueba de respuesta perdida',
            }),
          })
        },
      )
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
      await page.getByRole('button', { name: 'CP-000001', exact: true }).click()
      let dialog = page.getByRole('dialog')
      await dialog
        .getByRole('button', { name: 'Editar apertura', exact: true })
        .click()
      await dialog
        .getByRole('heading', {
          name: 'Editar apertura CP-000001',
          exact: true,
        })
        .waitFor()
      eq(
        await dialog
          .getByRole('button', { name: 'Guardar cambios', exact: true })
          .isDisabled(),
        true,
      )
      eq(
        await dialog.getByLabel('Debe 2', { exact: true }).isDisabled(),
        true,
        'inventario valorizado protegido',
      )
      eq(await dialog.getByLabel(/motivo/i).count(), 0, 'no exige motivo')
      await dialog.getByLabel('Debe 1', { exact: true }).fill('1500')
      await dialog
        .getByRole('button', { name: 'Guardar cambios', exact: true })
        .click()
      await dialog
        .getByText(/El Debe y el Haber deben sumar lo mismo/)
        .waitFor()
      eq(writes, 0, 'no envía un comprobante descuadrado')
      await dialog
        .getByRole('button', { name: 'Cuadrar patrimonio', exact: true })
        .click()
      eq(
        await dialog.getByLabel('Haber 3', { exact: true }).inputValue(),
        '781500',
      )
      await overflow()
      await page.screenshot({
        path: `${output}/editar-apertura-${width}.png`,
        fullPage: true,
      })
      await dialog
        .getByRole('button', { name: 'Guardar cambios', exact: true })
        .click()
      await dialog
        .getByRole('button', { name: 'Verificar guardado', exact: true })
        .waitFor()
      eq(await dialog.getByLabel('Debe 1', { exact: true }).isDisabled(), true)
      await dialog
        .getByRole('button', { name: 'Verificar guardado', exact: true })
        .click()
      await dialog
        .getByRole('button', { name: 'Editar apertura', exact: true })
        .waitFor()
      eq(writes, 2)
      eq((await detail()).revision, 1)
      eq((await detail()).openingHistory.length, 1)
      eq(
        (await one('select public.get_business_day(null) r')).r.status,
        'not_opened',
      )
      await dialog
        .getByText('Historial de ediciones (1)', { exact: true })
        .click()
      await dialog
        .getByRole('button', {
          name: 'Ver versión anterior · revisión 0',
          exact: true,
        })
        .click()
      await dialog
        .getByText('Versión del historial · revisión 0', { exact: true })
        .waitFor()
      eq(
        await dialog
          .getByRole('button', { name: 'Editar apertura', exact: true })
          .count(),
        0,
      )
      const download = page.waitForEvent('download')
      await dialog
        .getByRole('button', { name: 'Descargar PDF', exact: true })
        .click()
      const pdf = await download
      await pdf.saveAs(`${output}/apertura-original-${width}.pdf`)
      eq(pdf.suggestedFilename(), 'comprobante-CP-000001.pdf')
      await dialog
        .getByRole('button', {
          name: 'Volver a la versión actual',
          exact: true,
        })
        .click()
      await dialog
        .getByRole('button', { name: 'Editar apertura', exact: true })
        .click()
      const beforeConcurrent = await detail()
      await call('correct_opening_journal', {
        requestId: crypto.randomUUID(),
        entryId: id,
        expectedRevision: 1,
        description: 'Actualización desde otra ventana',
        reference: 'QA',
        lines: beforeConcurrent.lines.map((l) => ({
          account: l.account,
          debit: l.debit,
          credit: l.credit,
        })),
      })
      await dialog.getByLabel('Debe 1', { exact: true }).fill('1700')
      await dialog
        .getByRole('button', { name: 'Cuadrar patrimonio', exact: true })
        .click()
      await dialog
        .getByRole('button', { name: 'Guardar cambios', exact: true })
        .click()
      await dialog.getByText(/La apertura cambió desde que abriste/).waitFor()
      eq(
        await dialog
          .getByRole('button', { name: 'Guardar cambios', exact: true })
          .isDisabled(),
        true,
      )
      eq((await detail()).revision, 2)
      eq(fixture.failures.length, 1)
      eq(
        fixture.failures[0].includes('La apertura cambió desde que abriste'),
        true,
      )
      fixture.failures.splice(0, 1) // Ya se verificó expresamente el rechazo esperado.
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      await dialog
        .getByRole('button', { name: 'Editar apertura', exact: true })
        .click()
      const day = await call('open_business_day', {
        requestId: crypto.randomUUID(),
        expectedDay: fixture.today,
        openingNio: 500,
        openingUsd: 0,
      })
      const invoice = await call('create_document', {
        requestId: crypto.randomUUID(),
        kind: 'invoice',
        customerName: 'Cliente de auditoría',
        tier: 'emprendedor',
        currency: 'NIO',
        location: 'store',
        paymentMethod: 'cash',
        notes: '',
        items: [
          { productId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', quantity: 1 },
        ],
      })
      await dialog.getByLabel('Debe 1', { exact: true }).fill('1200')
      await dialog
        .getByRole('button', { name: 'Cuadrar patrimonio', exact: true })
        .click()
      await dialog
        .getByRole('button', { name: 'Guardar cambios', exact: true })
        .click()
      await dialog
        .getByRole('button', { name: 'Editar apertura', exact: true })
        .waitFor()
      eq((await detail()).revision, 3)
      eq((await detail()).number, 1)
      eq(
        (await one('select public.get_business_day(null) r')).r.openingNio,
        day.openingNio,
      )
      eq(
        (await one('select public.get_business_day(null) r')).r.report
          .expectedNio,
        866,
      )
      eq(
        (
          await one('select count(*) count from public.documents where id=$1', [
            invoice.id,
          ])
        ).count,
        1,
      )
      eq(
        (
          await one('select public.ledger_report($1,$1) r', [fixture.today])
        ).r.accounts.find((a) => a.code === '1110-001').closing,
        1566,
      )
      await overflow()
      await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click()
      // El acceso directo funciona aun cuando la apertura no está en la página del historial.
      await page
        .getByRole('button', { name: 'Editar saldos iniciales', exact: true })
        .click()
      dialog = page.getByRole('dialog')
      await dialog
        .getByRole('heading', {
          name: 'Editar apertura CP-000001',
          exact: true,
        })
        .waitFor()
      eq(
        await dialog.getByLabel('Debe 1', { exact: true }).inputValue(),
        '1200',
      )
      eq(errors, [])
      eq(fixture.failures, [])
      results.push({
        width,
        noReasonRequired: true,
        originalNumberPreserved: true,
        history: true,
        originalPdf: true,
        recovery: true,
        staleEditRejected: true,
        salePreserved: true,
        ledger: true,
      })
    } finally {
      await context.close()
      await fixture.close()
    }
  }
  await writeFile(
    `${output}/browser-results.json`,
    JSON.stringify({ checks, results }, null, 2),
  )
  console.log(
    `PASS navegador edición de apertura: ${checks} verificaciones en escritorio y móvil; ${base}`,
  )
} finally {
  await browser.close()
  await server?.close()
}

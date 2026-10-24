import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

const output = 'output/contingencias'
const baseUrl = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const fixture = await browserDatabase(page)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const call = async (name, payload) =>
      (
        await fixture.db.query(`select public.${name}($1::jsonb) result`, [
          JSON.stringify(payload),
        ])
      ).rows[0].result
    const day = async () =>
      (await fixture.db.query('select public.get_business_day() result'))
        .rows[0].result
    const navigate = async (path) => {
      await page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      await page.locator('.main-content h1').first().waitFor()
      if (path === '/sales' || path === '/proformas') {
        const details = page.locator('.document-customer-panel details')
        await details.waitFor()
        if ((await details.getAttribute('open')) === null)
          await details.locator(':scope > summary').click()
      }
    }
    const beforeUnloadWarns = () =>
      page.evaluate(() => {
        const event = new globalThis.Event('beforeunload', { cancelable: true })
        globalThis.dispatchEvent(event)
        return event.defaultPrevented
      })
    const addFirstProduct = async () => {
      await page
        .getByLabel('Buscar en catálogo', { exact: true })
        .fill('Oriental')
      await page
        .getByRole('button', { name: /^Agregar Lattafa/ })
        .first()
        .click()
    }
    try {
      await page.goto(`${baseUrl}/login`)
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

      // Una cotización no vende ni necesita abrir la jornada.
      await navigate('/proformas')
      await page
        .getByLabel('Cliente', { exact: true })
        .fill('Cliente cotización')
      await addFirstProduct()
      await page
        .getByRole('button', { name: 'Emitir proforma', exact: true })
        .click()
      await page.getByText(/Proforma PRO-.*emitida/).waitFor()
      assert.equal((await day()).status, 'not_opened')
      assert.equal(
        (
          await fixture.db.query(
            "select quantity from public.inventory_balances where product_id='aaaaaaaa-aaaa-4aaa-8aaa-000000000001' and location='store'",
          )
        ).rows[0].quantity,
        20,
      )

      await navigate('/sales')
      await page.getByText('Tienda sin abrir', { exact: true }).waitFor()
      await call('open_business_day', {
        requestId: crypto.randomUUID(),
        openingNio: 1000,
        openingUsd: 0,
        note: '',
      })
      await page.evaluate(() =>
        globalThis.dispatchEvent(new globalThis.Event('focus')),
      )
      await page.getByText('Tienda abierta', { exact: true }).waitFor()
      await page.getByLabel('Cliente', { exact: true }).fill('Cliente original')
      await addFirstProduct()
      assert.equal(await beforeUnloadWarns(), true, 'Protege formulario nuevo')
      await page
        .getByRole('link', { name: 'Consultar facturas emitidas' })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      assert.equal(
        new URL(page.url()).pathname,
        '/sales',
        'Protege navegación interna con cambios',
      )
      await page
        .getByRole('button', { name: 'Nueva factura', exact: true })
        .click()
      let dialog = page.getByRole('dialog')
      await dialog
        .getByRole('heading', { name: 'Cambios sin guardar' })
        .waitFor()
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      assert.equal(
        await page.getByLabel('Cliente', { exact: true }).inputValue(),
        'Cliente original',
      )
      await page
        .getByRole('button', { name: 'Nueva factura', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Descartar cambios', exact: true })
        .click()
      assert.equal(await beforeUnloadWarns(), false, 'Formulario descartado')

      await page
        .getByLabel('Cliente', { exact: true })
        .fill('Cliente respuesta perdida')
      await page
        .getByLabel('Forma de pago', { exact: true })
        .selectOption('cash')
      await addFirstProduct()
      await page
        .getByRole('button', { name: 'Guardar borrador', exact: true })
        .click()
      await page
        .getByText('Borrador guardado en tu cuenta.', { exact: true })
        .waitFor()
      assert.equal(
        await beforeUnloadWarns(),
        false,
        'Borrador guardado no cambia',
      )
      const quantity = page.getByLabel(/^Cantidad de Lattafa/)
      await quantity.fill('2')
      assert.equal(
        await beforeUnloadWarns(),
        true,
        'Detecta edición de borrador',
      )
      await page.locator('.saved-drafts button').first().click()
      dialog = page.getByRole('dialog')
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      assert.equal(await quantity.inputValue(), '2')
      await page.locator('.saved-drafts button').first().click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Abrir otro borrador', exact: true })
        .click()
      assert.equal(await quantity.inputValue(), '1')
      assert.equal(await beforeUnloadWarns(), false)

      let originalPayload
      let originalDocument
      let attempts = 0
      let holdResponse
      const responseGate = new Promise((resolve) => {
        holdResponse = resolve
      })
      await page.route('**/rest/v1/rpc/create_document', async (route) => {
        attempts += 1
        const payload = route.request().postDataJSON().p_payload
        if (attempts > 1) {
          assert.deepEqual(
            payload,
            originalPayload,
            'Reutiliza payload e ID originales',
          )
          return route.fallback()
        }
        originalPayload = payload
        originalDocument = await call('create_document', payload)
        const current = await day()
        await call('close_business_day', {
          requestId: crypto.randomUUID(),
          day: current.day,
          countedNio: current.report.expectedNio,
          countedUsd: current.report.expectedUsd,
          note: '',
          expectedRevision: current.revision,
          expectedStateToken: current.stateToken,
        })
        await responseGate
        return route.abort('failed')
      })
      await page
        .getByRole('button', { name: 'Emitir factura', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Emitiendo…', exact: true })
        .waitFor()
      assert.equal(
        await page.getByLabel('Cliente', { exact: true }).isDisabled(),
        true,
      )
      assert.equal(
        await page
          .getByRole('button', { name: 'Nueva factura', exact: true })
          .isDisabled(),
        true,
      )
      assert.equal(
        await quantity.inputValue(),
        '1',
        'Conserva renglones durante envío',
      )
      holdResponse()
      await page
        .getByRole('button', { name: 'Reintentar emisión', exact: true })
        .waitFor()
      await page.getByText('Jornada cerrada', { exact: true }).waitFor()
      assert.equal(
        await beforeUnloadWarns(),
        true,
        'Protege respuesta sin confirmar',
      )
      assert.equal(await quantity.isDisabled(), true)
      await page.locator('a[href="/inventory"]:visible').first().click()
      assert.equal(
        new URL(page.url()).pathname,
        '/sales',
        'No abandona factura incierta',
      )
      await page
        .getByText(
          'Verifica primero la factura pendiente de confirmación con «Reintentar emisión».',
          { exact: true },
        )
        .waitFor()
      assert.equal(
        await page.locator('.sidebar-bottom button').last().isDisabled(),
        true,
        'No cierra sesión con emisión incierta',
      )
      await page.goBack()
      await page
        .getByRole('heading', { name: 'Proformas', exact: true })
        .waitFor()
      await page
        .getByRole('link', { name: 'Recuperar factura', exact: true })
        .waitFor()
      assert.equal(
        await beforeUnloadWarns(),
        true,
        'El panel protege la emisión fuera de ventas',
      )
      assert.equal(
        await page.locator('.sidebar-bottom button').last().isDisabled(),
        true,
        'Logout también protegido después de Atrás',
      )
      const scopedMemory = await page.evaluate(async () => {
        const moduleUrl = globalThis.performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter(
            (name) =>
              new URL(name).pathname ===
              '/src/features/sales/pendingDocuments.ts',
          )
          .at(-1)
        const registry = await import(moduleUrl)
        return {
          own: registry.pendingDocuments(
            'user:11111111-1111-4111-8111-111111111111',
          ).length,
          other: registry.pendingDocuments(
            'user:22222222-2222-4222-8222-222222222222',
          ).length,
          demo: registry.pendingDocuments('demo').length,
        }
      })
      assert.deepEqual(
        scopedMemory,
        { own: 1, other: 0, demo: 0 },
        'La memoria está aislada por usuario',
      )
      await page.goForward()
      await page
        .getByRole('heading', { name: 'Facturación', exact: true })
        .waitFor()
      assert.equal(
        await page.getByLabel('Cliente', { exact: true }).inputValue(),
        'Cliente respuesta perdida',
      )
      assert.equal(
        await quantity.inputValue(),
        '1',
        'Adelante restaura productos',
      )
      await page.goBack()
      await page
        .getByRole('heading', { name: 'Proformas', exact: true })
        .waitFor()
      await page
        .getByRole('link', { name: 'Recuperar factura', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Facturación', exact: true })
        .waitFor()
      assert.equal(
        await page.getByLabel('Cliente', { exact: true }).inputValue(),
        'Cliente respuesta perdida',
      )
      assert.equal(
        await quantity.inputValue(),
        '1',
        'El enlace recupera el formulario completo',
      )
      assert.equal(
        await page
          .getByRole('button', { name: 'Nueva factura', exact: true })
          .isDisabled(),
        true,
      )
      assert.equal(
        (
          await fixture.db.query(
            "select jsonb_array_length(items) n from public.user_drafts where namespace='lcp.drafts.invoice.v2'",
          )
        ).rows[0].n,
        1,
        'No borra borrador sin confirmación',
      )
      await page.evaluate(() => {
        globalThis.dispatchEvent(new globalThis.Event('online'))
        globalThis.document.dispatchEvent(
          new globalThis.Event('visibilitychange'),
        )
      })
      await page
        .getByRole('button', { name: 'Reintentar emisión', exact: true })
        .click()
      await page
        .getByText(
          `Factura ${originalDocument.number} emitida. Las existencias ya se descontaron.`,
          { exact: true },
        )
        .waitFor()
      assert.equal(attempts, 2)
      assert.equal((await day()).status, 'closed')
      assert.equal(
        (
          await fixture.db.query(
            "select count(*)::int n from public.documents where kind='invoice'",
          )
        ).rows[0].n,
        1,
        'Una factura incluso después del cierre',
      )
      assert.equal(
        (
          await fixture.db.query(
            "select quantity from public.inventory_balances where product_id='aaaaaaaa-aaaa-4aaa-8aaa-000000000001' and location='store'",
          )
        ).rows[0].quantity,
        19,
        'Descuenta una sola vez',
      )
      assert.equal(
        await beforeUnloadWarns(),
        false,
        'La confirmación libera el aviso',
      )
      assert.equal(
        await page
          .getByRole('link', { name: 'Recuperar factura', exact: true })
          .count(),
        0,
      )
      assert.equal(
        await page.locator('.sidebar-bottom button').last().isEnabled(),
        true,
        'Libera cierre de sesión al confirmar',
      )
      assert.equal(
        (
          await fixture.db.query(
            "select jsonb_array_length(items) n from public.user_drafts where namespace='lcp.drafts.invoice.v2'",
          )
        ).rows[0].n,
        0,
        'Retira borrador sólo al confirmar factura',
      )
      // La respuesta también puede llegar mientras el usuario está en otra
      // pantalla. Se recupera la promesa ya resuelta sin repetir la escritura.
      await page.unroute('**/rest/v1/rpc/create_document')
      await navigate('/proformas')
      await page
        .getByLabel('Cliente', { exact: true })
        .fill('Cliente respuesta tardía')
      await addFirstProduct()
      await page
        .getByRole('button', { name: 'Guardar borrador', exact: true })
        .click()
      await page
        .getByText('Borrador guardado en tu cuenta.', { exact: true })
        .waitFor()
      let releaseProforma
      const proformaGate = new Promise((resolve) => {
        releaseProforma = resolve
      })
      const proformaPayloads = []
      let delayedProforma
      await page.route('**/rest/v1/rpc/create_document', async (route) => {
        const payload = route.request().postDataJSON().p_payload
        proformaPayloads.push(payload)
        const document = await call('create_document', payload)
        delayedProforma = document
        await proformaGate
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(document),
        })
      })
      await page
        .getByRole('button', { name: 'Emitir proforma', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Emitiendo…', exact: true })
        .waitFor()
      await page.goBack()
      await page
        .getByRole('heading', { name: 'Facturación', exact: true })
        .waitFor()
      await page
        .getByRole('link', { name: 'Recuperar proforma', exact: true })
        .waitFor()
      releaseProforma()
      await page.waitForFunction(async () => {
        const moduleUrl = globalThis.performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter(
            (name) =>
              new URL(name).pathname ===
              '/src/features/sales/pendingDocuments.ts',
          )
          .at(-1)
        const registry = await import(moduleUrl)
        return registry
          .pendingDocuments('user:11111111-1111-4111-8111-111111111111')
          .some(
            (attempt) =>
              attempt.kind === 'proforma' && attempt.status === 'confirmed',
          )
      })
      await page
        .getByRole('link', { name: 'Recuperar proforma', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Proformas', exact: true })
        .waitFor()
      assert.equal(
        await page.getByLabel('Cliente', { exact: true }).inputValue(),
        'Cliente respuesta tardía',
      )
      // El borrador no puede borrarse por un corte de red. La proforma sigue
      // confirmada y reutiliza su UUID incluso tras montar de nuevo la pantalla.
      const failDraftCleanup = (route) => route.abort('failed')
      await page.route('**/rest/v1/rpc/save_my_drafts', failDraftCleanup)
      await page
        .getByRole('button', { name: 'Reintentar emisión', exact: true })
        .click()
      await page
        .getByText(
          `Proforma ${delayedProforma.number} emitida. No modifica inventario.`,
          { exact: true },
        )
        .waitFor()
      await page
        .getByText(
          'La proforma está emitida, pero no se pudo retirar su borrador. No vuelvas a emitir ese borrador.',
          { exact: true },
        )
        .waitFor()
      assert.equal(
        proformaPayloads.length,
        1,
        'La respuesta tardía usa la promesa resuelta',
      )
      assert.equal(
        await page.locator('.sidebar-bottom button').last().isEnabled(),
        true,
        'Fallo del borrador no bloquea logout',
      )
      assert.equal(
        await page
          .getByRole('link', { name: 'Recuperar proforma', exact: true })
          .count(),
        0,
      )
      await page.unroute('**/rest/v1/rpc/save_my_drafts', failDraftCleanup)
      await navigate('/sales')
      await navigate('/proformas')
      await page
        .locator('.saved-drafts button')
        .filter({ hasText: 'Cliente respuesta tardía' })
        .click()
      await page
        .getByRole('button', { name: 'Emitir proforma', exact: true })
        .click()
      await page
        .getByText(
          `Proforma ${delayedProforma.number} emitida. No modifica inventario.`,
          { exact: true },
        )
        .waitFor()
      assert.equal(proformaPayloads.length, 2)
      assert.equal(
        proformaPayloads[0].requestId,
        proformaPayloads[1].requestId,
        'Borrador persistente conserva UUID tras desmontar',
      )
      assert.equal(
        (
          await fixture.db.query(
            "select count(*)::int n from public.documents where kind='proforma'",
          )
        ).rows[0].n,
        2,
        'Sólo existen las dos proformas distintas',
      )
      assert.equal(
        (
          await fixture.db.query(
            "select jsonb_array_length(items) n from public.user_drafts where namespace='lcp.drafts.proforma.v2'",
          )
        ).rows[0].n,
        0,
      )
      // Una emisión sin borrador guardado también conserva su ID al volver.
      // El snapshot «preview» nunca se convierte en un nuevo UUID de solicitud.
      await page
        .getByRole('button', { name: 'Nueva proforma', exact: true })
        .click()
      const unsavedCustomerDetails = page.locator(
        '.document-customer-panel details',
      )
      if ((await unsavedCustomerDetails.getAttribute('open')) === null)
        await unsavedCustomerDetails.locator(':scope > summary').click()
      await page
        .getByLabel('Cliente', { exact: true })
        .fill('Cliente sin borrador guardado')
      await addFirstProduct()
      await page.unroute('**/rest/v1/rpc/create_document')
      const unsavedPayloads = []
      let unsavedDocument
      await page.route('**/rest/v1/rpc/create_document', async (route) => {
        const payload = route.request().postDataJSON().p_payload
        unsavedPayloads.push(payload)
        if (unsavedPayloads.length > 1) {
          assert.deepEqual(
            payload,
            unsavedPayloads[0],
            'Solicitud sin borrador conserva ID completo',
          )
          return route.fallback()
        }
        unsavedDocument = await call('create_document', payload)
        return route.abort('failed')
      })
      await page
        .getByRole('button', { name: 'Emitir proforma', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Reintentar emisión', exact: true })
        .waitFor()
      await page.goBack()
      await page
        .getByRole('heading', { name: 'Facturación', exact: true })
        .waitFor()
      await page
        .getByRole('link', { name: 'Recuperar proforma', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Proformas', exact: true })
        .waitFor()
      assert.equal(
        await page.getByLabel('Cliente', { exact: true }).inputValue(),
        'Cliente sin borrador guardado',
      )
      await page
        .getByRole('button', { name: 'Reintentar emisión', exact: true })
        .click()
      await page
        .getByText(
          `Proforma ${unsavedDocument.number} emitida. No modifica inventario.`,
          { exact: true },
        )
        .waitFor()
      assert.equal(unsavedPayloads.length, 2)
      assert.equal(
        (
          await fixture.db.query(
            "select count(*)::int n from public.documents where kind='proforma'",
          )
        ).rows[0].n,
        3,
      )
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
      await page.screenshot({
        path: `${output}/venta-recuperada-${width}.png`,
        fullPage: true,
      })
      console.log(
        `OK: proforma sin jornada, borradores protegidos, respuesta perdida+cierre+reintento sin duplicados a ${width}px`,
      )
    } finally {
      await fixture.close()
      await context.close()
    }
  }
} finally {
  await browser.close()
}

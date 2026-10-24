import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname))
const widths = process.env.LCP_TEST_WIDTHS
  ? process.env.LCP_TEST_WIDTHS.split(',').map(Number)
  : [1440, 1280, 1024, 768, 390, 320]
assert.ok(
  widths.every(
    (width) => Number.isInteger(width) && width >= 320 && width <= 1920,
  ),
)
const output = 'output/everyday-usability-review'
await mkdir(output, { recursive: true })
let checks = 0
const results = []
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of widths) {
    const height = width === 1280 ? 720 : 900
    const context = await browser.newContext({
      viewport: { width, height },
      timezoneId: 'America/Managua',
      reducedMotion: 'reduce',
      isMobile: width <= 768,
      hasTouch: width <= 768,
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    await page.addInitScript(() => {
      Object.defineProperty(globalThis.navigator, 'canShare', {
        value: () => false,
        configurable: true,
      })
      globalThis.__printed = 0
      globalThis.print = () => globalThis.__printed++
      globalThis.__opened = []
      globalThis.open = (url) => {
        globalThis.__opened.push(url)
        return null
      }
    })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    const fixture = await browserDatabase(page)
    const one = async (sql, values = []) =>
      (await fixture.db.query(sql, values)).rows[0]
    const navigate = async (path, heading) => {
      await page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      await page.getByRole('heading', { name: heading, exact: true }).waitFor()
      await page.getByLabel('Buscar en catálogo', { exact: true }).waitFor()
    }
    const reveal = async (locator) => {
      // Los controles opcionales deben seguir accesibles mediante su resumen.
      // Se abre cada details real con el mismo clic que usaría la persona.
      const summaries = locator.locator(
        'xpath=ancestor::details[not(@open)]/summary',
      )
      for (const summary of await summaries.all()) await summary.click()
    }
    const clickButton = async (name) => {
      const target = page.getByRole('button', { name, exact: true })
      await reveal(target)
      await target.click()
    }
    const healthy = async (label) => {
      equal(errors, [], `${label}: sin errores JavaScript`)
      equal(fixture.failures, [], `${label}: sin errores API`)
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        `${label}: sin desbordamiento horizontal`,
      )
      const clippedInputs = await page
        .locator(
          '.main-content input, .main-content select, .main-content textarea',
        )
        .evaluateAll((inputs) =>
          inputs
            .filter((input) => {
              if (input.getClientRects().length === 0) return false
              const box = input.getBoundingClientRect()
              return box.left < -1 || box.right > globalThis.innerWidth + 1
            })
            .map((input) => input.getAttribute('aria-label') ?? input.id),
        )
      equal(clippedInputs, [], `${label}: campos dentro de su ancho`)
    }
    try {
      await fixture.db.query('select public.open_business_day($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          openingNio: 1000,
          openingUsd: 0,
          expectedDay: fixture.today,
        }),
      ])
      await page.goto(base + '/login')
      await page
        .getByLabel('Correo electrónico', { exact: true })
        .fill('auditoria@example.test')
      await page
        .getByLabel('Contraseña', { exact: true })
        .fill('Local-test-password!')
      await clickButton('Iniciar sesión')
      await page.getByRole('heading', { name: 'Inicio', exact: true }).waitFor()

      for (const kind of ['invoice', 'proforma']) {
        const noun = kind === 'invoice' ? 'factura' : 'proforma'
        const prefix = kind === 'invoice' ? 'FAC' : 'PRO'
        const path = kind === 'invoice' ? '/sales' : '/proformas'
        await navigate(path, kind === 'invoice' ? 'Facturación' : 'Proformas')
        const paper = page.locator('.invoice-paper')
        const search = page.getByLabel('Buscar en catálogo', { exact: true })
        const customer = page.getByLabel('Cliente', { exact: true })
        const phone = page.getByLabel('WhatsApp del cliente', { exact: true })
        const taxId = page.getByLabel('RUC / Identificación del cliente', {
          exact: true,
        })
        const notes = page.getByRole('textbox', { name: /^Notas/ })
        const clientSelect = page.getByLabel('Cliente registrado', {
          exact: true,
        })
        const savedClient = await one(
          'select id,name from public.customers limit 1',
        )
        await reveal(clientSelect)
        await clientSelect.selectOption(savedClient.id)
        equal(
          await customer.inputValue(),
          savedClient.name,
          'cliente registrado conserva su nombre',
        )
        equal(
          await customer.isDisabled(),
          true,
          'cliente registrado protegido de edición accidental',
        )
        await clientSelect.selectOption('')
        await customer.fill(`Cliente de uso diario ${kind} ${width}`)
        await reveal(phone)
        await phone.fill('88887777')
        await taxId.fill('J0310000001234')
        await page
          .getByLabel('Lista de precios', { exact: true })
          .selectOption('vip')
        await page.getByLabel('Moneda', { exact: true }).selectOption('USD')
        const rate = page.getByLabel('Tipo de cambio (NIO por 1 USD)', {
          exact: true,
        })
        await reveal(rate)
        equal(await rate.inputValue(), '36.6', 'tipo de cambio precargado')
        if (kind === 'invoice') {
          await page
            .getByLabel('Forma de pago', { exact: true })
            .selectOption('cash')
          await page
            .getByLabel('Sale de', { exact: true })
            .selectOption('store')
        } else {
          equal(
            (await page
              .getByLabel('Válida hasta', { exact: true })
              .inputValue()) > fixture.today,
            true,
            'vigencia futura conservada',
          )
        }

        const customerDetails = page
          .locator('.document-customer-panel details')
          .first()
        if (await customerDetails.count()) {
          await customerDetails.locator(':scope > summary').click()
          equal(
            await customerDetails.getAttribute('open'),
            null,
            'datos del cliente se pueden plegar',
          )
          equal(
            await customer.inputValue(),
            `Cliente de uso diario ${kind} ${width}`,
            'plegar conserva nombre del cliente',
          )
          equal(
            await phone.inputValue(),
            '88887777',
            'plegar conserva WhatsApp',
          )
          equal(
            await taxId.inputValue(),
            'J0310000001234',
            'plegar conserva identificación',
          )
        }

        const add = async (index) => {
          const sku = 'QA-' + String(index).padStart(4, '0')
          await search.fill(sku)
          await page.getByRole('button', { name: /^Agregar Lattafa/ }).click()
          equal(
            await search.inputValue(),
            sku,
            'agregar conserva búsqueda escrita',
          )
        }
        await add(1)
        const reviewInvalid = async (field, invalid, corrected) => {
          await reveal(field)
          await field.fill(invalid)
          await customerDetails.locator(':scope > summary').click()
          equal(
            await page
              .getByText('Completar datos', { exact: true })
              .isVisible(),
            true,
            'datos incompletos se anuncian aun plegados',
          )
          equal(
            await page
              .getByRole('button', { name: `Emitir ${noun}`, exact: true })
              .isDisabled(),
            true,
            'datos inválidos impiden emitir',
          )
          await clickButton('Revisar datos')
          equal(
            (await customerDetails.getAttribute('open')) !== null,
            true,
            'revisar abre los datos del cliente',
          )
          equal(
            await field.evaluate(
              (element) => element === globalThis.document.activeElement,
            ),
            true,
            'revisar enfoca el primer campo inválido',
          )
          await field.fill(corrected)
          equal(
            await page.getByText('Completar datos', { exact: true }).count(),
            0,
            'al corregir desaparece el aviso',
          )
        }
        await reviewInvalid(
          customer,
          '',
          `Cliente de uso diario ${kind} ${width}`,
        )
        await reviewInvalid(phone, '123', '88887777')
        if (kind === 'invoice') await reviewInvalid(rate, '0', '36.6')
        else {
          const validity = page.getByLabel('Válida hasta', { exact: true })
          const previous = await validity.inputValue()
          await reviewInvalid(validity, '', previous)
        }
        await customerDetails.locator(':scope > summary').click()
        equal(
          await search.inputValue(),
          'QA-0001',
          'revisar datos conserva búsqueda',
        )
        const firstQuantity = paper.getByRole('spinbutton').first()
        await firstQuantity.fill('3')
        equal(
          await firstQuantity.inputValue(),
          '3',
          'cantidad editada sin perder valor',
        )
        equal(
          await firstQuantity.evaluate(
            (el) => el === globalThis.document.activeElement,
          ),
          true,
          'editar cantidad conserva foco',
        )
        await add(2)
        equal(
          await paper.getByRole('spinbutton').count(),
          2,
          'dos productos agregados',
        )
        await paper
          .getByRole('button', { name: /^Quitar Lattafa Perfume 2$/ })
          .click()
        equal(
          await paper.getByRole('spinbutton').count(),
          1,
          'quitar conserva otros renglones',
        )
        equal(
          await firstQuantity.inputValue(),
          '3',
          'quitar conserva cantidad del primer perfume',
        )
        await firstQuantity.fill('0')
        equal(
          await page
            .getByRole('button', { name: `Emitir ${noun}`, exact: true })
            .isDisabled(),
          true,
          'cantidad inválida bloquea emisión',
        )
        await firstQuantity.fill('3')
        for (let i = 2; i <= 10; i++) await add(i)
        equal(
          await paper.getByRole('spinbutton').count(),
          10,
          'documento con diez perfumes',
        )
        await reveal(notes)
        await notes.fill(`Observación conservada ${kind} ${width}`)

        await page.evaluate(() =>
          globalThis.scrollTo({ top: 0, behavior: 'instant' }),
        )
        const layout = await page.evaluate(() => {
          const bounds = (selector) => {
            const element = globalThis.document.querySelector(selector)
            if (!element) return null
            const rect = element.getBoundingClientRect()
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            }
          }
          return {
            catalog: bounds('#document-catalog'),
            paper: bounds('.invoice-paper'),
            heading: bounds('.invoice-paper .invoice-heading'),
            meta: bounds('.invoice-paper .invoice-meta'),
            lines: bounds('.invoice-paper .invoice-lines'),
            checkout: bounds('.document-checkout'),
            navigation: bounds('.document-navigation'),
            viewport: {
              width: globalThis.innerWidth,
              height: globalThis.innerHeight,
            },
          }
        })
        results.push({ width, kind, layout })
        await writeFile(
          `${output}/geometria-${width}-${kind}.json`,
          JSON.stringify(layout, null, 2),
        )
        const paperSize = await paper.evaluate((element) => ({
          height: element.clientHeight,
          content: element.scrollHeight,
        }))
        equal(
          paperSize.content <= paperSize.height + 1,
          true,
          `el estado válido permite ver todas las acciones sin desplazar el papel (${JSON.stringify(paperSize)})`,
        )
        equal(
          !!layout.catalog && !!layout.checkout,
          true,
          'catálogo y resumen separados para trabajar',
        )
        if (width >= 1024) {
          equal(
            layout.catalog.right <= layout.paper.left + 1,
            true,
            'catálogo y documento se ven lado a lado',
          )
          await page
            .locator('#document-catalog')
            .evaluate((element) =>
              element.scrollIntoView({ block: 'start', behavior: 'instant' }),
            )
          const issueBounds = await page
            .getByRole('button', { name: `Emitir ${noun}`, exact: true })
            .boundingBox()
          equal(
            !!issueBounds &&
              issueBounds.y >= 0 &&
              issueBounds.y + issueBounds.height <= height,
            true,
            'al buscar, emitir sigue dentro de la pantalla con diez productos',
          )
          const lineScroll = await paper
            .locator('.invoice-lines')
            .evaluate((element) => ({
              height: element.clientHeight,
              content: element.scrollHeight,
            }))
          equal(
            lineScroll.height < lineScroll.content,
            true,
            'los productos desplazan su lista sin arrastrar el resumen',
          )
        }
        if (width <= 768) {
          equal(
            !!layout.navigation?.height,
            true,
            'atajos visibles en pantallas pequeñas',
          )
          const navigation = page.locator('.document-navigation')
          const totalLayout = await navigation
            .locator('strong')
            .evaluate((element) => ({
              height: element.getBoundingClientRect().height,
              line: parseFloat(globalThis.getComputedStyle(element).lineHeight),
            }))
          equal(
            totalLayout.height <= totalLayout.line + 1,
            true,
            'el total móvil mantiene decimales en una sola línea',
          )
          await navigation
            .getByRole('button', { name: /Ver documento/ })
            .click()
          equal(
            await firstQuantity.inputValue(),
            '3',
            'saltar al documento conserva cantidades',
          )
          await page.screenshot({
            path: `${output}/${kind}-${width}-documento.png`,
            fullPage: false,
          })
          await navigation
            .getByRole('button', { name: /Buscar productos/ })
            .click()
          equal(
            await search.inputValue(),
            'QA-0010',
            'volver al catálogo conserva búsqueda',
          )
          equal(
            await search.evaluate(
              (el) => el === globalThis.document.activeElement,
            ),
            true,
            'atajo devuelve foco a búsqueda',
          )
        }
        await healthy(`${kind} ${width} edición`)
        await page.screenshot({
          path: `${output}/${kind}-${width}-pantalla.png`,
          fullPage: false,
        })
        await page.screenshot({
          path: `${output}/${kind}-${width}.png`,
          fullPage: true,
        })

        await clickButton('Guardar borrador')
        await page
          .getByText('Borrador guardado en tu cuenta.', { exact: true })
          .waitFor()
        const saved = (
          await one('select items from public.user_drafts where namespace=$1', [
            `lcp.drafts.${kind}.v2`,
          ])
        ).items
        equal(saved.length, 1, 'un borrador por documento guardado')
        equal(saved[0].lines.length, 10, 'borrador guarda diez perfumes')
        equal(saved[0].lines[0].quantity, 3, 'borrador guarda cantidad editada')
        equal(
          saved[0].notes,
          `Observación conservada ${kind} ${width}`,
          'borrador conserva nota',
        )
        equal(saved[0].currency, 'USD', 'borrador conserva moneda')
        equal(saved[0].tier, 'vip', 'borrador conserva lista')

        await reveal(notes)
        await notes.fill(`Nota nueva ${kind} ${width}`)
        await clickButton(`Nueva ${noun}`)
        let dialog = page.getByRole('dialog', {
          name: 'Cambios sin guardar',
          exact: true,
        })
        await dialog
          .getByRole('button', { name: 'Cancelar', exact: true })
          .click()
        equal(
          await notes.inputValue(),
          `Nota nueva ${kind} ${width}`,
          'cancelar documento nuevo conserva cambios',
        )
        await clickButton(`Nueva ${noun}`)
        dialog = page.getByRole('dialog', {
          name: 'Cambios sin guardar',
          exact: true,
        })
        await dialog
          .getByRole('button', { name: 'Descartar cambios', exact: true })
          .click()
        equal(
          await paper.getByRole('spinbutton').count(),
          0,
          'documento nuevo limpio',
        )
        const savedDraft = page.getByRole('button', {
          name: new RegExp(saved[0].reference),
        })
        await reveal(savedDraft)
        await savedDraft.click()
        equal(
          await paper.getByRole('spinbutton').count(),
          10,
          'borrador reabre todos los productos',
        )
        equal(await firstQuantity.inputValue(), '3', 'borrador reabre cantidad')
        equal(
          await customer.inputValue(),
          `Cliente de uso diario ${kind} ${width}`,
          'borrador reabre cliente',
        )
        await reveal(notes)
        equal(
          await notes.inputValue(),
          `Observación conservada ${kind} ${width}`,
          'borrador reabre nota guardada',
        )
        await clickButton('Imprimir')
        equal(
          await page.evaluate(() => globalThis.__printed),
          kind === 'invoice' ? 1 : 3,
          'botón de impresión invoca impresión',
        )

        const before = await one(
          "select quantity from public.inventory_balances where product_id='aaaaaaaa-aaaa-4aaa-8aaa-000000000001' and location='store'",
        )
        await clickButton(`Emitir ${noun}`)
        await paper
          .getByText(new RegExp(`${prefix}-000001`))
          .first()
          .waitFor()
        const document = await one(
          'select id,total,currency,tier_code from public.documents where kind=$1',
          [kind],
        )
        equal(
          Number(document.total),
          120,
          'total emitido coincide con doce unidades',
        )
        equal(document.currency, 'USD', 'emisión conserva moneda')
        equal(document.tier_code, 'vip', 'emisión conserva lista')
        equal(
          (
            await one(
              'select sum(quantity)::int n from public.document_items where document_id=$1',
              [document.id],
            )
          ).n,
          12,
          'base guarda doce unidades',
        )
        equal(
          (
            await one(
              "select quantity from public.inventory_balances where product_id='aaaaaaaa-aaaa-4aaa-8aaa-000000000001' and location='store'",
            )
          ).quantity,
          before.quantity - (kind === 'invoice' ? 3 : 0),
          'solo factura descuenta existencias',
        )
        equal(
          (
            await one(
              'select items from public.user_drafts where namespace=$1',
              [`lcp.drafts.${kind}.v2`],
            )
          ).items.length,
          0,
          'emisión retira borrador guardado',
        )
        await clickButton('Imprimir')

        const downloading = page.waitForEvent('download')
        await clickButton('Compartir PDF')
        const download = await downloading
        equal(
          download.suggestedFilename().startsWith(`${prefix}-000001-`),
          true,
          'PDF corresponde al documento emitido',
        )
        equal(await download.failure(), null, 'PDF descargado completo')
        const pdfPath = `${output}/${kind}-${width}.pdf`
        await download.saveAs(pdfPath)
        const pdf = await readFile(pdfPath)
        equal(pdf.subarray(0, 5).toString(), '%PDF-', 'archivo PDF válido')
        equal(pdf.length > 10000, true, 'PDF incluye documento y logo')
        await clickButton('Enviar por WhatsApp')
        const whatsapp = await page.evaluate(() => globalThis.__opened.at(-1))
        const message = new URL(whatsapp)
        equal(
          message.origin,
          'https://wa.me',
          'WhatsApp conserva enlace del documento',
        )
        equal(
          message.pathname,
          '/50588887777',
          'WhatsApp conserva teléfono con prefijo local',
        )
        equal(
          message.searchParams.get('text').includes(`${prefix}-000001`),
          true,
          'WhatsApp usa el número emitido',
        )
        equal(
          message.searchParams.get('text').includes('120.00'),
          true,
          'WhatsApp usa el total emitido',
        )
        equal(
          await paper
            .getByRole('button', { name: `Emitir ${noun}`, exact: true })
            .count(),
          0,
          'documento emitido no vuelve a habilitar emisión',
        )
        await healthy(`${kind} ${width} emitido`)
      }
      equal(
        (await one('select count(*)::int n from public.documents')).n,
        2,
        'una factura y una proforma sin duplicados',
      )
    } catch (error) {
      await page.screenshot({
        path: `${output}/error-${width}.png`,
        fullPage: true,
      })
      await writeFile(
        `${output}/error-${width}.txt`,
        await page.locator('body').innerText(),
      )
      console.error({ width, errors, failures: fixture.failures })
      throw error
    } finally {
      await fixture.close()
      await context.close()
    }
  }
  await writeFile(
    `${output}/resultado.json`,
    JSON.stringify(
      { checks, widths, results, productionWrites: false },
      null,
      2,
    ),
  )
  console.log(
    JSON.stringify({ checks, widths, result: 'ok', productionWrites: false }),
  )
} finally {
  await browser.close()
}

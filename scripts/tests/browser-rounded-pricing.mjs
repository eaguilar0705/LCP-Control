import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { execFileSync } from 'node:child_process'
import { browserDatabase } from './browser-database.mjs'
import { identity, admin } from './database-fixture.mjs'
const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5199'
assert.ok(
  ['127.0.0.1', 'lcp-control.pages.dev'].includes(new URL(base).hostname),
)
const server = process.env.LCP_TEST_BASE_URL
  ? null
  : await createServer({
      configFile: 'frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 5199, strictPort: true },
    })
await server?.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const out = 'output/rounded-pricing-review'
await mkdir(out, { recursive: true })
let checks = 0
const eq = (a, b, m) => {
  assert.deepEqual(a, b, m)
  checks++
}
const ids = [
  'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
]
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      timezoneId: 'America/Managua',
      isMobile: width < 500,
      hasTouch: width < 500,
    })
    const page = await context.newPage()
    page.setDefaultTimeout(18000)
    const f = await browserDatabase(page),
      errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const one = async (s, args = []) => (await f.db.query(s, args)).rows[0]
    const rpc = async (name, input) =>
      (await one(`select public.${name}($1::jsonb) r`, [JSON.stringify(input)]))
        .r
    const navigate = async (path) =>
      page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
    try {
      await f.db.exec(
        "reset role;insert into public.price_tiers(code,name,sort_order)values('menudeo','Menudeo',4)on conflict(code)do nothing;update public.exchange_rates set usd_to_nio=37;update public.products set name=case when sku='QA-0001' then 'Mandaryn Sky' else 'Club de Nuit Intense' end where sku in('QA-0001','QA-0002')",
      )
      for (const [i, id] of ids.entries()) {
        await f.db.query(
          "insert into public.product_pricing(product_id,purchase_price,purchase_currency,markup_emprendedor,markup_vip,markup_premium,updated_by)values($1,$2,'NIO',35,25,15,$3)",
          [id, i ? 940 : 840, admin],
        )
        await f.db.query('select private.write_computed_prices($1,37)', [id])
        await f.db.query(
          "insert into public.product_prices(product_id,tier_code,currency,amount)values($1,'menudeo','USD',65),($1,'menudeo','NIO',2405)",
          [id],
        )
      }
      const draft = {
        id: crypto.randomUUID(),
        kind: 'proforma',
        reference: 'PRO-REVISION',
        customer: 'Cliente de revisión',
        customerId: null,
        phone: '',
        taxId: '',
        currency: 'USD',
        exchangeRate: 37,
        tier: 'emprendedor',
        payment: 'pending',
        location: 'store',
        validUntil: new Date(Date.parse(f.today + 'T12:00:00Z') + 7 * 86400000)
          .toISOString()
          .slice(0, 10),
        notes: '',
        createdAt: new Date().toISOString(),
        lines: ids.map((id, i) => ({
          productId: id,
          name: i ? 'Club de Nuit Intense' : 'Mandaryn Sky',
          barcode: i ? 'QA-0002' : 'QA-0001',
          size: '100 ml',
          quantity: 1,
          prices: {
            emprendedor: { USD: i ? 34.3 : 30.65, NIO: i ? 1269 : 1134 },
            vip: { USD: i ? 31.76 : 28.38, NIO: i ? 1175 : 1050 },
            premium: { USD: i ? 29.22 : 26.11, NIO: i ? 1081 : 966 },
            menudeo: { USD: 65, NIO: 2405 },
          },
        })),
      }
      await f.db.query(
        "insert into public.user_drafts(user_id,namespace,items)values($1,'lcp.drafts.proforma.v2',$2::jsonb)",
        [admin, JSON.stringify([draft])],
      )
      await identity(f.db, admin)
      await rpc('open_business_day', {
        requestId: crypto.randomUUID(),
        openingNio: 1000,
        openingUsd: 0,
      })
      await page.route('**/rest/v1/storefront_drafts*', (r) =>
        r.request().method() === 'HEAD'
          ? r.fulfill({
              status: 200,
              headers: { 'content-range': '*/0' },
              body: '',
            })
          : r.fallback(),
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
      await navigate('/proformas')
      await page
        .locator('.saved-drafts button')
        .filter({ hasText: 'PRO-REVISION' })
        .click()
      const paper = page.locator('.invoice-paper')
      await paper.getByText('USD 64.95', { exact: false }).first().waitFor()
      eq(
        (
          await one(
            "select items from public.user_drafts where namespace='lcp.drafts.proforma.v2'",
          )
        ).items[0].lines[0].prices.emprendedor.USD,
        30.65,
        'abrir no sustituye el precio guardado',
      )
      eq(
        await page
          .getByRole('button', { name: 'Emitir proforma', exact: true })
          .isDisabled(),
        true,
      )
      await page
        .getByRole('button', { name: 'Actualizar precios', exact: true })
        .click()
      let dialog = page.getByRole('dialog', {
        name: 'Actualizar precios del documento',
        exact: true,
      })
      await dialog.waitFor()
      const text = (await dialog.innerText()).replaceAll('\u00a0', ' ')
      eq(text.includes('USD 30.65 → USD 31.00'), true)
      eq(text.includes('USD 34.30 → USD 35.00'), true)
      await dialog
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      eq(
        (await paper.innerText())
          .replaceAll('\u00a0', ' ')
          .includes('USD 64.95'),
        true,
        'cancelar conserva el total cotizado',
      )
      await page
        .getByRole('button', { name: 'Actualizar precios', exact: true })
        .click()
      await dialog
        .getByRole('button', { name: 'Aplicar precios actuales', exact: true })
        .waitFor()
      await page.screenshot({
        path: `${out}/confirmacion-${width}.png`,
        fullPage: true,
      })
      await dialog
        .getByRole('button', { name: 'Aplicar precios actuales', exact: true })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      eq(
        (await paper.innerText())
          .replaceAll('\u00a0', ' ')
          .includes('USD 66.00'),
        true,
      )
      eq(
        (
          await one(
            "select items from public.user_drafts where namespace='lcp.drafts.proforma.v2'",
          )
        ).items[0].lines[0].prices.emprendedor.USD,
        30.65,
        'confirmar la vista todavía no reescribe el borrador',
      )
      await page
        .getByRole('button', { name: 'Guardar borrador', exact: true })
        .click()
      await page
        .getByRole('status')
        .filter({ hasText: /Borrador guardado/ })
        .waitFor()
      eq(
        (
          await one(
            "select items from public.user_drafts where namespace='lcp.drafts.proforma.v2'",
          )
        ).items[0].lines[0].prices.emprendedor.USD,
        31,
      )
      await page
        .getByRole('button', { name: 'Emitir proforma', exact: true })
        .click()
      await page.getByText('PRO-000001', { exact: true }).first().waitFor()
      eq(
        Number(
          (
            await one(
              "select total from public.documents where kind='proforma'",
            )
          ).total,
        ),
        66,
      )
      eq(
        (await one('select count(*)::int n from public.inventory_movements')).n,
        0,
        'una proforma no descuenta inventario',
      )
      await navigate('/sales')
      await page
        .getByRole('heading', { name: 'Facturación', exact: true })
        .waitFor()
      await page
        .locator('.price-controls')
        .getByLabel('Moneda', { exact: true })
        .selectOption('USD')
      for (const [search, expected] of [
        ['QA-0001', 31],
        ['QA-0002', 35],
      ]) {
        await page
          .getByLabel('Buscar en catálogo', { exact: true })
          .fill(search)
        const card = page.locator('.picker-product').filter({ hasText: search })
        await card.waitFor()
        eq(
          Number(
            (
              await card.locator('.picker-product-footer strong').innerText()
            ).replace(/[^0-9.]/g, ''),
          ),
          expected,
        )
        await card.getByRole('button', { name: /Agregar / }).click()
      }
      await page
        .locator('.price-controls')
        .getByLabel('Moneda', { exact: true })
        .selectOption('NIO')
      eq(
        (await page.locator('.invoice-paper').innerText())
          .replaceAll('\u00a0', ' ')
          .includes('NIO 2,442.00'),
        true,
      )
      await page
        .getByLabel('Lista de precios', { exact: true })
        .selectOption('premium')
      eq(
        (await page.locator('.invoice-paper').innerText())
          .replaceAll('\u00a0', ' ')
          .includes('NIO 2,109.00'),
        true,
      )
      await page
        .getByLabel('Lista de precios', { exact: true })
        .selectOption('menudeo')
      eq(
        (await page.locator('.invoice-paper').innerText())
          .replaceAll('\u00a0', ' ')
          .includes('NIO 4,810.00'),
        true,
        'menudeo no se mezcla con premium',
      )
      await page
        .getByLabel('Lista de precios', { exact: true })
        .selectOption('emprendedor')
      if (width === 1440) {
        await page.evaluate(() => {
          Object.defineProperty(globalThis.navigator, 'canShare', {
            value: () => false,
            configurable: true,
          })
        })
        const download = page.waitForEvent('download')
        await page
          .getByRole('button', { name: 'Compartir PDF', exact: true })
          .click()
        const pdf = await download
        await pdf.saveAs(`${out}/factura-redondeada.pdf`)
        execFileSync(
          'C:/Users/leoag/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',
          [
            '-c',
            "import sys;from pypdf import PdfReader;t=' '.join(p.extract_text() for p in PdfReader(sys.argv[1]).pages);assert all(v in t for v in ['1,147.00','1,295.00','2,442.00','66.00']);assert '2,403.00' not in t",
            `${out}/factura-redondeada.pdf`,
          ],
          { stdio: 'pipe' },
        )
        checks++
      }
      await page.screenshot({
        path: `${out}/factura-${width}.png`,
        fullPage: true,
      })
      eq(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth <=
            globalThis.innerWidth,
        ),
        true,
      )
      eq(errors, [])
      eq(f.failures, [])
    } finally {
      await context.close()
      await f.db.close()
    }
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
    `PASS navegador redondeo: ${checks} verificaciones en escritorio y móvil, borradores conservados hasta confirmación y API aislada.`,
  )
} finally {
  await browser.close()
  await server?.close()
}

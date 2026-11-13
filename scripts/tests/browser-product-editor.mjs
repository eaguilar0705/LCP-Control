import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build, preview } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
import { admin, identity } from './database-fixture.mjs'

// La interfaz publicada se puede comprobar interceptando todas sus llamadas a
// Supabase: las lecturas y escrituras sólo llegan al PostgreSQL desechable.
const output = 'output/product-editor'
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
const tiers = ['emprendedor', 'vip', 'premium']
const labels = ['Emprendedor', 'VIP', 'Premium']
await mkdir(output, { recursive: true })
let base = process.env.LCP_TEST_BASE_URL
let server
if (base) {
  assert.ok(
    ['127.0.0.1', 'localhost', 'lcp-control.pages.dev'].includes(
      new URL(base).hostname,
    ),
  )
} else {
  const outDir = resolve(output, 'dist')
  await build({
    configFile: 'frontend/vite.config.ts',
    define: {
      'import.meta.env.VITE_DATA_MODE': JSON.stringify('supabase'),
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(
        'https://lcp-tests.supabase.co',
      ),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(
        'sb_publishable_local_test_only',
      ),
    },
    build: { outDir },
    logLevel: 'warn',
  })
  server = await preview({
    configFile: 'frontend/vite.config.ts',
    build: { outDir },
    preview: { host: '127.0.0.1', port: 5218, strictPort: false },
  })
  base = server.resolvedUrls.local[0].replace(/\/$/, '')
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      timezoneId: 'America/Managua',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') console.error(message.text())
    })
    const fixture = await browserDatabase(page)
    const one = async (sql, args = []) =>
      (await fixture.db.query(sql, args)).rows[0]
    const navigate = (path) =>
      page.evaluate((target) => {
        globalThis.history.pushState({}, '', target)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
    try {
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
      for (const scenario of [
        'missing-tier',
        'empty',
        'missing-currency',
        'complete',
        'without-pricing-schema',
      ]) {
        // Cada escenario parte de los mismos precios guardados.
        await fixture.db.exec('reset role')
        await fixture.db.query(
          'delete from public.product_prices where product_id=$1',
          [product],
        )
        await fixture.db.query(
          "insert into public.product_prices(product_id,tier_code,currency,amount) select $1,t,c,case when c='NIO' then 366 else 10 end from unnest(array['emprendedor','vip','premium'])t cross join unnest(array['NIO','USD'])c",
          [product],
        )
        if (
          scenario === 'missing-tier' ||
          scenario === 'without-pricing-schema'
        )
          await fixture.db.query(
            "delete from public.product_prices where product_id=$1 and tier_code='vip'",
            [product],
          )
        if (scenario === 'empty')
          await fixture.db.query(
            'delete from public.product_prices where product_id=$1',
            [product],
          )
        if (scenario === 'missing-currency')
          await fixture.db.query(
            "delete from public.product_prices where product_id=$1 and tier_code='premium' and currency='USD'",
            [product],
          )
        await identity(fixture.db, admin)
        if (scenario === 'without-pricing-schema')
          await page.route('**/rest/v1/product_pricing?**', (route) =>
            route.fulfill({
              status: 404,
              contentType: 'application/json',
              body: JSON.stringify({
                code: 'PGRST205',
                message: 'Table not found',
              }),
            }),
          )
        const before = await one(
          'select revision from public.products where id=$1',
          [product],
        )
        await navigate(`/products/${product}/edit`)
        await page
          .getByRole('heading', { name: 'Editar perfume', exact: true })
          .waitFor()
        await page.getByLabel('Emprendedor USD', { exact: true }).waitFor()
        assert.equal(
          await page
            .getByRole('heading', { name: 'No pudimos cargar esta pantalla' })
            .count(),
          0,
        )
        if (scenario !== 'complete') {
          await page
            .getByRole('button', { name: 'Guardar perfume', exact: true })
            .click()
          await page.locator('[aria-invalid="true"]').first().waitFor()
          assert.deepEqual(
            await one('select revision from public.products where id=$1', [
              product,
            ]),
            before,
            'Los precios incompletos no se guardan como cero',
          )
        }
        for (const [index, label] of labels.entries()) {
          const input = page.getByLabel(`${label} USD`, { exact: true })
          const saved = await one(
            "select amount from public.product_prices where product_id=$1 and tier_code=$2 and currency='USD'",
            [product, tiers[index]],
          )
          if (saved)
            assert.equal(
              Number(await input.inputValue()),
              Number(saved.amount),
              'Se conserva el precio existente',
            )
          await input.fill(String(20 + index))
        }
        await page
          .getByLabel('Nombre del perfume', { exact: true })
          .fill(`Perfume corregido ${scenario} ${width}`)
        await page.screenshot({
          path: `${output}/${scenario}-${width}.png`,
          fullPage: true,
        })
        await page
          .getByRole('button', { name: 'Guardar perfume', exact: true })
          .click()
        await page.getByText('Perfume guardado.', { exact: true }).waitFor()
        assert.equal(
          (await one('select name from public.products where id=$1', [product]))
            .name,
          `Perfume corregido ${scenario} ${width}`,
        )
        const savedPrices = (
          await fixture.db.query(
            'select tier_code,currency,amount from public.product_prices where product_id=$1',
            [product],
          )
        ).rows
        for (const [index, tier] of tiers.entries()) {
          assert.equal(
            Number(
              savedPrices.find(
                (row) => row.tier_code === tier && row.currency === 'USD',
              ).amount,
            ),
            20 + index,
          )
          assert.equal(
            Number(
              savedPrices.find(
                (row) => row.tier_code === tier && row.currency === 'NIO',
              ).amount,
            ),
            (20 + index) * 36.6,
          )
        }
        await navigate(`/products/${product}/edit`)
        await page.getByLabel('Emprendedor USD', { exact: true }).waitFor()
        assert.equal(
          await page
            .getByLabel('Emprendedor USD', { exact: true })
            .inputValue(),
          '20',
        )
        await page.locator('.price-history-record').first().waitFor()
        assert.deepEqual(errors, [])
        assert.deepEqual(fixture.failures, [])
        await navigate('/inventory')
        await page
          .getByRole('heading', { name: 'Inventario', exact: true })
          .waitFor()
        if (scenario === 'without-pricing-schema')
          await page.unroute('**/rest/v1/product_pricing?**')
        results.push({ width, scenario, status: 'passed' })
        console.log(`PASS edición de perfume: ${scenario}, ${width}px`)
      }
    } catch (error) {
      await writeFile(
        `${output}/failure-${width}.txt`,
        `${error}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`,
      )
      await page.screenshot({
        path: `${output}/failure-${width}.png`,
        fullPage: true,
      })
      throw error
    } finally {
      await context.close()
      await fixture.close()
    }
  }
  await writeFile(
    `${output}/results.json`,
    JSON.stringify({ base, results, productionWrites: false }, null, 2),
  )
} finally {
  await browser.close()
  if (server)
    await new Promise((done, reject) =>
      server.httpServer.close((error) => (error ? reject(error) : done())),
    )
}

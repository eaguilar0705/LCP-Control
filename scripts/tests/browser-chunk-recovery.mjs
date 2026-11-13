import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build, preview } from 'vite'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'

// Usar la compilación real: el servidor de desarrollo no genera estos chunks.
const output = 'output/chunk-recovery'
await mkdir(output, { recursive: true })
const buildDirectory = resolve(output, 'dist')
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
  build: { outDir: buildDirectory },
  logLevel: 'warn',
})
const server = await preview({
  configFile: 'frontend/vite.config.ts',
  build: { outDir: buildDirectory },
  preview: { host: '127.0.0.1', port: 5217, strictPort: false },
})
const base = server.resolvedUrls.local[0].replace(/\/$/, '')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
const chunk = /\/assets\/ReportsPage-[^/]+\.js$/
const product = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
const target = '/reports?from=inventory#revision'
const navigate = (page, path) =>
  page.evaluate((path) => {
    globalThis.history.pushState({}, '', path)
    globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
  }, path)
const login = async (page) => {
  await page
    .getByLabel('Correo electrónico', { exact: true })
    .fill('auditoria@example.test')
  await page
    .getByLabel('Contraseña', { exact: true })
    .fill('Local-test-password!')
  await page
    .getByRole('button', { name: 'Iniciar sesión', exact: true })
    .click()
}

try {
  for (const scenario of ['transient', 'persistent', 'render-error']) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 900 },
      timezoneId: 'America/Managua',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(20000)
    const fixture = await browserDatabase(page)
    let documents = 0
    let attempts = 0
    let missing = true
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        documents++
    })
    await page.route(chunk, async (route) => {
      attempts++
      if (scenario === 'render-error')
        return route.fulfill({
          contentType: 'application/javascript',
          body: 'export function ReportsPage() { throw new Error("Ordinary render failure") }',
        })
      if (missing && (scenario === 'persistent' || attempts === 1))
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><html><body>SPA fallback</body></html>',
        })
      return route.continue()
    })
    try {
      await page.goto(base + '/login')
      await login(page)
      await page.getByRole('heading', { name: 'Inicio', exact: true }).waitFor()

      if (scenario === 'transient') {
        // La operación del dueño funciona antes y después de la recuperación.
        for (const width of [1440, 390, 320]) {
          await page.setViewportSize({ width, height: 960 })
          await navigate(page, `/products/${product}/edit`)
          await page
            .getByRole('heading', { name: 'Editar perfume', exact: true })
            .waitFor()
          await page
            .getByLabel('Nombre del perfume', { exact: true })
            .fill(`Perfume corregido ${width}`)
          await page
            .getByRole('button', { name: 'Guardar perfume', exact: true })
            .click()
          await page.getByText('Perfume guardado.', { exact: true }).waitFor()
          assert.equal(
            (
              await fixture.db.query(
                'select name from public.products where id=$1',
                [product],
              )
            ).rows[0].name,
            `Perfume corregido ${width}`,
          )
        }
      }
      const initialDocuments = documents
      await navigate(page, target)
      if (scenario !== 'render-error') {
        // La sesión es sólo de memoria: recuperar una versión exige acceder de
        // nuevo y después volver a la dirección completa que se estaba abriendo.
        await page.waitForURL(base + '/login')
        await login(page)
      }
      if (scenario === 'transient') {
        await page
          .getByRole('heading', { name: 'Reportes', exact: true })
          .waitFor()
        assert.equal(page.url(), base + target)
        assert.equal(documents, initialDocuments + 1)
        assert.equal(attempts, 2)
        await navigate(page, `/products/${product}/edit`)
        await page
          .getByRole('heading', { name: 'Editar perfume', exact: true })
          .waitFor()
        assert.equal(
          await page
            .getByLabel('Nombre del perfume', { exact: true })
            .inputValue(),
          'Perfume corregido 320',
        )
        await page
          .getByLabel('Nombre del perfume', { exact: true })
          .fill('Perfume editado después de recuperar')
        await page
          .getByRole('button', { name: 'Guardar perfume', exact: true })
          .click()
        await page.getByText('Perfume guardado.', { exact: true }).waitFor()
        assert.equal(
          (
            await fixture.db.query(
              'select name from public.products where id=$1',
              [product],
            )
          ).rows[0].name,
          'Perfume editado después de recuperar',
        )
      } else {
        const heading = page.getByRole('heading', {
          name: 'No pudimos cargar esta pantalla',
          exact: true,
        })
        await heading.waitFor()
        await page.waitForTimeout(800)
        assert.equal(
          documents,
          initialDocuments + (scenario === 'persistent' ? 1 : 0),
        )
        assert.equal(
          await page
            .getByText('Unexpected Application Error!', { exact: true })
            .count(),
          0,
        )
        assert.equal(
          await page
            .getByRole('button', { name: 'Recargar aplicación', exact: true })
            .count(),
          1,
        )
        assert.equal(
          await page
            .getByRole('link', { name: 'Ir al inicio', exact: true })
            .getAttribute('href'),
          '/',
        )
        for (const width of [1440, 390, 320]) {
          await page.setViewportSize({ width, height: 960 })
          assert.equal(
            await page.evaluate(
              () =>
                globalThis.document.documentElement.scrollWidth <=
                globalThis.innerWidth + 1,
            ),
            true,
          )
          await page.screenshot({
            path: `${output}/${scenario}-${width}.png`,
            fullPage: true,
          })
        }
        if (scenario === 'persistent') {
          assert.equal(attempts, 2)
          missing = false
          await page
            .getByRole('button', { name: 'Recargar aplicación', exact: true })
            .click()
          await page.waitForURL(base + '/login')
          await login(page)
          await page
            .getByRole('heading', { name: 'Reportes', exact: true })
            .waitFor()
          assert.equal(page.url(), base + target)
          assert.equal(documents, initialDocuments + 2)
        } else {
          assert.equal(
            await page
              .getByText(
                'Ocurrió un error al mostrar la pantalla. Recarga la aplicación para continuar.',
                { exact: true },
              )
              .count(),
            1,
          )
        }
      }
      assert.deepEqual(fixture.failures, [])
      results.push({ scenario, status: 'passed', attempts })
      console.log(`PASS recuperación de módulos: ${scenario}`)
    } catch (error) {
      await writeFile(
        `${output}/failure-${scenario}.txt`,
        `${error}\n${await page.locator('body').innerText()}`,
      )
      await page.screenshot({
        path: `${output}/failure-${scenario}.png`,
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
    JSON.stringify({ results, productionWrites: false }, null, 2),
  )
} finally {
  await browser.close()
  await new Promise((resolve, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolve())),
  )
}

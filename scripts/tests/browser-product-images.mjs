import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
import { admin, identity } from './database-fixture.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname))
const widths = process.env.LCP_TEST_WIDTHS
  ? process.env.LCP_TEST_WIDTHS.split(',').map(Number)
  : [1440, 390, 320]
assert.ok(widths.every((width) => Number.isInteger(width) && width >= 320))
const output = 'output/product-images-review'
await mkdir(output, { recursive: true })
// PNG real de un píxel; no usa imágenes, cuentas ni tráfico de producción.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z+XcAAAAASUVORK5CYII=',
  'base64',
)
let checks = 0
const results = []
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of widths) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      timezoneId: 'America/Managua',
      reducedMotion: 'reduce',
      isMobile: width <= 390,
      hasTouch: width <= 390,
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    await page.addInitScript(() => {
      const create = globalThis.URL.createObjectURL.bind(globalThis.URL)
      const revoke = globalThis.URL.revokeObjectURL.bind(globalThis.URL)
      globalThis.__imageCreated = []
      globalThis.__imageRevoked = []
      globalThis.__imageFetches = []
      globalThis.URL.createObjectURL = (blob) => {
        const url = create(blob)
        globalThis.__imageCreated.push({ url, type: blob.type })
        return url
      }
      globalThis.URL.revokeObjectURL = (url) => {
        globalThis.__imageRevoked.push(url)
        revoke(url)
      }
      const fetch = globalThis.fetch.bind(globalThis)
      globalThis.fetch = (input, init) => {
        const url = String(input?.url ?? input)
        if (url.includes('/storage/v1/object/sign/product-images/'))
          globalThis.__imageFetches.push({
            url,
            cache: init?.cache ?? input?.cache,
          })
        return fetch(input, init)
      }
    })
    const failures = []
    let imageCacheModuleUrl
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/lib/privateImageCache.ts'))
        imageCacheModuleUrl = request.url()
    })
    page.on('pageerror', (error) => failures.push(error.message))
    const fixture = await browserDatabase(page)
    const requests = new Map()
    const signatures = []
    let releaseFirst
    let delayed = new Promise((resolve) => (releaseFirst = resolve))
    let releaseLate
    const late = new Promise((resolve) => (releaseLate = resolve))
    let signature = 0
    let flakyFails = 1
    let notFound = true
    const downloads = (path) =>
      [...requests].reduce(
        (total, [url, count]) =>
          total + (new URL(url).pathname.endsWith('/' + path) ? count : 0),
        0,
      )
    // Se registran después del fixture: las rutas específicas tienen prioridad.
    await page.route(
      '**/storage/v1/object/sign/product-images',
      async (route) => {
        const body = route.request().postDataJSON()
        assert.equal(route.request().method(), 'POST')
        signature++
        signatures.push([...body.paths])
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(
            body.paths.map((path) => ({
              path,
              error: null,
              signedURL: `/object/sign/product-images/${path}?token=local-${signature}`,
            })),
          ),
        })
      },
    )
    await page.route(
      '**/storage/v1/object/sign/product-images/**',
      async (route) => {
        const url = route.request().url()
        requests.set(url, (requests.get(url) ?? 0) + 1)
        const path = new URL(url).pathname.split('/product-images/')[1]
        if (path === 'qa/foto-01.png' && delayed) await delayed
        if (path === 'qa/pendiente-02.png') await late
        if (path === 'qa/foto-30.png' && notFound)
          return route.fulfill({ status: 404, body: 'No existe' })
        if (path === 'qa/foto-29.png' && flakyFails-- > 0)
          return route.fulfill({
            status: 503,
            body: 'Temporalmente no disponible',
          })
        return route.fulfill({
          status: 200,
          contentType: 'image/png',
          headers: { 'cache-control': 'no-store' },
          body: png,
        })
      },
    )
    const navigate = async (path, heading) => {
      await page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      await page.getByRole('heading', { name: heading, exact: true }).waitFor()
    }
    const login = async () => {
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
    }
    const photo = (number) =>
      page.locator('.catalog-product').filter({
        has: page.getByRole('button', {
          name: `Foto ${String(number).padStart(2, '0')}`,
          exact: true,
        }),
      })
    const loaded = async (locator) => {
      await locator.scrollIntoViewIfNeeded()
      await locator.locator('img').first().waitFor()
      await page.waitForFunction(
        (selector) => {
          const images = [...globalThis.document.querySelectorAll(selector)]
          return (
            images.length > 0 &&
            images.every((img) => img.complete && img.naturalWidth > 0)
          )
        },
        await locator
          .locator('img')
          .first()
          .evaluate((img) => {
            img.dataset.imageAudit = 'target'
            return 'img[data-image-audit="target"]'
          }),
      )
    }
    const healthy = async (label) => {
      equal(failures, [], `${label}: sin errores JavaScript`)
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
      equal(
        await page
          .locator('.transient-image.is-loading img')
          .evaluateAll((images) =>
            images.every(
              (img) => globalThis.getComputedStyle(img).opacity === '0',
            ),
          ),
        true,
        `${label}: ninguna imagen a medio cargar se muestra rota`,
      )
    }
    try {
      await fixture.db.exec('reset role')
      await fixture.db.exec(`update public.products set active=false;
        update public.products set active=true,
          name='Foto '||right(sku,2), image_path='qa/foto-'||right(sku,2)||'.png'
          where sku between 'QA-0001' and 'QA-0030';`)
      await identity(fixture.db, admin)
      await page.goto(base + '/login')
      await login()
      await navigate('/inventory', 'Inventario')
      await photo(1).scrollIntoViewIfNeeded()
      await photo(1).locator('.transient-image.is-loading').waitFor()
      equal(
        downloads('qa/foto-01.png'),
        1,
        'primera descarga iniciada una sola vez',
      )
      equal(
        await photo(1).locator('img[src]').count(),
        0,
        'carga inicial sin src vacío y sin icono roto',
      )
      await page.screenshot({ path: `${output}/cargando-${width}.png` })

      // El detalle y la tarjeta piden la misma foto mientras sigue descargando.
      await photo(1)
        .getByRole('button', { name: 'Ver Foto 01', exact: true })
        .click()
      const dialog = page.getByRole('dialog')
      await dialog.locator('.transient-image.is-loading').waitFor()
      equal(
        downloads('qa/foto-01.png'),
        1,
        'dos consumidores comparten la descarga pendiente',
      )
      releaseFirst()
      delayed = null
      await loaded(dialog)
      equal(
        await dialog.locator('img').first().getAttribute('src'),
        await photo(1).locator('img').first().getAttribute('src'),
        'tarjeta y detalle reutilizan el mismo blob',
      )
      await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click()
      await loaded(photo(1))
      await page
        .getByRole('button', { name: 'Página siguiente', exact: true })
        .click()
      await photo(25).waitFor()
      await page
        .getByRole('button', { name: 'Página anterior', exact: true })
        .click()
      await loaded(photo(1))
      equal(
        downloads('qa/foto-01.png'),
        1,
        'volver a la página anterior no vuelve a descargar',
      )
      await healthy(`Inventario ${width}`)

      await navigate('/sales', 'Facturación')
      await page
        .getByLabel('Buscar en catálogo', { exact: true })
        .fill('QA-0001')
      const picker = page.locator('.picker-product').first()
      await picker.scrollIntoViewIfNeeded()
      await loaded(picker)
      equal(
        downloads('qa/foto-01.png'),
        1,
        'facturación reutiliza la foto de inventario',
      )
      await healthy(`Facturación ${width}`)
      await page.screenshot({ path: `${output}/facturacion-${width}.png` })
      await navigate('/proformas', 'Proformas')
      await page
        .getByLabel('Buscar en catálogo', { exact: true })
        .fill('QA-0001')
      await loaded(page.locator('.picker-product').first())
      equal(
        downloads('qa/foto-01.png'),
        1,
        'proformas reutilizan la misma foto',
      )

      // Una foto reemplazada tiene otra ruta. No debe quedar la imagen anterior.
      const originalBlob = await page
        .locator('.picker-product img')
        .first()
        .getAttribute('src')
      await fixture.db.exec('reset role')
      await fixture.db.query(
        "update public.products set image_path='qa/reemplazada-01.png' where sku='QA-0001'",
      )
      await identity(fixture.db, admin)
      await navigate('/inventory', 'Inventario')
      await loaded(photo(1))
      equal(
        downloads('qa/reemplazada-01.png'),
        1,
        'la ruta nueva descarga la foto de reemplazo',
      )
      equal(
        downloads('qa/foto-01.png'),
        1,
        'reemplazar no vuelve a descargar la foto anterior',
      )
      equal(
        (await photo(1).locator('img').first().getAttribute('src')) !==
          originalBlob,
        true,
        'el reemplazo muestra otro blob',
      )

      // Expira la concesión en el fixture sin adelantar el reloj de Auth.
      const replacedBlob = await photo(1)
        .locator('img')
        .first()
        .getAttribute('src')
      assert.ok(imageCacheModuleUrl, 'El navegador importó la caché privada')
      await page.evaluate(async (moduleUrl) => {
        const { privateImageCache } = await import(moduleUrl)
        const grant = privateImageCache.get('qa/reemplazada-01.png')
        if (!grant) throw new Error('La concesión de auditoría no existe')
        privateImageCache.set(
          'qa/reemplazada-01.png',
          { ...grant, expires: Date.now() - 1 },
          privateImageCache.generation,
        )
      }, imageCacheModuleUrl)
      await navigate('/sales', 'Facturación')
      await page
        .getByLabel('Buscar en catálogo', { exact: true })
        .fill('QA-0001')
      await loaded(page.locator('.picker-product').first())
      equal(
        downloads('qa/reemplazada-01.png'),
        2,
        'una firma caducada obtiene una nueva descarga autorizada',
      )
      equal(
        (await page
          .locator('.picker-product img')
          .first()
          .getAttribute('src')) !== replacedBlob,
        true,
        'una concesión nueva no usa el blob de la firma anterior',
      )
      await navigate('/inventory', 'Inventario')

      const missingBefore = downloads('qa/foto-30.png')
      await page.getByLabel('Buscar producto', { exact: true }).fill('QA-0030')
      await photo(30).scrollIntoViewIfNeeded()
      await photo(30).getByText('Foto no disponible', { exact: true }).waitFor()
      equal(
        downloads('qa/foto-30.png'),
        missingBefore + 1,
        '404 termina con una sola petición por montaje',
      )
      equal(
        await photo(30).locator('img').count(),
        0,
        '404 muestra el respaldo y elimina la imagen rota',
      )
      await page.getByLabel('Buscar producto', { exact: true }).fill('QA-0029')
      await photo(29).scrollIntoViewIfNeeded()
      await loaded(photo(29))
      equal(
        downloads('qa/foto-29.png'),
        2,
        '503 se recupera con un único reintento acotado',
      )
      const missingAgain = downloads('qa/foto-30.png')
      await page.getByLabel('Buscar producto', { exact: true }).fill('QA-0030')
      await photo(30).getByText('Foto no disponible', { exact: true }).waitFor()
      equal(
        downloads('qa/foto-30.png'),
        missingAgain + 1,
        'volver a una foto ausente hace sólo una petición en el nuevo montaje',
      )
      await page.waitForTimeout(700)
      equal(
        downloads('qa/foto-30.png'),
        missingAgain + 1,
        '404 no entra en un bucle de reintentos',
      )
      await healthy(`Fallos ${width}`)

      // Las fotos sólo se mantienen en memoria dentro de la sesión autorizada.
      await page.getByLabel('Buscar producto', { exact: true }).fill('QA-0001')
      await loaded(photo(1))
      await fixture.db.exec('reset role')
      await fixture.db.query(
        "update public.products set image_path='qa/pendiente-02.png' where sku='QA-0002'",
      )
      await identity(fixture.db, admin)
      await navigate('/proformas', 'Proformas')
      await navigate('/inventory', 'Inventario')
      await page.getByLabel('Buscar producto', { exact: true }).fill('QA-0002')
      await photo(2).scrollIntoViewIfNeeded()
      await photo(2).locator('.transient-image.is-loading').waitFor()
      await page.waitForFunction(() =>
        globalThis.__imageFetches.some((request) =>
          request.url.includes('/qa/pendiente-02.png'),
        ),
      )
      equal(
        downloads('qa/pendiente-02.png'),
        1,
        'descarga pendiente iniciada antes del cierre de sesión',
      )
      const previousUrls = await page.evaluate(() =>
        globalThis.__imageCreated.map((value) => value.url),
      )
      if (width <= 390)
        await page
          .getByRole('button', { name: 'Abrir menú', exact: true })
          .click()
      await page
        .getByRole('button', { name: 'Cerrar sesión', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Iniciar sesión', exact: true })
        .waitFor()
      const revoked = await page.evaluate(() => globalThis.__imageRevoked)
      equal(
        previousUrls.every((url) => revoked.includes(url)),
        true,
        'cerrar sesión revoca todos los blobs anteriores',
      )
      releaseLate()
      await page.waitForTimeout(200)
      equal(
        await page.evaluate(() => globalThis.__imageCreated.length),
        previousUrls.length,
        'una respuesta tardía no crea fotos después de cerrar sesión',
      )
      notFound = false
      await login()
      await navigate('/inventory', 'Inventario')
      await loaded(photo(1))
      equal(
        downloads('qa/reemplazada-01.png'),
        3,
        'iniciar sesión de nuevo solicita otra descarga privada',
      )
      equal(
        signatures.length >= 3,
        true,
        'las firmas se renuevan para el reemplazo y la nueva sesión',
      )
      const fetches = await page.evaluate(() => globalThis.__imageFetches)
      equal(
        fetches.length > 0 &&
          fetches.every((fetch) => fetch.cache === 'no-store'),
        true,
        'se conserva cache no-store para todas las fotos',
      )
      equal(
        await page.evaluate(() =>
          Object.keys(globalThis.localStorage).some((key) =>
            /image|photo|auth-token/.test(key),
          ),
        ),
        false,
        'sin caché de fotos ni credenciales en localStorage',
      )
      await healthy(`Nueva sesión ${width}`)
      results.push({
        width,
        requests: Object.fromEntries(requests),
        signatures,
        fetches: fetches.length,
        checks,
      })
      await page.screenshot({ path: `${output}/final-${width}.png` })
    } finally {
      releaseFirst?.()
      releaseLate?.()
      await context.close()
      await fixture.close()
    }
  }
  await writeFile(
    `${output}/summary.json`,
    JSON.stringify({ checks, results }, null, 2),
  )
  console.log(
    JSON.stringify({ checks, widths, report: `${output}/summary.json` }),
  )
} finally {
  await browser.close()
}

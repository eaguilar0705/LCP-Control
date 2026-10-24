import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { browserDatabase } from './browser-database.mjs'
import { admin, identity } from './database-fixture.mjs'

const base = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname))
const output = 'output/inventory-usability'
await mkdir(output, { recursive: true })
let checks = 0
const measurements = []
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      timezoneId: 'America/Managua',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const fixture = await browserDatabase(page)
    const navigate = async (path, heading) => {
      await page.evaluate((path) => {
        globalThis.history.pushState({}, '', path)
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      }, path)
      await page.getByRole('heading', { name: heading, exact: true }).waitFor()
    }
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
        name + ': sin desplazamiento horizontal',
      )
      const toolbar = page
        .locator('.inventory-toolbar, .directory-toolbar')
        .first()
      for (const field of await toolbar.locator('.field').all()) {
        if (!(await field.isVisible())) continue
        const inside = await field.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return rect.left >= 0 && rect.right <= globalThis.innerWidth + 1
        })
        equal(inside, true, name + ': campo dentro de la pantalla')
      }
    }
    try {
      await fixture.db.exec('reset role')
      await fixture.db.exec(`
        insert into public.customers(name,phone,price_tier,active) values
          ('Cliente VIP activo','88880001','vip',true),
          ('Cliente VIP archivado','88880002','vip',false);
        insert into public.suppliers(name,phone,active) values
          ('Proveedor archivado','88880003',false);
      `)
      await identity(fixture.db, admin)
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
      await navigate('/inventory', 'Inventario')
      await page.locator('.catalog-product').first().waitFor()
      const toggle = page.getByRole('button', { name: /^Filtros/ })
      const panel = page.locator('#inventory-secondary-filters')
      equal(
        await toggle.getAttribute('aria-expanded'),
        'false',
        'filtros secundarios plegados al entrar',
      )
      equal(
        await panel.isVisible(),
        false,
        'la búsqueda no queda detrás de siete filtros',
      )
      equal(
        await page.getByLabel('Buscar producto', { exact: true }).isVisible(),
        true,
        'búsqueda siempre visible',
      )
      equal(
        await page.getByRole('button', { name: /Escanear/ }).isVisible(),
        true,
        'escáner siempre visible',
      )
      equal(
        await page.getByLabel('Moneda', { exact: true }).count(),
        1,
        'mantiene moneda',
      )
      equal(
        await page.getByLabel('Lista de precios', { exact: true }).count(),
        1,
        'mantiene lista de precios',
      )
      await healthy('inventario compacto ' + width)
      const firstProduct = await page
        .locator('.catalog-product')
        .first()
        .boundingBox()
      measurements.push({ width, firstProductTop: firstProduct.y })
      await page.screenshot({
        path: `${output}/inventory-${width}.png`,
        fullPage: false,
      })
      await toggle.click()
      equal(
        await toggle.getAttribute('aria-expanded'),
        'true',
        'abre filtros accesibles',
      )
      const selections = [
        ['Categoría', 'arabian'],
        ['Marca', 'Lattafa'],
        ['Género', 'unisex'],
        ['Tamaño', '100 ml'],
        ['Mostrar perfumes', 'all'],
        ['Ubicación', 'store'],
        ['Existencias', 'available'],
      ]
      for (const [label, value] of selections)
        await panel.getByLabel(label, { exact: true }).selectOption(value)
      await page.getByLabel('Buscar producto', { exact: true }).fill('QA-0001')
      equal(
        await page.locator('.catalog-product').count(),
        1,
        'combina búsqueda y todos los filtros',
      )
      equal(
        await toggle.locator('.inventory-filter-count').textContent(),
        '7',
        'muestra filtros activos',
      )
      await healthy('inventario filtrado ' + width)
      await toggle.click()
      equal(await panel.isVisible(), false, 'permite plegar filtros activos')
      equal(
        await page.locator('.catalog-product').count(),
        1,
        'plegar no elimina filtros',
      )
      equal(
        await toggle.locator('.inventory-filter-count').textContent(),
        '7',
        'plegado avisa que siguen activos',
      )
      await toggle.click()
      for (const [label, value] of selections)
        equal(
          await panel.getByLabel(label, { exact: true }).inputValue(),
          value,
          label + ': conserva selección',
        )
      equal(
        await page.getByLabel('Buscar producto', { exact: true }).inputValue(),
        'QA-0001',
        'conserva búsqueda',
      )
      await page
        .getByRole('button', { name: 'Limpiar filtros', exact: true })
        .click()
      equal(
        await toggle.locator('.inventory-filter-count').count(),
        0,
        'limpiar restablece todos los filtros',
      )
      equal(
        await panel
          .getByLabel('Mostrar perfumes', { exact: true })
          .inputValue(),
        'active',
        'limpiar vuelve a perfumes activos',
      )
      equal(
        await page.getByLabel('Buscar producto', { exact: true }).inputValue(),
        '',
        'limpia búsqueda',
      )
      equal(
        await page.locator('.catalog-product').count(),
        24,
        'mantiene paginación de 24 productos',
      )
      await page.getByRole('button', { name: 'Tabla', exact: true }).click()
      equal(
        await page
          .getByRole('button', { name: 'Tabla', exact: true })
          .getAttribute('aria-pressed'),
        'true',
        'mantiene vista tabla',
      )
      await page.getByRole('button', { name: 'Tarjetas', exact: true }).click()
      await toggle.click()
      await healthy('inventario restaurado ' + width)

      await navigate('/customers', 'Clientes')
      await page.locator('.record-card').first().waitFor()
      equal(
        await page.getByLabel('Buscar', { exact: true }).isVisible(),
        true,
        'buscar cliente visible',
      )
      await page
        .getByLabel('Lista de precios', { exact: true })
        .selectOption('vip')
      equal(
        await page.locator('.record-card').count(),
        1,
        'filtro de lista de clientes activo',
      )
      await page.getByLabel('Mostrar', { exact: true }).selectOption('all')
      equal(
        await page.locator('.record-card').count(),
        2,
        'mostrar todos conserva lista de clientes',
      )
      await page.getByLabel('Buscar', { exact: true }).fill('archivado')
      equal(
        await page.locator('.record-card').count(),
        1,
        'buscar conserva estado y lista',
      )
      equal(
        (await page.locator('.directory-count').textContent()).trim(),
        '1 de 3 clientes',
        'conteo muestra resultado y total',
      )
      await healthy('directorio clientes ' + width)
      await page.screenshot({
        path: `${output}/customers-${width}.png`,
        fullPage: true,
      })
      await page
        .getByRole('button', { name: 'Nuevo cliente', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByLabel('Nombre', { exact: true })
        .waitFor()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cancelar', exact: true })
        .click()
      equal(
        await page.getByLabel('Buscar', { exact: true }).inputValue(),
        'archivado',
        'cancelar formulario conserva filtros de clientes',
      )

      await navigate('/suppliers', 'Proveedores')
      await page.locator('.record-card').first().waitFor()
      await page.getByLabel('Mostrar', { exact: true }).selectOption('archived')
      await page.getByLabel('Buscar', { exact: true }).fill('archivado')
      equal(
        await page.locator('.record-card').count(),
        1,
        'estado y búsqueda de proveedores',
      )
      equal(
        (await page.locator('.directory-count').textContent()).trim(),
        '1 de 2 proveedores',
        'conteo proveedores',
      )
      await healthy('directorio proveedores ' + width)
      await page.screenshot({
        path: `${output}/suppliers-${width}.png`,
        fullPage: true,
      })
    } finally {
      await fixture.db.close()
      await context.close()
    }
  }
} finally {
  await browser.close()
}
await writeFile(
  `${output}/summary.json`,
  JSON.stringify({ checks, measurements }, null, 2),
)
console.log(JSON.stringify({ checks, measurements }))

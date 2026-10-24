import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { browserDatabase } from './browser-database.mjs'
import { identity, admin } from './database-fixture.mjs'

const baseUrl = process.env.LCP_TEST_BASE_URL ?? 'http://127.0.0.1:5173'
const output = 'output/cashier-access'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let checks = 0
function equal(a, b, message) {
  assert.deepEqual(a, b, message)
  checks++
}
async function login(page) {
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
}
async function navigate(page, path) {
  await page.evaluate((target) => {
    globalThis.history.pushState({}, '', target)
    globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
  }, path)
}
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
    try {
      await fixture.db.query('select public.open_business_day($1::jsonb)', [
        JSON.stringify({
          requestId: crypto.randomUUID(),
          openingNio: 0,
          openingUsd: 0,
        }),
      ])
      await fixture.db.exec('reset role')
      await fixture.db.query(
        "update public.staff_members set role='operator' where user_id=$1",
        [admin],
      )
      await identity(fixture.db, admin)
      await login(page)
      equal(
        await page.locator('.stat-card').count(),
        0,
        'Caja no recibe el resumen de inventario',
      )
      equal(
        await page
          .locator(
            'a[href="/inventory"],a[href="/proformas"],a[href="/customers"],a[href="/alerts"],a[href="/inventory/history"]',
          )
          .count(),
        0,
        'sin accesos de inventario ni proformas',
      )
      equal(
        await page
          .getByRole('button', { name: 'Abrir tienda', exact: true })
          .count(),
        0,
        'Caja no abre ni cierra la jornada',
      )
      for (const path of [
        '/inventory',
        '/inventory/history',
        '/products',
        '/products/manage',
        '/products/new',
        '/products/aaaaaaaa-aaaa-4aaa-8aaa-000000000001/edit',
        '/scanner',
        '/alerts',
        '/customers',
        '/proformas',
        '/proformas/history',
        '/reports',
        '/accounting',
        '/staff',
        '/settings',
        '/suppliers',
      ]) {
        await navigate(page, path)
        await page
          .getByText(/No tienes permiso|Tu cuenta no tiene/)
          .first()
          .waitFor()
        equal(
          await page
            .locator(
              '.picker-product,.product-card,.record-card,.movement-record',
            )
            .count(),
          0,
          `sin datos de ${path}`,
        )
      }
      await navigate(page, '/sales')
      await page
        .getByRole('heading', { name: 'Facturación', exact: true })
        .waitFor()
      await page
        .getByLabel('Cliente', { exact: true })
        .fill('Cliente de la caja móvil')
      await page
        .getByLabel('Buscar en catálogo', { exact: true })
        .fill('Oriental')
      await page
        .getByRole('button', { name: /^Agregar Lattafa/ })
        .first()
        .click()
      await page
        .getByRole('button', { name: 'Emitir factura', exact: true })
        .click()
      await page
        .getByText(/FAC-000001/)
        .first()
        .waitFor()
      equal(
        (await fixture.db.query('select count(*)::int n from public.documents'))
          .rows[0].n,
        1,
        'se factura con rol Caja',
      )
      await page
        .getByRole('link', { name: 'Consultar facturas emitidas', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Facturas emitidas', exact: true })
        .waitFor()
      await page
        .getByText(/FAC-000001/)
        .first()
        .waitFor()
      if (width <= 400) {
        equal(
          await page
            .locator('.history-filter-grid input[type="date"]')
            .evaluateAll((fields) =>
              fields.every(
                (field) => field.getBoundingClientRect().width >= 170,
              ),
            ),
          true,
          'las fechas completas caben en el filtro móvil',
        )
      }
      await page.screenshot({
        path: `${output}/caja-${width}.png`,
        fullPage: true,
      })
      equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth + 1,
        ),
        false,
        `sin desborde ${width}px`,
      )
      equal(errors, [], `sin errores de ejecución ${width}px`)
      equal(fixture.failures, [], `sin llamadas fallidas ${width}px`)
    } finally {
      await fixture.close()
      await context.close()
    }
  }
  // Paginación real del cliente utilizado por el directorio y la factura.
  const context = await browser.newContext({
    viewport: { width: 390, height: 960 },
  })
  const page = await context.newPage()
  const fixture = await browserDatabase(page)
  try {
    await fixture.db.exec('reset role')
    await fixture.db.exec(
      "insert into public.customers(name,price_tier) select 'Cliente paginado '||lpad(i::text,4,'0'),'vip' from generate_series(1,2205) i;",
    )
    const last = (
      await fixture.db.query(
        "select id from public.customers where name='Cliente paginado 2205'",
      )
    ).rows[0].id
    await identity(fixture.db, admin)
    await login(page)
    const all = await page.evaluate(async () =>
      (await import('/src/services/workspace.ts')).listContacts('customers'),
    )
    equal(
      all.length,
      2206,
      'se consultan todos los contactos, también después del corte 2000',
    )
    const exact = await page.evaluate(
      async (id) =>
        (await import('/src/services/workspace.ts')).listContacts(
          'customers',
          id,
        ),
      last,
    )
    equal(
      exact.map((r) => r.id),
      [last],
      'verificación por UUID no queda detrás de ninguna página',
    )
    await fixture.db.exec('reset role')
    await fixture.db.exec(
      "insert into public.products(sku,name,brand_id) select 'PAGINA-'||lpad(i::text,4,'0'),'ZZ Perfume paginado '||lpad(i::text,4,'0'),(select id from public.brands limit 1) from generate_series(1,1946) i",
    )
    await identity(fixture.db, admin)
    const catalogue = await page.evaluate(async () => {
      const { privateServices } = await import('/src/services/index.ts')
      const products = await privateServices.productService.listProducts()
      const inventory = await privateServices.inventoryService.getInventory()
      return {
        products: products.length,
        inventory: inventory.length,
        final: products.some((p) => p.barcode === 'PAGINA-1946'),
      }
    })
    equal(
      catalogue,
      { products: 2206, inventory: 2206, final: true },
      'listas de precios y facturación consultan los 2206 perfumes sin cortes',
    )
    await fixture.db.exec('reset role')
    await fixture.db.exec(
      "delete from public.customers where name like 'Cliente paginado %'; insert into public.customers(name,price_tier,active) values('Cliente VIP','vip',true),('Cliente VIP archivado','vip',false),('Cliente Premium','premium',true)",
    )
    await identity(fixture.db, admin)
    await navigate(page, '/customers')
    await page.getByRole('heading', { name: 'Clientes', exact: true }).waitFor()
    await page
      .getByLabel('Lista de precios', { exact: true })
      .selectOption('vip')
    await page
      .getByRole('heading', { name: 'Cliente VIP', exact: true })
      .waitFor()
    equal(
      await page.locator('.contact-card').count(),
      1,
      'filtro VIP combina estado activo',
    )
    await page.getByLabel('Mostrar', { exact: true }).selectOption('archived')
    await page
      .getByRole('heading', { name: 'Cliente VIP archivado', exact: true })
      .waitFor()
    equal(
      await page.locator('.contact-card').count(),
      1,
      'filtro VIP combina archivados',
    )
    equal(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth >
          globalThis.innerWidth + 1,
      ),
      false,
      'filtro adicional no desborda en móvil',
    )
    equal(fixture.failures, [], 'paginación y filtros sin fallas de API')
  } finally {
    await fixture.close()
    await context.close()
  }
  console.log(
    `PASS browser cashier access: ${checks} checks; permisos de Caja, venta e historial en escritorio y móvil, filtros y 2206 clientes paginados`,
  )
} finally {
  await browser.close()
}

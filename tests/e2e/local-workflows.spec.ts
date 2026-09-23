import { test, expect } from '@playwright/test'
test.beforeEach(async ({ page }) => {
  // El entorno de pruebas no habla con servicios reales: cualquier petición que
  // salga del servidor local se corta.
  await page.route(
    (url) => url.protocol.startsWith('http') && url.hostname !== '127.0.0.1',
    (route) => route.abort(),
  )
})
test('catalog categories, variant filters, unavailable photos and internal barcode', async ({
  page,
}, info) => {
  await page.goto('/demo/products')
  await page.getByLabel('Categoría', { exact: true }).selectOption('niche')
  await expect(page.getByText('5 de 30 productos')).toBeVisible()
  await page.getByRole('button', { name: 'Limpiar filtros' }).click()
  await expect(page.getByText('30 de 30 productos')).toBeVisible()
  await page.getByLabel('Marca', { exact: true }).selectOption('Aurora Norte')
  await expect(page.getByText('5 de 30 productos')).toBeVisible()
  await page.getByLabel('Buscar producto').fill('Cedro 01')
  await page.getByLabel('Moneda', { exact: true }).selectOption('USD')
  await page.getByLabel('Lista de precios').selectOption('premium')
  await expect(page.locator('.catalog-price')).toContainText('22.00')
  await expect(page.getByText('Foto no disponible')).toBeVisible()
  await page.getByRole('button', { name: 'Ver Cedro 01', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText(
    'Código de fabricante: pendiente de registrar',
  )
  await expect(
    page.getByRole('img', { name: 'Código interno DEMO-0001' }),
  ).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Descargar etiqueta' }).click()
  expect((await download).suggestedFilename()).toBe('DEMO-0001.svg')
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click()
  await page.getByRole('button', { name: 'Limpiar filtros' }).click()
  await page.getByLabel('Tamaño', { exact: true }).selectOption('unknown')
  await expect(page.getByText('6 de 30 productos')).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: `output/test-results/catalog-${info.project.name}.png`,
    fullPage: true,
  })
})
test('the invoice screen recalculates every tier and currency, saves and reopens a draft', async ({
  page,
}, info) => {
  await page.goto('/demo/sales')
  await page.getByLabel('Cliente', { exact: true }).fill('Cliente de prueba')
  await page
    .getByRole('button', { name: /^Agregar Aurora Norte Cedro 01/ })
    .click()
  await page.getByLabel('Cantidad de Aurora Norte Cedro 01').fill('3')
  // 25 USD por unidad, convertidos con la tasa de muestra de 36.6.
  await expect(page.locator('.invoice-total')).toContainText('2,745.00')
  await page.getByLabel('Moneda', { exact: true }).selectOption('USD')
  await expect(page.locator('.invoice-total')).toContainText('75.00')
  await page.getByLabel('Lista de precios').selectOption('premium')
  await expect(page.locator('.invoice-total')).toContainText('66.00')
  await page.getByLabel('Moneda', { exact: true }).selectOption('NIO')
  await expect(page.locator('.invoice-total')).toContainText('2,415.60')
  await page.getByLabel('Cantidad de Aurora Norte Cedro 01').fill('0')
  await expect(
    page.getByRole('button', { name: 'Guardar borrador' }),
  ).toBeDisabled()
  await page.getByLabel('Cantidad de Aurora Norte Cedro 01').fill('3')
  await page.getByRole('button', { name: 'Guardar borrador' }).click()
  await expect(page.getByRole('status')).toContainText('Borrador guardado')
  await page.reload()
  await page.locator('.saved-drafts button').click()
  await expect(page.getByLabel('Cliente', { exact: true })).toHaveValue(
    'Cliente de prueba',
  )
  await expect(page.locator('.invoice-total')).toContainText('2,415.60')
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: `output/test-results/invoice-${info.project.name}.png`,
    fullPage: true,
  })
  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('.letter-footer')).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Facturación', exact: true }),
  ).not.toBeVisible()
  await page.screenshot({
    path: `output/test-results/invoice-print-${info.project.name}.png`,
    fullPage: true,
  })
})
test('proformas are a separate screen and never share drafts with invoices', async ({
  page,
}, info) => {
  await page.goto('/demo/sales')
  await page.getByLabel('Cliente', { exact: true }).fill('Cliente de factura')
  await page
    .getByRole('button', { name: /^Agregar Aurora Norte Cedro 01/ })
    .click()
  await page.getByRole('button', { name: 'Guardar borrador' }).click()
  await expect(page.getByRole('status')).toContainText('Borrador guardado')
  await page.goto('/demo/proformas')
  await expect(
    page.getByRole('heading', { name: 'Proformas', exact: true }),
  ).toBeVisible()
  await expect(page.locator('.invoice-heading strong')).toContainText(
    'PROFORMA',
  )
  await expect(page.locator('.invoice-notice')).toContainText('cotización')
  // El borrador de factura no aparece aquí: cada tipo guarda por separado.
  await expect(page.locator('.saved-drafts button')).toHaveCount(0)
  await expect(page.getByLabel('Válida hasta')).toBeVisible()
  await expect(page.getByLabel('Forma de pago')).toHaveCount(0)
  await page.getByLabel('Cliente', { exact: true }).fill('Cliente de proforma')
  await page.getByLabel('WhatsApp del cliente').fill('5555 0100')
  await page
    .getByRole('button', { name: /^Agregar Aurora Norte Cedro 01/ })
    .click()
  await expect(page.locator('.invoice-total')).toContainText('915.00')
  await expect(
    page.getByRole('button', { name: 'Enviar por WhatsApp' }),
  ).toBeEnabled()
  await expect(
    page.getByRole('button', { name: 'Compartir PDF' }),
  ).toBeEnabled()
  await page.getByRole('button', { name: 'Guardar borrador' }).click()
  await expect(page.getByRole('status')).toContainText('Borrador guardado')
  await page.screenshot({
    path: `output/test-results/proforma-${info.project.name}.png`,
    fullPage: true,
  })
  // De vuelta en Facturación sólo está el borrador de factura, con su sello.
  await page.goto('/demo/sales')
  await expect(page.locator('.saved-drafts button')).toHaveCount(1)
  await page.locator('.saved-drafts button').click()
  await expect(page.getByLabel('Cliente', { exact: true })).toHaveValue(
    'Cliente de factura',
  )
  await expect(page.locator('.invoice-heading strong')).toContainText('FACTURA')
})
test('supplier registration and edits survive refresh', async ({
  page,
}, info) => {
  await page.goto('/demo/suppliers')
  await page.getByRole('button', { name: 'Nuevo proveedor' }).click()
  await page.getByLabel('Empresa o nombre').fill('Distribuidora de prueba')
  await page.getByLabel('Persona de contacto').fill('Contacto de prueba')
  await page.getByLabel('Teléfono / WhatsApp').fill('8888-0000')
  await page.getByLabel('Correo electrónico').fill('proveedor@example.com')
  await page.getByRole('button', { name: 'Guardar proveedor' }).click()
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Distribuidora de prueba' }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Editar Distribuidora de prueba' })
    .click()
  await page
    .getByLabel('Condiciones de pago y entrega')
    .fill('Entrega por confirmar')
  await page.getByRole('button', { name: 'Guardar proveedor' }).click()
  await expect(page.getByText('Entrega por confirmar')).toBeVisible()
  await expect(page.locator('.supplier-card')).toHaveCount(1)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: `output/test-results/suppliers-${info.project.name}.png`,
    fullPage: true,
  })
})
test('entry, exit and damage are pending drafts and never change stock', async ({
  page,
}) => {
  await page.goto('/demo/inventory')
  for (const title of ['Entrada', 'Salida', 'Dañado']) {
    await page.getByRole('button', { name: title, exact: true }).click()
    await page.getByRole('button', { name: /Producto del movimiento/ }).click()
    await page
      .getByRole('combobox', { name: /Buscar perfume/ })
      .fill('DEMO-0001')
    await page.getByRole('option', { name: /Cedro 01/ }).click()
    await page.getByLabel('Cantidad', { exact: true }).fill('2')
    await page
      .getByLabel(
        title === 'Entrada' ? 'Proveedor o motivo de la entrada' : 'Motivo',
        { exact: true },
      )
      .fill('Prueba del formulario')
    await page
      .getByRole('button', { name: 'Guardar movimiento pendiente' })
      .click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
  }
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Movimientos pendientes (3)' }),
  ).toBeVisible()
  // Los borradores no tocan las existencias: el catálogo local sigue contado.
  await page.getByLabel('Existencias', { exact: true }).selectOption('unknown')
  await expect(page.getByText('0 de 30 productos')).toBeVisible()
  await page
    .getByLabel('Existencias', { exact: true })
    .selectOption('available')
  await expect(page.getByText('30 de 30 productos')).toBeVisible()
})
test('a new visit rotates the reflection without consuming two entries in StrictMode', async ({
  page,
}) => {
  await page.goto('/demo')
  const first = await page.locator('blockquote').innerText()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('lcp.reflections.v1') ?? '[]').length,
      ),
    )
    .toBe(1)
  await page.reload()
  await expect(page.locator('blockquote')).not.toHaveText(first)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('lcp.reflections.v1') ?? '[]').length,
      ),
    )
    .toBe(2)
})

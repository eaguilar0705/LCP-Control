import { test, expect } from '@playwright/test'

test('inventory combines photos, table, product editing and quantity controls', async ({
  page,
}, info) => {
  await page.goto('/demo/products')
  await expect(page).toHaveURL(/\/demo\/inventory$/)
  await expect(
    page.getByRole('heading', { name: 'Inventario', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Catálogo', exact: true }),
  ).toHaveCount(0)
  await page.getByLabel('Buscar producto').fill('Cedro 01')
  await expect(page.locator('.stock-by-location').first()).toContainText('Bodega')
  await page.getByRole('button', { name: 'Tabla', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Tabla', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(
    page.locator('.inventory-table:visible, .inventory-cards:visible'),
  ).toContainText('Cedro 01')
  await page.getByRole('button', { name: 'Tarjetas', exact: true }).click()
  await page.getByRole('link', { name: 'Editar', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Cantidades del perfume' }),
  ).toBeVisible()
  await page.getByLabel('Ubicación de las cantidades').selectOption('warehouse')
  await page
    .getByLabel('Cómo cambiar las cantidades')
    .selectOption({ label: 'Registrar conteo total' })
  await page.getByLabel('Conteo total del perfume').fill('10')
  await page
    .getByRole('button', { name: 'Aumentar cantidad en una unidad' })
    .click()
  await page
    .getByRole('button', { name: 'Reducir cantidad en una unidad' })
    .click()
  await expect(page.getByLabel('Conteo total del perfume')).toHaveValue('10')
  await expect(page.locator('.stock-preview')).toContainText('Bodega')
  await expect(
    page.getByRole('button', { name: 'Guardar cantidades' }),
  ).toBeDisabled()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page
    .locator('.product-stock-editor')
    .screenshot({
      path: `output/test-results/quantity-editor-${info.project.name}.png`,
    })
  await page.getByRole('link', { name: 'Volver al inventario' }).click()
  await page.getByLabel('Mostrar perfumes').selectOption('inactive')
  await expect(
    page.getByRole('heading', { name: 'No hay resultados' }),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Nuevo perfume' }).click()
  await expect(
    page.getByText(
      'Guarda el perfume para registrar sus cantidades en Tienda y Bodega.',
    ),
  ).toBeVisible()
})

test('page titles use one typeface, size and weight across all sections', async ({
  page,
}) => {
  let expected: string[] | undefined
  for (const route of [
    '',
    'inventory',
    'sales',
    'proformas',
    'suppliers',
    'customers',
    'staff',
    'settings',
    'account',
    'scanner',
    'alerts',
    'inventory/history',
    'products/new',
  ]) {
    await page.goto(`/demo/${route}`)
    const title = page.locator('.main-content h1')
    await expect(title).toBeVisible()
    const style = await title.evaluate((el) => {
      const s = getComputedStyle(el)
      return [s.fontFamily, s.fontSize, s.fontWeight]
    })
    expected ??= style
    expect(style, route).toEqual(expected)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      route,
    ).toBe(true)
  }
})

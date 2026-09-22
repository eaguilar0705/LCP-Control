import { test, expect } from '@playwright/test'

test('inventory scanning filters here and clears conflicting filters', async ({
  page,
}, info) => {
  await page.goto('/demo/inventory')
  await page.getByLabel('Buscar producto').fill('no coincide')
  await page.getByRole('button', { name: 'Escanear', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Código de barras o etiqueta').fill('DEMO-0003')
  await dialog.getByRole('button', { name: 'Buscar código' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/\/demo\/inventory$/)
  await expect(page.getByLabel('Buscar producto')).toHaveValue('DEMO-0003')
  await expect(
    page.getByRole('button', { name: 'Vainilla 03', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Escanear', exact: true }),
  ).toHaveCount(0)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: `test-results/context-inventory-${info.project.name}.png`,
    fullPage: true,
  })
})

for (const route of ['sales', 'proformas']) {
  test(`${route} keeps selected products while scanning and handles unknown codes`, async ({
    page,
  }, info) => {
    await page.goto(`/demo/${route}`)
    await page.getByLabel('Buscar en catálogo').fill('DEMO-0001')
    await page
      .locator('.picker-product')
      .getByRole('button', { name: /Agregar/ })
      .click()
    await page.getByRole('button', { name: 'Escanear', exact: true }).click()
    await page
      .getByRole('dialog')
      .getByLabel('Código de barras o etiqueta')
      .fill('DEMO-0003')
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Buscar código' })
      .click()
    await expect(page.getByLabel('Buscar en catálogo')).toHaveValue('DEMO-0003')
    await expect(page.locator('.picker-product')).toContainText('Vainilla 03')
    await expect(page.locator('.main-content')).toContainText('Cedro 01')
    await expect(page).toHaveURL(new RegExp(`/demo/${route}$`))
    await page.screenshot({
      path: `test-results/context-${route}-${info.project.name}.png`,
      fullPage: true,
    })
    await page.getByRole('button', { name: 'Escanear', exact: true }).click()
    await page
      .getByRole('dialog')
      .getByLabel('Código de barras o etiqueta')
      .fill('9999999999999')
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Buscar código' })
      .click()
    await expect(page.getByText('No encontramos ese perfume')).toBeVisible()
    await expect(page.locator('.main-content')).toContainText('Cedro 01')
  })
}

test('registration captures manufacturer code, preserves leading zeros and never submits the editor', async ({
  page,
}) => {
  await page.goto('/demo/products/new')
  await page.getByLabel('Nombre del perfume').fill('Perfume sin guardar')
  await page.getByRole('button', { name: 'Leer código' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Código de barras o etiqueta').fill('DEMO-0003')
  await dialog.getByRole('button', { name: 'Usar código' }).click()
  await expect(dialog.getByRole('alert')).toContainText('EAN o UPC')
  await dialog.getByLabel('Código de barras o etiqueta').fill('012345678905')
  await dialog.getByRole('button', { name: 'Usar código' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(
    page.getByLabel('Código del fabricante (EAN / UPC)'),
  ).toHaveValue('012345678905')
  await expect(page.getByLabel('Nombre del perfume')).toHaveValue(
    'Perfume sin guardar',
  )
  await expect(page).toHaveURL(/\/demo\/products\/new$/)
})

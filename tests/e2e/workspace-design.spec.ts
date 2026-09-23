import { test, expect } from '@playwright/test'
test('visual picker searches as you type and adds the chosen perfume without a dropdown', async ({
  page,
}, info) => {
  await page.goto('/demo/sales')
  await page.getByLabel('Buscar en catálogo').fill('jazmin aurora')
  await expect(page.locator('.picker-product')).toHaveCount(1)
  await page
    .getByRole('button', { name: /^Agregar Aurora Norte Jazmín 02/ })
    .click()
  await expect(page.locator('.invoice-line strong').first()).toHaveText(
    'Aurora Norte Jazmín 02',
  )
  await expect(
    page.getByRole('button', { name: /^Agregar Aurora Norte Jazmín 02/ }),
  ).toBeDisabled()
  await page.getByLabel('Buscar en catálogo').fill('no-existe-perfume')
  await expect(page.getByText('No encontramos ese perfume')).toBeVisible()
  await page.getByRole('button', { name: 'Limpiar búsqueda' }).click()
  await expect(page.locator('.picker-product')).toHaveCount(6)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: `output/test-results/visual-picker-${info.project.name}.png`,
    fullPage: true,
  })
})
test('new management screens share the brand presentation and fit the viewport', async ({
  page,
}, info) => {
  for (const route of ['customers', 'staff', 'settings', 'inventory/history']) {
    await page.goto(`/demo/${route}`)
    await expect(page.locator('.workspace-heading h1')).toBeVisible()
    await expect(page.locator('.state.error')).toHaveCount(0)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await page.screenshot({
      path: `output/test-results/workspace-${route.replace('/', '-')}-${info.project.name}.png`,
      fullPage: true,
    })
  }
})

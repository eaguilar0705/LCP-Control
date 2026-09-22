import { test, expect } from '@playwright/test'

test('product dropdown searches inside the inventory dialog and Escape keeps the form open', async ({
  page,
}, info) => {
  await page.goto('/demo/inventory')
  await page.getByRole('button', { name: 'Entrada', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /Producto del movimiento/ }).click()
  const search = dialog.getByRole('combobox', { name: /Buscar perfume/ })
  await search.fill('DEMO-0001')
  await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(1)
  await expect(dialog.getByRole('listbox').getByRole('option')).toContainText(
    'Cedro 01',
  )
  await dialog.screenshot({
    path: `test-results/product-dropdown-${info.project.name}.png`,
  })
  await search.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('listbox')).toHaveCount(0)
  await dialog.getByRole('button', { name: /Producto del movimiento/ }).click()
  await search.fill('DEMO-0001')
  await search.press('Enter')
  await expect(
    dialog.getByRole('button', { name: /Producto del movimiento/ }),
  ).toContainText('Cedro 01')
  await expect(dialog).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
})

test('short dropdowns use brand styling and retain selection behavior', async ({
  page,
}, info) => {
  await page.goto('/demo/inventory')
  const currency = page.getByLabel('Moneda', { exact: true })
  expect(await currency.evaluate((el) => getComputedStyle(el).appearance)).toBe(
    'base-select',
  )
  await currency.click()
  await expect(currency.getByRole('option', { name: /Dólares/ })).toBeVisible()
  await page.screenshot({
    path: `test-results/currency-dropdown-${info.project.name}.png`,
  })
  await currency.getByRole('option', { name: /Dólares/ }).click()
  await expect(currency).toHaveValue('USD')
})

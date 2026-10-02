import { test, expect } from '@playwright/test'

test('bank transfers retain bank and account currency in drafts and printed invoices', async ({ page }, info) => {
  await page.goto('/demo/sales')
  await page.getByLabel('Cliente', { exact: true }).fill('Cliente de prueba')
  await page.getByRole('button', { name: /^Agregar Aurora Norte Cedro 01/ }).click()
  const payment = page.getByLabel('Forma de pago')
  const accounts = [
    ['bac_nio', 'Bac C$'], ['bac_usd', 'Bac $'],
    ['lafise_nio', 'LAFISE C$'], ['lafise_usd', 'LAFISE $'],
    ['ficohsa_nio', 'Ficohsa C$'], ['ficohsa_usd', 'Ficohsa $'],
  ]
  for (const [value, label] of accounts) {
    await expect(payment.locator(`option[value="${value}"]`)).toHaveText(label)
    await payment.selectOption(value)
    await expect(page.locator('.letter-document')).toContainText(label)
  }
  await page.getByRole('button', { name: 'Guardar borrador' }).click()
  await expect(page.getByRole('status')).toContainText('Borrador guardado')
  await page.reload()
  await page.locator('.saved-drafts button').click()
  await expect(payment).toHaveValue('ficohsa_usd')
  await expect(page.locator('.letter-document')).toContainText('Ficohsa $')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await payment.click()
  await page.screenshot({ path: `output/test-results/bank-transfers-${info.project.name}.png`, fullPage: true })
})

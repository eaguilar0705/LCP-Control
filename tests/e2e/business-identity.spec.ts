import { test, expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

test('business form exposes invoice fields without overflowing on mobile', async ({ page }, info) => {
  await page.goto('/demo/settings')
  for (const label of ['Razón social / Nombre del titular', 'RUC del negocio', 'Sucursal', 'Correo del negocio', 'Datos adicionales de facturación']) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible()
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: `output/test-results/business-${info.project.name}.png`, fullPage: true })
})

test('printed and downloaded documents include the complete issuer identity', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Printed paper has a fixed page size')
  for (const kind of ['invoice', 'proforma'] as const) {
    await page.goto('/demo/settings')
    const bytes = await page.evaluate(async (kind) => {
      const path = '/tests/e2e/fixtures/business-preview.tsx'
      const module = await import(/* @vite-ignore */ path)
      return module.preview(kind) as Promise<number[]>
    }, kind)
    await writeFile(`output/test-results/business-${kind}.pdf`, Buffer.from(bytes))
    await expect(page.locator('.letter-issuer')).toContainText('RUC: J0310000000001')
    await expect(page.locator('.letter-issuer')).toContainText('tienda@example.test')
    await expect(page.locator('.letter-document')).not.toContainText('comprobante fiscal')
    await page.emulateMedia({ media: 'print' })
    await page.pdf({ path: `output/test-results/business-${kind}-html.pdf`, preferCSSPageSize: true, printBackground: true })
    await page.screenshot({ path: `output/test-results/business-${kind}-html.png`, fullPage: true })
    await page.emulateMedia({ media: 'screen' })
  }
  await page.goto('/demo/settings')
  const bytes = await page.evaluate(async () => {
    const path = '/tests/e2e/fixtures/business-preview.tsx'
    const module = await import(/* @vite-ignore */ path)
    return module.preview('invoice', true) as Promise<number[]>
  })
  await writeFile('output/test-results/business-long-identity.pdf', Buffer.from(bytes))
})

import { test, expect } from '@playwright/test'

test('product editor exposes all fields and photo replacement without real writes in demo', async ({
  page,
}, info) => {
  await page.goto('/demo/products/manage')
  await expect(page).toHaveURL(/\/demo\/inventory$/)
  await page.getByLabel('Buscar producto').fill('Cedro 01')
  await page.getByRole('link', { name: 'Editar', exact: true }).click()
  await expect(page.getByLabel('Nombre del perfume')).toHaveValue('Cedro 01')
  await page.getByLabel('Nombre del perfume').fill('Nombre revisado')
  await page.getByLabel('Categoría', { exact: true }).selectOption('niche')
  await page.getByLabel('Tamaño (vacío si falta confirmar)').fill('100')
  await page.getByLabel('Unidad', { exact: true }).selectOption('ml')
  await expect(page.getByLabel('VIP USD', { exact: true })).toHaveValue('24')
  await expect(
    page.getByRole('button', { name: 'Guardar perfume' }),
  ).toBeDisabled()
  await page
    .getByLabel('Cambiar imagen')
    .setInputFiles('public/brand/monogram-wine.jpeg')
  await expect(page.locator('.editor-photo img')).toHaveAttribute(
    'src',
    /^blob:/,
  )
  await expect(page.locator('.optimized-photo-note')).toContainText('WebP')
  await expect(page.locator('.optimized-photo-note')).toContainText('KB')
  expect(
    await page
      .locator('.editor-photo img')
      .evaluate((img: HTMLImageElement) => img.naturalWidth > 0),
  ).toBe(true)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: `output/test-results/product-editor-${info.project.name}.png`,
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Quitar foto' }).click()
  await expect(page.locator('.editor-photo img')).toHaveCount(0)
})

test('letter examples download a PDF and print only the business document', async ({
  page,
}, info) => {
  for (const kind of ['invoice', 'proforma']) {
    await page.goto(`/demo/documents/example/${kind}`)
    await expect(page.locator('.letter-stamp')).toContainText('EJEMPLO')
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Descargar PDF' }).click()
    const result = await download
    expect(result.suggestedFilename()).toContain(
      kind === 'invoice' ? 'FAC-EJEMPLO' : 'PRO-EJEMPLO',
    )
    await result.saveAs(`output/test-results/${kind}-${info.project.name}.pdf`)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await page.emulateMedia({ media: 'print' })
    await expect(page.locator('.letter-document')).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Descargar PDF' }),
    ).toBeHidden()
    if (info.project.name === 'desktop')
      await page.pdf({
        path: `output/test-results/${kind}-browser-print.pdf`,
        preferCSSPageSize: true,
        printBackground: true,
      })
    await page.screenshot({
      path: `output/test-results/${kind}-letter-${info.project.name}.png`,
      fullPage: true,
    })
    await page.emulateMedia({ media: 'screen' })
  }
})

test('account form leaves role read-only and does not change credentials in demo', async ({
  page,
}) => {
  await page.goto('/demo/account')
  await expect(page.getByLabel('Nombre visible')).toHaveValue(
    'Usuario de ejemplo',
  )
  await expect(
    page.getByLabel('Nueva contraseña', { exact: true }),
  ).toHaveAttribute('type', 'password')
  await expect(
    page.getByRole('button', { name: 'Cambiar contraseña' }),
  ).toBeDisabled()
  await expect(
    page.getByRole('button', { name: 'Guardar nombre' }),
  ).toBeDisabled()
})

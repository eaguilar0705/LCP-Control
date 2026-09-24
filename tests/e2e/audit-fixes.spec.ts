import { expect, test } from '@playwright/test'

// Correcciones de la auditoría del 23 de septiembre de 2026.

test('el velo del menú del teléfono cierra el menú sin pulsar lo que hay debajo', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'El menú desplegable sólo existe en el teléfono')
  await page.goto('/demo/inventory')
  const hidden = await page
    .getByRole('button', { name: 'Dañado' })
    .boundingBox()
  await page.getByRole('button', { name: 'Más' }).click()
  await expect(page.locator('.sidebar-open')).toBeVisible()
  // Fuera del panel (280 px) y justo encima del botón «Dañado».
  await page.mouse.click(
    hidden!.x + hidden!.width - 8,
    hidden!.y + hidden!.height / 2,
  )
  await expect(page.locator('.sidebar-open')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)

  const more = page.getByRole('button', { name: 'Más' })
  await more.click()
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('button', { name: 'Cerrar menú' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('.sidebar-open')).toHaveCount(0)
  await expect(more).toBeFocused()
})

test('una fecha elegida a mano no deja marcado otro periodo ni un rango invertido', async ({
  page,
}) => {
  await page.goto('/demo/reports')
  await expect(page.getByRole('heading', { name: 'Reportes' })).toBeVisible()
  await page.getByLabel('Desde').fill('2026-08-01')
  await expect(page.locator('.preset[aria-pressed="true"]')).toHaveCount(0)
  await page.getByLabel('Desde').fill('2099-01-01')
  await expect(page.getByLabel('Hasta')).toHaveValue('2099-01-01')
  await page.getByRole('button', { name: 'Últimos 7 días' }).click()
  await expect(
    page.getByRole('button', { name: 'Últimos 7 días' }),
  ).toHaveAttribute('aria-pressed', 'true')
})

test('la proforma avisa si la vigencia está vacía o vencida', async ({
  page,
}) => {
  await page.goto('/demo/proformas')
  await page
    .getByRole('button', { name: /Agregar Aurora Norte Cedro 01/ })
    .click()
  await page.getByLabel('Cliente', { exact: true }).fill('Cliente de prueba')
  const validity = page.getByLabel('Válida hasta')
  await validity.fill('')
  await expect(
    page.getByText('Elige hasta qué fecha es válida la proforma.'),
  ).toBeVisible()
  await validity.fill('2020-01-01')
  await expect(
    page.getByText('La vigencia no puede ser anterior a hoy.'),
  ).toBeVisible()
})

test('un borrador guardado se puede eliminar', async ({ page }) => {
  await page.goto('/demo/sales')
  await page
    .getByRole('button', { name: /Agregar Aurora Norte Cedro 01/ })
    .click()
  await page.getByLabel('Cliente', { exact: true }).fill('Cliente temporal')
  await page.getByRole('button', { name: 'Guardar borrador' }).click()
  await expect(page.locator('.saved-drafts button')).toHaveCount(1)
  await page.getByRole('button', { name: 'Eliminar borrador' }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Eliminar borrador' })
    .click()
  await expect(page.locator('.saved-drafts button')).toHaveCount(0)
  await expect(page.getByText('Borrador eliminado.')).toBeVisible()
})

test('el inventario encuentra perfumes aunque se escriban sin tilde', async ({
  page,
}) => {
  await page.goto('/demo/inventory')
  await page.getByLabel('Buscar producto').fill('jazmin')
  await expect(page.locator('.table-footer span').first()).toHaveText(
    '6 de 30 productos',
  )
})

test('una dirección inexistente tiene su propio encabezado principal', async ({
  page,
}) => {
  await page.goto('/no-existe')
  await expect(
    page.getByRole('heading', { level: 1, name: 'Página no encontrada' }),
  ).toBeVisible()
})

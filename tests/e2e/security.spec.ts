import { expect, test } from '@playwright/test'

// Auditoría de seguridad del 26-09-2026. La sesión vive sólo en la memoria de
// la pestaña; lo que no exige sesión se comprueba aquí.

test('el ejemplo de factura se abre en otra pestaña sin pedir la sesión', async ({
  page,
}) => {
  await page.goto('/documents/example/invoice')
  await expect(
    page.getByRole('heading', { name: 'Ejemplo de factura' }),
  ).toBeVisible()
  await page.goto('/documents/example/proforma')
  await expect(
    page.getByRole('heading', { name: 'Ejemplo de proforma' }),
  ).toBeVisible()
})

test('las pantallas privadas siguen pidiendo iniciar sesión', async ({
  page,
}) => {
  for (const path of ['/', '/inventory', '/sales', '/staff', '/settings']) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/login$/)
  }
})

test('sin sesión el navegador no guarda credenciales ni cookies', async ({
  page,
  context,
}) => {
  await page.goto('/login')
  await page.getByLabel('Correo electrónico').fill('persona@example.com')
  await page
    .getByLabel('Contraseña', { exact: true })
    .fill('ClaveDePrueba-2026!')
  await page.getByRole('button', { name: 'Iniciar sesión' }).click()
  const stored = await page.evaluate(() =>
    JSON.stringify([
      Object.entries(localStorage),
      Object.entries(sessionStorage),
      document.cookie,
    ]),
  )
  expect(stored).not.toContain('ClaveDePrueba-2026!')
  expect(stored).not.toMatch(/sb-.+-auth-token/)
  expect(await context.cookies()).toEqual([])
})

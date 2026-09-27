import { test, expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

const fits = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)

// La pantalla Precios en la vista local: datos de muestra, sin escrituras.
test('owners see the average cost, percentage, profit and sale price of each list', async ({
  page,
}) => {
  await page.goto('/demo/prices')
  await expect(page.getByRole('heading', { name: 'Precios' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: /Calculados\s*4/ }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: /Pendientes de costo\s*1/ }),
  ).toBeVisible()
  // Cedro 11: costo promedio C$ 1 050.42 con 28.1 % en Emprendedor.
  await page.getByRole('button', { name: 'Editar precios de Cedro 11' }).click()
  const dialog = page.getByRole('dialog', { name: 'Cedro 11' })
  await expect(dialog.locator('output')).toHaveText('NIO 1,050.42')
  const emprendedor = dialog.getByRole('group', { name: 'Emprendedor' })
  await expect(emprendedor).toContainText('NIO 295.17')
  await expect(emprendedor).toContainText('NIO 1,345.59')
  // El costo no se escribe: sólo hay un porcentaje por lista.
  await expect(dialog.getByRole('spinbutton')).toHaveCount(3)
  await dialog
    .getByLabel('% de ganancia sobre el costo · Emprendedor')
    .fill('25')
  // 1 050.42 × 1.25 = 1 313.025 → 1 313.03; en dólares 35.88.
  await expect(emprendedor).toContainText('NIO 262.61')
  await expect(emprendedor).toContainText('NIO 1,313.03')
  await expect(emprendedor).toContainText('USD 35.88')
  // La vista local deja probar el cálculo, pero no guardar.
  await expect(
    dialog.getByRole('button', { name: 'Guardar precios' }),
  ).toBeDisabled()
  await expect(dialog).toContainText('los precios no se guardan')
  expect(await fits(page)).toBe(true)
})

test('the inventory cost section lists stock and average cost apart from the percentages', async ({
  page,
}) => {
  await page.goto('/demo/prices?apartado=costo')
  const table = page.getByRole('region', { name: 'Costo promedio por perfume' })
  await expect(table).toBeVisible()
  await expect(
    page.getByText('Costo promedio nuevo = (existencias'),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: /Sin costo\s*1/ }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Registrar compra', exact: true }),
  ).toBeDisabled()
  expect(await fits(page)).toBe(true)
})

test('a CSV file is previewed with the rows that change and the rows it cannot use', async ({
  page,
}, info) => {
  const file = info.outputPath('precios.csv')
  await writeFile(
    file,
    [
      'Código;Marca;Perfume;Costo promedio C$ (informativo, no se importa);% Emprendedor;% VIP;% Premium',
      'DEMO-0002;Aurora Norte;Jazmín 02;1;20;15;10',
      'DEMO-0009;;;;30;25;20',
      'DEMO-9999;;;;1;1;1',
    ].join('\r\n'),
  )
  await page.goto('/demo/prices')
  await page.getByRole('button', { name: 'Cargar archivo' }).click()
  const dialog = page.getByRole('dialog', {
    name: 'Cargar precios desde un archivo',
  })
  await dialog.getByLabel('Archivo con los precios').setInputFiles(file)
  await expect(dialog).toContainText('2 perfumes cambian')
  await expect(dialog).toContainText('1 fila no se puede usar')
  await expect(dialog).toContainText(
    'No hay ningún perfume con el código «DEMO-9999»',
  )
  await expect(dialog).toContainText('no se importa')
  // Jazmín 02: costo C$ 523.38 con 20 % → C$ 628.06 (el «1» del archivo no cuenta).
  await expect(dialog.getByRole('region', { name: 'Cambios' })).toContainText(
    'NIO 628.06',
  )
  await expect(
    dialog.getByRole('button', { name: 'Guardar 2 perfumes' }),
  ).toBeDisabled()
  expect(await fits(page)).toBe(true)
})

test('the perfume editor keeps pending and manual lists editable until there is a cost', async ({
  page,
}) => {
  await page.goto('/demo/products/demo-0021/edit')
  // Cedro 21 tiene 9.8 % en Emprendedor y todavía no tiene costo promedio.
  const card = page.locator('#precios')
  await expect(card.getByText('Sin costo todavía')).toBeVisible()
  const emprendedor = page.getByRole('group', { name: 'Emprendedor' })
  await expect(emprendedor).toContainText('Pendiente de costo')
  await expect(page.getByLabel('Emprendedor USD', { exact: true })).toHaveValue(
    '45',
  )
  await expect(page.getByLabel('VIP USD', { exact: true })).toHaveValue('44')
  await page.getByLabel('% de ganancia sobre el costo · VIP').fill('10')
  await expect(page.getByRole('group', { name: 'VIP' })).toContainText(
    'Pendiente de costo',
  )
  await expect(page.getByLabel('VIP USD', { exact: true })).toHaveCount(1)
  expect(await fits(page)).toBe(true)
})

test('the perfume editor computes from the average cost when there is one', async ({
  page,
}) => {
  await page.goto('/demo/products/demo-0006/edit')
  const vip = page.getByRole('group', { name: 'VIP' })
  // Cedro 06: costo C$ 735.66 con 20 % en VIP → C$ 882.79.
  await expect(vip).toContainText('Calculado')
  await expect(vip).toContainText('NIO 882.79')
  await expect(page.getByLabel('VIP USD', { exact: true })).toHaveCount(0)
  await page.getByLabel('% de ganancia sobre el costo · VIP').fill('')
  await expect(vip).toContainText('A mano')
  await expect(page.getByLabel('VIP USD', { exact: true })).toHaveCount(1)
  expect(await fits(page)).toBe(true)
})

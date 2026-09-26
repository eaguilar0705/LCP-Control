import { test, expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

// La pantalla Precios en la vista local: datos de muestra, sin escrituras.
test('owners see purchase price, percentage, profit and sale price of each list', async ({
  page,
}) => {
  await page.goto('/demo/prices')
  await expect(page.getByRole('heading', { name: 'Precios' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: /Calculados\s*3/ }),
  ).toBeVisible()
  // Cedro 11 se compró en C$ 1 000 con 28,1 % en Emprendedor: C$ 1 281.
  await page.getByRole('button', { name: 'Editar precios de Cedro 11' }).click()
  const dialog = page.getByRole('dialog', { name: 'Cedro 11' })
  const emprendedor = dialog.getByRole('group', { name: 'Emprendedor' })
  await expect(emprendedor).toContainText('NIO 1,000.00')
  await expect(emprendedor).toContainText('NIO 281.00')
  await expect(emprendedor).toContainText('NIO 1,281.00')
  // El ejemplo del dueño: C$ 500 con 20 % se vende en C$ 600.
  await dialog.getByLabel('Precio de compra', { exact: true }).fill('500')
  await dialog.getByLabel('% de ganancia Emprendedor').fill('20')
  await expect(emprendedor).toContainText('NIO 100.00')
  await expect(emprendedor).toContainText('NIO 600.00')
  await expect(emprendedor).toContainText('USD 16.39')
  // La vista local deja probar el cálculo, pero no guardar.
  await expect(
    dialog.getByRole('button', { name: 'Guardar precios' }),
  ).toBeDisabled()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
})

test('a CSV file is previewed with the rows that change and the rows it cannot use', async ({
  page,
}, info) => {
  const file = info.outputPath('precios.csv')
  await writeFile(
    file,
    [
      'Código;Marca;Perfume;Precio de compra;Moneda;% Emprendedor;% VIP;% Premium',
      'DEMO-0002;Aurora Norte;Jazmín 02;500;C$;20;15;10',
      'DEMO-0009;;;20;US$;30;25;20',
      'DEMO-9999;;;5;C$;1;1;1',
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
  await expect(dialog.getByRole('region', { name: 'Cambios' })).toContainText(
    'NIO 600.00',
  )
  await expect(
    dialog.getByRole('button', { name: 'Guardar 2 perfumes' }),
  ).toBeDisabled()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
})

test('the perfume editor shows the same breakdown and keeps manual lists editable', async ({
  page,
}) => {
  await page.goto('/demo/products/demo-0021/edit')
  // Cedro 21: Emprendedor calculado desde C$ 1 500; VIP y Premium a mano.
  const emprendedor = page.getByRole('group', { name: 'Emprendedor' })
  await expect(emprendedor).toContainText('NIO 1,500.00')
  await expect(emprendedor).toContainText('9.8 % de la compra')
  await expect(emprendedor).toContainText('NIO 1,647.00')
  await expect(page.getByLabel('VIP USD', { exact: true })).toHaveValue('44')
  await page.getByLabel('% de ganancia VIP').fill('10')
  await expect(page.getByRole('group', { name: 'VIP' })).toContainText(
    'NIO 1,650.00',
  )
  await expect(page.getByLabel('VIP USD', { exact: true })).toHaveCount(0)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
})

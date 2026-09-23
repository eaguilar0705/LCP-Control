import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

// Los reportes se calculan en el navegador sobre las ventas sintéticas de la
// vista local, así que estas pruebas comprueban cifras reales sin tocar la base.

test('muestra indicadores, gráficos y el detalle del periodo', async ({
  page,
}, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/demo/reports')
  await expect(page.getByRole('heading', { name: 'Reportes' })).toBeVisible()

  // Una cifra de ingresos con separador de miles: el cálculo llegó a la pantalla.
  const cordobas = page.locator('.report-currency').first()
  await expect(cordobas.getByText('Ingresos', { exact: true })).toBeVisible()
  await expect(cordobas.locator('.stat-card strong').first()).toHaveText(
    /NIO\s[\d,]+\.\d{2}/,
  )

  await expect(
    page.getByRole('img', { name: /Ingresos diarios en NIO/ }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Productos más vendidos' }).first(),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Formas de pago' }).first(),
  ).toBeVisible()

  await page.screenshot({
    path: `output/test-results/reportes-${info.project.name}.png`,
    fullPage: true,
  })
  expect(errors).toEqual([])
})

test('el periodo cambia las cifras y el encabezado', async ({ page }) => {
  await page.goto('/demo/reports')
  const total = page.locator('.report-currency .stat-card strong').first()
  await expect(total).toHaveText(/NIO/)
  const thirtyDays = await total.textContent()

  await page.getByRole('button', { name: 'Últimos 7 días' }).click()
  await expect(
    page.getByRole('button', { name: 'Últimos 7 días' }),
  ).toHaveAttribute('aria-pressed', 'true')
  // Siete días venden menos que treinta: la cifra tiene que bajar.
  await expect(total).not.toHaveText(thirtyDays ?? '')
})

test('descarga el reporte en PDF y en Excel', async ({ page }) => {
  await page.goto('/demo/reports')
  await expect(page.getByRole('heading', { name: 'Reportes' })).toBeVisible()

  const pdfDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Descargar PDF' }).click()
  const pdf = await pdfDownload
  expect(pdf.suggestedFilename()).toMatch(
    /^reporte-\d{4}-\d{2}-\d{2}-a-.*\.pdf$/,
  )
  const pdfPath = await pdf.path()
  const pdfBytes = readFileSync(pdfPath)
  // Cabecera y marca de fin de un PDF válido.
  expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-')
  expect(pdfBytes.subarray(-1024).toString()).toContain('%%EOF')
  expect(pdfBytes.length).toBeGreaterThan(5000)

  const excelDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Descargar Excel' }).click()
  const excel = await excelDownload
  expect(excel.suggestedFilename()).toMatch(/\.xlsx$/)
  const excelBytes = readFileSync(await excel.path())
  // Un .xlsx es un ZIP: empieza por PK y contiene el libro.
  expect(excelBytes.subarray(0, 2).toString()).toBe('PK')
  expect(excelBytes.toString('latin1')).toContain('xl/workbook.xml')
  expect(excelBytes.length).toBeGreaterThan(3000)
})

test('la portada resume el mes y ya no ofrece el atajo del lector', async ({
  page,
}) => {
  await page.goto('/demo')
  await expect(
    page.getByRole('heading', { name: 'Ingresos de los últimos 30 días' }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Más vendidos del mes' }),
  ).toBeVisible()
  // El atajo se retiró: ocupaba una franja para repetir lo que ya está en el menú.
  await expect(
    page.getByRole('heading', { name: 'Buscar por código' }),
  ).toHaveCount(0)
  // El lector ahora acompaña las búsquedas, no ocupa una pestaña.
  await expect(
    page.getByRole('link', { name: 'Escanear', exact: true }),
  ).toHaveCount(0)
})

test('muestra la variación contra el periodo anterior y los indicadores de seguimiento', async ({
  page,
}) => {
  await page.goto('/demo/reports')
  const cordobas = page.locator('.report-currency').first()

  // La comparación con el periodo previo exige cargar más días de los pedidos:
  // si la ventana no llegara, no habría contra qué comparar.
  await expect(cordobas.locator('.stat-delta').first()).toContainText('%')
  await expect(cordobas.getByText(/antes NIO/).first()).toBeVisible()

  await expect(
    page.getByRole('heading', { name: 'Clientes que no volvieron' }).first(),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Con qué frecuencia vuelven' }).first(),
  ).toBeVisible()
  await expect(
    page.getByRole('img', { name: /Ingresos por día de la semana/ }).first(),
  ).toBeVisible()
  await expect(cordobas.getByText(/concentran el \d+%/).first()).toBeVisible()

  await expect(
    page.getByRole('heading', { name: 'Qué reponer primero' }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Capital detenido' }),
  ).toBeVisible()
})

test('el total del periodo no arrastra los días de la ventana anterior', async ({
  page,
}) => {
  await page.goto('/demo/reports')
  const total = page.locator('.report-currency .stat-card strong').first()
  await expect(total).toHaveText(/NIO/)

  // El mismo dato en dos sitios: el indicador y el pie del gráfico de la
  // portada salen del mismo cálculo, así que una ventana mal acotada los
  // separaría.
  const reported = (await total.textContent()) ?? ''
  await page.goto('/demo')
  await expect(page.locator('.report-figure').first()).toHaveText(
    reported.trim(),
  )
})

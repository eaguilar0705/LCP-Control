import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

test('conecta resumen, crédito, flujo, arqueo y exportación en la muestra', async ({
  page,
}, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/demo/accounting')
  await expect(
    page.getByRole('heading', { name: 'Contabilidad', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Resumen', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(
    page.getByText('Ventas del período', { exact: true }),
  ).toBeVisible()
  await page.screenshot({
    path: `output/test-results/contabilidad-resumen-${info.project.name}.png`,
    fullPage: true,
  })

  await page
    .getByRole('button', { name: 'Cobros y pagos', exact: true })
    .click()
  const credits = page.getByRole('table', {
    name: 'Cuentas por cobrar y pagar al corte',
  })
  await expect(credits).toBeVisible()
  await expect(credits).toContainText('Saldo C$')
  await expect(
    credits.getByRole('button', { name: /Registrar abono/ }).first(),
  ).toBeDisabled()
  await page.getByLabel('Estado de cuenta').selectOption('settled')
  await expect(credits).toContainText('Saldada')
  await page.getByLabel('Estado de cuenta').selectOption('pending')

  await page
    .getByRole('button', { name: 'Flujo de efectivo', exact: true })
    .click()
  await expect(
    page.getByRole('table', { name: 'Entradas y salidas de dinero' }),
  ).toBeVisible()
  await page.getByLabel('Cuenta de dinero').selectOption('caja')
  await expect(
    page.getByRole('table', { name: 'Entradas y salidas de dinero' }),
  ).not.toContainText('Banco')
  await page.screenshot({
    path: `output/test-results/contabilidad-flujo-${info.project.name}.png`,
    fullPage: true,
  })

  await page.getByRole('button', { name: 'Cierre diario', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Arqueo de efectivo' }),
  ).toBeVisible()
  await expect(page.getByLabel('C$ 100 · cantidad')).toBeDisabled()
  await expect(
    page.getByRole('button', { name: 'Guardar arqueo' }),
  ).toBeDisabled()
  await page.screenshot({
    path: `output/test-results/contabilidad-arqueo-${info.project.name}.png`,
    fullPage: true,
  })

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Descargar Excel' }).click()
  const download = await downloadPromise
  const bytes = readFileSync(await download.path())
  expect(bytes.subarray(0, 2).toString()).toBe('PK')
  const text = bytes.toString('utf8')
  for (const name of [
    'Movimientos de dinero',
    'Cobros y pagos',
    'Flujo de efectivo',
    'Arqueos de caja',
  ])
    expect(text).toContain(name)
  expect(errors).toEqual([])
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
})

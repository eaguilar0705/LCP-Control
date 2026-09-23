import { test, expect } from '@playwright/test'

// Cuenta las hojas de un PDF generado por Chrome.
function pageCount(pdf: Buffer) {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? [])
    .length
}

test.describe('impresión compacta de facturas y proformas', () => {
  for (const kind of ['invoice', 'proforma'] as const)
    for (const count of [20, 30, 40])
      test(`${kind} con ${count} productos cabe en una hoja carta y A4`, async ({
        page,
      }, info) => {
        test.skip(
          info.project.name !== 'desktop',
          'page.pdf sólo existe en Chromium de escritorio',
        )
        await page.goto(`/demo/documents/example/${kind}?productos=${count}`)
        await expect(page.locator('.letter-items tbody tr')).toHaveCount(count)
        await page.emulateMedia({ media: 'print' })
        const description = page.locator('.letter-description').first()
        expect(
          Number(
            await description.evaluate((cell) =>
              parseFloat(getComputedStyle(cell).fontSize),
            ),
          ),
        ).toBeGreaterThanOrEqual(11)
        expect(
          await description.evaluate(
            (cell) => getComputedStyle(cell).fontWeight,
          ),
        ).toBe('700')
        expect(
          await page
            .locator('.letter-money')
            .first()
            .evaluate((cell) => getComputedStyle(cell).fontWeight),
        ).toBe('700')
        for (const format of ['Letter', 'A4'] as const) {
          const pdf = await page.pdf({ format, printBackground: true })
          expect(pageCount(pdf), `${format}`).toBe(1)
          if (count === 40)
            await page.screenshot({
              path: `output/test-results/print-${kind}-${count}.png`,
              fullPage: true,
            })
        }
      })
})

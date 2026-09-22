import { test, expect } from '@playwright/test'
import { writeQrVideo } from './fakeCamera'
import { browserChannel } from '../../playwright.config'

// The camera lifecycle is covered in foundation.spec.ts. This checks the step
// that only a real decode exercises: a code read from video reaches the
// catalogue lookup, stops the camera, and shows the product. QR here, CODE128
// (the format printed on the shelf labels) in scanner-decode-unknown.spec.ts.

const CODE = 'DEMO-0003'

test('context camera returns the product to inventory and releases the camera', async ({
  page,
}) => {
  await page.goto('/demo/inventory')
  await page.getByRole('button', { name: 'Escanear', exact: true }).click()
  await page.getByRole('button', { name: 'Activar cámara' }).click()
  await expect(page.getByLabel('Buscar producto')).toHaveValue(CODE, {
    timeout: 45000,
  })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('video')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Vainilla 03', exact: true }),
  ).toBeVisible()
})

test.setTimeout(90000)

test.use({
  launchOptions: {
    channel: browserChannel,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${writeQrVideo(CODE, 'test-results/fake-camera/known-qr.y4m')}`,
    ],
  },
})

test('the camera reads a registered code and shows the product', async ({
  page,
}, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/demo/scanner')
  await page.getByRole('button', { name: 'Iniciar cámara' }).click()

  // A clean synthetic frame can decode before the video paints, so the result
  // is the signal here; foundation.spec.ts covers the camera's own lifecycle.
  await expect(page.getByText('Producto encontrado')).toBeVisible({
    timeout: 45000,
  })
  await expect(
    page.getByRole('heading', { name: 'Vainilla 03', exact: true }),
  ).toBeVisible()
  await expect(page.getByText(CODE, { exact: true })).toBeVisible()

  // A read stops the camera: the button offers a new scan instead of a stop.
  await expect(
    page.getByRole('button', { name: 'Escanear de nuevo' }),
  ).toBeVisible()
  await expect(page.locator('video')).toHaveCount(0)

  await page.screenshot({
    path: `test-results/scanner-decoded-${info.project.name}.png`,
    fullPage: true,
  })
  expect(errors).toEqual([])
})

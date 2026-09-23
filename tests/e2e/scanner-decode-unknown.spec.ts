import { test, expect } from '@playwright/test'
import { writeBarcodeVideo } from './support/fakeCamera'
import { browserChannel } from '../../playwright.config'

// Separate file because Playwright only allows one launchOptions per worker.
// Reads a CODE128 label, the format the app prints, and checks that a code
// outside the catalogue is reported instead of silently ignored.

const CODE = 'DEMO-9999'

test.setTimeout(90000)

test.use({
  launchOptions: {
    channel: browserChannel,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${writeBarcodeVideo(CODE, 'output/test-results/fake-camera/unknown-code128.y4m')}`,
    ],
  },
})

test('an unregistered code is reported with its next step', async ({
  page,
}) => {
  await page.goto('/demo/scanner')
  await page.getByRole('button', { name: 'Iniciar cámara' }).click()

  await expect(page.getByText('Código no registrado')).toBeVisible({
    timeout: 45000,
  })
  await expect(page.getByText(CODE, { exact: true })).toBeVisible()
  await expect(page.locator('video')).toHaveCount(0)
})

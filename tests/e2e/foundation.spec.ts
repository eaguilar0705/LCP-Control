import { test, expect } from '@playwright/test'
import { browserChannel } from '../../playwright.config'
declare global {
  interface Window {
    __cameraTracks: MediaStreamTrack[]
  }
}

test.use({
  launchOptions: {
    channel: browserChannel,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
})
test.describe('browser camera lifecycle', () => {
  test('starts and releases video on stop and SPA navigation', async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
      window.__cameraTracks = []
      const original = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      )
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await original(constraints)
        window.__cameraTracks.push(...stream.getTracks())
        return stream
      }
    })
    await page.goto('/demo/scanner')
    await page.getByRole('button', { name: 'Iniciar cámara' }).click()
    await expect(page.locator('video')).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__cameraTracks.some((track) => track.readyState === 'live'),
        ),
      )
      .toBe(true)
    await page.getByRole('button', { name: 'Detener cámara' }).click()
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__cameraTracks.every((track) => track.readyState === 'ended'),
        ),
      )
      .toBe(true)
    await page.getByRole('button', { name: 'Iniciar cámara' }).click()
    await expect(page.locator('video')).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__cameraTracks.some((track) => track.readyState === 'live'),
        ),
      )
      .toBe(true)
    await page
      .locator('a:visible')
      .filter({ hasText: /^Inventario$/ })
      .first()
      .click()
    await expect(
      page.getByRole('heading', { name: 'Inventario', exact: true }),
    ).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__cameraTracks.every((track) => track.readyState === 'ended'),
        ),
      )
      .toBe(true)
    expect(errors).toEqual([])
  })
})
test('private routes redirect to login', async ({ page }) => {
  await page.goto('/inventory')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByLabel('Correo electrónico')).toBeVisible()
})
test('the test server asks search engines not to index it', async ({
  request,
}) => {
  for (const path of ['/login', '/demo/products'])
    expect((await request.get(path)).headers()['x-robots-tag']).toBe(
      'noindex, nofollow',
    )
})
test('demo dashboard, responsive layout, inventory filters and navigation', async ({
  page,
}, info) => {
  await page.goto('/demo')
  await expect(page.getByRole('heading', { name: 'Inicio' })).toBeVisible()
  await expect(
    page.getByText(
      'Vista local · Los borradores se guardan únicamente en este navegador.',
    ),
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: `output/test-results/dashboard-${info.project.name}.png`,
    fullPage: true,
  })
  await page.goto('/demo/inventory')
  await page.getByLabel('Buscar producto').fill('Cedro 01')
  await expect(page.getByText('1 de 30 productos')).toBeVisible()
  await page.getByLabel('Buscar producto').fill('does not exist')
  await expect(
    page.getByRole('heading', { name: 'No hay resultados' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Limpiar filtros' }).click()
  await expect(page.getByText('30 de 30 productos')).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: `output/test-results/inventory-${info.project.name}.png`,
    fullPage: true,
  })
  for (const [path, title] of [
    ['sales', 'Facturación'],
    ['proformas', 'Proformas'],
    ['products', 'Inventario'],
    ['alerts', 'Alertas de inventario'],
    ['suppliers', 'Proveedores'],
  ] as const) {
    await page.goto(`/demo/${path}`)
    await expect(
      page.getByRole('heading', { name: title, exact: true }),
    ).toBeVisible()
  }
})
test('manual scanner identifies known and unknown products', async ({
  page,
}, info) => {
  await page.goto('/demo/scanner')
  await page.getByLabel('Código del producto').fill('DEMO-0001')
  await page.getByRole('button', { name: 'Buscar', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Cedro 01', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Salida', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Entendido' }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await page.screenshot({
    path: `output/test-results/scanner-${info.project.name}.png`,
    fullPage: true,
  })
  await page.getByLabel('Código del producto').fill('UNKNOWN')
  await page.getByRole('button', { name: 'Buscar', exact: true }).click()
  await expect(
    page.getByText('Código no registrado', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText(/Solicita al administrador/)).toBeVisible()
})
test('camera permission denial is understandable and retryable', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: () =>
          Promise.reject(
            new DOMException('Permission denied', 'NotAllowedError'),
          ),
        enumerateDevices: () => Promise.resolve([]),
      },
      configurable: true,
    })
  })
  await page.goto('/demo/scanner')
  await page.getByRole('button', { name: 'Iniciar cámara' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'permiso de cámara fue rechazado',
  )
  await expect(
    page.getByRole('button', { name: 'Reintentar', exact: true }),
  ).toBeVisible()
})

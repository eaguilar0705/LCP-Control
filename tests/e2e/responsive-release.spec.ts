import { expect, test } from '@playwright/test'

test('release screens fit small phones and tablets', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Explicit viewport sweep')
  test.setTimeout(120_000)
  await page.route(
    (url) => url.protocol.startsWith('http') && url.hostname !== '127.0.0.1',
    (route) => route.abort(),
  )
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 })
    for (const route of [
      '/login',
      '/forgot-password',
      '/reset-password',
      '/activate',
      '/demo',
      '/demo/inventory',
      '/demo/sales',
      '/demo/proformas',
      '/demo/products/new',
      '/demo/customers',
      '/demo/suppliers',
      '/demo/reports',
      '/demo/account',
      '/demo/staff',
      '/demo/settings',
    ]) {
      await page.goto(route)
      await expect(page.locator('h1, h2').first()).toBeVisible()
      await expect(page.getByText('Cargando…', { exact: true })).toHaveCount(0)
      const overflow = await page.evaluate(() => ({
        width: innerWidth,
        content: document.documentElement.scrollWidth,
      }))
      expect(overflow.content, `${route} at ${width}px`).toBeLessThanOrEqual(
        overflow.width,
      )
      if (route === '/demo/inventory') {
        await expect(page.locator('.catalog-product').first()).toBeVisible()
        const overflowingTiles = await page
          .locator('.catalog-product .stock-tile')
          .evaluateAll(
            (tiles) =>
              tiles.filter((tile) => {
                const bounds = tile.getBoundingClientRect()
                return [...tile.children].some((child) => {
                  const box = child.getBoundingClientRect()
                  return box.left < bounds.left || box.right > bounds.right
                })
              }).length,
          )
        expect(overflowingTiles, `Stock labels at ${width}px`).toBe(0)
        if (width === 390)
          await page.screenshot({
            path: 'output/test-results/inventory-release-mobile.png',
            fullPage: true,
          })
      }
    }
  }
  expect(errors).toEqual([])
})

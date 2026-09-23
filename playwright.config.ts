import { defineConfig, devices } from '@playwright/test'
// Chrome instalado es el objetivo real. PLAYWRIGHT_CHANNEL permite usar el
// Chromium de Playwright donde no haya Chrome (contenedores, integración
// continua) sin tocar la configuración.
export const browserChannel = process.env.PLAYWRIGHT_CHANNEL || 'chrome'
export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './output/test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: './output/playwright-report', open: 'never' }],
  ],
  fullyParallel: true,
  workers: 2,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
    launchOptions: { channel: browserChannel },
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
        defaultBrowserType: 'chromium',
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  // Mode test loads .env.test: no Supabase project, synthetic catalog only. Its own
  // port keeps Playwright from reusing a dev server that points at real data.
  webServer: {
    command:
      'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174 --strictPort --mode test',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
    env: {
      VITE_DATA_MODE: 'demo',
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_PUBLISHABLE_KEY: '',
    },
  },
})

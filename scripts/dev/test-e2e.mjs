// Vite vive en este proceso: se cierra también en Windows al terminar Playwright.
// El servidor sólo sirve datos sintéticos y nunca hereda una conexión del negocio.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

Object.assign(process.env, {
  VITE_DATA_MODE: 'demo',
  VITE_SUPABASE_URL: '',
  VITE_SUPABASE_PUBLISHABLE_KEY: '',
  LCP_E2E_EXTERNAL_SERVER: '1',
})
const server = await createServer({
  mode: 'test',
  cacheDir: 'output/cache/vite-e2e',
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    hmr: false,
    watch: null,
  },
})
try {
  await server.listen()
  const cli = fileURLToPath(
    new URL('../../node_modules/@playwright/test/cli.js', import.meta.url),
  )
  const runner = spawn(
    process.execPath,
    [cli, 'test', ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: process.env,
    },
  )
  process.exitCode = await new Promise((resolve, reject) => {
    runner.once('error', reject)
    runner.once('exit', (code) => resolve(code ?? 1))
  })
} finally {
  await server.close()
}

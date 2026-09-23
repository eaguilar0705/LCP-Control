import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import {
  exposedSecretEnv,
  findSecrets,
  isLoopbackHost,
} from './src/lib/security.ts'

const textOutput = /\.(?:html|css|js|mjs|json|map|svg|txt|webmanifest)$/

// Everything the browser downloads is public. A secret-looking VITE_* variable
// stops dev and build, and the finished bundle is scanned before it is written.
function clientSecretGuard(): Plugin {
  return {
    name: 'lcp-client-secret-guard',
    configResolved(config) {
      const exposed = exposedSecretEnv(config.env)
      if (exposed.length)
        throw new Error(
          `[seguridad] ${exposed.join(', ')} parece un secreto y Vite lo enviaría al navegador. Guárdalo en un backend o una Edge Function.`,
        )
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === 'asset' && !textOutput.test(output.fileName))
          continue
        const text =
          output.type === 'chunk'
            ? output.code
            : typeof output.source === 'string'
              ? output.source
              : new TextDecoder().decode(output.source)
        const found = findSecrets(text)
        if (found.length)
          this.error(
            `[seguridad] ${output.fileName} contiene ${found.join(', ')}. La compilación se detuvo para no publicarlo.`,
          )
      }
    },
  }
}

// Dev and preview servers are test environments: loopback only. Reaching one from
// another device goes through an authenticated tunnel or VPN that ends on this
// machine, never through an open network port.
function localOnlyServers(): Plugin {
  const check = (host: string | boolean | undefined) => {
    if (!isLoopbackHost(host))
      throw new Error(
        `[seguridad] El servidor de pruebas sólo escucha en 127.0.0.1 (se pidió ${String(host)}). Para abrirlo desde otro equipo usa un túnel o una VPN con autenticación.`,
      )
  }
  return {
    name: 'lcp-local-only-servers',
    configureServer: (server) => check(server.config.server.host),
    configurePreviewServer: (server) => check(server.config.preview.host),
  }
}

const noIndex = { 'X-Robots-Tag': 'noindex, nofollow' }

// Todo lo generado (compilación, informes y cachés) vive bajo output/, ignorado por Git.
export default defineConfig({
  cacheDir: 'output/cache/vite',
  // '@/' apunta a src/: las pruebas en tests/unit importan el código sin rutas ../../..
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: 'output/dist', emptyOutDir: true },
  plugins: [react(), tailwindcss(), clientSecretGuard(), localOnlyServers()],
  server: { host: '127.0.0.1', headers: noIndex },
  preview: { host: '127.0.0.1', headers: noIndex },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/unit/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    coverage: { reportsDirectory: 'output/coverage' },
    restoreMocks: true,
  },
})

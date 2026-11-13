import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  server: { middlewareMode: true, hmr: false, ws: false },
})
const { isChunkLoadError, recoverChunkLoad } = await server.ssrLoadModule(
  '/src/app/chunkRecovery.ts',
)
await server.close()

function browserWindow(t, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value,
  })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else delete globalThis.window
  })
}

test('reconoce errores de módulos y CSS en Chrome, Firefox y Safari', () => {
  for (const message of [
    'Failed to fetch dynamically imported module: /assets/ReportsPage-old.js',
    'error loading dynamically imported module: /assets/ReportsPage-old.js',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/screen-old.css',
  ]) {
    assert.equal(isChunkLoadError(new TypeError(message)), true)
    assert.equal(isChunkLoadError(message), true)
  }
  for (const error of [null, undefined, {}, new Error('Failed to fetch')])
    assert.equal(isChunkLoadError(error), false)
})

test('recarga una sola vez por versión y pestaña, conservando la dirección', (t) => {
  const stored = new Map()
  let reloads = 0
  const href =
    'https://example.test/products/123/edit?from=inventory#cantidades'
  browserWindow(t, {
    navigator: { onLine: true },
    sessionStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
    },
    location: { href, reload: () => reloads++ },
  })
  const error = new TypeError('Failed to fetch dynamically imported module')
  assert.equal(recoverChunkLoad(error), true)
  assert.equal(recoverChunkLoad(error), false)
  assert.equal(reloads, 1)
  assert.equal(globalThis.window.location.href, href)
  // Una nueva versión puede recuperarse aunque la pestaña usara una anterior.
  stored.set('lcp:chunk-reload', 'https://example.test/assets/index-old.js')
  assert.equal(recoverChunkLoad(error), true)
  assert.equal(reloads, 2)
})

test('no recarga por errores de negocio, sin conexión o sin almacenamiento', (t) => {
  let reloads = 0
  browserWindow(t, {
    navigator: { onLine: false },
    get sessionStorage() {
      throw new Error('Storage blocked')
    },
    location: { reload: () => reloads++ },
  })
  const error = new TypeError('Failed to fetch dynamically imported module')
  assert.equal(recoverChunkLoad(error), false)
  globalThis.window.navigator.onLine = true
  assert.equal(recoverChunkLoad(new Error('Invalid product')), false)
  assert.equal(recoverChunkLoad(error), false)
  assert.equal(reloads, 0)
})

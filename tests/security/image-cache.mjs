// Caché HTTP habilitada, sin routing Playwright y sin datos/servicios reales.
// El control nativo debe cachear; las fotos del programa deben volver a bajar.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

Object.assign(process.env, {
  VITE_DATA_MODE: 'demo',
  VITE_SUPABASE_URL: '',
  VITE_SUPABASE_PUBLISHABLE_KEY: '',
})
const PORT = 5179
const BASE = `http://127.0.0.1:${PORT}`
const marker = (name) => `synthetic-photo-${name}-capability-20261003`
const fixture = {
  control: `${BASE}/private-photo/control?token=${marker('control')}`,
  products: [
    {
      brand: 'Prueba',
      name: 'absoluta',
      imageUrl: `http://localhost:${PORT}/private-photo/absolute?token=${marker('absolute')}`,
    },
    {
      brand: 'Prueba',
      name: 'relativa',
      imageUrl: `/private-photo/relative?token=${marker('relative')}`,
    },
    {
      brand: 'Prueba',
      name: 'protocolo relativo',
      imageUrl: `//127.0.0.1:${PORT}/private-photo/protocol?token=${marker('protocol')}`,
    },
    {
      brand: 'Prueba',
      name: 'redirección',
      imageUrl: `/photo-redirect?token=${marker('redirect')}`,
    },
  ],
  preview: `/private-photo/editor?token=${marker('editor')}`,
}
const names = ['absolute', 'relative', 'protocol', 'redirect', 'editor']
const hits = new Map()
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
  'base64',
)
const plugin = {
  name: 'private-photo-cache-regression',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, BASE)
      if (url.pathname.startsWith('/private-photo/')) {
        const name = url.pathname.split('/').at(-1)
        hits.set(name, (hits.get(name) ?? 0) + 1)
        res.setHeader('Content-Type', 'image/png')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Cache-Control', 'public, max-age=31536000')
        res.end(png)
      } else if (url.pathname === '/photo-redirect') {
        res.statusCode = 302
        res.setHeader('Cache-Control', 'public, max-age=31536000')
        res.setHeader('Location', `/private-photo/redirect${url.search}`)
        res.end()
      } else if (url.pathname === '/photo-fixture') {
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(fixture))
      } else if (url.pathname === '/photo-cache-test') {
        // Las concesiones vienen de JSON no-store, nunca del código Vite cacheable.
        const html = `<!doctype html><html><body><div id="root"></div><script type="module">
          import React from 'react'; import { createRoot } from 'react-dom/client';
          import { ProductImage } from '/src/components/ProductImage.tsx';
          import { TransientImage } from '/src/components/TransientImage.tsx';
          const fixture = await fetch('/photo-fixture', {cache:'no-store'}).then(r => r.json());
          const root = createRoot(document.getElementById('root'));
          window.removePhotos = () => root.unmount();
          root.render(React.createElement('div', {},
            React.createElement('img', {src:fixture.control, alt:'control nativo'}),
            ...fixture.products.map(p => React.createElement(ProductImage, {key:p.name, product:p, large:true})),
            React.createElement(TransientImage, {src:fixture.preview, alt:'preview editor'})
          ));
        </script></body></html>`
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Type', 'text/html')
        res.end(await server.transformIndexHtml('/photo-cache-test', html))
      } else next()
    })
  },
}
const server = await createServer({
  mode: 'test',
  plugins: [plugin],
  cacheDir: 'output/cache/vite-image-cache',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: PORT, strictPort: true },
})
const profile = mkdtempSync(join(tmpdir(), 'lcp-photo-cache-'))
const launch = () =>
  chromium.launchPersistentContext(profile, {
    channel: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? undefined
      : process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
    viewport: { width: 1280, height: 900 },
  })
function retainedMarkers() {
  const found = new Set()
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else {
        const bytes = readFileSync(path)
        for (const name of ['control', ...names])
          if (bytes.includes(Buffer.from(marker(name)))) found.add(name)
      }
    }
  }
  // Se inspecciona con Chrome cerrado: errores de lectura hacen fallar la prueba.
  walk(profile)
  return [...found]
}
let context
try {
  await server.listen()
  for (let round = 1; round <= 2; round++) {
    context = await launch()
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto(`${BASE}/photo-cache-test`)
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('img')]
      return (
        images.length === 6 && images.every((image) => image.naturalWidth > 0)
      )
    })
    const sources = await page
      .locator('img')
      .evaluateAll((images) => images.slice(1).map((image) => image.src))
    assert(
      sources.every((src) => src.startsWith('blob:')),
      'sólo URLs temporales en las fotos del programa',
    )
    assert.equal(
      hits.get('control'),
      1,
      'control nativo: se reutiliza la caché HTTP',
    )
    for (const name of names)
      assert.equal(
        hits.get(name),
        round,
        `${name}: descarga nueva con no-store`,
      )
    await page.evaluate(() => window.removePhotos())
    const accessible = await page.evaluate(
      async (sources) =>
        Promise.all(
          sources.map(async (src) => {
            try {
              await fetch(src)
              return true
            } catch {
              return false
            }
          }),
        ),
      sources,
    )
    assert(
      accessible.every((value) => !value),
      'objetos temporales revocados al desmontar',
    )
    await context.close()
    context = undefined
    const retained = retainedMarkers()
    assert(
      retained.includes('control'),
      'control positivo: el escáner detecta la concesión nativa',
    )
    assert(
      names.every((name) => !retained.includes(name)),
      'ninguna concesión del programa queda en el perfil',
    )
  }
  console.log(
    JSON.stringify({
      cacheEnabled: true,
      requestInterception: false,
      nativeControlRequests: hits.get('control'),
      privatePhotoRequests: Object.fromEntries(
        names.map((name) => [name, hits.get(name)]),
      ),
      privateGrantsRetained: false,
      temporaryUrlsRevoked: true,
      scope:
        'Cinco representaciones sintéticas en perfil persistente; sin servicios ni credenciales reales.',
    }),
  )
} finally {
  if (context) await context.close()
  await server.close()
  // profile fue creado por mkdtempSync dentro de tmpdir(), sin entradas externas.
  rmSync(profile, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  cacheDir: fileURLToPath(
    new URL('../../output/cache/private-image-tests', import.meta.url),
  ),
  server: { middlewareMode: true, hmr: false, ws: false },
})
after(() => server.close())
const { PrivateImageDownloads, privateImageDownloads } =
  await server.ssrLoadModule('/src/lib/privateImageDownloads.ts')
const { privateImageCache } = await server.ssrLoadModule(
  '/src/lib/privateImageCache.ts',
)

const source = (name) => `https://images.example.test/${name}?token=private`
const imageResponse = (size = 4) =>
  new Response(new Blob(['x'.repeat(size)], { type: 'image/webp' }), {
    headers: { 'content-type': 'image/webp' },
  })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function until(predicate) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (predicate()) return
    await Promise.resolve()
  }
  assert.ok(predicate(), 'La operación debió avanzar sin esperas de red reales')
}
function urls(t) {
  const created = []
  const revoked = []
  t.mock.method(URL, 'createObjectURL', (blob) => {
    assert.ok(blob instanceof Blob)
    const url = `blob:private-image-test-${created.length + 1}`
    created.push({ url, bytes: blob.size })
    return url
  })
  t.mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url))
  return { created, revoked }
}
function harness(t, fetcher = async () => imageResponse(), options = {}) {
  const observed = urls(t)
  const cache = new PrivateImageDownloads(fetcher, {
    retryDelayMs: 0,
    ...options,
  })
  t.after(() => cache.clear())
  return { cache, ...observed }
}

test('comparte una descarga pendiente entre dos consumidores y no filtra la concesión al img', async (t) => {
  const pending = deferred()
  const requests = []
  const { cache, created } = harness(t, (src, init) => {
    requests.push({ src, init })
    return pending.promise
  })
  const first = cache.acquire(source('one.webp'))
  const second = cache.acquire(source('one.webp'))
  await until(() => requests.length === 1)
  assert.equal(requests[0].init.cache, 'no-store')
  assert.equal(requests[0].init.credentials, 'omit')
  assert.equal(requests[0].init.referrerPolicy, 'no-referrer')
  assert.ok(requests[0].init.signal instanceof AbortSignal)
  pending.resolve(imageResponse())
  const [firstUrl, secondUrl] = await Promise.all([first.result, second.result])
  assert.equal(firstUrl, secondUrl)
  assert.match(firstUrl, /^blob:/)
  assert.notEqual(firstUrl, source('one.webp'))
  assert.equal(created.length, 1)
  assert.equal(requests.length, 1)
  first.release()
  second.release()
})

test('volver a una foto descargada después de desmontarla reutiliza la misma imagen', async (t) => {
  let requests = 0
  const { cache, revoked } = harness(t, async () => {
    requests++
    return imageResponse()
  })
  const first = cache.acquire(source('one.webp'))
  const url = await first.result
  first.release()
  first.release()
  const again = cache.acquire(source('one.webp'))
  assert.equal(await again.result, url)
  assert.equal(requests, 1)
  assert.deepEqual(revoked, [])
  again.release()
})

test('soltar una referencia no revoca la imagen que otro componente sigue usando', async (t) => {
  const { cache, revoked } = harness(t, undefined, { maxEntries: 1 })
  const first = cache.acquire(source('one.webp'))
  const second = cache.acquire(source('one.webp'))
  const url = await first.result
  await second.result
  first.release()
  const other = cache.acquire(source('two.webp'))
  await other.result
  other.release()
  assert.equal(revoked.includes(url), false)
  second.release()
})

test('una descarga que termina sin consumidores queda disponible para volver al catálogo', async (t) => {
  const pending = deferred()
  let requests = 0
  const { cache } = harness(t, () => {
    requests++
    return pending.promise
  })
  const first = cache.acquire(source('one.webp'))
  await until(() => requests === 1)
  first.release()
  pending.resolve(imageResponse())
  const url = await first.result
  const again = cache.acquire(source('one.webp'))
  assert.equal(await again.result, url)
  assert.equal(requests, 1)
  again.release()
})

test('el límite de entradas retira la menos usada sin revocar fotos activas', async (t) => {
  let requests = 0
  const { cache, revoked } = harness(
    t,
    async () => {
      requests++
      return imageResponse()
    },
    { maxEntries: 2 },
  )
  const a = cache.acquire(source('a.webp'))
  const aUrl = await a.result
  a.release()
  const b = cache.acquire(source('b.webp'))
  const bUrl = await b.result
  b.release()
  const recentA = cache.acquire(source('a.webp'))
  assert.equal(await recentA.result, aUrl)
  recentA.release()
  const c = cache.acquire(source('c.webp'))
  await c.result
  assert.ok(revoked.includes(bUrl))
  assert.equal(revoked.includes(aUrl), false)
  const stillA = cache.acquire(source('a.webp'))
  assert.equal(await stillA.result, aUrl)
  assert.equal(requests, 3)
  stillA.release()
  c.release()
})

test('el límite de bytes retira blobs antiguos y no fuerza una foto activa fuera de memoria', async (t) => {
  const { cache, revoked } = harness(t, async () => imageResponse(4), {
    maxBytes: 6,
    maxEntries: 10,
  })
  const first = cache.acquire(source('a.webp'))
  const firstUrl = await first.result
  first.release()
  const active = cache.acquire(source('b.webp'))
  const activeUrl = await active.result
  assert.ok(revoked.includes(firstUrl))
  assert.equal(revoked.includes(activeUrl), false)
  active.release()
})

test('una invalidación antigua no borra la descarga nueva de la misma dirección', async (t) => {
  let requests = 0
  const { cache } = harness(t, async () => {
    requests++
    return imageResponse()
  })
  const old = cache.acquire(source('one.webp'))
  const oldUrl = await old.result
  old.invalidate()
  old.release()
  const replacement = cache.acquire(source('one.webp'))
  const replacementUrl = await replacement.result
  assert.notEqual(replacementUrl, oldUrl)
  old.invalidate()
  const observer = cache.acquire(source('one.webp'))
  assert.equal(await observer.result, replacementUrl)
  assert.equal(requests, 2)
  observer.release()
  replacement.release()
})

test('limpiar revoca también una foto invalidada que todavía tiene consumidores', async (t) => {
  const { cache, revoked } = harness(t)
  const original = cache.acquire(source('one.webp'))
  const retained = cache.acquire(source('one.webp'))
  const originalUrl = await original.result
  await retained.result
  original.invalidate()
  original.release()
  assert.equal(revoked.includes(originalUrl), false)
  const replacement = cache.acquire(source('one.webp'))
  const replacementUrl = await replacement.result
  cache.clear()
  assert.ok(revoked.includes(originalUrl))
  assert.ok(revoked.includes(replacementUrl))
  assert.equal(revoked.filter((url) => url === originalUrl).length, 1)
  assert.equal(revoked.filter((url) => url === replacementUrl).length, 1)
  retained.release()
  replacement.release()
  assert.equal(revoked.filter((url) => url === originalUrl).length, 1)
  assert.equal(revoked.filter((url) => url === replacementUrl).length, 1)
})

test('una foto demasiado grande que termina sin consumidores no queda retenida', async (t) => {
  const pending = deferred()
  let requests = 0
  const { cache, revoked } = harness(
    t,
    () => {
      requests++
      return requests === 1 ? pending.promise : imageResponse(8)
    },
    { maxBytes: 4 },
  )
  const first = cache.acquire(source('large.webp'))
  await until(() => requests === 1)
  first.release()
  pending.resolve(imageResponse(8))
  const releasedUrl = await first.result
  assert.match(releasedUrl, /^blob:/)
  assert.ok(revoked.includes(releasedUrl))
  const next = cache.acquire(source('large.webp'))
  const activeUrl = await next.result
  assert.notEqual(activeUrl, releasedUrl)
  assert.equal(requests, 2)
  assert.equal(revoked.includes(activeUrl), false)
  next.release()
  assert.ok(revoked.includes(activeUrl))
})

test('limpiar cancela la petición y una respuesta tardía no repuebla la sesión terminada', async (t) => {
  const pending = deferred()
  const requests = []
  const { cache, created, revoked } = harness(t, (src, init) => {
    requests.push({ src, init })
    return requests.length === 1 ? pending.promise : imageResponse()
  })
  const old = cache.acquire(source('one.webp'))
  const rejected = assert.rejects(old.result)
  await until(() => requests.length === 1)
  cache.clear()
  assert.equal(requests[0].init.signal.aborted, true)
  pending.resolve(imageResponse())
  await rejected
  const fresh = cache.acquire(source('one.webp'))
  const freshUrl = await fresh.result
  assert.equal(requests.length, 2)
  assert.equal(created.length, 1)
  assert.equal(revoked.includes(freshUrl), false)
  old.release()
  assert.equal(revoked.includes(freshUrl), false)
  fresh.release()
  cache.clear()
  assert.ok(revoked.includes(freshUrl))
})

test('404 no se reintenta y permite volver a intentar al adquirir después', async (t) => {
  let requests = 0
  const { cache, created } = harness(t, async () => {
    requests++
    return requests === 1
      ? new Response('No existe', { status: 404 })
      : imageResponse()
  })
  const missing = cache.acquire(source('missing.webp'))
  await assert.rejects(missing.result)
  assert.equal(requests, 1)
  assert.equal(created.length, 0)
  missing.release()
  const retry = cache.acquire(source('missing.webp'))
  assert.match(await retry.result, /^blob:/)
  assert.equal(requests, 2)
  retry.release()
})

for (const kind of ['503', 'red']) {
  test(`reintenta una vez un fallo transitorio de ${kind}`, async (t) => {
    let requests = 0
    const { cache } = harness(t, async () => {
      requests++
      if (requests === 1) {
        if (kind === '503') return new Response('Temporal', { status: 503 })
        throw new TypeError('Sin conexión')
      }
      return imageResponse()
    })
    const lease = cache.acquire(source('one.webp'))
    assert.match(await lease.result, /^blob:/)
    assert.equal(requests, 2)
    lease.release()
  })
}

test('un error transitorio persistente termina después de dos intentos', async (t) => {
  let requests = 0
  const { cache } = harness(t, async () => {
    requests++
    return new Response('Temporal', { status: 503 })
  })
  const lease = cache.acquire(source('one.webp'))
  await assert.rejects(lease.result)
  assert.equal(requests, 2)
  lease.release()
})

test('cambiar de usuario o cerrar sesión limpia el singleton sin persistir imágenes', async (t) => {
  const { revoked } = urls(t)
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return imageResponse()
  })
  privateImageCache.setSession('image-test-first')
  t.after(() => {
    privateImageCache.setSession(null)
    privateImageDownloads.clear()
  })
  const first = privateImageDownloads.acquire(source('session.webp'))
  const firstUrl = await first.result
  first.release()
  privateImageCache.setSession('image-test-first')
  const sameUser = privateImageDownloads.acquire(source('session.webp'))
  assert.equal(await sameUser.result, firstUrl)
  assert.equal(requests, 1)
  sameUser.release()
  privateImageCache.setSession('image-test-second')
  assert.ok(revoked.includes(firstUrl))
  const nextUser = privateImageDownloads.acquire(source('session.webp'))
  const nextUrl = await nextUser.result
  assert.notEqual(nextUrl, firstUrl)
  assert.equal(requests, 2)
  privateImageCache.setSession(null)
  assert.ok(revoked.includes(nextUrl))
  nextUser.release()
})

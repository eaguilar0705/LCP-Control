import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  cacheDir: fileURLToPath(
    new URL('../../output/cache/idempotent-tests', import.meta.url),
  ),
  server: { middlewareMode: true, hmr: false, ws: false },
})
after(() => server.close())
const { createIdempotentOperation } = await server.ssrLoadModule(
  '/src/lib/idempotentOperation.ts',
)

test('un envío simultáneo comparte promesa y mantiene ID tras respuesta perdida', async () => {
  const sent = []
  const operation = createIdempotentOperation(async (input) => {
    sent.push(input)
    if (sent.length === 1) throw new TypeError('Respuesta perdida')
    return { id: 'documento' }
  })
  const first = operation.execute({ amount: 100 })
  const concurrent = operation.execute({ amount: 100 })
  assert.equal(first, concurrent)
  await assert.rejects(first)
  assert.deepEqual(await operation.execute({ amount: 100 }), {
    id: 'documento',
  })
  assert.equal(sent.length, 2)
  assert.equal(sent[0].requestId, sent[1].requestId)
})

test('el UUID del borrador conserva el ID al reiniciar o recrear la operación', async () => {
  const sent = []
  const send = async (input) => {
    sent.push(input)
    return { id: 'documento' }
  }
  const draftId = crypto.randomUUID()
  const operation = createIdempotentOperation(send)
  await operation.execute({ amount: 100 }, draftId)
  operation.reset()
  await operation.execute({ amount: 100 }, draftId)
  await createIdempotentOperation(send).execute({ amount: 100 }, draftId)
  assert.equal(sent.length, 3)
  assert.ok(sent.every((input) => input.requestId === draftId))
  await operation.execute({ amount: 200 }, draftId)
  assert.equal(
    sent.at(-1).requestId,
    draftId,
    'Editar un borrador ya emitido no crea otro ID',
  )
})

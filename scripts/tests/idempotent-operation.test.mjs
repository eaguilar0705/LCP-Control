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
const {
  createIdempotentOperation,
  listPendingOperations,
  subscribePendingOperations,
  pendingOperationsRevision,
} = await server.ssrLoadModule('/src/lib/idempotentOperation.ts')
const { AppError } = await server.ssrLoadModule('/src/lib/errors.ts')
const pendingMessage =
  'Hay un guardado pendiente de confirmar. Reintenta con los datos originales antes de cambiarlos.'
const confirmationMessage =
  'No pudimos confirmar el guardado. Reintenta con los mismos datos para verificarlo sin duplicarlo.'

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

for (const [name, failure] of [
  ['network', new AppError('network', 'Detalle de conexión privado')],
  ['unexpected', new AppError('unexpected', 'Detalle técnico privado')],
  ['TypeError', new TypeError('Respuesta perdida')],
  ['Error', new Error('Un resultado desconocido')],
  ['desconocido', 'Un error desconocido'],
]) {
  test(`un error ${name} bloquea cambiar datos, resetear o cambiar UUID hasta confirmar`, async () => {
    const sent = []
    const operation = createIdempotentOperation(async (input) => {
      sent.push(input)
      if (sent.length === 1) throw failure
      return { id: 'compra' }
    })
    const requestId = crypto.randomUUID()
    const original = { lines: [{ productId: 'perfume', quantity: 2 }] }
    await assert.rejects(
      operation.execute(original, requestId),
      (error) =>
        error instanceof AppError &&
        error.kind === 'network' &&
        error.message === confirmationMessage,
    )
    operation.reset()
    await assert.rejects(
      operation.execute({ lines: [{ productId: 'perfume', quantity: 5 }] }),
      (error) =>
        error instanceof AppError &&
        error.kind === 'validation' &&
        error.message === pendingMessage,
    )
    await assert.rejects(
      operation.execute(original, crypto.randomUUID()),
      (error) => error.message === pendingMessage,
    )
    assert.equal(
      sent.length,
      1,
      'No envía otra compra mientras el resultado es desconocido',
    )
    assert.deepEqual(await operation.execute(original, requestId), {
      id: 'compra',
    })
    assert.equal(sent.length, 2)
    assert.ok(sent.every((input) => input.requestId === requestId))
    assert.deepEqual(
      sent.map((input) => input.lines),
      [original.lines, original.lines],
    )
    operation.reset()
    await operation.execute({ lines: [{ productId: 'perfume', quantity: 5 }] })
    assert.notEqual(
      sent.at(-1).requestId,
      requestId,
      'Después de confirmar sí permite una operación nueva',
    )
  })
}

for (const kind of [
  'validation',
  'unauthorized',
  'rate_limited',
  'configuration',
]) {
  test(`un primer rechazo definitivo ${kind} permite corregir y enviar otros datos`, async () => {
    const sent = []
    const failure = new AppError(kind, 'Rechazo definitivo')
    const operation = createIdempotentOperation(async (input) => {
      sent.push(input)
      if (sent.length === 1) throw failure
      return 'guardado'
    })
    await assert.rejects(
      operation.execute({ amount: 100 }),
      (error) => error === failure,
    )
    assert.equal(await operation.execute({ amount: 200 }), 'guardado')
    assert.notEqual(sent[0].requestId, sent[1].requestId)
    assert.equal(sent[1].amount, 200)
  })
}

test('cambiar datos durante el envío no crea una segunda solicitud y reset no descarta la primera', async () => {
  const sent = []
  let finish
  const operation = createIdempotentOperation(async (input) => {
    sent.push(input)
    await new Promise((resolve) => {
      finish = resolve
    })
    return 'guardado'
  })
  const original = { lines: [{ quantity: 2 }] }
  const first = operation.execute(original)
  original.lines[0].quantity = 999
  operation.reset()
  await assert.rejects(
    operation.execute(original),
    (error) => error.message === pendingMessage,
  )
  assert.equal(sent.length, 1)
  assert.equal(
    sent[0].lines[0].quantity,
    2,
    'La copia del envío no cambia al editar el formulario',
  )
  assert.equal(operation.execute({ lines: [{ quantity: 2 }] }), first)
  finish()
  assert.equal(await first, 'guardado')
  assert.equal(
    await operation.execute({ lines: [{ quantity: 2 }] }),
    'guardado',
  )
  assert.equal(sent.length, 1, 'La solicitud confirmada permanece memorizada')
})

test('un envío que modifica su argumento no altera el payload original de los reintentos', async () => {
  const sent = []
  const operation = createIdempotentOperation(async (input) => {
    sent.push(structuredClone(input))
    if (sent.length === 1) {
      input.lines[0].quantity = 999
      throw new TypeError('Respuesta perdida')
    }
    return 'confirmado'
  })
  const original = { lines: [{ quantity: 2 }] }
  await assert.rejects(operation.execute(original))
  assert.equal(await operation.execute(original), 'confirmado')
  assert.deepEqual(sent[0], sent[1])
})

test('un rechazo de permisos o cuota al verificar no prueba que el envío original no exista', async () => {
  const sent = []
  const operation = createIdempotentOperation(async (input) => {
    sent.push(input)
    if (sent.length === 1) throw new TypeError('Respuesta perdida tras guardar')
    if (sent.length === 2)
      throw new AppError('unauthorized', 'Permiso temporalmente retirado')
    if (sent.length === 3)
      throw new AppError('rate_limited', 'Espera un momento')
    return 'confirmado'
  })
  const original = { amount: 100 }
  for (let index = 0; index < 3; index++) {
    await assert.rejects(
      operation.execute(original),
      (error) =>
        error.kind === 'network' && error.message === confirmationMessage,
    )
    await assert.rejects(
      operation.execute({ amount: 200 }),
      (error) => error.message === pendingMessage,
    )
    operation.reset()
  }
  assert.equal(await operation.execute(original), 'confirmado')
  assert.equal(new Set(sent.map((input) => input.requestId)).size, 1)
  await operation.execute({ amount: 200 })
  assert.notEqual(sent.at(-1).requestId, sent[0].requestId)
})

test('una validación definitiva al verificar libera el payload para corregir sin duplicar', async () => {
  const sent = []
  const operation = createIdempotentOperation(async (input) => {
    sent.push(input)
    if (sent.length === 1) throw new TypeError('No se sabe si llegó')
    if (sent.length === 2)
      throw new AppError('validation', 'La cantidad supera la existencia')
    return 'guardado'
  })
  await assert.rejects(operation.execute({ quantity: 100 }))
  await assert.rejects(
    operation.execute({ quantity: 100 }),
    (error) => error.kind === 'validation',
  )
  assert.equal(await operation.execute({ quantity: 2 }), 'guardado')
  assert.equal(sent[0].requestId, sent[1].requestId)
  assert.notEqual(sent[2].requestId, sent[0].requestId)
})

test('retryPending recupera el DTO original sin depender de los datos visibles del formulario', async () => {
  const sent = []
  const operation = createIdempotentOperation(async (input) => {
    sent.push(input)
    if (sent.length === 1) throw new TypeError('Respuesta perdida')
    return 'confirmado'
  })
  assert.equal(operation.isUncertain(), false)
  await assert.rejects(
    operation.retryPending(),
    (error) => error.kind === 'validation',
  )
  assert.equal(sent.length, 0)
  const edited = { amount: 100, lines: [{ quantity: 2 }] }
  await assert.rejects(operation.execute(edited))
  assert.equal(operation.isUncertain(), true)
  edited.amount = 900
  edited.lines[0].quantity = 999
  assert.equal(await operation.retryPending(), 'confirmado')
  assert.deepEqual(sent[1], sent[0])
  assert.equal(sent[1].amount, 100)
  assert.equal(sent[1].lines[0].quantity, 2)
  assert.equal(operation.isUncertain(), false)
  await assert.rejects(
    operation.retryPending(),
    (error) => error.kind === 'validation',
  )
  assert.equal(
    sent.length,
    2,
    'No crea una operación nueva al verificar algo ya confirmado',
  )
})

test('retryPending comparte el envío activo y deja de estar incierto tras rechazo definitivo', async () => {
  let finish
  const sent = []
  const operation = createIdempotentOperation(async (input) => {
    sent.push(input)
    await new Promise((resolve) => {
      finish = resolve
    })
    throw new AppError('validation', 'Revisa la cantidad')
  })
  const first = operation.execute({ quantity: 2 })
  assert.equal(operation.isUncertain(), true)
  assert.equal(operation.retryPending(), first)
  await Promise.resolve()
  finish()
  await assert.rejects(first, (error) => error.kind === 'validation')
  assert.equal(operation.isUncertain(), false)
  assert.equal(sent.length, 1)
})

test('el aviso global conserva una operación tras desmontar el formulario y bloquea otra instancia', async () => {
  const sent = []
  const options = {
    scope: crypto.randomUUID(),
    key: 'inventory',
    label: 'Movimiento de inventario',
  }
  const send = async (input) => {
    sent.push(input)
    if (sent.length === 1)
      throw new TypeError('Se guardó sin recibir respuesta')
    return 'movimiento'
  }
  await assert.rejects(
    createIdempotentOperation(send, options).execute({ quantity: 2 }),
  )
  const entries = listPendingOperations(options.scope)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].key, 'inventory')
  assert.equal(entries[0].label, 'Movimiento de inventario')
  assert.deepEqual(Object.keys(entries[0]).sort(), [
    'key',
    'label',
    'operation',
  ])
  assert.deepEqual(Object.keys(entries[0].operation), ['retryPending'])
  const recreated = createIdempotentOperation(send, options)
  await assert.rejects(
    recreated.execute({ quantity: 5 }),
    (error) => error.kind === 'validation' && error.message === pendingMessage,
  )
  assert.equal(sent.length, 1, 'Reabrir el formulario no permite otra salida')
  recreated.reset()
  assert.equal(listPendingOperations(options.scope).length, 1)
  assert.equal(await entries[0].operation.retryPending(), 'movimiento')
  assert.deepEqual(sent[1], sent[0])
  assert.deepEqual(listPendingOperations(options.scope), [])
  assert.equal(await recreated.execute({ quantity: 5 }), 'movimiento')
  assert.notEqual(sent[2].requestId, sent[0].requestId)
})

test('la suscripción conoce el guardado antes de enviarlo y comparte una verificación simultánea', async () => {
  const options = {
    scope: crypto.randomUUID(),
    key: 'purchase',
    label: 'Compra',
  }
  const previous = pendingOperationsRevision()
  const revisions = []
  const retries = []
  let notifications = 0
  let sends = 0
  let finish
  const unsubscribe = subscribePendingOperations(() => {
    notifications++
    revisions.push(pendingOperationsRevision())
    const [entry] = listPendingOperations(options.scope)
    if (entry) retries.push(entry.operation.retryPending())
  })
  try {
    const operation = createIdempotentOperation(async () => {
      sends++
      await new Promise((resolve) => {
        finish = resolve
      })
      return 'compra'
    }, options)
    const first = operation.execute({ quantity: 2 })
    assert.equal(listPendingOperations(options.scope).length, 1)
    assert.equal(notifications, 1)
    assert.equal(
      retries[0],
      first,
      'La notificación no dispara una segunda compra',
    )
    await Promise.resolve()
    assert.equal(sends, 1)
    finish()
    assert.equal(await first, 'compra')
    assert.equal(notifications, 2)
    assert.deepEqual(listPendingOperations(options.scope), [])
    assert.deepEqual(revisions, [previous + 1, previous + 2])
  } finally {
    unsubscribe()
  }
})

test('usuarios y tipos distintos no comparten el aviso ni bloquean sus operaciones', async () => {
  const user = crypto.randomUUID()
  const other = crypto.randomUUID()
  const metadata = [
    { scope: user, key: 'inventory', label: 'Inventario' },
    { scope: user, key: 'purchase', label: 'Compra' },
    { scope: other, key: 'inventory', label: 'Inventario ajeno' },
  ]
  const operations = metadata.map((options) => {
    let calls = 0
    return createIdempotentOperation(async () => {
      if (++calls === 1) throw new TypeError('Sin respuesta')
      return 'confirmado'
    }, options)
  })
  for (const operation of operations)
    await assert.rejects(operation.execute({ quantity: 1 }))
  assert.deepEqual(
    listPendingOperations(user).map((entry) => entry.label),
    ['Inventario', 'Compra'],
  )
  assert.deepEqual(
    listPendingOperations(other).map((entry) => entry.label),
    ['Inventario ajeno'],
  )
  assert.deepEqual(listPendingOperations(crypto.randomUUID()), [])
  const visible = listPendingOperations(user)
  visible[0].label = 'Etiqueta alterada'
  visible[0].operation.retryPending = async () => 'Alterado'
  assert.equal(listPendingOperations(user)[0].label, 'Inventario')
  for (const operation of operations) await operation.retryPending()
  assert.deepEqual(listPendingOperations(user), [])
  assert.deepEqual(listPendingOperations(other), [])
})

test('el registro mantiene rechazos de permisos tras incertidumbre y se libera con SQL definitivo', async () => {
  const options = {
    scope: crypto.randomUUID(),
    key: 'finance-entry',
    label: 'Cobro',
  }
  let calls = 0
  const operation = createIdempotentOperation(async () => {
    calls++
    if (calls === 1) throw new TypeError('Respuesta perdida')
    if (calls === 2) throw new AppError('unauthorized', 'Acceso temporal')
    if (calls === 3) throw new AppError('validation', 'Pago rechazado')
    return 'corregido'
  }, options)
  await assert.rejects(operation.execute({ amount: 100 }))
  operation.reset()
  assert.equal(listPendingOperations(options.scope).length, 1)
  await assert.rejects(
    listPendingOperations(options.scope)[0].operation.retryPending(),
  )
  assert.equal(listPendingOperations(options.scope).length, 1)
  await assert.rejects(
    listPendingOperations(options.scope)[0].operation.retryPending(),
    (error) => error.kind === 'validation',
  )
  assert.deepEqual(listPendingOperations(options.scope), [])
  assert.equal(await operation.execute({ amount: 50 }), 'corregido')
  assert.deepEqual(listPendingOperations(options.scope), [])
})

test('un primer rechazo definitivo retira el aviso sin conservar falsos pendientes', async () => {
  for (const kind of [
    'validation',
    'unauthorized',
    'rate_limited',
    'configuration',
  ]) {
    const options = {
      scope: crypto.randomUUID(),
      key: 'inventory',
      label: 'Inventario',
    }
    const operation = createIdempotentOperation(async () => {
      throw new AppError(kind, 'Rechazo definitivo')
    }, options)
    const attempt = operation.execute({ quantity: 1 })
    assert.equal(listPendingOperations(options.scope).length, 1)
    await assert.rejects(attempt, (error) => error.kind === kind)
    assert.deepEqual(listPendingOperations(options.scope), [])
  }
})

import { describe, expect, it, vi } from 'vitest'
import { createIdempotentOperation } from '@/lib/idempotentOperation'

describe('reintentos de operaciones', () => {
  it('reutiliza el ID después de una respuesta perdida', async () => {
    const send = vi
      .fn<(input: { quantity: number; requestId: string }) => Promise<string>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue('FAC-000001')
    const operation = createIdempotentOperation<{ quantity: number }, string>(
      send,
    )
    await expect(operation.execute({ quantity: 2 })).rejects.toThrow()
    await expect(operation.execute({ quantity: 2 })).resolves.toBe('FAC-000001')
    expect(send.mock.calls[0][0].requestId).toBe(
      send.mock.calls[1][0].requestId,
    )
  })
  it('un doble clic y un reintento tras éxito no envían dos escrituras', async () => {
    const send = vi
      .fn<(input: { quantity: number; requestId: string }) => Promise<string>>()
      .mockResolvedValue('ok')
    const operation = createIdempotentOperation<{ quantity: number }, string>(
      send,
    )
    await Promise.all([
      operation.execute({ quantity: 2 }),
      operation.execute({ quantity: 2 }),
    ])
    await operation.execute({ quantity: 2 })
    expect(send).toHaveBeenCalledTimes(1)
    operation.reset()
    await operation.execute({ quantity: 2 })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0][0].requestId).not.toBe(
      send.mock.calls[1][0].requestId,
    )
  })
  it('asigna otro ID al corregir los datos', async () => {
    const send = vi
      .fn<(input: { quantity: number; requestId: string }) => Promise<string>>()
      .mockResolvedValue('ok')
    const operation = createIdempotentOperation<{ quantity: number }, string>(
      send,
    )
    await operation.execute({ quantity: 1 })
    await operation.execute({ quantity: 2 })
    expect(send.mock.calls[0][0].requestId).not.toBe(
      send.mock.calls[1][0].requestId,
    )
  })
})

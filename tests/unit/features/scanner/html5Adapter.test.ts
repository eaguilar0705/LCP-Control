import { afterEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  clear: vi.fn(),
  scanning: false,
}))
vi.mock('html5-qrcode', () => ({
  Html5Qrcode: class {
    get isScanning() {
      return mock.scanning
    }
    start = mock.start
    stop = mock.stop
    clear = mock.clear
  },
}))
import { createHtml5Adapter } from '@/features/scanner/html5Adapter'
afterEach(() => {
  mock.scanning = false
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})
describe('html5 camera adapter', () => {
  it('waits for an in-flight camera startup before releasing it', async () => {
    vi.stubGlobal('isSecureContext', true)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    })
    let resolve!: () => void
    mock.start.mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolve = () => {
            mock.scanning = true
            r()
          }
        }),
    )
    mock.stop.mockImplementation(async () => {
      mock.scanning = false
    })
    const adapter = createHtml5Adapter('reader')
    const start = adapter.start(() => {})
    await vi.waitFor(() => expect(mock.start).toHaveBeenCalled())
    const stop = adapter.stop()
    expect(mock.stop).not.toHaveBeenCalled()
    resolve()
    await start
    await stop
    expect(mock.stop).toHaveBeenCalledOnce()
    expect(mock.clear).toHaveBeenCalledOnce()
    expect(mock.start.mock.calls[0][0]).toEqual({ facingMode: 'environment' })
  })
  it('rejects insecure contexts without requesting a camera', async () => {
    vi.stubGlobal('isSecureContext', false)
    await expect(
      createHtml5Adapter('reader').start(() => {}),
    ).rejects.toMatchObject({ kind: 'insecure' })
    expect(mock.start).not.toHaveBeenCalled()
  })
  it('distinguishes a missing camera', async () => {
    vi.stubGlobal('isSecureContext', true)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: undefined,
    })
    await expect(
      createHtml5Adapter('reader').start(() => {}),
    ).rejects.toMatchObject({ kind: 'unavailable' })
  })
})

import { describe, expect, it, vi } from 'vitest'
import { ScannerSession } from '@/features/scanner/ScannerSession'
import { CameraError, type ScannerAdapter } from '@/features/scanner/adapter'
import { demoAdapter } from '@/services/adapters/demo'
function harness() {
  let decode: (code: string) => void = () => {}
  const adapter: ScannerAdapter = {
    start: vi.fn(async (callback) => {
      decode = callback
    }),
    stop: vi.fn(async () => {}),
  }
  const find = vi.fn(demoAdapter.findByBarcode)
  const emit = vi.fn()
  const session = new ScannerSession(adapter, find, emit)
  return {
    adapter,
    find,
    emit,
    session,
    decode: (code: string) => decode(code),
  }
}
describe('scanner lifecycle', () => {
  it('does not start a camera if unmounted during initial cleanup', async () => {
    const h = harness()
    const start = h.session.start()
    await h.session.cancel()
    await start
    expect(h.adapter.start).not.toHaveBeenCalled()
  })
  it('stops and looks up only once for consecutive frames', async () => {
    const h = harness()
    await h.session.start()
    h.decode('LCP-0001')
    h.decode('LCP-0001')
    h.decode('LCP-0002')
    await vi.waitFor(() =>
      expect(h.emit).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'found' }),
      ),
    )
    expect(h.find).toHaveBeenCalledTimes(1)
    expect(h.adapter.stop).toHaveBeenCalledTimes(2)
  })
  it('handles unknown and invalid codes', async () => {
    const h = harness()
    await h.session.lookup('unknown')
    expect(h.emit).toHaveBeenLastCalledWith({
      status: 'unknown',
      code: 'unknown',
    })
    await h.session.lookup(' ')
    expect(h.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'error' }),
    )
    expect(h.find).toHaveBeenCalledTimes(1)
  })
  it('shows permission denial and allows retry', async () => {
    const h = harness()
    vi.mocked(h.adapter.start).mockRejectedValueOnce(new CameraError('denied'))
    await h.session.start()
    expect(h.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'error',
        message: expect.stringContaining('rechazado'),
      }),
    )
    await h.session.start()
    expect(h.emit).toHaveBeenLastCalledWith({ status: 'scanning' })
  })
  it('ignores callbacks after navigation / cancellation', async () => {
    const h = harness()
    await h.session.start()
    await h.session.cancel()
    h.emit.mockClear()
    h.decode('LCP-0001')
    await Promise.resolve()
    expect(h.find).not.toHaveBeenCalled()
    expect(h.emit).not.toHaveBeenCalled()
  })
  it('does not display an old lookup after cancellation', async () => {
    const h = harness()
    let resolve!: (value: null) => void
    h.find.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    const lookup = h.session.lookup('unknown')
    await vi.waitFor(() => expect(h.find).toHaveBeenCalled())
    await h.session.cancel()
    h.emit.mockClear()
    resolve(null)
    await lookup
    expect(h.emit).not.toHaveBeenCalled()
  })
  it('surfaces lookup failures without exposing internal messages', async () => {
    const h = harness()
    h.find.mockRejectedValue(new Error('private SQL detail'))
    await h.session.lookup('LCP-0001')
    expect(h.emit).toHaveBeenLastCalledWith({
      status: 'error',
      message: 'No pudimos completar la operación. Inténtalo de nuevo.',
    })
  })
})

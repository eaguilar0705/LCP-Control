import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TransientImage } from '@/components/TransientImage'
import { ProductImage } from '@/components/ProductImage'
import type { Product } from '@/lib/domain'

const fetchImage = vi.fn()
const createUrl = vi.fn()
const revokeUrl = vi.fn()
beforeEach(() => {
  fetchImage.mockReset()
  createUrl.mockReset().mockReturnValue('blob:temporary-photo')
  revokeUrl.mockReset()
  vi.stubGlobal('fetch', fetchImage)
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createUrl
      static revokeObjectURL = revokeUrl
    },
  )
})
afterEach(() => vi.unstubAllGlobals())

it.each([
  'https://photos.example/object?token=synthetic-grant',
  '//photos.example/object?token=synthetic-grant',
  '/object?token=synthetic%2Dgrant',
])(
  'downloads %s without caching and only exposes a temporary URL',
  async (src) => {
    fetchImage.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['photo']),
    })
    const view = render(<TransientImage src={src} alt="Perfume" />)
    expect(screen.getByRole('img')).not.toHaveAttribute('src', src)
    await waitFor(() =>
      expect(screen.getByRole('img')).toHaveAttribute(
        'src',
        'blob:temporary-photo',
      ),
    )
    expect(fetchImage).toHaveBeenCalledWith(
      src,
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: expect.any(AbortSignal),
      }),
    )
    view.unmount()
    expect(revokeUrl).toHaveBeenCalledWith('blob:temporary-photo')
  },
)

it('keeps the editor-owned local preview without refetching or revoking it', () => {
  const view = render(
    <TransientImage src="blob:editor-owned" alt="Vista previa" />,
  )
  expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:editor-owned')
  view.rerender(<TransientImage src="data:,demo-photo" alt="Vista previa" />)
  expect(screen.getByRole('img')).toHaveAttribute('src', 'data:,demo-photo')
  view.unmount()
  expect(fetchImage).not.toHaveBeenCalled()
  expect(revokeUrl).not.toHaveBeenCalled()
})

it('never falls back to the signed URL when downloading fails', async () => {
  fetchImage.mockResolvedValue({ ok: false })
  render(
    <ProductImage
      large
      product={
        {
          brand: 'Marca',
          name: 'Perfume',
          imageUrl: '/photo?token=grant',
        } as Product
      }
    />,
  )
  expect(await screen.findByText('Foto no disponible')).toBeVisible()
  expect(screen.queryByRole('img')).toBeNull()
  expect(createUrl).not.toHaveBeenCalled()
})

it('aborts an old download and discards a late response when the source changes', async () => {
  let finish!: (response: unknown) => void
  fetchImage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  fetchImage.mockResolvedValue({
    ok: true,
    blob: async () => new Blob(['new']),
  })
  const view = render(<TransientImage src="/old?token=old" alt="Perfume" />)
  const oldSignal = fetchImage.mock.calls[0][1].signal as AbortSignal
  view.rerender(<TransientImage src="/new?token=new" alt="Perfume" />)
  expect(oldSignal.aborted).toBe(true)
  await waitFor(() => expect(createUrl).toHaveBeenCalledOnce())
  await act(async () => {
    finish({ ok: true, blob: async () => new Blob(['old']) })
  })
  expect(createUrl).toHaveBeenCalledOnce()
  view.unmount()
  expect(revokeUrl).toHaveBeenCalledOnce()
})

it('preserves lazy downloading until the photo approaches the viewport', async () => {
  let enter!: IntersectionObserverCallback
  const disconnect = vi.fn()
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        enter = callback
      }
      observe() {}
      disconnect = disconnect
    },
  )
  fetchImage.mockResolvedValue({
    ok: true,
    blob: async () => new Blob(['photo']),
  })
  render(
    <TransientImage src="/photo?token=grant" alt="Perfume" loading="lazy" />,
  )
  expect(fetchImage).not.toHaveBeenCalled()
  act(() =>
    enter(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  )
  await waitFor(() => expect(fetchImage).toHaveBeenCalledOnce())
  fireEvent.error(screen.getByRole('img'))
  expect(disconnect).toHaveBeenCalled()
})

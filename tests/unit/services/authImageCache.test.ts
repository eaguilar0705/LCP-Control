import { beforeEach, expect, it, vi } from 'vitest'
const auth = vi.hoisted(() => ({
  signOut: vi.fn(),
  onAuthStateChange: vi.fn(),
}))
vi.mock('@/lib/supabase', () => ({ supabase: { auth } }))
import { authService } from '@/services/auth'
import { privateImageCache } from '@/lib/privateImageCache'

beforeEach(() => {
  privateImageCache.setSession('previous-user')
  privateImageCache.clear()
  auth.signOut.mockReset()
  auth.onAuthStateChange.mockReset()
})
function grant() {
  privateImageCache.set(
    'photo',
    { url: 'https://photos.example?token=grant', expires: Date.now() + 1000 },
    privateImageCache.generation,
  )
}
it('removes photo grants before the logout request can finish', async () => {
  grant()
  let finish!: (value: unknown) => void
  auth.signOut.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = authService.signOut()
  expect(privateImageCache.get('photo')).toBeUndefined()
  finish({ error: null })
  await pending
  expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
})
it.each([null, { user: { id: 'next-user' } }])(
  'invalidates grants synchronously on auth event %j',
  (session) => {
    grant()
    auth.onAuthStateChange.mockImplementation((callback) => {
      callback(session ? 'SIGNED_IN' : 'SIGNED_OUT', session)
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    })
    const unsubscribe = authService.subscribe(vi.fn())
    expect(privateImageCache.get('photo')).toBeUndefined()
    unsubscribe()
  },
)

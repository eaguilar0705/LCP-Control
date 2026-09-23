import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AccessContext } from '@/app/AccessContext'
import { useWorkspaceDrafts } from '@/lib/workspaceDrafts'
const { read, write } = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: read }) }) }),
  },
}))
vi.mock('@/services/workspace', () => ({ rpc: write }))
const schema = z.object({ name: z.string() })
function open() {
  return renderHook(() => useWorkspaceDrafts('lcp.drafts.invoice.v2', schema), {
    wrapper: ({ children }) => (
      <AccessContext.Provider
        value={{
          demo: false,
          base: '',
          role: 'admin',
          storageScope: 'user:test',
        }}
      >
        {children}
      </AccessContext.Provider>
    ),
  })
}
beforeEach(() => {
  read.mockReset()
  write.mockReset()
  localStorage.clear()
})
it('loads account drafts and saves using the database revision without browser persistence', async () => {
  read.mockResolvedValue({
    data: { items: [{ name: 'Guardado' }], revision: 4 },
    error: null,
  })
  write.mockResolvedValue(5)
  const hook = open()
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  expect(hook.result.current.items).toEqual([{ name: 'Guardado' }])
  await act(async () => {
    expect(await hook.result.current.save([{ name: 'Editado' }])).toBe(true)
  })
  expect(write).toHaveBeenCalledWith('save_my_drafts', {
    p_namespace: 'lcp.drafts.invoice.v2',
    p_items: [{ name: 'Editado' }],
    p_revision: 4,
  })
  expect(localStorage.length).toBe(0)
})
it('blocks writes after a read failure until the user reloads successfully', async () => {
  read
    .mockResolvedValueOnce({ error: new TypeError('offline') })
    .mockResolvedValue({ data: { items: [], revision: 2 } })
  const hook = open()
  await waitFor(() => expect(hook.result.current.error).not.toBe(''))
  await act(async () => {
    expect(await hook.result.current.save([{ name: 'Nuevo' }])).toBe(false)
  })
  expect(write).not.toHaveBeenCalled()
  act(() => hook.result.current.retry())
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  expect(hook.result.current.error).toBe('')
})
it('keeps confirmed drafts after a conflicting save and loads the other device revision on retry', async () => {
  read
    .mockResolvedValueOnce({
      data: { items: [{ name: 'Original' }], revision: 1 },
    })
    .mockResolvedValue({
      data: { items: [{ name: 'Otro equipo' }], revision: 2 },
    })
  write.mockRejectedValueOnce(new Error('conflict'))
  const hook = open()
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  await act(async () => {
    expect(await hook.result.current.save([{ name: 'No guardado' }])).toBe(
      false,
    )
  })
  expect(hook.result.current.items).toEqual([{ name: 'Original' }])
  expect(hook.result.current.error).toContain('Recarga')
  act(() => hook.result.current.retry())
  await waitFor(() =>
    expect(hook.result.current.items).toEqual([{ name: 'Otro equipo' }]),
  )
})

import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { AccessContext } from '@/app/AccessContext'
import { useLocalDrafts } from '@/lib/localDrafts'

it('los borradores de una cuenta no aparecen en otra cuenta ni en demo', () => {
  localStorage.clear()
  const schema = z.object({ name: z.string() })
  function open(scope: string) {
    return renderHook(() => useLocalDrafts('draft-test', schema), {
      wrapper: ({ children }) => (
        <AccessContext.Provider
          value={{
            demo: scope === 'demo',
            base: '',
            role: 'operator',
            storageScope: scope,
          }}
        >
          {children}
        </AccessContext.Provider>
      ),
    })
  }
  const first = open('user:1')
  act(() => {
    first.result.current.save([{ name: 'Cliente privado' }])
  })
  first.unmount()
  expect(open('user:2').result.current.items).toEqual([])
  expect(open('demo').result.current.items).toEqual([])
  expect(open('user:1').result.current.items).toEqual([
    { name: 'Cliente privado' },
  ])
})

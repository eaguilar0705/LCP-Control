import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { AccessContext } from '@/app/AccessContext'
import { useServices } from '@/services/useServices'
import { supabaseAdapter } from '@/services/adapters/supabase'

vi.mock('@/lib/supabase', () => ({ authConfigured: true, supabase: null }))

it('la vista demo usa productos sintéticos aunque haya una conexión real', async () => {
  const remote = vi.spyOn(supabaseAdapter, 'getInventory')
  const { result } = renderHook(useServices, {
    wrapper: ({ children }) => (
      <AccessContext.Provider
        value={{ demo: true, base: '/demo', role: 'operator' }}
      >
        {children}
      </AccessContext.Provider>
    ),
  })
  const items = await result.current.inventoryService.getInventory()
  expect(items).toHaveLength(30)
  expect(
    items.every(({ product }) => product.barcode.startsWith('DEMO-')),
  ).toBe(true)
  expect(remote).not.toHaveBeenCalled()
  await expect(
    result.current.salesService.createDocument({} as never),
  ).rejects.toThrow('no emite')
})

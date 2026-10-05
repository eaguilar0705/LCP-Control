import { createContext, useContext } from 'react'
import type { UserRole } from '../lib/domain'
export const AccessContext = createContext<{
  demo: boolean
  base: string
  role: UserRole | null
  storageScope?: string
}>({ demo: false, base: '', role: null })
export function useAccess() {
  return useContext(AccessContext)
}

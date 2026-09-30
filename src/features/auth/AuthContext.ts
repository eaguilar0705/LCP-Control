import { createContext, useContext } from 'react'
import type { UserProfile } from '../../lib/domain'
import type { AuthService } from '../../services/auth'
interface AuthState {
  user: UserProfile | null
  loading: boolean
  error: string | null
  service: AuthService
  retry: () => void
}
export const AuthContext = createContext<AuthState | null>(null)
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('AuthProvider required')
  return context
}

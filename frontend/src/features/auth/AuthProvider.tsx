import { useEffect, useState, type ReactNode } from 'react'
import { authService, type AuthService } from '../../services/auth'
import { AuthContext } from './AuthContext'
import type { UserProfile } from '../../lib/domain'
import { errorMessage } from '../../lib/errors'
export function AuthProvider({
  children,
  service = authService,
}: {
  children: ReactNode
  service?: AuthService
}) {
  const [state, setState] = useState<{
    user: UserProfile | null
    loading: boolean
    error: string | null
  }>({ user: null, loading: true, error: null })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    let receivedEvent = false
    const unsubscribe = service.subscribe((user) => {
      receivedEvent = true
      if (active) setState({ user, loading: false, error: null })
    })
    service
      .getSession()
      .then((user) => {
        if (active && !receivedEvent)
          setState({ user, loading: false, error: null })
      })
      .catch((error) => {
        if (active && !receivedEvent)
          setState({ user: null, loading: false, error: errorMessage(error) })
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [service, attempt])
  return (
    <AuthContext.Provider
      value={{
        ...state,
        service,
        retry: () => {
          setState({ user: null, loading: true, error: null })
          setAttempt((value) => value + 1)
        },
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

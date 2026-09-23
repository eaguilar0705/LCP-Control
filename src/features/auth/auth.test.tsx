import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AuthProvider } from './AuthProvider'
import { ProtectedRoute } from './ProtectedRoute'
import { LoginPage } from './LoginPage'
import { useAuth } from './AuthContext'
import type { Session } from '@supabase/supabase-js'
import {
  authService,
  profileFromSession,
  type AuthService,
} from '../../services/auth'
import * as supabaseModule from '../../lib/supabase'
import type { UserProfile } from '../../lib/domain'
import { AppError } from '../../lib/errors'
const profile: UserProfile = {
  id: 'test',
  email: 'test@example.test',
  role: 'operator',
}
function serviceFor(user: UserProfile | null): AuthService {
  return {
    getSession: vi.fn(async () => user),
    subscribe: vi.fn(() => () => {}),
    signIn: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  }
}
function PrivatePage() {
  const { service } = useAuth()
  return (
    <>
      <h1>Private</h1>
      <button
        onClick={() => {
          void service.signOut()
        }}
      >
        Salir
      </button>
    </>
  )
}
function mount(service: AuthService, initial = '/inventory') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <AuthProvider service={service}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<h1>Inicio</h1>} />
            <Route path="/inventory" element={<PrivatePage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}
describe('auth flow', () => {
  it('redirects unauthenticated visitors', async () => {
    mount(serviceFor(null))
    expect(
      await screen.findByRole('heading', { name: 'Iniciar sesión' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Private')).not.toBeInTheDocument()
  })
  it('restores a session after refresh', async () => {
    mount(serviceFor(profile))
    expect(await screen.findByText('Private')).toBeInTheDocument()
  })
  it.each(['/login', '/inventory'])(
    'opens home after signing in from %s',
    async (initial) => {
      const service = serviceFor(null)
      let callback!: (user: UserProfile | null) => void
      service.subscribe = (handler) => {
        callback = handler
        return () => {}
      }
      service.signIn = vi.fn(async () => callback(profile))
      mount(service, initial)
      const user = userEvent.setup()
      await user.type(
        await screen.findByLabelText('Correo electrónico'),
        'test@example.test',
      )
      await user.type(screen.getByLabelText('Contraseña'), 'test-password')
      await user.click(screen.getByRole('button', { name: 'Iniciar sesión' }))
      expect(
        await screen.findByRole('heading', { name: 'Inicio' }),
      ).toBeInTheDocument()
      expect(screen.queryByText('Private')).not.toBeInTheDocument()
    },
  )
  it('shows loading until restoration completes', async () => {
    const service = serviceFor(null)
    service.getSession = () => new Promise(() => {})
    mount(service)
    expect(screen.getByRole('status')).toHaveTextContent('Cargando')
  })
  it('denies an account without a backend role', async () => {
    mount(serviceFor({ ...profile, role: null }))
    expect(await screen.findByRole('alert')).toHaveTextContent('rol autorizado')
    expect(screen.queryByText('Private')).not.toBeInTheDocument()
  })
  it('handles invalid credentials in the login form', async () => {
    const service = serviceFor(null)
    service.signIn = vi
      .fn()
      .mockRejectedValue(
        new AppError('unauthorized', 'Correo o contraseña incorrectos.'),
      )
    mount(service, '/login')
    await screen.findByLabelText('Correo electrónico')
    const user = userEvent.setup()
    await user.type(
      screen.getByLabelText('Correo electrónico'),
      'test@example.test',
    )
    await user.type(screen.getByLabelText('Contraseña'), 'not-a-real-password')
    await user.click(screen.getByRole('button', { name: 'Iniciar sesión' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('incorrectos')
  })
  it('logout event removes access', async () => {
    const service = serviceFor(profile)
    let callback!: (user: UserProfile | null) => void
    service.subscribe = (handler) => {
      callback = handler
      return () => {}
    }
    service.signOut = vi.fn(async () => callback(null))
    mount(service)
    await userEvent.click(await screen.findByText('Salir'))
    expect(
      await screen.findByRole('heading', { name: 'Iniciar sesión' }),
    ).toBeInTheDocument()
  })
  it('does not let stale restoration overwrite an auth event', async () => {
    const service = serviceFor(null)
    let resolve!: (user: UserProfile | null) => void
    service.getSession = () =>
      new Promise((r) => {
        resolve = r
      })
    service.subscribe = (handler) => {
      handler(profile)
      return () => {}
    }
    mount(service)
    expect(await screen.findByText('Private')).toBeInTheDocument()
    resolve(null)
    await waitFor(() => expect(screen.getByText('Private')).toBeInTheDocument())
  })
})
describe('el rol se resuelve contra staff_members', () => {
  const session = {
    user: {
      id: 'u1',
      email: 'duena@example.test',
      app_metadata: { role: 'admin' },
    },
  } as unknown as Session
  function withRows(
    rows: { role: string; active: boolean } | null,
    error?: unknown,
  ) {
    const maybeSingle = vi.fn(async () => ({
      data: rows,
      error: error ?? null,
    }))
    const eq = vi.fn(() => ({ maybeSingle }))
    const select = vi.fn(() => ({ eq }))
    const from = vi.fn(() => ({ select }))
    return { from, select, eq, maybeSingle }
  }
  it('toma el rol de la tabla y no del token', async () => {
    const stub = withRows({ role: 'operator', active: true })
    vi.spyOn(supabaseModule, 'supabase', 'get').mockReturnValue(
      stub as unknown as typeof supabaseModule.supabase,
    )
    const result = await profileFromSession(session)
    expect(stub.from).toHaveBeenCalledWith('staff_members')
    expect(stub.eq).toHaveBeenCalledWith('user_id', 'u1')
    // El token dice admin; manda la tabla.
    expect(result?.role).toBe('operator')
  })
  it('niega a una cuenta desactivada', async () => {
    vi.spyOn(supabaseModule, 'supabase', 'get').mockReturnValue(
      withRows({
        role: 'admin',
        active: false,
      }) as unknown as typeof supabaseModule.supabase,
    )
    expect((await profileFromSession(session))?.role).toBeNull()
  })
  it('niega a una cuenta sin fila en la tabla', async () => {
    vi.spyOn(supabaseModule, 'supabase', 'get').mockReturnValue(
      withRows(null) as unknown as typeof supabaseModule.supabase,
    )
    expect((await profileFromSession(session))?.role).toBeNull()
  })
  it('avisa en lugar de conceder acceso si la consulta falla', async () => {
    vi.spyOn(supabaseModule, 'supabase', 'get').mockReturnValue(
      withRows(null, {
        message: 'network',
      }) as unknown as typeof supabaseModule.supabase,
    )
    await expect(profileFromSession(session)).rejects.toThrow('autorización')
  })
})

describe('eventos de sesión fuera de orden', () => {
  it('una consulta pendiente no restaura al usuario después de cerrar sesión', async () => {
    let listener!: (event: string, session: Session | null) => void
    let resolve!: (result: unknown) => void
    const maybeSingle = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const unsubscribe = vi.fn()
    const client = {
      auth: {
        onAuthStateChange: (callback: typeof listener) => {
          listener = callback
          return { data: { subscription: { unsubscribe } } }
        },
      },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    }
    vi.spyOn(supabaseModule, 'supabase', 'get').mockReturnValue(client as never)
    const callback = vi.fn()
    const stop = authService.subscribe(callback)
    listener('SIGNED_IN', {
      user: { id: 'u1', email: 'user@example.test' },
    } as Session)
    await waitFor(() => expect(maybeSingle).toHaveBeenCalled())
    listener('SIGNED_OUT', null)
    resolve({ data: { role: 'admin', active: true }, error: null })
    await new Promise((done) => setTimeout(done, 0))
    expect(callback.mock.calls).toEqual([[null]])
    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it('al desmontar cancela la consulta diferida y las notificaciones', async () => {
    let listener!: (event: string, session: Session | null) => void
    const from = vi.fn()
    vi.spyOn(supabaseModule, 'supabase', 'get').mockReturnValue({
      from,
      auth: {
        onAuthStateChange: (callback: typeof listener) => {
          listener = callback
          return { data: { subscription: { unsubscribe: vi.fn() } } }
        },
      },
    } as never)
    const callback = vi.fn()
    const stop = authService.subscribe(callback)
    listener('SIGNED_IN', { user: { id: 'u1' } } as Session)
    stop()
    await new Promise((done) => setTimeout(done, 0))
    expect(from).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
  })
})

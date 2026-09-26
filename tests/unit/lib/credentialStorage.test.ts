import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Las credenciales viven sólo en memoria (decisión del 26-09-2026). Estas
// pruebas usan el cliente real de supabase-js con un servidor simulado: nada
// sale a la red.
const PASSWORD = 'ClaveDePrueba-2026!'
const REFRESH = 'refresh-de-prueba-123'

function jwt(payload: Record<string, unknown>) {
  const part = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.firma-simulada-0123456789`
}

function fakeSupabase() {
  const now = Math.floor(Date.now() / 1000)
  const user = {
    id: '11111111-2222-3333-4444-555555555555',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'persona@example.com',
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  }
  const access = jwt({ sub: user.id, role: 'authenticated', exp: now + 3600 })
  const calls: { url: string; cache?: RequestCache }[] = []
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, cache: init?.cache })
      if (url.includes('/auth/v1/token'))
        return new Response(
          JSON.stringify({
            access_token: access,
            token_type: 'bearer',
            expires_in: 3600,
            expires_at: now + 3600,
            refresh_token: REFRESH,
            user,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      if (url.includes('/auth/v1/logout'))
        return new Response(null, { status: 204 })
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  )
  return { fetchMock, calls, access }
}

function everythingStored() {
  const dump = (store: Storage) =>
    Array.from({ length: store.length }, (_, i) => {
      const key = store.key(i)!
      return `${key}=${store.getItem(key)}`
    }).join('\n')
  return `${dump(localStorage)}\n${dump(sessionStorage)}\n${document.cookie}`
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('credenciales sólo en memoria', () => {
  it('borra las sesiones que dejó una versión anterior y nada más', async () => {
    localStorage.setItem('sb-proyecto-auth-token', '{"refresh_token":"viejo"}')
    localStorage.setItem('sb-proyecto-auth-token-user', '{"email":"a@b.c"}')
    sessionStorage.setItem('sb-proyecto-auth-token-code-verifier', 'x')
    localStorage.setItem('lcp.reflections.v1', '[1,2]')
    const { purgeStoredCredentials } = await import('@/lib/supabase')
    // La importación ya limpió; una segunda pasada no encuentra nada.
    expect(localStorage.getItem('sb-proyecto-auth-token')).toBeNull()
    expect(localStorage.getItem('sb-proyecto-auth-token-user')).toBeNull()
    expect(sessionStorage.length).toBe(0)
    expect(localStorage.getItem('lcp.reflections.v1')).toBe('[1,2]')
    expect(purgeStoredCredentials()).toBe(0)
  })

  it('un almacenamiento bloqueado no rompe el arranque', async () => {
    const { purgeStoredCredentials } = await import('@/lib/supabase')
    const blocked = {
      get length(): number {
        throw new DOMException('bloqueado', 'SecurityError')
      },
    } as unknown as Storage
    expect(purgeStoredCredentials([blocked, undefined])).toBe(0)
  })

  it('iniciar sesión no escribe tokens, correo ni contraseña en el navegador', async () => {
    const { fetchMock, calls, access } = fakeSupabase()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('VITE_SUPABASE_URL', 'https://prueba.supabase.co')
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_prueba')
    const { supabase } = await import('@/lib/supabase')
    expect(supabase).not.toBeNull()

    const { error } = await supabase!.auth.signInWithPassword({
      email: 'persona@example.com',
      password: PASSWORD,
    })
    expect(error).toBeNull()
    // La sesión existe, pero sólo en la memoria de esta pestaña.
    const { data } = await supabase!.auth.getSession()
    expect(data.session?.refresh_token).toBe(REFRESH)

    const stored = everythingStored()
    for (const secret of [PASSWORD, REFRESH, access, 'persona@example.com'])
      expect(stored).not.toContain(secret)
    expect(document.cookie).toBe('')

    // Ninguna respuesta de Supabase pasa por la caché HTTP del navegador.
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((call) => call.cache === 'no-store')).toBe(true)

    await supabase!.auth.signOut({ scope: 'local' })
    expect((await supabase!.auth.getSession()).data.session).toBeNull()
    expect(calls.some((call) => call.url.includes('/auth/v1/logout'))).toBe(
      true,
    )
  })

  it('una sesión nueva del mismo navegador empieza sin credenciales', async () => {
    const { fetchMock } = fakeSupabase()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('VITE_SUPABASE_URL', 'https://prueba.supabase.co')
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_prueba')
    const first = (await import('@/lib/supabase')).supabase!
    await first.auth.signInWithPassword({
      email: 'persona@example.com',
      password: PASSWORD,
    })
    // Recargar la página equivale a volver a evaluar el módulo.
    vi.resetModules()
    const second = (await import('@/lib/supabase')).supabase!
    expect((await second.auth.getSession()).data.session).toBeNull()
  })
})

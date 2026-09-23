import { describe, expect, it } from 'vitest'
import { exposedSecretEnv, findSecrets, isLoopbackHost } from '@/lib/security'

// Credentials are assembled at runtime so the repository never contains a
// string that looks like a real key.
const fake = (prefix: string) => prefix + 'x'.repeat(40)
function jwt(payload: object) {
  const part = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.${'s'.repeat(43)}`
}

describe('secretos que no pueden llegar al navegador', () => {
  it('detecta claves secretas y deja pasar las publicables', () => {
    expect(findSecrets(`const key = "${fake('sb_secret_')}"`)).toEqual([
      'clave secreta de Supabase',
    ])
    expect(findSecrets(`const key = "${fake('sb_publishable_')}"`)).toEqual([])
  })
  it('no confunde el código de supabase-js que sólo compara prefijos', () => {
    expect(
      findSecrets(
        'e.startsWith(`sb_publishable_`)||e.startsWith(`sb_secret_`)',
      ),
    ).toEqual([])
  })
  it('distingue la clave anon de un JWT con privilegios', () => {
    expect(findSecrets(jwt({ role: 'anon' }))).toEqual([])
    expect(findSecrets(jwt({ role: 'service_role' }))).toEqual([
      'JWT distinto de la clave anon',
    ])
  })
  it('detecta llaves privadas y cadenas de conexión con contraseña', () => {
    expect(findSecrets('-----BEGIN ' + 'PRIVATE KEY-----')).toEqual([
      'clave privada PEM',
    ])
    expect(
      findSecrets('postgresql://postgres:' + 'inventada@db.example.test/db'),
    ).toEqual(['cadena de conexión con contraseña'])
  })
  it('señala variables VITE_ con nombre o valor de secreto', () => {
    expect(
      exposedSecretEnv({
        VITE_SUPABASE_URL: 'https://example.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: fake('sb_publishable_'),
        VITE_SERVICE_ROLE_KEY: 'x',
        VITE_ANALYTICS_ID: fake('sb_secret_'),
        DATABASE_PASSWORD: 'sin prefijo VITE_ no se expone',
      }),
    ).toEqual(['VITE_SERVICE_ROLE_KEY', 'VITE_ANALYTICS_ID'])
  })
})

describe('servidores de prueba sólo locales', () => {
  it.each(['127.0.0.1', 'localhost', '::1', undefined])('acepta %s', (host) =>
    expect(isLoopbackHost(host)).toBe(true),
  )
  it.each(['0.0.0.0', '192.168.1.20', true])('rechaza %s', (host) =>
    expect(isLoopbackHost(host)).toBe(false),
  )
})
